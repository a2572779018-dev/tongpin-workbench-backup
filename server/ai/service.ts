import { AI_BUSINESS_TIER_LABELS, AI_BUSINESS_TIERS, type AiChatBudget, type AiChatPreflight, type AiChatPreflightReason, type AiChatRequest, type AiChatResponse, type AiHarnessCapability, type AiHarnessConfig, type AiHarnessTrace, type AiImageAsset, type AiImageRequest, type AiImageResponse, type AiMember, type AiObservabilityDashboard, type AiProviderConfig, type AiProviderInput, type AiProviderTestResult, type AiQuota, type AiRequestResult, type AiStatus, type AiUsage } from "../../shared/ai";
import { AiError, safeBaseUrl, type SecretBox } from "./security";
import { AiStore, type StoredProvider, type StoredRequest } from "./storage";
import { AI_TIMEOUT_MS, isProviderRejection, object, parseProviderResult, providerBody, readProviderHttpError, readBoundedJson, readProviderResponse, type AiTransport } from "./provider";
import { chatInputReserve, parseChatCapabilities, parseComputerPlan, parsePresentation, parseToolPlan, parseToolClarification, validateImageBase64 } from "./capabilities";
import { AiPersonaRepository } from "./persona";
import type { AiPersonaProfile } from "../../shared/aiPersona";
import { imageProviderBody, MAX_IMAGE_RESPONSE_BYTES, readImageProviderResponse } from "./imageProvider";
import { searchCallLimit } from "./searchPolicy";
import { AiVideoService } from "./videoService";
import { AvailabilityProbe } from "./availability";
import { needsOnlineEvidence, routeChatProvider } from "./autoRouting";
import { BAI_ASTRA_MODEL, filterBaiAgentModels, isTongpinQuickAgent, TONGPIN_QUICK_AGENT } from "../../shared/aiAuto";
import type { AiAvailability } from "../../shared/ai";
import { AI_CHAT_CONTEXT_LIMITS, AiCurrentContextTooLongError, fitAiChatMessages, type AiChatTextContext } from "../../shared/aiContext";
import { claimToolPlan, toolPlanContextFingerprint, toolPlanExpiry, validateToolPlan } from "./toolPlans";
import { verifiedBaiAgentModels } from "./modelVerification";
import { AiHarness, parseHarnessContinuationDecision, requestCapability, validConversationId, type ResolvedHarnessRoute } from "./harness";
import { parsePublicExplanation, supportsPublicExplanation } from "./publicExplanation";
import { parseAiDispatchDecision } from "./dispatch";

type MemberIdentity = Omit<AiMember, "quota">;
const MAX_TOKEN_LIMIT = 1_000_000_000;
// search_context_size=low is a size preference, not a contractual token ceiling.
// Keep the existing conservative allowance until a provider supplies a verifiable cap.
const SEARCH_INPUT_RESERVE = 32768;
const MIN_OUTPUT_TOKENS = 16;
const CONTINUATION_TOOLS = new Set<AiHarnessCapability>(["web_search", "image", "video", "presentation", "computer"]);

export interface AiBackgroundAgentCycle {
  scanned: number;
  resumed: number;
  completed: number;
  waitingApproval: number;
  pending: number;
  skippedInactive: number;
  failed: number;
}

export type AiBackgroundPrincipalCheck = (tenantId: string, userId: string) => boolean | Promise<boolean>;

function continuationPrompt(
  trace: AiHarnessTrace,
  allowed: readonly AiHarnessCapability[],
  context: ReturnType<AiHarness["decisionContext"]>,
): string {
  const workflow = trace.steps.find(step => step.kind === "strategy")?.workflowId;
  return [
    "根据下面这份应用拥有的状态，决定当前任务是否完成，或提出一个下一项工具。",
    "不得复述思考过程，不得添加字段。工具必须来自 allowedTools；列表为空时只能 complete。",
    JSON.stringify({
      strategy: trace.strategy,
      taskGoal: context.goal,
      verifiedToolResults: context.results,
      allowedTools: allowed,
      remainingToolSteps: trace.toolBudget.remaining,
      ...(workflow ? { workflow } : {}),
    }),
  ].join("\n");
}

