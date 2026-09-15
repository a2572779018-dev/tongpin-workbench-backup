import type { AiChatBudget, AiChatPreflight, AiChatPreflightReason, AiChatRequest, AiChatResponse, AiImageAsset, AiImageRequest, AiImageResponse, AiMember, AiProviderConfig, AiProviderInput, AiProviderTestResult, AiQuota, AiRequestResult, AiStatus, AiUsage } from "../../shared/ai";
import { AiError, safeBaseUrl, type SecretBox } from "./security";
import { AiStore, type StoredProvider, type StoredRequest } from "./storage";
import { AI_TIMEOUT_MS, isProviderRejection, object, parseProviderResult, providerBody, readProviderHttpError, readBoundedJson, readProviderResponse, type AiTransport } from "./provider";
import { chatInputReserve, parseChatCapabilities, parsePresentation, validateImageBase64 } from "./capabilities";
import { AiPersonaRepository } from "./persona";
import type { AiPersonaProfile } from "../../shared/aiPersona";
import { imageProviderBody, MAX_IMAGE_RESPONSE_BYTES, readImageProviderResponse } from "./imageProvider";
import { searchCallLimit } from "./searchPolicy";
import { AiVideoService } from "./videoService";
import { AvailabilityProbe } from "./availability";
import { routeChatProvider } from "./autoRouting";
import { BAI_QUICK_AUTO } from "../../shared/aiAuto";
import type { AiAvailability } from "../../shared/ai";