function chatBudget(request: AiChatRequest, provider: AiProviderConfig, quota: AiQuota, persona: AiPersonaProfile, model: string): AiChatBudget {
  const inputReserve = chatInputReserve(request, persona, model, provider.visionInputReserveTokens);
  const searchInputReserve = request.webSearch ? SEARCH_INPUT_RESERVE : 0;
  const convertedReserve = request.webSearch ? provider.webSearchQuotaTokens! * searchCallLimit(provider) : 0;
  return {
    inputReserve, searchInputReserve, convertedReserve, minOutputTokens: MIN_OUTPUT_TOKENS,
    minimumRequiredTokens: inputReserve + searchInputReserve + convertedReserve + MIN_OUTPUT_TOKENS,
    availableOutputTokens: Math.max(0, Math.min(provider.maxOutputTokens, quota.remainingTokens - inputReserve - searchInputReserve - convertedReserve)),
    maxOutputTokens: provider.maxOutputTokens,
  };
}
function budgetReason(budget: AiChatBudget, quota: AiQuota, pending: boolean): AiChatPreflightReason {
  if (pending) return "request_in_progress";
  if (quota.remainingTokens === 0) return "quota_exhausted";
  if (quota.remainingTokens < budget.minimumRequiredTokens) return budget.searchInputReserve ? "search_quota_insufficient" : "quota_insufficient";
  return null;
}
function requireChatBudget(preflight: AiChatPreflight): void {
  const { reason } = preflight;
  if (reason === "request_in_progress") throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "当前对话已有任务，或该账号的并行任务已达 3 条，请稍候", true, preflight);
  if (reason === "quota_exhausted") throw new AiError(402, "AI_QUOTA_EXHAUSTED", "可用同频点已用完，请联系管理员增加额度", true, preflight);
  if (reason === "search_quota_insufficient") throw new AiError(402, "AI_SEARCH_QUOTA_INSUFFICIENT", "当前余额不足以预留本次联网搜索所需额度；尚未发送，也未扣费", true, preflight);
  if (reason === "quota_insufficient") throw new AiError(402, "AI_QUOTA_INSUFFICIENT", "当前仍有余额，但不足以预留本次对话所需额度；请缩短对话或联系管理员", true, preflight);
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new AiError(400, "AI_INPUT_INVALID", `${name}格式不正确`);
  return value.trim();
}
function parseProvider(value: unknown, existing: StoredProvider | null, harnessSearchConfigured = false): AiProviderInput {
  const p = object(value);
  if (p.apiKey !== undefined && typeof p.apiKey !== "string") throw new AiError(400, "AI_INPUT_INVALID", "API 密钥格式不正确");
  const protocol = p.protocol;
  if (protocol !== "chat_completions" && protocol !== "responses") throw new AiError(400, "AI_INPUT_INVALID", "请选择接口协议");
  if (!Number.isInteger(p.maxOutputTokens) || Number(p.maxOutputTokens) < 16 || Number(p.maxOutputTokens) > 32768) throw new AiError(400, "AI_INPUT_INVALID", "单次最大输出需为 16 到 32768 的整数");
  if (!["", "low", "medium", "high"].includes(String(p.reasoningEffort ?? "")) || typeof p.enabled !== "boolean") throw new AiError(400, "AI_INPUT_INVALID", "AI 服务配置格式不正确");
  if (p.imageApiKey !== undefined && typeof p.imageApiKey !== "string") throw new AiError(400, "AI_INPUT_INVALID", "图片 API 密钥格式不正确");
  const imageModelValue = p.imageModel ?? existing?.imageModel ?? "";
  if (typeof imageModelValue !== "string") throw new AiError(400, "AI_INPUT_INVALID", "图片模型格式不正确");
  const imageModel = imageModelValue.trim() ? text(imageModelValue, "图片模型", 160) : "";
  const imageBaseValue = p.imageBaseUrl ?? existing?.imageBaseUrl ?? "";
  if (typeof imageBaseValue !== "string") throw new AiError(400, "AI_INPUT_INVALID", "图片 API 地址格式不正确");
  const imageBaseUrl = imageBaseValue.trim() ? safeBaseUrl(imageBaseValue) : "";
  const imageQuotaTokens = p.imageQuotaTokens ?? existing?.imageQuotaTokens ?? 0;
  const webSearchQuotaTokens = p.webSearchQuotaTokens ?? existing?.webSearchQuotaTokens ?? 0;
  if (![imageQuotaTokens, webSearchQuotaTokens].every(n => Number.isSafeInteger(n) && Number(n) >= 0 && Number(n) <= 10_000_000)) throw new AiError(400, "AI_INPUT_INVALID", "工具折算额度需为 0 到 1000 万之间的整数");
  const webSearchEnabled = p.webSearchEnabled ?? existing?.webSearchEnabled ?? false;
  const webSearchProtocol = p.webSearchProtocol ?? existing?.webSearchProtocol ?? "standard";
  if (webSearchProtocol !== "standard" && webSearchProtocol !== "compatible") throw new AiError(400, "AI_SEARCH_CONFIG_INVALID", "请选择标准或兼容搜索协议");
  const visionEnabled = p.visionEnabled ?? existing?.visionEnabled ?? false;
  const visionInputReserveTokens = p.visionInputReserveTokens ?? existing?.visionInputReserveTokens ?? 4096;
  if (!Number.isSafeInteger(visionInputReserveTokens) || Number(visionInputReserveTokens) < 256 || Number(visionInputReserveTokens) > 131072) throw new AiError(400, "AI_VISION_CONFIG_INVALID", "每张图片的输入预留需为 256 到 131072 的整数估算值");
  const imageStream = p.imageStream ?? existing?.imageStream ?? false;
  if (typeof webSearchEnabled !== "boolean" || typeof visionEnabled !== "boolean" || typeof imageStream !== "boolean") throw new AiError(400, "AI_INPUT_INVALID", "AI 能力开关格式不正确");
  if (imageModel && !imageQuotaTokens) throw new AiError(400, "AI_IMAGE_QUOTA_REQUIRED", "启用图片模型前，请设置每张图片的折算额度");
  if (webSearchEnabled && ((!harnessSearchConfigured && protocol !== "responses") || !webSearchQuotaTokens)) throw new AiError(400, "AI_SEARCH_CONFIG_INVALID", "联网搜索需使用 Responses 协议，并设置每次搜索的折算额度");
  if (!imageBaseUrl && typeof p.imageApiKey === "string" && p.imageApiKey.trim()) throw new AiError(400, "AI_INPUT_INVALID", "填写独立图片密钥时，还需填写图片 API 地址");
  const quickModel = text(p.quickModel, "快速模型", 160);
  const quickAgent = isTongpinQuickAgent(quickModel);
  if (quickAgent && new URL(safeBaseUrl(p.baseUrl)).hostname !== "api.b.ai") throw new AiError(400, "AI_AGENT_PROVIDER_INVALID", "快速 Agent 当前仅支持 B.AI");
  return {
    name: text(p.name ?? "AI 服务", "服务名称", 80), baseUrl: safeBaseUrl(p.baseUrl), protocol,
    quickModel: quickAgent ? TONGPIN_QUICK_AGENT : quickModel, deepModel: quickAgent ? BAI_ASTRA_MODEL : text(p.deepModel, "深度模型", 160),
    maxOutputTokens: Number(p.maxOutputTokens), reasoningEffort: (p.reasoningEffort ?? "") as AiProviderInput["reasoningEffort"], enabled: p.enabled,
    imageModel, imageBaseUrl, imageQuotaTokens: Number(imageQuotaTokens), imageStream, visionEnabled, visionInputReserveTokens: Number(visionInputReserveTokens), webSearchEnabled, webSearchQuotaTokens: Number(webSearchQuotaTokens), webSearchProtocol,
    ...(typeof p.apiKey === "string" && p.apiKey.trim() ? { apiKey: text(p.apiKey, "API 密钥", 4096) } : {}),
    ...(typeof p.imageApiKey === "string" && p.imageApiKey.trim() ? { imageApiKey: text(p.imageApiKey, "图片 API 密钥", 4096) } : {}),
  };
}
function parseChat(value: unknown): AiChatRequest {
  const p = object(value);
  if (typeof p.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(p.requestId)) throw new AiError(400, "AI_REQUEST_ID_INVALID", "请求标识无效，请刷新后重试");
  if (!AI_BUSINESS_TIERS.includes(p.mode as AiChatRequest["mode"])) throw new AiError(400, "AI_INPUT_INVALID", "请选择快速、标准、深度或 Pro 档位");
  if (!Array.isArray(p.messages) || !p.messages.length || p.messages.length > AI_CHAT_CONTEXT_LIMITS.incomingMessages) throw new AiError(400, "AI_CONTEXT_TOO_LONG", "当前对话记录超出可处理上限，请刷新后重试");
  const rawMessages = p.messages;
  const messages: AiChatRequest["messages"] = rawMessages.map((value, index) => {
    const item = object(value);
    if (item.role !== "user" && item.role !== "assistant") throw new AiError(400, "AI_INPUT_INVALID", "消息角色不正确");
    const max = index === rawMessages.length - 1 ? AI_CHAT_CONTEXT_LIMITS.requestMessageCharacters : AI_CHAT_CONTEXT_LIMITS.persistedMessageCharacters;
    if (typeof item.content !== "string" || !item.content.trim() || item.content.length > max) throw new AiError(400, "AI_CONTEXT_TOO_LONG", index === rawMessages.length - 1 ? "本轮消息过长，请缩短后重试" : "历史消息超出可处理上限，请刷新后重试");
    return { role: item.role, content: item.content };
  });
  if (messages[messages.length - 1].role !== "user") throw new AiError(400, "AI_INPUT_INVALID", "最后一条消息必须是你的提问");
  const capabilities = parseChatCapabilities(p);
  const textContext: AiChatTextContext = {
    ...(capabilities.projectContext ? { projectContext: capabilities.projectContext } : {}),
    ...(capabilities.attachments?.length ? { attachments: capabilities.attachments.map(({ dataUrl: _image, ...text }) => text) } : {}),
  };
  try {
    return { requestId: p.requestId, mode: p.mode as AiChatRequest["mode"], conversationId: validConversationId(p.conversationId, p.requestId), messages: fitAiChatMessages(messages, textContext), ...capabilities };
  } catch (error) {
    if (error instanceof AiCurrentContextTooLongError) throw new AiError(400, "AI_CONTEXT_TOO_LONG", error.message);
    throw error;
  }
}
function parseImageRequest(value: unknown): AiImageRequest {
  const p = object(value);
  if (typeof p.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(p.requestId)) throw new AiError(400, "AI_REQUEST_ID_INVALID", "请求标识无效，请刷新后重试");
  if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.length > 12000 || /\u0000/.test(p.prompt)) throw new AiError(400, "AI_INPUT_INVALID", "请填写 12000 字以内的图片描述");
  if (typeof p.planRequestId !== "string") throw new AiError(409, "AI_TOOL_PLAN_REQUIRED", "请先让同频 AI 整理图片任务，再确认生成");
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(p.planRequestId)) throw new AiError(400, "AI_TOOL_PLAN_INVALID", "工具方案标识无效，请重新整理任务");
  const context = parseChatCapabilities({ projectContext: p.projectContext, attachments: p.attachments });
  return {
    requestId: p.requestId,
    conversationId: validConversationId(p.conversationId, p.requestId),
    prompt: p.prompt.trim(),
    planRequestId: p.planRequestId,
    ...(context.projectContext ? { projectContext: context.projectContext } : {}),
    ...(context.attachments?.length ? { attachments: context.attachments } : {}),
  };
}
function totalReserved(request: StoredRequest): number { return request.inputReserve + request.outputReserve + (request.convertedReserve ?? 0); }
function conservativeUsage(request: StoredRequest): AiUsage {
  return { inputTokens: request.inputReserve, outputTokens: request.outputReserve, totalTokens: totalReserved(request), estimated: true,
    ...(request.convertedReserve ? { convertedTokens: request.convertedReserve, billingKind: request.kind === "image" ? "image_conversion" as const : "tokens_with_search" as const } : {}),
  };
}