type MemberIdentity = Omit<AiMember, "quota">;
const MAX_TOKEN_LIMIT = 1_000_000_000;
// search_context_size=low is a size preference, not a contractual token ceiling.
// Keep the existing conservative allowance until a provider supplies a verifiable cap.
const SEARCH_INPUT_RESERVE = 32768;
const MIN_OUTPUT_TOKENS = 16;

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
  if (reason === "request_in_progress") throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "该账号已有一条 AI 请求正在处理，请稍候", true, preflight);
  if (reason === "quota_exhausted") throw new AiError(402, "AI_QUOTA_EXHAUSTED", "可用同频点已用完，请联系管理员增加额度", true, preflight);
  if (reason === "search_quota_insufficient") throw new AiError(402, "AI_SEARCH_QUOTA_INSUFFICIENT", "当前余额不足以预留本次联网搜索所需额度；尚未发送，也未扣费", true, preflight);
  if (reason === "quota_insufficient") throw new AiError(402, "AI_QUOTA_INSUFFICIENT", "当前仍有余额，但不足以预留本次对话所需额度；请缩短对话或联系管理员", true, preflight);
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new AiError(400, "AI_INPUT_INVALID", `${name}格式不正确`);
  return value.trim();
}
function parseProvider(value: unknown, existing: StoredProvider | null): AiProviderInput {
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
  if (webSearchEnabled && (protocol !== "responses" || !webSearchQuotaTokens)) throw new AiError(400, "AI_SEARCH_CONFIG_INVALID", "联网搜索需使用 Responses 协议，并设置每次搜索的折算额度");
  if (!imageBaseUrl && typeof p.imageApiKey === "string" && p.imageApiKey.trim()) throw new AiError(400, "AI_INPUT_INVALID", "填写独立图片密钥时，还需填写图片 API 地址");
  if (p.quickModel === BAI_QUICK_AUTO && new URL(safeBaseUrl(p.baseUrl)).hostname !== "api.b.ai") throw new AiError(400, "AI_AUTO_PROVIDER_INVALID", "当前自动模式仅支持 B.AI");
  return {
    name: text(p.name ?? "AI 服务", "服务名称", 80), baseUrl: safeBaseUrl(p.baseUrl), protocol,
    quickModel: text(p.quickModel, "快速模型", 160), deepModel: p.quickModel === BAI_QUICK_AUTO ? "gpt-6-astra" : text(p.deepModel, "深度模型", 160),
    maxOutputTokens: Number(p.maxOutputTokens), reasoningEffort: (p.reasoningEffort ?? "") as AiProviderInput["reasoningEffort"], enabled: p.enabled,
    imageModel, imageBaseUrl, imageQuotaTokens: Number(imageQuotaTokens), imageStream, visionEnabled, visionInputReserveTokens: Number(visionInputReserveTokens), webSearchEnabled, webSearchQuotaTokens: Number(webSearchQuotaTokens), webSearchProtocol,
    ...(typeof p.apiKey === "string" && p.apiKey.trim() ? { apiKey: text(p.apiKey, "API 密钥", 4096) } : {}),
    ...(typeof p.imageApiKey === "string" && p.imageApiKey.trim() ? { imageApiKey: text(p.imageApiKey, "图片 API 密钥", 4096) } : {}),
  };
}
function parseChat(value: unknown): AiChatRequest {
  const p = object(value);
  if (typeof p.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(p.requestId)) throw new AiError(400, "AI_REQUEST_ID_INVALID", "请求标识无效，请刷新后重试");
  if (p.mode !== "quick" && p.mode !== "deep") throw new AiError(400, "AI_INPUT_INVALID", "请选择快速或深度模式");
  if (!Array.isArray(p.messages) || !p.messages.length || p.messages.length > 64) throw new AiError(400, "AI_CONTEXT_TOO_LONG", "对话过长，请新建对话");
  const messages: AiChatRequest["messages"] = p.messages.map(value => {
    const item = object(value);
    if (item.role !== "user" && item.role !== "assistant") throw new AiError(400, "AI_INPUT_INVALID", "消息角色不正确");
    if (typeof item.content !== "string" || !item.content.trim() || item.content.length > 24000) throw new AiError(400, "AI_CONTEXT_TOO_LONG", "消息为空或过长，请缩短后重试");
    return { role: item.role, content: item.content };
  });
  if (messages[messages.length - 1].role !== "user") throw new AiError(400, "AI_INPUT_INVALID", "最后一条消息必须是你的提问");
  const capabilities = parseChatCapabilities(p);
  const textContext = { messages, projectContext: capabilities.projectContext, attachments: capabilities.attachments?.map(({ dataUrl: _image, ...text }) => text) };
  if (new TextEncoder().encode(JSON.stringify(textContext)).length > 64000) throw new AiError(400, "AI_CONTEXT_TOO_LONG", "对话与资料合计过长，请减少附件或新建对话");
  return { requestId: p.requestId, mode: p.mode, messages, ...capabilities };
}
function parseImageRequest(value: unknown): AiImageRequest {
  const p = object(value);
  if (typeof p.requestId !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(p.requestId)) throw new AiError(400, "AI_REQUEST_ID_INVALID", "请求标识无效，请刷新后重试");
  if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.length > 12000 || /\u0000/.test(p.prompt)) throw new AiError(400, "AI_INPUT_INVALID", "请填写 12000 字以内的图片描述");
  return { requestId: p.requestId, prompt: p.prompt.trim() };
}
function totalReserved(request: StoredRequest): number { return request.inputReserve + request.outputReserve + (request.convertedReserve ?? 0); }
function conservativeUsage(request: StoredRequest): AiUsage {
  return { inputTokens: request.inputReserve, outputTokens: request.outputReserve, totalTokens: totalReserved(request), estimated: true,
    ...(request.convertedReserve ? { convertedTokens: request.convertedReserve, billingKind: request.kind === "image" ? "image_conversion" as const : "tokens_with_search" as const } : {}),
  };
}
async function requestHash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, "0")).join("");
}
export class AiService {
  readonly video: AiVideoService;
  private readonly availabilityProbe: AvailabilityProbe;
  constructor(readonly store: AiStore, private readonly box: () => Promise<SecretBox>, private readonly transport: AiTransport, videoKey?: () => string) {
    this.video = new AiVideoService(store, box, transport, videoKey);
    this.availabilityProbe = new AvailabilityProbe(transport, box);
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
    const provider = this.store.provider()!;
    const baseUrl = target === "image" && provider.imageBaseUrl ? provider.imageBaseUrl : provider.baseUrl;
    const key = target === "image" && provider.imageBaseUrl ? provider.encryptedImageKey! : provider.encryptedKey;
    const check = await this.availabilityProbe.check(target, baseUrl, key);
    if (JSON.stringify(provider) !== JSON.stringify(this.store.provider())) throw new AiError(409, "AI_CONFIG_CHANGED", "服务配置已更改，请重新检测。");
    // Re-read account state after awaiting the shared probe. Never cache member permissions/quota.
    const current = this.status(userId);
    if (!current.accessGranted || current.quota.remainingTokens <= 0) return { status: current, check: { state: "unavailable", code: "AI_QUOTA_EXHAUSTED", message: "当前没有可用额度，请联系管理员。", checkedAt: new Date().toISOString() } };
    return { status: current, check };
  }
  provider(): AiProviderConfig | null {
    const p = this.store.provider();
    if (!p) return null;
    const { encryptedKey: _encrypted, encryptedImageKey: _imageKey, ...safe } = p;
    return { ...safe, imageApiKeyConfigured: Boolean(p.imageBaseUrl ? p.encryptedImageKey : p.encryptedKey) };
  }
  async saveProvider(value: unknown): Promise<AiProviderConfig> {
    const existing = this.store.provider();
    const parsed = parseProvider(value, existing);
    if (!parsed.apiKey && (!existing?.encryptedKey || existing.baseUrl !== parsed.baseUrl)) throw new AiError(400, "AI_KEY_REQUIRED", "首次接入或更换 API 地址时，请重新填写 API 密钥");
    if (parsed.imageBaseUrl && !parsed.imageApiKey && (!existing?.encryptedImageKey || existing.imageBaseUrl !== parsed.imageBaseUrl)) throw new AiError(400, "AI_IMAGE_KEY_REQUIRED", "首次接入或更换图片 API 地址时，请重新填写图片密钥");
    const { apiKey, imageApiKey, ...config } = parsed;
    const encryptedKey = apiKey ? await (await this.box()).encrypt(apiKey) : existing!.encryptedKey;
    const encryptedImageKey = config.imageBaseUrl ? imageApiKey ? await (await this.box()).encrypt(imageApiKey) : existing!.encryptedImageKey : undefined;
    // Do not let concurrent configuration saves pair a different host with an old key.
    this.store.sql.transaction(() => {
      const current = this.store.provider();
      if (!apiKey && (current?.baseUrl !== config.baseUrl || current?.encryptedKey !== existing?.encryptedKey)) throw new AiError(409, "AI_CONFIG_CHANGED", "配置刚刚被修改，请重新填写密钥后保存");
      if (config.imageBaseUrl && !imageApiKey && (current?.imageBaseUrl !== config.imageBaseUrl || current?.encryptedImageKey !== existing?.encryptedImageKey)) throw new AiError(409, "AI_CONFIG_CHANGED", "图片配置刚刚被修改，请重新填写图片密钥后保存");
      this.store.saveProvider({ ...config, encryptedKey, ...(encryptedImageKey ? { encryptedImageKey } : {}), apiKeyConfigured: true, imageApiKeyConfigured: Boolean(encryptedImageKey || !config.imageBaseUrl), updatedAt: new Date().toISOString() });
    });
    return this.provider()!;
  }
  async testProvider(value?: unknown): Promise<AiProviderTestResult> {
    const provider = this.store.provider();
    const draft = object(value);
    if (draft.target !== undefined && draft.target !== "chat" && draft.target !== "image") throw new AiError(400, "AI_INPUT_INVALID", "接口测试目标不正确");
    const savedBase = draft.target === "image" && provider?.imageBaseUrl ? provider.imageBaseUrl : provider?.baseUrl;
    const savedKey = draft.target === "image" && provider?.imageBaseUrl ? provider.encryptedImageKey : provider?.encryptedKey;
    if (draft.apiKey !== undefined && typeof draft.apiKey !== "string") throw new AiError(400, "AI_INPUT_INVALID", "API 密钥格式不正确");
    const baseUrl = draft.baseUrl !== undefined ? safeBaseUrl(draft.baseUrl) : savedBase;
    if (!baseUrl) throw new AiError(400, "AI_NOT_CONFIGURED", "请先填写 API 地址和密钥");
    const draftKey = typeof draft.apiKey === "string" && draft.apiKey.trim() ? text(draft.apiKey, "API 密钥", 4096) : "";
    if (!draftKey && (!savedKey || savedBase !== baseUrl)) throw new AiError(400, "AI_KEY_REQUIRED", "首次接入或更换 API 地址时，请填写 API 密钥");
    const key = draftKey || await (await this.box()).decrypt(savedKey!);
    let response: Response;
    try { response = await this.transport(`${baseUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) }); }
    catch (error) { if (error instanceof AiError) throw error; throw new AiError(502, "AI_CONNECTION_FAILED", "无法连接 AI 服务，请检查公网 API 地址和网络"); }
    if (!response.ok) throw await readProviderHttpError(response, "models");
    const root = object(await readBoundedJson(response, 512000));
    if (!Array.isArray(root.data)) throw new AiError(502, "AI_MODELS_UNAVAILABLE", "服务商未返回模型列表，可核对文档后手动填写模型名称");
    const models = root.data.map(row => object(row).id).filter((id): id is string => typeof id === "string" && id.length < 160).slice(0, 500);
    return { ok: true, models, message: "连接成功，已读取可用模型；未进行生成，不消耗成员额度" };
  }
  quota(userId: string): AiQuota { this.recover(userId); return this.store.quota(userId); }
  status(userId: string): AiStatus {
    const p = this.provider();
    const configured = Boolean(p?.enabled && p.apiKeyConfigured);
    const quota = this.quota(userId);
    return { accessGranted: this.store.hasAccess(userId), configured, quickModel: p?.quickModel ?? "", deepModel: p?.deepModel ?? "", maxOutputTokens: p?.maxOutputTokens ?? 0, quota,
      imageEnabled: Boolean(configured && p?.imageModel && p.imageQuotaTokens && p.imageApiKeyConfigured), imageQuotaTokens: p?.imageQuotaTokens ?? 0,
      visionEnabled: Boolean(configured && p?.visionEnabled), webSearchEnabled: Boolean(configured && p?.protocol === "responses" && p.webSearchEnabled && p.webSearchQuotaTokens), webSearchQuotaTokens: p?.webSearchQuotaTokens ?? 0 };
  }
  members(users: MemberIdentity[]): AiMember[] { return users.map(user => ({ ...user, quota: this.quota(user.id) })); }
  private chatProvider(request: AiChatRequest): StoredProvider {
    const saved = this.store.provider();
    if (!saved?.enabled) throw new AiError(503, "AI_NOT_CONFIGURED", "管理员尚未启用 AI 服务");
    const provider = routeChatProvider(saved, request);
    if (request.webSearchMode === "auto") request.webSearch = Boolean(provider.protocol === "responses" && provider.webSearchEnabled && provider.webSearchQuotaTokens);
    if (request.webSearch && (provider.protocol !== "responses" || !provider.webSearchEnabled || !provider.webSearchQuotaTokens)) throw new AiError(403, "AI_SEARCH_DISABLED", "管理员尚未启用联网搜索");
    if (request.attachments?.some(item => item.dataUrl) && !provider.visionEnabled) throw new AiError(403, "AI_VISION_DISABLED", "管理员尚未启用图片理解，请上传可提取文字的文档");
    return provider;
  }
  private chatPreflight(userId: string, request: AiChatRequest, provider: AiProviderConfig, persona: AiPersonaProfile, model: string): AiChatPreflight {
    const quota = this.store.quota(userId);
    const pending = this.store.pending(userId).length > 0;
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
    const provider = this.chatProvider(request);
    const model = request.mode === "deep" ? provider.deepModel : provider.quickModel;
    const persona = new AiPersonaRepository(this.store.sql).read(userId).profile;
    return this.chatPreflight(userId, request, provider, persona, model);
  }
  getAsset(userId: string, assetId: string): AiImageAsset {
    const asset = this.store.asset(userId, assetId);
    if (!asset) throw new AiError(404, "AI_ASSET_NOT_FOUND", "图片不存在或已删除");
    return asset;
  }
  deleteAsset(userId: string, assetId: string): void { this.store.deleteAsset(userId, assetId); }
  getRequestResult(userId: string, requestId: string): AiRequestResult {
    this.recover(userId);
    const request = this.store.request(userId, requestId);
    if (!request) throw new AiError(404, "AI_REQUEST_NOT_FOUND", "生成记录不存在");
    const quota = this.store.quota(userId);
    return { requestId, status: request.status, ...(request.result ? { result: { ...request.result, quota } } : {}), ...(request.imageResult ? { imageResult: { ...request.imageResult, quota } } : {}), ...(request.error ? { error: request.error } : {}) };
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
        if (request.expiresAt < Date.now()) this.settle(request, conservativeUsage(request), "uncertain", "请求中断，按预留上限保守计入；请管理员核对服务商流水", undefined, new AiError(502, "AI_REQUEST_UNCERTAIN", "上次请求状态不确定，已记录预留用量，请联系管理员核对"));
      }
    });
  }
  private settle(request: StoredRequest, usage: AiUsage, status: "completed" | "failed" | "uncertain", reason: string, content?: string, error?: AiError, extras?: Pick<AiChatResponse, "presentation" | "sources">, images?: AiImageResponse["images"]): boolean {
    if (this.store.request(request.userId, request.requestId)?.status !== "pending") return false;
    const q = this.store.quota(request.userId);
    q.reservedTokens = Math.max(0, q.reservedTokens - totalReserved(request));
    q.usedTokens += usage.totalTokens; q.inputTokens += usage.inputTokens; q.outputTokens += usage.outputTokens;
    request.status = status;
    if (content !== undefined) request.result = { requestId: request.requestId, model: request.model, content, usage, ...extras };
    if (images !== undefined) request.imageResult = { requestId: request.requestId, model: request.model, images, usage };
    if (error) request.error = { status: error.status, code: error.code, message: error.message, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) };
    this.store.saveQuota(request.userId, q);
    this.store.saveRequest(request);
    this.store.addUsage({ id: crypto.randomUUID(), userId: request.userId, actorId: null, requestId: request.requestId, kind: request.kind ?? "chat", status, model: request.model, mode: request.mode, createdAt: new Date().toISOString(), reason, limitTokens: null, ...usage, ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}) });
    return true;
  }
  async chat(userId: string, value: unknown): Promise<AiChatResponse> {
    this.store.assertAccess(userId);
    const request = parseChat(value);
    const { requestId: _requestId, ...hashable } = request;
    const hash = await requestHash(hashable);
    this.recover(userId);
    const prior = this.store.request(userId, request.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new AiError(409, "AI_REQUEST_CONFLICT", "相同请求标识不能用于不同消息");
      if (prior.result) return { ...prior.result, quota: this.quota(userId) };
      if (prior.error) throw new AiError(prior.error.status, prior.error.code, prior.error.message, false, undefined, prior.error.diagnostic);
      throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "AI 正在处理这条消息，请稍候");
    }
    const provider = this.chatProvider(request);
    const key = await (await this.box()).decrypt(provider.encryptedKey);
    const model = request.mode === "deep" ? provider.deepModel : provider.quickModel;
    const persona = new AiPersonaRepository(this.store.sql).read(userId).profile;
    const reserved = this.store.sql.transaction(() => {
      // Recheck after asynchronous hashing / key decryption.
      if (this.store.request(userId, request.requestId)) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "AI 正在处理这条消息，请稍候");
      const preflight = this.chatPreflight(userId, request, provider, persona, model);
      requireChatBudget(preflight);
      const q = preflight.quota;
      // UTF-8 bytes plus protocol overhead is deliberately conservative, not a fake provider token count.
      const inputReserve = preflight.budget.inputReserve + preflight.budget.searchInputReserve;
      const convertedReserve = preflight.budget.convertedReserve;
      const outputReserve = preflight.budget.availableOutputTokens;
      const pending: StoredRequest = { requestId: request.requestId, userId, hash, status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + AI_TIMEOUT_MS + 30_000, inputReserve, outputReserve, convertedReserve, kind: "chat", model, mode: request.mode };
      q.reservedTokens += totalReserved(pending);
      this.store.saveQuota(userId, q); this.store.saveRequest(pending);
      return pending;
    });
    let knownRejection = false;
    try {
      const response = await this.transport(`${provider.baseUrl}/${provider.protocol === "responses" ? "responses" : "chat/completions"}`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: provider.protocol === "responses" ? "text/event-stream, application/json" : "application/json", "Idempotency-Key": `${userId}:${request.requestId}` },
        body: JSON.stringify(providerBody(provider, request, model, reserved.outputReserve, persona)), signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!response.ok) { knownRejection = isProviderRejection(response.status); throw await readProviderHttpError(response, "chat"); }
      const maxSearchCalls = request.webSearch ? searchCallLimit(provider) : 0;
      const result = parseProviderResult(await readProviderResponse(response, { maxSearchCalls }), provider.protocol);
      const validUsage = Boolean(result.usage && result.usage.inputTokens <= reserved.inputReserve && result.usage.outputTokens <= reserved.outputReserve && result.searchCalls <= maxSearchCalls);
      const convertedTokens = request.webSearch ? provider.webSearchQuotaTokens! * result.searchCalls : 0;
      const usage: AiUsage = validUsage ? { ...result.usage!, ...(request.webSearch ? { searchCalls: result.searchCalls, tokenUsageEstimated: false } : {}), ...(convertedTokens ? { convertedTokens, totalTokens: result.usage!.totalTokens + convertedTokens, estimated: true, billingKind: "tokens_with_search" } : {}) } : conservativeUsage(reserved);
      if (!result.content.trim() || (result.status !== undefined && result.status !== "completed")) {
        const error = result.status === "incomplete"
          ? new AiError(502, "AI_RESPONSE_INCOMPLETE", "AI 未能完成回复，可能达到输出上限，请管理员调整模型或单次输出上限")
          : new AiError(502, "AI_EMPTY_RESPONSE", "AI 未返回完整可显示的文字，请检查模型及输出上限");
        this.store.sql.transaction(() => this.settle(reserved, usage, "uncertain", usage.estimated ? "生成未完成，用量不确定，按预留上限计入" : "生成未完成，按服务商实际 Token 用量计入", undefined, error));
        throw error;
      }
      if (request.webSearch && ((request.webSearchMode !== "auto" && result.searchCalls < 1) || result.searchCalls > maxSearchCalls || result.completedSearchCalls !== result.searchCalls)) {
        const error = new AiError(502, "AI_SEARCH_NOT_COMPLETED", "服务商未按要求完成联网搜索，请管理员检查模型支持；已记录生成用量");
        this.store.sql.transaction(() => this.settle(reserved, usage, "uncertain", "联网搜索执行不符合请求限制，已记录用量，请管理员核对", undefined, error));
        throw error;
      }
      let presentation: AiChatResponse["presentation"];
      if (request.outputFormat === "presentation") {
        try { presentation = parsePresentation(result.content); }
        catch (error) {
          const safe = error instanceof AiError ? error : new AiError(502, "AI_PRESENTATION_INVALID", "演示文稿结构不正确");
          this.store.sql.transaction(() => this.settle(reserved, usage, validUsage ? "failed" : "uncertain", "演示文稿格式未通过验证，已记录服务商生成用量", undefined, safe));
          throw safe;
        }
      }
      const content = presentation ? `已生成《${presentation.title}》，共 ${presentation.slides.length} 页。` : result.content;
      const extras: Pick<AiChatResponse, "presentation" | "sources"> = { ...(presentation ? { presentation } : {}), ...(result.sources.length ? { sources: result.sources } : {}) };
      const settled = this.store.sql.transaction(() => this.settle(reserved, usage, validUsage ? "completed" : "uncertain", validUsage ? convertedTokens ? `服务商实际生成 Token + ${result.searchCalls} 次搜索的管理员设定折算额度` : "服务商实际 Token 用量" : "服务商未返回有效 Token 用量或报告超过请求上限，按预留上限保守计入，请管理员核对", content, undefined, extras));
      if (!settled) {
        const final = this.store.request(userId, request.requestId);
        if (final?.result) return { ...final.result, quota: this.store.quota(userId) };
        throw new AiError(final?.error?.status ?? 502, final?.error?.code ?? "AI_REQUEST_UNCERTAIN", final?.error?.message ?? "请求已按中断记录，请管理员核对用量");
      }
      return { requestId: request.requestId, content, model, usage, quota: this.store.quota(userId), ...extras };
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "AI 服务连接失败或超时，请稍后重试；不确定用量已记录，请管理员核对");
      this.availabilityProbe.invalidate("chat");
      knownRejection ||= safe.definitelyNotSent;
      const usage = knownRejection ? { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } : conservativeUsage(reserved);
      this.store.sql.transaction(() => {
        if (this.store.request(userId, request.requestId)?.status === "pending") this.settle(reserved, usage, knownRejection ? "failed" : "uncertain", knownRejection ? "请求未发出或被服务商拒绝，预留额度已释放" : "结果或用量不确定，按预留上限保守计入", undefined, safe);
      });
      throw safe;
    }
  }
  async generateImage(userId: string, value: unknown): Promise<AiImageResponse> {
    this.store.assertAccess(userId);
    const request = parseImageRequest(value);
    const hash = await requestHash({ kind: "image", prompt: request.prompt });
    this.recover(userId);
    const prior = this.store.request(userId, request.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new AiError(409, "AI_REQUEST_CONFLICT", "相同请求标识不能用于不同任务");
      if (prior.imageResult) return { ...prior.imageResult, quota: this.quota(userId) };
      if (prior.error) throw new AiError(prior.error.status, prior.error.code, prior.error.message, false, undefined, prior.error.diagnostic);
      throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "图片正在生成，请稍候");
    }
    const provider = this.store.provider();
    if (!provider?.enabled || !provider.imageModel || !provider.imageQuotaTokens) throw new AiError(503, "AI_IMAGE_DISABLED", "管理员尚未配置图片生成服务");
    const baseUrl = provider.imageBaseUrl || provider.baseUrl;
    const encryptedKey = provider.imageBaseUrl ? provider.encryptedImageKey : provider.encryptedKey;
    if (!encryptedKey) throw new AiError(503, "AI_IMAGE_DISABLED", "管理员尚未配置图片生成密钥");
    const key = await (await this.box()).decrypt(encryptedKey);
    const model = provider.imageModel;
    const reserved = this.store.sql.transaction(() => {
      if (this.store.request(userId, request.requestId) || this.store.pending(userId).length) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "该账号已有一条 AI 请求正在处理，请稍候");
      if (this.store.activeImageCount() >= 3) throw new AiError(429, "AI_CAPACITY_BUSY", "图片生成任务较多，请稍后重试，本次未扣除额度");
      const quota = this.store.quota(userId);
      if (quota.remainingTokens < provider.imageQuotaTokens!) throw new AiError(402, "AI_QUOTA_EXHAUSTED", "可用额度不足以生成一张图片，请联系管理员增加额度");
      // Reserve room for the largest accepted image before sending a potentially paid generation.
      this.store.assertAssetCapacity(userId, 4 * 1024 * 1024);
      const pending: StoredRequest = { requestId: request.requestId, userId, hash, kind: "image", status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + AI_TIMEOUT_MS + 30_000, inputReserve: 0, outputReserve: 0, convertedReserve: provider.imageQuotaTokens!, model, mode: "quick" };
      quota.reservedTokens += totalReserved(pending);
      this.store.saveQuota(userId, quota); this.store.saveRequest(pending);
      return pending;
    });
    let knownRejection = false;
    try {
      const response = await this.transport(`${baseUrl}/images/generations`, {
        method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: provider.imageStream ? "text/event-stream, application/json" : "application/json", "Idempotency-Key": `${userId}:${request.requestId}` },
        body: JSON.stringify(imageProviderBody(provider, request.prompt)),
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
          if (current?.imageResult) return { ...current.imageResult, quota: this.store.quota(userId) };
          throw new AiError(current?.error?.status ?? 502, current?.error?.code ?? "AI_REQUEST_UNCERTAIN", current?.error?.message ?? "图片请求已按中断记录，请管理员核对用量");
        }
        const asset = this.store.saveAsset(userId, image.mimeType, image.base64, image.byteLength);
        this.settle(reserved, usage, "completed", "按管理员设定的每张图片额度折算；不是服务商实际输入或输出 Token", undefined, undefined, undefined, [asset]);
        return { requestId: request.requestId, model, images: [asset], usage, quota: this.store.quota(userId) };
      });
      return result;
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "图片生成连接中断或超时，请管理员核对服务商用量");
      this.availabilityProbe.invalidate("image");
      knownRejection ||= safe.definitelyNotSent;
      const usage: AiUsage = knownRejection ? { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false } : conservativeUsage(reserved);
      this.store.sql.transaction(() => this.settle(reserved, usage, knownRejection ? "failed" : "uncertain", knownRejection ? "图片请求未发出或被服务商拒绝，已释放预留额度" : "图片结果不确定，已记录预留折算额度，请管理员核对", undefined, safe));
      throw safe;
    }
  }
}