function memberChatResult(result: Omit<AiChatResponse, "quota">): Omit<AiChatResponse, "quota"> {
  // Video model selection is an explicit member input. The server has already
  // rebound it to the selected tier's verified provider before persisting the
  // plan, so returning it lets the one-click composer execute that exact plan.
  return result;
}
async function requestHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
export async function providerIdempotencyKey(tenantId: string, userId: string, requestId: string, operation: "chat" | "image"): Promise<string> {
  return `tongpin-${await requestHash({ version: 1, tenantId, userId, requestId, operation })}`;
}
export class AiService {
  readonly video: AiVideoService;
  readonly harness: AiHarness;
  private readonly availabilityProbe: AvailabilityProbe;
  constructor(readonly store: AiStore, private readonly box: () => Promise<SecretBox>, private readonly transport: AiTransport, private readonly videoKey: () => string = () => "", private readonly isBackgroundPrincipalActive: AiBackgroundPrincipalCheck = () => false) {
    this.harness = new AiHarness(store, box, transport);
    this.video = new AiVideoService(store, box, transport, videoKey, this.harness);
    this.availabilityProbe = new AvailabilityProbe(transport, box);
  }
  forTenant(tenantId: string): AiService {
    const scoped = this.store.forTenant(tenantId);
    return scoped === this.store ? this : new AiService(scoped, this.box, this.transport, this.videoKey, this.isBackgroundPrincipalActive);
  }
  /** Compatibility pricing/settings for a harness-only installation. Reading
   * this draft never writes settings or changes the authoritative tier routes. */
  private providerBaseline(): StoredProvider | null {
    const saved = this.store.provider();
    if (saved) return saved;
    const harness = this.store.harness();
    if (!harness) return null;
    const tier = AI_BUSINESS_TIERS.find(item => harness.tiers[item].enabled) ?? "quick";
    const route = harness.tiers[tier];
    const connection = harness.providers.find(item => item.id === route.providerId);
    if (!connection) return null;
    return this.harness.asProvider({ tier, providerId: connection.id, providerName: connection.name,
      baseUrl: connection.baseUrl, encryptedKey: connection.encryptedKey, modelId: route.modelId,
      protocol: route.protocol, maxOutputTokens: route.maxOutputTokens, reasoningEffort: route.reasoningEffort,
      capabilities: route.capabilities, policy: harness.policy, legacy: false }, null);
  }
  async availability(userId: string, target: string = "chat"): Promise<AiAvailability> {
    if (target !== "chat" && target !== "image") throw new AiError(400, "AI_INPUT_INVALID", "检测目标不正确");
    const status = this.status(userId);
    const unavailable = (code: string, message: string): AiAvailability => ({ status, check: { state: "unavailable", code, message, checkedAt: new Date().toISOString() } });
    if (!status.accessGranted) return unavailable("AI_ACCESS_NOT_GRANTED", "管理员尚未为此账号开通 AI 使用权限。");
    if (!status.configured) return unavailable("AI_NOT_CONFIGURED", "管理员尚未启用 AI 服务。");
    if (status.quota.remainingTokens <= 0) return unavailable("AI_QUOTA_EXHAUSTED", "当前没有可用额度，请联系管理员；历史对话仍可查看。");
    if (target === "image" && !status.imageEnabled) return unavailable("AI_IMAGE_DISABLED", "管理员尚未启用图片生成，请切换文字对话或联系管理员。");
    if (target === "image" && status.quota.remainingTokens < (status.imageQuotaTokens ?? 0)) return unavailable("AI_QUOTA_EXHAUSTED", "可用额度不足以生成一张图片，请联系管理员；仍可切换文字对话。");
    const provider = this.store.provider();
    const harnessSnapshot = JSON.stringify(this.store.harness());
    const tier = status.availableTiers?.[0] ?? "quick";
    const quickRoute = target === "chat" ? this.harness.resolve(tier, provider, "chat") : undefined;
    const publicHarness = this.harness.settings();
    const imageTier = this.store.harness() && AI_BUSINESS_TIERS.find(item => {
      const route = publicHarness!.tiers[item];
      const connection = publicHarness!.providers.find(provider => provider.id === route.imageProviderId);
      return route.enabled && route.capabilities.includes("image") && route.imageModelId && connection?.enabled && connection.apiKeyConfigured && connection.modelsVerified && connection.availableModels.includes(route.imageModelId);
    });
    const imageRoute = target === "image" ? this.harness.resolveMedia(imageTier || tier, provider, "image") : undefined;
    if (target === "image" && !imageRoute && (!provider?.enabled || !provider.imageModel)) return unavailable("AI_IMAGE_DISABLED", "管理员尚未启用图片生成，请切换文字对话或联系管理员。");
    const baseUrl = imageRoute?.baseUrl ?? (target === "image" && provider?.imageBaseUrl ? provider.imageBaseUrl : quickRoute?.baseUrl ?? provider?.baseUrl);
    const key = imageRoute?.encryptedKey ?? (target === "image" && provider?.imageBaseUrl ? provider.encryptedImageKey : quickRoute?.encryptedKey ?? provider?.encryptedKey);
    if (!baseUrl || !key) return unavailable("AI_NOT_CONFIGURED", "管理员尚未完成当前业务档位的服务配置。");
    const check = await this.availabilityProbe.check(target, baseUrl, key);
    if (JSON.stringify(provider) !== JSON.stringify(this.store.provider()) || harnessSnapshot !== JSON.stringify(this.store.harness())) throw new AiError(409, "AI_CONFIG_CHANGED", "服务配置已更改，请重新检测。");
    // Re-read account state after awaiting the shared probe. Never cache member permissions/quota.
    const current = this.status(userId);
    if (!current.accessGranted || current.quota.remainingTokens <= 0) return { status: current, check: { state: "unavailable", code: "AI_QUOTA_EXHAUSTED", message: "当前没有可用额度，请联系管理员。", checkedAt: new Date().toISOString() } };
    return { status: current, check };
  }
  provider(): AiProviderConfig | null {
    const p = this.providerBaseline();
    if (!p) return null;
    const verified = isTongpinQuickAgent(p.quickModel) ? verifiedBaiAgentModels(p) : null;
    const {
      encryptedKey: _encrypted, encryptedImageKey: _imageKey,
      modelConfigVersion: _modelConfigVersion, modelKeyVersion: _modelKeyVersion,
      verifiedModelConfigVersion: _verifiedConfig, verifiedModelKeyVersion: _verifiedKey,
      verifiedModels: _verifiedModels, verifiedModelsAt: _verifiedAt,
      modelsVerified: _legacyVerified, availableModels: _legacyAvailable, modelsVerifiedAt: _legacyVerifiedAt,
      ...safe
    } = p;
    return {
      ...safe,
      imageApiKeyConfigured: Boolean(p.imageBaseUrl ? p.encryptedImageKey : p.encryptedKey),
      ...(isTongpinQuickAgent(p.quickModel) ? { modelsVerified: verified !== null, availableModels: verified ?? [], modelsVerifiedAt: verified === null ? null : p.verifiedModelsAt ?? null } : {}),
    };
  }
  async saveProvider(value: unknown): Promise<AiProviderConfig> {
    const existing = this.providerBaseline();
    const harness = this.store.harness();
    const harnessSearchConfigured = Boolean(harness && AI_BUSINESS_TIERS.some(tier => harness.tiers[tier].enabled && harness.tiers[tier].protocol === "responses" && harness.tiers[tier].capabilities.includes("web_search")));
    const parsed = parseProvider(value, existing, harnessSearchConfigured);
    if (!parsed.apiKey && (!existing?.encryptedKey || existing.baseUrl !== parsed.baseUrl)) throw new AiError(400, "AI_KEY_REQUIRED", "首次接入或更换 API 地址时，请重新填写 API 密钥");
    if (parsed.imageBaseUrl && !parsed.imageApiKey && (!existing?.encryptedImageKey || existing.imageBaseUrl !== parsed.imageBaseUrl)) throw new AiError(400, "AI_IMAGE_KEY_REQUIRED", "首次接入或更换图片 API 地址时，请重新填写图片密钥");
    const { apiKey, imageApiKey, ...config } = parsed;
    const encryptedKey = apiKey ? await (await this.box()).encrypt(apiKey) : existing!.encryptedKey;
    const encryptedImageKey = config.imageBaseUrl ? imageApiKey ? await (await this.box()).encrypt(imageApiKey) : existing!.encryptedImageKey : undefined;
    // Do not let concurrent configuration saves pair a different host with an old key.
    this.store.sql.transaction(() => {
      const current = this.providerBaseline();
      if (!apiKey && (current?.baseUrl !== config.baseUrl || current?.encryptedKey !== existing?.encryptedKey)) throw new AiError(409, "AI_CONFIG_CHANGED", "配置刚刚被修改，请重新填写密钥后保存");
      if (config.imageBaseUrl && !imageApiKey && (current?.imageBaseUrl !== config.imageBaseUrl || current?.encryptedImageKey !== existing?.encryptedImageKey)) throw new AiError(409, "AI_CONFIG_CHANGED", "图片配置刚刚被修改，请重新填写图片密钥后保存");
      this.store.saveProvider({
        ...config, encryptedKey, ...(encryptedImageKey ? { encryptedImageKey } : {}),
        apiKeyConfigured: true, imageApiKeyConfigured: Boolean(encryptedImageKey || !config.imageBaseUrl), updatedAt: new Date().toISOString(),
        // Every persisted configuration save invalidates the previous discovery.
        // The UI immediately performs a new non-generating check with this saved key.
        modelConfigVersion: crypto.randomUUID(),
        modelKeyVersion: apiKey ? crypto.randomUUID() : existing?.modelKeyVersion ?? crypto.randomUUID(),
      });
    });
    return this.provider()!;
  }
  async testProvider(value?: unknown): Promise<AiProviderTestResult> {
    let provider = this.providerBaseline();
    const draft = object(value);
    if (draft.target !== undefined && draft.target !== "chat" && draft.target !== "image") throw new AiError(400, "AI_INPUT_INVALID", "接口测试目标不正确");
    const target = draft.target === "image" ? "image" : "chat";
    let savedBase = target === "image" && provider?.imageBaseUrl ? provider.imageBaseUrl : provider?.baseUrl;
    let savedKey = target === "image" && provider?.imageBaseUrl ? provider.encryptedImageKey : provider?.encryptedKey;
    if (draft.apiKey !== undefined && typeof draft.apiKey !== "string") throw new AiError(400, "AI_INPUT_INVALID", "API 密钥格式不正确");
    const baseUrl = draft.baseUrl !== undefined ? safeBaseUrl(draft.baseUrl) : savedBase;
    if (!baseUrl) throw new AiError(400, "AI_NOT_CONFIGURED", "请先填写 API 地址和密钥");
    const draftKey = typeof draft.apiKey === "string" && draft.apiKey.trim() ? text(draft.apiKey, "API 密钥", 4096) : "";
    if (!draftKey && (!savedKey || savedBase !== baseUrl)) throw new AiError(400, "AI_KEY_REQUIRED", "首次接入或更换 API 地址时，请填写 API 密钥");
    const usingSavedChatKey = Boolean(target === "chat" && !draftKey && provider && provider.baseUrl === baseUrl && savedKey === provider.encryptedKey);
    if (usingSavedChatKey && provider && isTongpinQuickAgent(provider.quickModel) && (!provider.modelConfigVersion || !provider.modelKeyVersion)) {
      const previous = provider;
      const migrated: StoredProvider = { ...previous, modelConfigVersion: crypto.randomUUID(), modelKeyVersion: crypto.randomUUID() };
      this.store.sql.transaction(() => {
        if (JSON.stringify(this.store.provider()) !== JSON.stringify(previous)) throw new AiError(409, "AI_CONFIG_CHANGED", "接入配置已修改，请重新检查模型列表");
        this.store.saveProvider(migrated);
      });
      provider = migrated;
      savedBase = provider.baseUrl;
      savedKey = provider.encryptedKey;
    }
    const key = draftKey || await (await this.box()).decrypt(savedKey!);
    let response: Response;
    try { response = await this.transport(`${baseUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); }
    catch (error) { if (error instanceof AiError) throw error; throw new AiError(502, "AI_CONNECTION_FAILED", "无法连接 AI 服务，请检查公网 API 地址和网络"); }
    if (!response.ok) throw await readProviderHttpError(response, "models");
    const root = object(await readBoundedJson(response, 512000));
    if (!draftKey && JSON.stringify(provider) !== JSON.stringify(this.providerBaseline())) throw new AiError(409, "AI_CONFIG_CHANGED", "接入配置已修改，请重新检查模型列表");
    if (!Array.isArray(root.data)) throw new AiError(502, "AI_MODELS_UNAVAILABLE", "服务商未返回模型列表，可核对文档后手动填写模型名称");
    const models = root.data.map(row => object(row).id).filter((id): id is string => typeof id === "string" && id.length < 160).slice(0, 500);
    const baiModels = new URL(baseUrl).hostname === "api.b.ai" ? filterBaiAgentModels(models) : undefined;
    if (baiModels && usingSavedChatKey && provider && isTongpinQuickAgent(provider.quickModel)) {
      const snapshot = provider;
      const checkedAt = new Date().toISOString();
      this.store.sql.transaction(() => {
        const current = this.store.provider();
        if (!current || current.modelConfigVersion !== snapshot.modelConfigVersion || current.modelKeyVersion !== snapshot.modelKeyVersion
          || current.baseUrl !== snapshot.baseUrl || current.encryptedKey !== snapshot.encryptedKey || !isTongpinQuickAgent(current.quickModel)) {
          throw new AiError(409, "AI_CONFIG_CHANGED", "接入配置已修改，请重新检查模型列表");
        }
        this.store.saveProvider({
          ...current,
          verifiedModelConfigVersion: current.modelConfigVersion,
          verifiedModelKeyVersion: current.modelKeyVersion,
          verifiedModels: baiModels,
          verifiedModelsAt: checkedAt,
        });
      });
      const quickCount = baiModels.filter(model => model !== BAI_ASTRA_MODEL).length;
      return {
        ok: true, models, availableModels: baiModels, modelsVerified: true, modelsVerifiedAt: checkedAt,
        message: `已读取并保存当前密钥可用的 Agent 模型：快速模型 ${quickCount} 个，Astra ${baiModels.includes(BAI_ASTRA_MODEL) ? "可用" : "不可用"}；未进行生成`,
      };
    }
    return {
      ok: true, models,
      ...(baiModels ? { availableModels: baiModels, modelsVerified: false } : {}),
      message: baiModels ? "已读取 B.AI 模型列表；保存配置后会使用已保存密钥绑定 Agent 可用模型，未进行生成" : "连接成功，已读取可用模型；未进行生成，不消耗成员额度",
    };
  }
  harnessSettings(): AiHarnessConfig | null { return this.harness.settings(); }
  saveHarness(value: unknown): Promise<AiHarnessConfig> { return this.harness.save(value); }
  discoverHarnessProvider(providerId: string) { return this.harness.discover(providerId); }
  observability(windowMinutes?: number): AiObservabilityDashboard { return this.store.observability(windowMinutes); }
  acknowledgeObservabilityAlert(alertId: string, actorId: string) { return this.store.acknowledgeObservabilityAlert(alertId, actorId); }
  harnessTrace(userId: string, requestId: string): AiHarnessTrace {
    const trace = this.harness.trace(userId, requestId);
    if (!trace) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    return trace;
  }
  async resumeHarnessRun(userId: string, requestId: string): Promise<AiHarnessTrace> {
    this.recover(userId);

    const settlePersistedContinuation = (): AiHarnessTrace | undefined => this.store.sql.transaction(() => {
      const state = this.harness.continuationState(userId, requestId);
      if (!state.requestId) return undefined;
      const decisionRequest = this.store.request(userId, state.requestId);
      if (!decisionRequest || decisionRequest.status === "pending") return this.harness.trace(userId, requestId);
      if (decisionRequest.status === "completed" && decisionRequest.result?.content) {
        const run = this.store.harnessRun(userId, requestId)!;
        const route = this.harness.resolve(run.tier, this.store.provider(), "chat");
        const allowed = route.capabilities.filter(capability => CONTINUATION_TOOLS.has(capability));
        try {
          return this.harness.finishContinuation(userId, requestId, state.requestId!, parseHarnessContinuationDecision(decisionRequest.result.content, allowed));
        } catch {
          return this.harness.failContinuation(userId, requestId, state.requestId!, "failed");
        }
      }
      return this.harness.failContinuation(userId, requestId, state.requestId, decisionRequest.status === "uncertain" ? "uncertain" : "failed");
    });

    const persisted = settlePersistedContinuation();
    if (persisted) return persisted;

    const claim = this.store.sql.transaction(() => {
      const trace = this.harness.resume(userId, requestId);
      if (trace.status !== "planned") return { trace };
      const run = this.store.harnessRun(userId, requestId)!;
      const route = this.harness.resolve(run.tier, this.store.provider(), "chat");
      const allowed = route.capabilities.filter(capability => CONTINUATION_TOOLS.has(capability));
      const continuationRequestId = crypto.randomUUID();
      this.harness.beginContinuation(userId, requestId, continuationRequestId);
      return { trace: this.harness.trace(userId, requestId)!, run, allowed, continuationRequestId };
    });
    if (!claim.continuationRequestId || !claim.run || !claim.allowed) return claim.trace;

    try {
      const decision = await this.chat(userId, {
        requestId: claim.continuationRequestId,
        conversationId: claim.run.conversationId,
        mode: claim.run.tier,
        skillIds: ["agent-continuation-v1"],
        messages: [{ role: "user", content: continuationPrompt(claim.trace, claim.allowed, this.harness.decisionContext(userId, requestId)) }],
      });
      const parsed = parseHarnessContinuationDecision(decision.content, claim.allowed);
      return this.store.sql.transaction(() => this.harness.finishContinuation(userId, requestId, claim.continuationRequestId!, parsed));
    } catch {
      // chat() persists a definitive/uncertain outcome before throwing. If it
      // could not even create the child request, failing the parent is safe;
      // a pending request is never replayed here.
      return this.store.sql.transaction(() => {
        const stored = this.store.request(userId, claim.continuationRequestId!);
        if (stored?.status === "pending") return this.harness.trace(userId, requestId)!;
        return this.harness.failContinuation(userId, requestId, claim.continuationRequestId!, stored?.status === "uncertain" ? "uncertain" : "failed");
      });
    }
  }
  /** Continue only persisted, server-planned model decisions. This never
   * executes a proposed tool: every paid or state-changing next step remains
   * waiting for the existing one-time approval flow. */
  async runBackgroundAgentCycle(limit = 4): Promise<AiBackgroundAgentCycle> {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(8, limit)) : 4;
    const candidates = this.store.backgroundHarnessCandidates(bounded);
    const result: AiBackgroundAgentCycle = { scanned: 0, resumed: 0, completed: 0, waitingApproval: 0, pending: 0, skippedInactive: 0, failed: 0 };
    let providerAttempts = 0;
    for (const candidate of candidates) {
      if (providerAttempts >= bounded) break;
      result.scanned += 1;
      try {
        // Re-authorize at every tick. A disabled/deleted/moved account must not
        // incur another provider call merely because an earlier session was valid.
        if (!await this.isBackgroundPrincipalActive(candidate.tenantId, candidate.userId)) {
          // Do not let an inactive oldest row starve active work every tick.
          // Re-enabled users can still resume it explicitly from the client.
          this.forTenant(candidate.tenantId).store.disableHarnessBackground(candidate.userId, candidate.requestId);
          result.skippedInactive += 1;
          continue;
        }
        providerAttempts += 1;
        const trace = await this.forTenant(candidate.tenantId).resumeHarnessRun(candidate.userId, candidate.requestId);
        result.resumed += 1;
        if (trace.status === "succeeded") result.completed += 1;
        else if (trace.status === "waiting_approval") result.waitingApproval += 1;
        else result.pending += 1;
      } catch {
        // One corrupt/configuration-failed tenant run cannot stop other tenants.
        result.failed += 1;
      }
    }
    return result;
  }
  cancelHarnessRun(userId: string, requestId: string): AiHarnessTrace { return this.harness.cancelWaitingRun(userId, requestId); }
  quota(userId: string): AiQuota { this.recover(userId); return this.store.quota(userId); }
  status(userId: string): AiStatus {
    const p = this.provider();
    const harness = this.harness.settings();
    const configured = harness
      ? harness.providers.some(provider => provider.enabled && provider.apiKeyConfigured) && AI_BUSINESS_TIERS.some(tier => harness.tiers[tier].enabled)
      : Boolean(p?.enabled && p.apiKeyConfigured);
    const harnessImageConfigured = Boolean(harness && AI_BUSINESS_TIERS.some(tier => {
      const route = harness.tiers[tier];
      const provider = harness.providers.find(item => item.id === route.imageProviderId);
      return route.enabled && route.capabilities.includes("image") && Boolean(route.imageModelId && provider?.enabled && provider.modelsVerified && provider.availableModels.includes(route.imageModelId));
    }));
    const quota = this.quota(userId);
    return { accessGranted: this.store.hasAccess(userId), configured, quickModel: "quick", deepModel: "deep", maxOutputTokens: harness?.tiers.quick.maxOutputTokens ?? p?.maxOutputTokens ?? 0, quota,
      availableTiers: harness ? AI_BUSINESS_TIERS.filter(tier => harness.tiers[tier].enabled) : ["quick", "deep"], quickAgent: Boolean(p && isTongpinQuickAgent(p.quickModel)),
      imageEnabled: Boolean(configured && p?.imageQuotaTokens && (this.store.harness() ? harnessImageConfigured : p.imageModel && p.imageApiKeyConfigured)), imageQuotaTokens: p?.imageQuotaTokens ?? 0,
      visionEnabled: Boolean(configured && (this.store.harness() ? AI_BUSINESS_TIERS.some(tier => harness!.tiers[tier].enabled && harness!.tiers[tier].capabilities.includes("vision")) : p?.visionEnabled)),
      webSearchEnabled: Boolean(configured && p?.webSearchEnabled && p.webSearchQuotaTokens && (this.store.harness() ? AI_BUSINESS_TIERS.some(tier => harness!.tiers[tier].enabled && harness!.tiers[tier].protocol === "responses" && harness!.tiers[tier].capabilities.includes("web_search")) : p.protocol === "responses")), webSearchQuotaTokens: p?.webSearchQuotaTokens ?? 0 };
  }
  members(users: MemberIdentity[]): AiMember[] { return users.map(user => ({ ...user, quota: this.quota(user.id) })); }
  memberUsage(userId: string) {
    return this.store.usage(userId).map(entry => ({ ...entry, model: entry.kind === "image" ? "图片生成" : entry.kind === "video" ? "视频生成" : entry.mode ? AI_BUSINESS_TIER_LABELS[entry.mode] : null }));
  }
  private chatSelection(request: AiChatRequest): { provider: StoredProvider; route: ResolvedHarnessRoute } {
    const saved = this.store.provider();
    let route = this.harness.resolve(request.mode, saved, requestCapability(request));
    let provider = this.harness.asProvider(route, saved);
    if (route.legacy) {
      if (!saved?.enabled) throw new AiError(503, "AI_NOT_CONFIGURED", "管理员尚未启用 AI 服务");
      provider = routeChatProvider(saved, request, isTongpinQuickAgent(saved.quickModel) ? verifiedBaiAgentModels(saved) : null);
      const deep = request.mode === "deep" || request.mode === "pro";
      route = { ...route, modelId: deep ? provider.deepModel : provider.quickModel, protocol: provider.protocol, maxOutputTokens: provider.maxOutputTokens, reasoningEffort: deep ? provider.reasoningEffort : "" };
    }
    if (request.webSearchMode === "auto") {
      const latestUserText = request.messages.filter(message => message.role === "user").at(-1)?.content ?? "";
      request.webSearch = Boolean((route.legacy || route.policy.strategy !== "direct") && route.policy.autoWebSearch && needsOnlineEvidence(latestUserText) && provider.protocol === "responses" && provider.webSearchEnabled && provider.webSearchQuotaTokens);
    }
    if (request.webSearch && (provider.protocol !== "responses" || !provider.webSearchEnabled || !provider.webSearchQuotaTokens)) throw new AiError(403, "AI_SEARCH_DISABLED", "管理员尚未启用联网搜索");
    if (request.attachments?.some(item => item.dataUrl) && !provider.visionEnabled) throw new AiError(403, "AI_VISION_DISABLED", "管理员尚未启用图片理解，请上传可提取文字的文档");
    return { provider, route };
  }
  private bindVideoTierParameters(request: AiChatRequest): void {
    if (request.outputFormat !== "video_plan" || !request.videoParameters) return;
    const model = this.video.bindPlanModel(request.mode, request.videoParameters.model);
    const parsed = parseChatCapabilities({ outputFormat: "video_plan", videoParameters: { ...request.videoParameters, model } });
    request.videoParameters = parsed.videoParameters!;
  }
  private chatPreflight(userId: string, request: AiChatRequest, provider: AiProviderConfig, persona: AiPersonaProfile, model: string): AiChatPreflight {
    const quota = this.store.quota(userId);
    const pendingRequests = this.store.pending(userId);
    const conversationId = validConversationId(request.conversationId, request.requestId);
    const activeVideos = this.store.activeVideoJobs(userId);
    const pending = pendingRequests.length + activeVideos.length >= 3
      || this.store.pendingForConversation(userId, conversationId).length > 0
      || this.store.activeVideoForConversation(userId, conversationId).length > 0;
    const budget = chatBudget(request, provider, quota, persona, model);
    const reason = budgetReason(budget, quota, pending);
    if (!request.webSearch) return { canSend: reason === null, reason, quota, budget };
    const ordinaryBudget = chatBudget({ ...request, webSearch: false }, provider, quota, persona, model);
    const ordinaryReason = budgetReason(ordinaryBudget, quota, pending);
    if (request.webSearchMode === "auto" && reason !== null && ordinaryReason === null) {
      request.webSearch = false;
      return { canSend: true, reason: null, quota, budget: ordinaryBudget };
    }
    return { canSend: reason === null, reason, quota, budget,
      withoutWebSearch: { canSend: ordinaryReason === null, reason: ordinaryReason, budget: ordinaryBudget } };
  }
  /** Does not decrypt credentials, recover/mutate requests, reserve quota or contact a provider. */
  preflight(userId: string, value: unknown): AiChatPreflight {
    this.store.assertAccess(userId);
    const request = parseChat(value);
    this.bindVideoTierParameters(request);
    const { provider, route } = this.chatSelection(request);
    const model = route.modelId;
    const persona = new AiPersonaRepository(this.store.sql).read(userId, this.store.tenantId).profile;
    return this.chatPreflight(userId, request, provider, persona, model);
  }
  getAsset(userId: string, assetId: string): AiImageAsset {
    const asset = this.store.asset(userId, assetId);
    if (!asset) throw new AiError(404, "AI_ASSET_NOT_FOUND", "图片不存在或已删除");
    return asset;
  }
  deleteAsset(userId: string, assetId: string): void { this.store.deleteAsset(userId, assetId); }
  private assertToolPlan(userId: string, planRequestId: string | undefined, kind: "image" | "video" | "presentation", prompt: string, contextFingerprint?: string): void {
    // Generation is a conversational tool call. Direct/legacy callers must not
    // bypass the model-authored plan and explicit member confirmation boundary.
    validateToolPlan(this.store, userId, planRequestId, kind, prompt, { contextFingerprint });
  }
  getRequestResult(userId: string, requestId: string): AiRequestResult {
    this.recover(userId);
    const request = this.store.request(userId, requestId);
    if (!request) throw new AiError(404, "AI_REQUEST_NOT_FOUND", "生成记录不存在");
    const quota = this.store.quota(userId);
    return { requestId, status: request.status, ...(request.result ? { result: { ...memberChatResult(request.result), model: AI_BUSINESS_TIER_LABELS[request.mode], quota } } : {}), ...(request.imageResult ? { imageResult: { ...request.imageResult, model: "图片生成", quota } } : {}), ...(request.error ? { error: request.error } : {}) };
  }
  setQuota(userId: string, actorId: string, body: unknown): AiQuota {
    const p = object(body);
    if (!Number.isSafeInteger(p.limitTokens) || Number(p.limitTokens) < 0 || Number(p.limitTokens) > MAX_TOKEN_LIMIT) throw new AiError(400, "AI_QUOTA_INVALID", "同频点总限额必须为 0 到 10 亿之间的整数");
    const reason = typeof p.reason === "string" ? p.reason.trim().slice(0, 240) : "管理员调整额度";
    this.recover(userId);
    return this.store.sql.transaction(() => {
      const q = this.store.quota(userId);
      if (Number(p.limitTokens) < q.usedTokens + q.reservedTokens) throw new AiError(409, "AI_QUOTA_BELOW_USED", "总额度不能低于已用与正在使用的额度之和");
      q.limitTokens = Number(p.limitTokens);
      this.store.saveQuota(userId, q);
      this.store.addUsage({ id: crypto.randomUUID(), userId, actorId, requestId: null, kind: "quota", status: "adjusted", model: null, mode: null, createdAt: new Date().toISOString(), reason, limitTokens: q.limitTokens, inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false });
      return this.store.quota(userId);
    });
  }
  private recover(userId: string): void {
    this.store.sql.transaction(() => {
      for (const request of this.store.pending(userId)) {
        if (request.expiresAt < Date.now()) {
          this.settle(request, conservativeUsage(request), "uncertain", "请求中断，按预留上限保守计入；请管理员核对服务商流水", undefined, new AiError(502, "AI_REQUEST_UNCERTAIN", "上次请求状态不确定，已记录预留用量，请联系管理员核对"));
          if (request.toolPlanRequestId) this.harness.finishApprovedTool(userId, request.toolPlanRequestId, request.kind === "image" ? "image" : "presentation", "uncertain");
        }
      }
    });
  }
  private settle(request: StoredRequest, usage: AiUsage, status: "completed" | "failed" | "uncertain", reason: string, content?: string, error?: AiError, extras?: Pick<AiChatResponse, "analysisSummary" | "presentation" | "toolPlan" | "toolClarification" | "dispatch" | "computerPlan" | "sources" | "trace">, images?: AiImageResponse["images"]): boolean {
    if (this.store.request(request.userId, request.requestId)?.status !== "pending") return false;
    if (!extras?.trace && this.store.harnessRun(request.userId, request.requestId)?.status === "running") {
      const trace = this.harness.finishRun(request.userId, request.requestId, status === "completed" ? "succeeded" : status);
      if (trace) extras = { ...extras, trace };
    }
    const q = this.store.quota(request.userId);
    q.reservedTokens = Math.max(0, q.reservedTokens - totalReserved(request));
    q.usedTokens += usage.totalTokens; q.inputTokens += usage.inputTokens; q.outputTokens += usage.outputTokens;
    request.status = status;
    if (content !== undefined) request.result = { requestId: request.requestId, model: AI_BUSINESS_TIER_LABELS[request.mode], content, usage, ...extras };
    if (extras?.toolPlan) request.toolPlanExpiresAt = toolPlanExpiry();
    if (images !== undefined) request.imageResult = { requestId: request.requestId, model: "图片生成", images, usage };
    if (error) request.error = { status: error.status, code: error.code, message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
    this.store.saveQuota(request.userId, q);
    this.store.saveRequest(request);
    this.store.addUsage({ id: crypto.randomUUID(), userId: request.userId, actorId: null, requestId: request.requestId, kind: request.kind ?? "chat", status, model: request.model, mode: request.mode, createdAt: new Date().toISOString(), reason, limitTokens: null, ...usage, ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    const run = this.store.harnessRun(request.userId, request.requestId);
    const capability = run?.capability ?? (request.kind === "image" ? "image" : "chat");
    const operation = request.kind === "image" || (capability === "presentation" && Boolean(request.toolPlanRequestId)) ? "execution" : capability === "image" || capability === "video" || capability === "presentation" || capability === "computer" ? "planning" : "execution";
    this.store.addObservability({ userId: request.userId, tier: request.mode, providerId: request.providerId ?? run?.providerId ?? "legacy", capability, operation, success: status === "completed", latencyMs: Date.now() - Date.parse(request.createdAt), ...(error ? { errorCode: error.code } : {}) });
    return true;
  }
  async chat(userId: string, value: unknown): Promise<AiChatResponse> {
    this.store.assertAccess(userId);
    const request = parseChat(value);
    this.bindVideoTierParameters(request);
    const { requestId: _requestId, ...hashable } = request;
    const hash = await requestHash(hashable);
    const plannedContextFingerprint = request.outputFormat === "image_plan" || request.outputFormat === "presentation_plan"
      ? await toolPlanContextFingerprint(request.projectContext, request.attachments)
      : undefined;
    const executionContextFingerprint = request.outputFormat === "presentation"
      ? await toolPlanContextFingerprint(request.projectContext, request.attachments)
      : undefined;
    this.recover(userId);
    const prior = this.store.request(userId, request.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new AiError(409, "AI_REQUEST_CONFLICT", "相同请求标识不能用于不同消息");
      if (prior.result) return { ...memberChatResult(prior.result), model: AI_BUSINESS_TIER_LABELS[prior.mode], quota: this.quota(userId) };
      if (prior.error) throw new AiError(prior.error.status, prior.error.code, prior.error.message, false, undefined, prior.error.diagnostic);
      throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "AI 正在处理这条消息，请稍候");
    }
    if (request.outputFormat === "presentation") {
      const prompt = request.messages.at(-1)?.content ?? "";
      this.assertToolPlan(userId, request.toolPlanRequestId, "presentation", prompt, executionContextFingerprint);
    }
    const { provider, route } = this.chatSelection(request);
    const key = await (await this.box()).decrypt(route.encryptedKey);
    const idempotencyKey = await providerIdempotencyKey(this.store.tenantId, userId, request.requestId, "chat");
    const model = route.modelId;
    const persona = new AiPersonaRepository(this.store.sql).read(userId, this.store.tenantId).profile;
    const reserved = this.store.sql.transaction(() => {
      // Recheck after asynchronous hashing / key decryption.
      if (this.store.request(userId, request.requestId)) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "AI 正在处理这条消息，请稍候");
      if (request.outputFormat === "presentation") {
        claimToolPlan(this.store, userId, request.toolPlanRequestId, "presentation", request.messages.at(-1)?.content ?? "", request.requestId, executionContextFingerprint);
        this.harness.beginApprovedTool(userId, request.toolPlanRequestId!, "presentation", request.requestId);
      }
      const preflight = this.chatPreflight(userId, request, provider, persona, model);
      requireChatBudget(preflight);
      const q = preflight.quota;
      // UTF-8 bytes plus protocol overhead is deliberately conservative, not a fake provider token count.
      const inputReserve = preflight.budget.inputReserve + preflight.budget.searchInputReserve;
      const convertedReserve = preflight.budget.convertedReserve;
      const outputReserve = preflight.budget.availableOutputTokens;
      const pending: StoredRequest = { requestId: request.requestId, userId, hash, status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + AI_TIMEOUT_MS + 30_000, inputReserve, outputReserve, convertedReserve, kind: "chat", model, mode: request.mode, conversationId: validConversationId(request.conversationId, request.requestId), providerId: route.providerId, ...(request.toolPlanRequestId ? { toolPlanRequestId: request.toolPlanRequestId } : {}), ...(plannedContextFingerprint ? { toolPlanContextFingerprint: plannedContextFingerprint } : {}) };
      q.reservedTokens += totalReserved(pending);
      this.store.saveQuota(userId, q); this.store.saveRequest(pending);
      pending.harnessRunId = this.harness.startRun(userId, request, route);
      this.store.saveRequest(pending);
      return pending;
    });
    let knownRejection = false;
    try {
      const response = await this.transport(`${provider.baseUrl}/${provider.protocol === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: provider.protocol === "responses" ? "text/event-stream, application/json" : "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(providerBody(provider, request, model, reserved.outputReserve, persona)), signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!response.ok) { knownRejection = isProviderRejection(response.status); throw await readProviderHttpError(response, "chat"); }
      const maxSearchCalls = request.webSearch ? searchCallLimit(provider) : 0;
      const result = parseProviderResult(await readProviderResponse(response, { maxSearchCalls }), provider.protocol);
      const publicExplanation = supportsPublicExplanation(request)
        ? parsePublicExplanation(result.content, request.mode)
        : { content: result.content };
      const validUsage = Boolean(result.usage && result.usage.inputTokens <= reserved.inputReserve && result.usage.outputTokens <= reserved.outputReserve && result.searchCalls <= maxSearchCalls);
      const convertedTokens = request.webSearch ? provider.webSearchQuotaTokens! * result.searchCalls : 0;
      const usage: AiUsage = validUsage ? { ...result.usage!, ...(request.webSearch ? { searchCalls: result.searchCalls, tokenUsageEstimated: false } : {}), ...(convertedTokens ? { convertedTokens, totalTokens: result.usage!.totalTokens + convertedTokens, estimated: true, billingKind: "tokens_with_search" } : {}) } : conservativeUsage(reserved);
      if (!publicExplanation.content.trim() || (result.status !== undefined && result.status !== "completed")) {
        const error = result.status === "incomplete"
          ? new AiError(502, "AI_RESPONSE_INCOMPLETE", "AI 未能完成回复，可能达到输出上限，请管理员调整模型或单次输出上限")
          : new AiError(502, "AI_EMPTY_RESPONSE", "AI 未返回完整可显示的文字，请检查模型及输出上限");
        this.store.sql.transaction(() => {
          const trace = this.harness.finishRun(userId, request.requestId, "uncertain");
          this.settle(reserved, usage, "uncertain", usage.estimated ? "生成未完成，用量不确定，按预留上限计入" : "生成未完成，按服务商实际 Token 用量计入", undefined, error, trace ? { trace } : undefined);
        });
        throw error;
      }
      if (request.webSearch && ((request.webSearchMode !== "auto" && result.searchCalls < 1) || result.searchCalls > maxSearchCalls || result.completedSearchCalls !== result.searchCalls)) {
        const error = new AiError(502, "AI_SEARCH_NOT_COMPLETED", "服务商未按要求完成联网搜索，请管理员检查模型支持；已记录生成用量");
        this.store.sql.transaction(() => {
          const trace = this.harness.finishRun(userId, request.requestId, "uncertain");
          this.settle(reserved, usage, "uncertain", "联网搜索执行不符合请求限制，已记录用量，请管理员核对", undefined, error, trace ? { trace } : undefined);
        });
        throw error;
      }
      let presentation: AiChatResponse["presentation"];
      let toolPlan: AiChatResponse["toolPlan"];
      let toolClarification: string | undefined;
      let dispatch: AiChatResponse["dispatch"];
      let computerPlan: AiChatResponse["computerPlan"];
      if (request.outputFormat === "dispatch") {
        try { dispatch = parseAiDispatchDecision(publicExplanation.content, request.mode); }
        catch (error) {
          const safe = error instanceof AiError ? error : new AiError(502, "AI_DISPATCH_INVALID", "同频 AI 返回的任务类型不正确");
          this.store.sql.transaction(() => this.settle(reserved, usage, validUsage ? "failed" : "uncertain", "任务分派结果未通过应用校验，已记录模型生成用量", undefined, safe));
          throw safe;
        }
      } else if (request.outputFormat === "presentation") {
        try { presentation = parsePresentation(publicExplanation.content); }
        catch (error) {
          const safe = error instanceof AiError ? error : new AiError(502, "AI_PRESENTATION_INVALID", "演示文稿结构不正确");
          this.store.sql.transaction(() => this.settle(reserved, usage, validUsage ? "failed" : "uncertain", "演示文稿格式未通过验证，已记录服务商生成用量", undefined, safe));
          throw safe;
        }
      } else if (request.outputFormat === "image_plan" || request.outputFormat === "video_plan" || request.outputFormat === "presentation_plan") {
        try {
          toolClarification = parseToolClarification(publicExplanation.content);
          if (!toolClarification) toolPlan = {
            ...parseToolPlan(publicExplanation.content, request.outputFormat === "image_plan" ? "image" : request.outputFormat === "video_plan" ? "video" : "presentation"),
            ...(request.outputFormat === "video_plan" ? { videoParameters: request.videoParameters! } : {}),
          };
        }
        catch (error) {
          const safe = error instanceof AiError ? error : new AiError(502, "AI_TOOL_PLAN_INVALID", "同频 AI 返回的工具方案不正确");
          this.store.sql.transaction(() => this.settle(reserved, usage, validUsage ? "failed" : "uncertain", "工具方案未通过应用校验，已记录模型生成用量", undefined, safe));
          throw safe;
        }
      } else if (request.outputFormat === "computer_plan") {
        try { computerPlan = parseComputerPlan(publicExplanation.content); }
        catch (error) {
          const safe = error instanceof AiError ? error : new AiError(502, "AI_COMPUTER_PLAN_INVALID", "同频 AI 返回的本机操作方案不正确");
          this.store.sql.transaction(() => this.settle(reserved, usage, validUsage ? "failed" : "uncertain", "本机操作方案未通过应用校验，已记录模型生成用量", undefined, safe));
          throw safe;
        }
      }
      const content = dispatch
        ? dispatch.kind === "text" ? dispatch.content : dispatch.clarification ?? ""
        : toolClarification ?? (presentation ? `已生成《${presentation.title}》，共 ${presentation.slides.length} 页。` : toolPlan ? `已整理${toolPlan.kind === "video" ? "视频" : toolPlan.kind === "image" ? "图片" : "PPT"}任务，请确认后生成。` : computerPlan ? "已整理一个本机操作，请在系统确认框中核对。" : publicExplanation.content);
      const toolCapability = toolPlan ? toolPlan.kind === "image" ? "image" : toolPlan.kind === "video" ? "video" : "presentation" : computerPlan ? "computer" : undefined;
      const toolSummary = toolPlan?.summary ?? computerPlan?.summary;
      const dispatchSummary = dispatch?.kind === "text" ? dispatch.analysisSummary : undefined;
      const extras: Pick<AiChatResponse, "analysisSummary" | "presentation" | "toolPlan" | "toolClarification" | "dispatch" | "computerPlan" | "sources" | "trace"> = { ...(toolClarification ? { toolClarification } : {}), ...(dispatch ? { dispatch } : {}), ...(dispatchSummary || publicExplanation.analysisSummary ? { analysisSummary: dispatchSummary ?? publicExplanation.analysisSummary } : {}), ...(presentation ? { presentation } : {}), ...(toolPlan ? { toolPlan } : {}), ...(computerPlan ? { computerPlan } : {}), ...(result.sources.length ? { sources: result.sources } : {}) };
      const settled = this.store.sql.transaction(() => {
        const trace = this.harness.finishRun(userId, request.requestId, validUsage ? "succeeded" : "uncertain", toolCapability ? { capability: toolCapability, summary: toolSummary } : undefined);
        if (trace) extras.trace = trace;
        return this.settle(reserved, usage, validUsage ? "completed" : "uncertain", validUsage ? convertedTokens ? `服务商实际生成 Token + ${result.searchCalls} 次搜索的管理员设定折算额度` : "服务商实际 Token 用量" : "服务商未返回有效 Token 用量或报告超过请求上限，按预留上限保守计入，请管理员核对", content, undefined, extras);
      });
      if (!settled) {
        const final = this.store.request(userId, request.requestId);
        if (final?.result) return { ...memberChatResult(final.result), model: AI_BUSINESS_TIER_LABELS[final.mode], quota: this.store.quota(userId) };
        throw new AiError(final?.error?.status ?? 502, final?.error?.code ?? "AI_REQUEST_UNCERTAIN", final?.error?.message ?? "请求已按中断记录，请管理员核对用量");
      }
      if (request.outputFormat === "presentation" && request.toolPlanRequestId) this.store.sql.transaction(() => this.harness.finishApprovedTool(userId, request.toolPlanRequestId!, "presentation", validUsage ? "succeeded" : "uncertain"));
      return { ...memberChatResult({ requestId: request.requestId, content, model: AI_BUSINESS_TIER_LABELS[request.mode], usage, ...extras }), quota: this.store.quota(userId) };
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "AI 服务连接失败或超时，请稍后重试；不确定用量已记录，请管理员核对");
      this.availabilityProbe.invalidate("chat");
      knownRejection ||= safe.definitelyNotSent;
      const usage = knownRejection ? { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } : conservativeUsage(reserved);
      this.store.sql.transaction(() => {
        if (this.store.request(userId, request.requestId)?.status === "pending") {
          const trace = this.harness.finishRun(userId, request.requestId, knownRejection ? "failed" : "uncertain");
          this.settle(reserved, usage, knownRejection ? "failed" : "uncertain", knownRejection ? "请求未发出或被服务商拒绝，预留额度已释放" : "结果或用量不确定，按预留上限保守计入", undefined, safe, trace ? { trace } : undefined);
        }
        if (request.outputFormat === "presentation" && request.toolPlanRequestId) this.harness.finishApprovedTool(userId, request.toolPlanRequestId, "presentation", knownRejection ? "failed" : "uncertain");
      });
      throw safe;
    }
  }
  async generateImage(userId: string, value: unknown): Promise<AiImageResponse> {
    this.store.assertAccess(userId);
    const request = parseImageRequest(value);
    const contextFingerprint = await toolPlanContextFingerprint(request.projectContext, request.attachments);
    const hash = await requestHash({ kind: "image", prompt: request.prompt, planRequestId: request.planRequestId, conversationId: request.conversationId, projectContext: request.projectContext, attachments: request.attachments });
    this.recover(userId);
    const prior = this.store.request(userId, request.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new AiError(409, "AI_REQUEST_CONFLICT", "相同请求标识不能用于不同任务");
      if (prior.imageResult) return { ...prior.imageResult, model: "图片生成", quota: this.quota(userId) };
      if (prior.error) throw new AiError(prior.error.status, prior.error.code, prior.error.message, false, undefined, prior.error.diagnostic);
      throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "图片正在生成，请稍候");
    }
    this.assertToolPlan(userId, request.planRequestId, "image", request.prompt, contextFingerprint);
    const provider = this.store.provider();
    const planRun = this.store.harnessRun(userId, request.planRequestId!);
    const tier = planRun?.tier ?? "quick";
    const mediaRoute = this.harness.resolveMedia(tier, provider, "image");
    if (!provider?.imageQuotaTokens) throw new AiError(503, "AI_IMAGE_DISABLED", "管理员尚未设置图片生成折算额度");
    if (!mediaRoute && (!provider.enabled || !provider.imageModel)) throw new AiError(503, "AI_IMAGE_DISABLED", "管理员尚未配置图片生成服务");
    const baseUrl = mediaRoute?.baseUrl ?? (provider.imageBaseUrl || provider.baseUrl);
    const encryptedKey = mediaRoute?.encryptedKey ?? (provider.imageBaseUrl ? provider.encryptedImageKey : provider.encryptedKey);
    if (!encryptedKey) throw new AiError(503, "AI_IMAGE_DISABLED", "管理员尚未配置图片生成密钥");
    const key = await (await this.box()).decrypt(encryptedKey);
    const idempotencyKey = await providerIdempotencyKey(this.store.tenantId, userId, request.requestId, "image");
    const model = mediaRoute?.modelId ?? provider.imageModel!;
    const reserved = this.store.sql.transaction(() => {
      const conversationId = validConversationId(request.conversationId, request.requestId);
      const pendingForUser = this.store.pending(userId);
      const activeVideos = this.store.activeVideoJobs(userId);
      const atUserLimit = pendingForUser.length + activeVideos.length >= 3;
      if (this.store.request(userId, request.requestId) || atUserLimit || this.store.pendingForConversation(userId, conversationId).length || this.store.activeVideoForConversation(userId, conversationId).length) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", atUserLimit ? "当前已有 3 条任务并行处理，请等待任意一条完成" : "当前对话已有一条 AI 请求正在处理，请稍候");
      claimToolPlan(this.store, userId, request.planRequestId, "image", request.prompt, request.requestId, contextFingerprint);
      this.harness.beginApprovedTool(userId, request.planRequestId!, "image", request.requestId);
      if (this.store.activeImageCount() >= 3) throw new AiError(429, "AI_CAPACITY_BUSY", "图片生成任务较多，请稍后重试，本次未扣除额度");
      const quota = this.store.quota(userId);
      if (quota.remainingTokens < provider.imageQuotaTokens!) throw new AiError(402, "AI_QUOTA_EXHAUSTED", "可用额度不足以生成一张图片，请联系管理员增加额度");
      // Reserve room for the largest accepted image before sending a potentially paid generation.
      this.store.assertAssetCapacity(userId, 4 * 1024 * 1024);
      const pending: StoredRequest = { requestId: request.requestId, userId, hash, kind: "image", status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + AI_TIMEOUT_MS + 30_000, inputReserve: 0, outputReserve: 0, convertedReserve: provider.imageQuotaTokens!, model, mode: tier, conversationId, providerId: mediaRoute?.providerId ?? (provider.imageBaseUrl ? "image" : "legacy"), toolPlanRequestId: request.planRequestId };
      quota.reservedTokens += totalReserved(pending);
      this.store.saveQuota(userId, quota); this.store.saveRequest(pending);
      return pending;
    });
    let knownRejection = false;
    try {
      const response = await this.transport(`${baseUrl}/images/generations`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: provider.imageStream ? "text/event-stream, application/json" : "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(imageProviderBody({ ...provider, imageModel: model }, request.prompt)),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS), maxResponseBytes: MAX_IMAGE_RESPONSE_BYTES,
      });
      if (!response.ok) { knownRejection = isProviderRejection(response.status); throw await readProviderHttpError(response, "image"); }
      const body = object(await readImageProviderResponse(response));
      if (!Array.isArray(body.data) || body.data.length !== 1) throw new AiError(502, "AI_IMAGE_INVALID", "服务商没有返回一张有效图片");
      const item = object(body.data[0]);
      // Never fetch provider-supplied URLs. An incompatible provider must support base64 explicitly.
      if (!item.b64_json) throw new AiError(502, "AI_IMAGE_FORMAT_UNSUPPORTED", "图片服务需支持 b64_json 返回格式；不会自动下载不明图片地址");
      const image = validateImageBase64(item.b64_json);
      const usage = conservativeUsage(reserved);
      const result = this.store.sql.transaction(() => {
        const current = this.store.request(userId, request.requestId);
        if (current?.status !== "pending") {
          if (current?.imageResult) return { ...current.imageResult, model: "图片生成", quota: this.store.quota(userId) };
          throw new AiError(current?.error?.status ?? 502, current?.error?.code ?? "AI_REQUEST_UNCERTAIN", current?.error?.message ?? "图片请求已按中断记录，请管理员核对用量");
        }
        const asset = this.store.saveAsset(userId, image.mimeType, image.base64, image.byteLength);
        this.settle(reserved, usage, "completed", "按管理员设定的每张图片额度折算；不是服务商实际输入或输出 Token", undefined, undefined, undefined, [asset]);
        this.harness.finishApprovedTool(userId, request.planRequestId!, "image", "succeeded");
        return { requestId: request.requestId, model: "图片生成", images: [asset], usage, quota: this.store.quota(userId) };
      });
      return result;
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "图片生成连接中断或超时，请管理员核对服务商用量");
      this.availabilityProbe.invalidate("image");
      knownRejection ||= safe.definitelyNotSent;
      const usage: AiUsage = knownRejection ? { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } : conservativeUsage(reserved);
      this.store.sql.transaction(() => {
        this.settle(reserved, usage, knownRejection ? "failed" : "uncertain", knownRejection ? "图片请求未发出或被服务商拒绝，已释放预留额度" : "图片结果不确定，已记录预留折算额度，请管理员核对", undefined, safe);
        this.harness.finishApprovedTool(userId, request.planRequestId!, "image", knownRejection ? "failed" : "uncertain");
      });
      throw safe;
    }
  }
}
