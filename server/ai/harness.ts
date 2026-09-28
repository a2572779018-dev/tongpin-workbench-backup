import {
  AI_BUSINESS_TIERS,
  AI_BUSINESS_TIER_LABELS,
  AI_HARNESS_CAPABILITY_LABELS,
  type AiChatRequest,
  type AiHarnessCapability,
  type AiHarnessConfig,
  type AiHarnessInput,
  type AiHarnessProviderConfig,
  type AiHarnessProviderInput,
  type AiHarnessStrategy,
  type AiHarnessStep,
  type AiHarnessTrace,
  type AiHarnessTierRoute,
  type AiMode,
  type AiProviderConfig,
  type AiReasoningEffort,
} from "../../shared/ai";
import { object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";
import { oneLineSummary } from "./capabilities";
import { AiError, safeBaseUrl, type SecretBox } from "./security";
import type { AiStore, StoredHarnessConfig, StoredHarnessProvider, StoredProvider } from "./storage";
import { AI_WORKFLOW_VERSION, aiWorkflowTemplate } from "../../shared/aiWorkflows";
import { DEPLOYMENT_VIDEO_KEY, legacyHarnessDraft } from "./harnessMigration";
import { parseImageEditCapability, parseImageGenerationCapability } from "./imageCapabilities";
import { openSquillaRouteStep } from "./openSquillaRouting";
import type { AiImageEditCapability, AiImageGenerationCapability } from "../../shared/aiImageCapabilities";
import { readAiMultiAgentSettings, type AiMultiAgentSettings } from "../../shared/aiMultiAgent";

const CAPABILITIES = new Set<AiHarnessCapability>(["chat", "vision", "web_search", "code_interpreter", "image", "video", "presentation", "computer"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,120}$/;
const TERMINAL_RUNS = new Set(["succeeded", "failed", "cancelled", "uncertain"]);
const CONTINUATION_CAPABILITIES = new Set<AiHarnessCapability>(["web_search", "image", "video", "presentation", "computer"]);

export type AiHarnessContinuationDecision =
  | { action: "complete"; summary: string }
  | { action: "tool"; capability: AiHarnessCapability; summary: string };

function safeSummary(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 240 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) {
    throw new AiError(502, "AI_AGENT_DECISION_INVALID", "AI 返回的下一步决策不完整");
  }
  return value.trim();
}

export function parseHarnessContinuationDecision(content: string, allowed: readonly AiHarnessCapability[]): AiHarnessContinuationDecision {
  let raw: unknown;
  try { raw = JSON.parse(content.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "")); }
  catch { throw new AiError(502, "AI_AGENT_DECISION_INVALID", "AI 没有返回完整的下一步决策"); }
  const value = object(raw);
  if (value.action === "complete" && Object.keys(value).length === 2) return { action: "complete", summary: safeSummary(value.summary) };
  if (value.action === "tool" && Object.keys(value).length === 3 && typeof value.capability === "string"
    && CONTINUATION_CAPABILITIES.has(value.capability as AiHarnessCapability) && allowed.includes(value.capability as AiHarnessCapability)) {
    return { action: "tool", capability: value.capability as AiHarnessCapability, summary: safeSummary(value.summary) };
  }
  throw new AiError(502, "AI_AGENT_DECISION_INVALID", "AI 返回的下一步超出了已开放能力");
}

function requiredText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AiError(400, "AI_HARNESS_INVALID", `${label}格式不正确`);
  }
  return value.trim();
}

function publicProvider(provider: StoredHarnessProvider): AiHarnessProviderConfig {
  return {
    id: provider.id,
    name: provider.name,
    baseUrl: provider.baseUrl,
    protocol: provider.protocol,
    enabled: provider.enabled,
    apiKeyConfigured: Boolean(provider.encryptedKey),
    modelsVerified: provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion,
    availableModels: provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion ? provider.availableModels : [],
    modelsVerifiedAt: provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion ? provider.modelsVerifiedAt : null,
  };
}

export function publicHarness(value: StoredHarnessConfig): AiHarnessConfig {
  return { ...value, providers: value.providers.map(publicProvider) };
}

function legacyRoute(provider: StoredProvider, tier: AiMode): AiHarnessTierRoute {
  const deep = tier === "deep" || tier === "pro";
  return {
    providerId: "legacy",
    modelId: deep ? provider.deepModel : provider.quickModel,
    protocol: provider.protocol,
    maxOutputTokens: provider.maxOutputTokens,
    reasoningEffort: deep ? provider.reasoningEffort : "",
    capabilities: ["chat", ...(provider.visionEnabled ? ["vision" as const] : []), ...(provider.webSearchEnabled ? ["web_search" as const] : []), ...(provider.codeInterpreterEnabled ? ["code_interpreter" as const] : [])],
    enabled: provider.enabled,
  };
}

export interface ResolvedHarnessRoute {
  tier: AiMode;
  providerId: string;
  providerName: string;
  baseUrl: string;
  encryptedKey: string;
  modelId: string;
  protocol: AiHarnessTierRoute["protocol"];
  maxOutputTokens: number;
  reasoningEffort: AiReasoningEffort;
  capabilities: AiHarnessCapability[];
  policy: AiHarnessConfig["policy"];
  legacy: boolean;
  /** Present when this tier uses 多 Agent 协作 for text turns. `policy` stays the
   * global rule (tool steps, auto search); only a run that really goes
   * multi-agent records `multi_agent`. An unverified sub-agent model is dropped
   * here (sub-agents then use the tier model). */
  multiAgent?: AiMultiAgentSettings;
}

export interface ResolvedHarnessMediaRoute {
  tier: AiMode;
  capability: "image" | "video";
  providerId: string;
  providerName: string;
  baseUrl: string;
  encryptedKey: string;
  /** Image: the tier's verified model. Video: the tier's configured default,
   * which may be unavailable; the video service binds a verified model. */
  modelId: string;
  legacy: boolean;
  imageEditCapability?: AiImageEditCapability;
  imageGenerationCapability?: AiImageGenerationCapability;
}

export function requestCapability(request: AiChatRequest): AiHarnessCapability {
  if (request.outputFormat === "image_plan") return "image";
  if (request.outputFormat === "video_plan") return "video";
  if (request.outputFormat === "presentation" || request.outputFormat === "presentation_plan") return "presentation";
  if (request.outputFormat === "computer_plan" || request.outputFormat === "computer_task") return "computer";
  if (request.webSearch) return "web_search";
  if (request.attachments?.some(item => item.dataUrl)) return "vision";
  return "chat";
}

/** Private continuation context is deliberately application-authored. The
 * user's original message already lives in their workspace; duplicating it in
 * Harness telemetry would widen the disclosure surface. */
function safeTaskGoal(request: AiChatRequest, capability: AiHarnessCapability): string {
  const workflow = request.workflowId ? aiWorkflowTemplate(request.workflowId) : undefined;
  if (workflow) return `完成已选择的「${workflow.name}」，并仅根据已校验阶段结果判断下一步。`;
  const goals: Record<AiHarnessCapability, string> = {
    chat: "完成当前对话任务，并仅根据已校验结果判断下一步。",
    vision: "完成当前图片理解任务，并仅根据已校验结果判断下一步。",
    web_search: "完成当前需要时效性证据的对话任务，仅使用已校验来源。",
    code_interpreter: "完成当前需要代码执行的任务，并仅根据已校验的执行结果判断下一步。",
    image: "完成当前图片生成任务，并在生成结果校验后判断是否继续。",
    video: "完成当前视频生成任务，并在生成结果校验后判断是否继续。",
    presentation: "完成当前演示文稿任务，并在产物校验后判断是否继续。",
    computer: "完成当前经用户确认的本机操作任务，仅根据已校验操作结果继续。",
  };
  return goals[capability];
}

export function validConversationId(value: unknown, _requestId: string): string {
  // Older clients did not send a stable conversation identity. Keep all such
  // requests in one conservative single-flight scope instead of letting a new
  // request ID silently bypass the per-conversation lock.
  if (value === undefined) return "legacy";
  if (typeof value !== "string" || !CONVERSATION_ID.test(value)) throw new AiError(400, "AI_CONVERSATION_ID_INVALID", "对话标识无效，请重新打开对话");
  return value;
}

export class AiHarness {
  /** `deploymentVideoKey` is the deployment video secret (TONGPIN_H3_API_KEY),
   * used only to migrate video that runs on it into the four-tier settings. */
  constructor(private readonly store: AiStore, private readonly box: () => Promise<SecretBox>, private readonly transport: AiTransport, private readonly deploymentVideoKey: () => string = () => "") {}

  private draft(): StoredHarnessConfig | null {
    return legacyHarnessDraft(this.store, { deploymentVideoKey: Boolean(this.deploymentVideoKey()) });
  }

  /** The draft's deployment-secret video connection has no ciphertext yet. */
  private deploymentKey(): string {
    const key = this.deploymentVideoKey();
    if (!key) throw new AiError(400, "AI_KEY_REQUIRED", "部署视频密钥已不可用，请为视频服务填写 API 密钥");
    return key;
  }

  settings(): AiHarnessConfig | null {
    const value = this.store.harness() ?? this.draft();
    return value ? publicHarness(value) : null;
  }

  private parseTier(tier: AiMode, value: unknown, providers: Set<string>): AiHarnessTierRoute {
    const route = object(value);
    const providerId = requiredText(route.providerId, "服务标识", 48);
    if (!providers.has(providerId)) throw new AiError(400, "AI_HARNESS_PROVIDER_MISSING", "业务档位引用了不存在的服务连接");
    const modelId = requiredText(route.modelId, "模型 ID", 160);
    const protocol = route.protocol;
    if (protocol !== "chat_completions" && protocol !== "responses") throw new AiError(400, "AI_HARNESS_INVALID", "业务档位接口协议不正确");
    if (!Number.isInteger(route.maxOutputTokens) || Number(route.maxOutputTokens) < 16 || Number(route.maxOutputTokens) > 32768) throw new AiError(400, "AI_HARNESS_INVALID", "业务档位单次最大输出需为 16 到 32768 的整数");
    const reasoningEffort = String(route.reasoningEffort ?? "") as AiReasoningEffort;
    if (!["", "low", "medium", "high"].includes(reasoningEffort)) throw new AiError(400, "AI_HARNESS_INVALID", "业务档位思考强度不正确");
    if (!Array.isArray(route.capabilities) || !route.capabilities.length) throw new AiError(400, "AI_HARNESS_INVALID", "每个业务档位至少需要文字对话能力");
    const capabilities = [...new Set(route.capabilities.map(item => String(item) as AiHarnessCapability))];
    if (!capabilities.includes("chat") || capabilities.some(item => !CAPABILITIES.has(item))) throw new AiError(400, "AI_HARNESS_INVALID", "业务档位能力列表不正确");
    // Hosted search and code execution exist only in a Responses request body;
    // on a Chat Completions text route they would be offered but never run.
    const hostedTools = capabilities.filter(item => item === "web_search" || item === "code_interpreter");
    if (protocol !== "responses" && hostedTools.length) {
      throw new AiError(400, "AI_HARNESS_TOOL_PROTOCOL", `${AI_BUSINESS_TIER_LABELS[tier]}档：${hostedTools.map(item => AI_HARNESS_CAPABILITY_LABELS[item]).join("和")}需要 Responses 协议的文字服务`);
    }
    if (typeof route.enabled !== "boolean") throw new AiError(400, "AI_HARNESS_INVALID", "业务档位启用状态不正确");
    const media = (capability: "image" | "video") => {
      const providerKey = `${capability}ProviderId` as const;
      const modelKey = `${capability}ModelId` as const;
      const rawProvider = route[providerKey];
      const rawModel = route[modelKey];
      if (rawProvider === undefined && rawModel === undefined) return {};
      const mediaProviderId = requiredText(rawProvider, `${capability === "image" ? "图片" : "视频"}服务标识`, 48);
      if (!providers.has(mediaProviderId)) throw new AiError(400, "AI_HARNESS_PROVIDER_MISSING", `${capability === "image" ? "图片" : "视频"}档位引用了不存在的服务连接`);
      return { [providerKey]: mediaProviderId, [modelKey]: requiredText(rawModel, `${capability === "image" ? "图片" : "视频"}模型 ID`, 160) };
    };
    const image = media("image");
    const video = media("video");
    if (capabilities.includes("image") && !image.imageModelId) throw new AiError(400, "AI_HARNESS_IMAGE_ROUTE_REQUIRED", "开放图片生成前，请为此档位选择图片服务和模型");
    if (capabilities.includes("video") && !video.videoModelId) throw new AiError(400, "AI_HARNESS_VIDEO_ROUTE_REQUIRED", "开放视频生成前，请为此档位选择视频服务和模型");
    const imageEditCapability = parseImageEditCapability(route.imageEditCapability);
    if (imageEditCapability && imageEditCapability.modelId !== image.imageModelId) throw new AiError(400, "AI_IMAGE_EDIT_CAPABILITY_INVALID", "图片编辑协议与所选模型不一致，请重新选择");
    const imageGenerationCapability = parseImageGenerationCapability(route.imageGenerationCapability);
    if (imageGenerationCapability && imageGenerationCapability.modelId !== image.imageModelId) throw new AiError(400, "AI_IMAGE_GENERATION_CAPABILITY_MISMATCH", "图片生成协议与所选模型不一致，请重新选择");
    const multiAgent = route.multiAgent === undefined || route.multiAgent === null ? undefined : readAiMultiAgentSettings(route.multiAgent, Number(route.maxOutputTokens));
    if (multiAgent?.error) throw new AiError(400, "AI_HARNESS_INVALID", multiAgent.error);
    return { providerId, modelId, protocol, maxOutputTokens: Number(route.maxOutputTokens), reasoningEffort, capabilities, enabled: route.enabled, ...image, ...video,
      ...(imageGenerationCapability ? { imageGenerationCapability } : {}), ...(imageEditCapability ? { imageEditCapability } : {}),
      ...(multiAgent?.settings ? { multiAgent: multiAgent.settings } : {}) };
  }

  async save(value: unknown): Promise<AiHarnessConfig> {
    const input = object(value) as unknown as AiHarnessInput;
    if (!Array.isArray(input.providers) || !input.providers.length || input.providers.length > 8) throw new AiError(400, "AI_HARNESS_INVALID", "请配置 1 到 8 个模型服务连接");
    const existing = this.store.harness() ?? this.draft();
    const ids = new Set<string>();
    const prepared: StoredHarnessProvider[] = [];
    for (const raw of input.providers as AiHarnessProviderInput[]) {
      const item = object(raw);
      const id = requiredText(item.id, "服务标识", 48).toLowerCase();
      if (!PROVIDER_ID.test(id) || ids.has(id)) throw new AiError(400, "AI_HARNESS_INVALID", "服务标识需唯一，并仅使用小写字母、数字、下划线或短横线");
      ids.add(id);
      const previous = existing?.providers.find(provider => provider.id === id);
      const baseUrl = safeBaseUrl(item.baseUrl);
      const protocol = item.protocol;
      if (protocol !== "chat_completions" && protocol !== "responses") throw new AiError(400, "AI_HARNESS_INVALID", "接口协议不正确");
      if (typeof item.enabled !== "boolean") throw new AiError(400, "AI_HARNESS_INVALID", "服务启用状态不正确");
      const suppliedKey = typeof item.apiKey === "string" && item.apiKey.trim() ? requiredText(item.apiKey, "API 密钥", 4096) : "";
      if (!suppliedKey && (!previous?.encryptedKey || previous.baseUrl !== baseUrl)) throw new AiError(400, "AI_KEY_REQUIRED", "首次接入或更换 API 地址时，请填写 API 密钥");
      // Migrating video that ran on the deployment secret stores that same key
      // encrypted, like any administrator-entered key; it is not a new key.
      const encryptedKey = suppliedKey ? await (await this.box()).encrypt(suppliedKey)
        : previous!.encryptedKey === DEPLOYMENT_VIDEO_KEY ? await (await this.box()).encrypt(this.deploymentKey()) : previous!.encryptedKey;
      // Only what a model-list read depends on invalidates it. The connection's
      // name and protocol are labels: every request uses the tier's protocol.
      const configChanged = !previous || previous.baseUrl !== baseUrl;
      const keyChanged = Boolean(suppliedKey);
      prepared.push({
        id, name: requiredText(item.name, "服务名称", 80), baseUrl, protocol, enabled: item.enabled,
        encryptedKey, apiKeyConfigured: true,
        configVersion: configChanged ? crypto.randomUUID() : previous!.configVersion,
        keyVersion: keyChanged ? crypto.randomUUID() : previous!.keyVersion,
        modelsVerified: false, availableModels: configChanged || keyChanged ? [] : previous!.availableModels,
        modelsVerifiedAt: configChanged || keyChanged ? null : previous!.modelsVerifiedAt,
        ...(configChanged || keyChanged ? {} : { verifiedConfigVersion: previous!.verifiedConfigVersion, verifiedKeyVersion: previous!.verifiedKeyVersion }),
        ...(configChanged || keyChanged || !previous?.modelQuarantine ? {} : { modelQuarantine: previous.modelQuarantine }),
      });
    }
    const tiersObject = object(input.tiers);
    const tiers = Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, this.parseTier(tier, tiersObject[tier], ids)])) as Record<AiMode, AiHarnessTierRoute>;
    for (const tier of AI_BUSINESS_TIERS) {
      const route = tiers[tier];
      if (route.imageEditCapability && route.imageEditCapability.baseUrl !== prepared.find(provider => provider.id === route.imageProviderId)?.baseUrl) throw new AiError(400, "AI_IMAGE_EDIT_CAPABILITY_INVALID", "图片服务地址已改变，请重新确认编辑协议");
      if (route.imageGenerationCapability && route.imageGenerationCapability.baseUrl !== prepared.find(provider => provider.id === route.imageProviderId)?.baseUrl) throw new AiError(400, "AI_IMAGE_GENERATION_CAPABILITY_MISMATCH", "图片服务地址已改变，请重新确认生成协议");
    }
    const policy = object(input.policy);
    if (!['direct', 'react', 'plan_execute'].includes(String(policy.strategy))) throw new AiError(400, "AI_HARNESS_INVALID", "代理策略不正确");
    if (!Number.isInteger(policy.maxToolSteps) || Number(policy.maxToolSteps) < 1 || Number(policy.maxToolSteps) > 8) throw new AiError(400, "AI_HARNESS_INVALID", "工具步骤上限需为 1 到 8");
    if (policy.requireApproval !== true) throw new AiError(400, "AI_HARNESS_APPROVAL_REQUIRED", "涉及付费或本机操作的工具必须保留确认步骤");
    if (typeof policy.autoWebSearch !== "boolean") throw new AiError(400, "AI_HARNESS_INVALID", "自动联网策略不正确");
    const stored: StoredHarnessConfig = {
      providers: prepared, tiers,
      policy: { strategy: policy.strategy as AiHarnessConfig["policy"]["strategy"], maxToolSteps: Number(policy.maxToolSteps), requireApproval: true, autoWebSearch: policy.autoWebSearch },
      updatedAt: new Date().toISOString(), migratedFromLegacy: false,
    };
    this.store.sql.transaction(() => this.store.saveHarness(stored));
    return publicHarness(stored);
  }

  async discover(providerId: string): Promise<{ provider: AiHarnessProviderConfig; models: string[] }> {
    const stored = this.store.harness() ?? this.draft();
    const snapshot = stored?.providers.find(provider => provider.id === providerId);
    if (!stored || !snapshot) throw new AiError(404, "AI_HARNESS_PROVIDER_NOT_FOUND", "没有找到该模型服务连接");
    const key = snapshot.encryptedKey === DEPLOYMENT_VIDEO_KEY ? this.deploymentKey() : await (await this.box()).decrypt(snapshot.encryptedKey);
    let response: Response;
    try {
      response = await this.transport(`${snapshot.baseUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (error instanceof AiError) throw error;
      throw new AiError(502, "AI_CONNECTION_FAILED", "无法连接模型服务，请检查公网 API 地址和网络");
    }
    if (!response.ok) throw await readProviderHttpError(response, "models");
    const root = object(await readBoundedJson(response, 512_000));
    if (!Array.isArray(root.data)) throw new AiError(502, "AI_MODELS_UNAVAILABLE", "服务商未返回模型列表");
    const listed = [...root.data, ...await this.audioModels(snapshot.baseUrl, key)];
    const models = [...new Set(listed.map(item => object(item).id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 160))].sort().slice(0, 1000);
    const verifiedAt = new Date().toISOString();
    let usable = models;
    this.store.sql.transaction(() => {
      const persisted = this.store.harness();
      const current = persisted ?? this.draft();
      const target = current?.providers.find(provider => provider.id === providerId);
      if (!current || !target || target.configVersion !== snapshot.configVersion || target.keyVersion !== snapshot.keyVersion || target.encryptedKey !== snapshot.encryptedKey) {
        throw new AiError(409, "AI_CONFIG_CHANGED", "服务连接已修改，请重新获取模型列表");
      }
      // The gateway keeps listing a model it answered model_not_found for; that
      // quarantine holds for this connection version, so a re-read does not
      // silently reopen it. A new key or address starts a clean version.
      const quarantine = target.modelQuarantine;
      if (quarantine && quarantine.configVersion === target.configVersion && quarantine.keyVersion === target.keyVersion) usable = models.filter(id => !quarantine.models.includes(id));
      else delete target.modelQuarantine;
      target.availableModels = usable;
      target.modelsVerifiedAt = verifiedAt;
      target.verifiedConfigVersion = target.configVersion;
      target.verifiedKeyVersion = target.keyVersion;
      // Reading models must not activate the migration or change live routing.
      if (persisted) this.store.saveHarness(current);
    });
    return { provider: publicProvider({ ...snapshot, availableModels: usable, modelsVerifiedAt: verifiedAt, verifiedConfigVersion: snapshot.configVersion, verifiedKeyVersion: snapshot.keyVersion }), models: usable };
  }

  /** SiliconFlow lists its speech models (e.g. the open-source CosyVoice2) only
   * under `?type=audio`; read them too so they can be chosen for 朗读. Best effort. */
  private async audioModels(baseUrl: string, key: string): Promise<unknown[]> {
    let host = "";
    try { host = new URL(baseUrl).hostname; } catch { return []; }
    if (host !== "api.siliconflow.cn" && host !== "api.siliconflow.com") return [];
    try {
      const response = await this.transport(`${baseUrl}/models?type=audio`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return [];
      const root = object(await readBoundedJson(response, 512_000));
      return Array.isArray(root.data) ? root.data : [];
    } catch { return []; }
  }

  resolve(tier: AiMode, legacy: StoredProvider | null, capability: AiHarnessCapability): ResolvedHarnessRoute {
    const stored = this.store.harness();
    if (!stored) {
      if (!legacy?.enabled) throw new AiError(503, "AI_NOT_CONFIGURED", "管理员尚未启用 AI 服务");
      const route = legacyRoute(legacy, tier);
      return {
        tier,
        providerId: "legacy",
        providerName: legacy.name,
        baseUrl: legacy.baseUrl,
        encryptedKey: legacy.encryptedKey,
        modelId: route.modelId,
        protocol: route.protocol,
        maxOutputTokens: route.maxOutputTokens,
        reasoningEffort: route.reasoningEffort,
        capabilities: route.capabilities,
        policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: true },
        legacy: true,
      };
    }
    const route = stored.tiers[tier];
    if (!route?.enabled) throw new AiError(503, "AI_TIER_DISABLED", `${AI_BUSINESS_TIER_LABELS[tier]}档位暂未启用`);
    if (!route.capabilities.includes(capability)) throw new AiError(403, "AI_TIER_CAPABILITY_DISABLED", `${AI_BUSINESS_TIER_LABELS[tier]}档位未开放此能力`);
    const provider = stored.providers.find(item => item.id === route.providerId);
    if (!provider?.enabled) throw new AiError(503, "AI_HARNESS_PROVIDER_DISABLED", "该业务档位的模型服务暂未启用");
    const verified = provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion;
    if (!verified || !provider.availableModels.includes(route.modelId)) throw new AiError(503, "AI_HARNESS_MODEL_UNVERIFIED", "该业务档位尚未完成当前密钥的模型校验，请管理员重新获取模型列表", true);
    const multiAgent: AiMultiAgentSettings | undefined = route.multiAgent && { maxConcurrency: route.multiAgent.maxConcurrency, subAgentMaxOutputTokens: route.multiAgent.subAgentMaxOutputTokens,
      ...(route.multiAgent.subAgentModelId && provider.availableModels.includes(route.multiAgent.subAgentModelId) ? { subAgentModelId: route.multiAgent.subAgentModelId } : {}) };
    return { tier, providerId: provider.id, providerName: provider.name, baseUrl: provider.baseUrl, encryptedKey: provider.encryptedKey, modelId: route.modelId, protocol: route.protocol, maxOutputTokens: route.maxOutputTokens, reasoningEffort: route.reasoningEffort, capabilities: route.capabilities,
      policy: stored.policy, legacy: false, ...(multiAgent ? { multiAgent } : {}) };
  }

  /** Resolves an admin-only media binding. A missing binding deliberately
   * returns null so legacy image/video settings can remain usable during a
   * staged migration. Once a binding exists it must be enabled, model-list
   * verified and compatible with the adapter used by the executor. */
  resolveMedia(tier: AiMode, legacy: StoredProvider | null, capability: "image" | "video"): ResolvedHarnessMediaRoute | null {
    const stored = this.store.harness();
    if (!stored) {
      if (capability !== "image" || !legacy?.enabled || !legacy.imageModel) return null;
      const encryptedKey = legacy.imageBaseUrl ? legacy.encryptedImageKey : legacy.encryptedKey;
      if (!encryptedKey) return null;
      return { tier, capability, providerId: legacy.imageBaseUrl ? "legacy-image" : "legacy", providerName: legacy.name, baseUrl: legacy.imageBaseUrl || legacy.baseUrl, encryptedKey, modelId: legacy.imageModel, legacy: true };
    }
    const tierRoute = stored.tiers[tier];
    if (!tierRoute?.enabled || !tierRoute.capabilities.includes(capability)) throw new AiError(403, "AI_TIER_CAPABILITY_DISABLED", `${AI_BUSINESS_TIER_LABELS[tier]}档位未开放此能力`);
    const providerId = capability === "image" ? tierRoute.imageProviderId : tierRoute.videoProviderId;
    const modelId = capability === "image" ? tierRoute.imageModelId : tierRoute.videoModelId;
    if (!providerId || !modelId) return null;
    const provider = stored.providers.find(item => item.id === providerId);
    if (!provider?.enabled) throw new AiError(503, "AI_HARNESS_PROVIDER_DISABLED", "该业务档位的媒体服务暂未启用");
    const verified = provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion;
    // A video tier whose default model is unavailable (e.g. quarantined after
    // model_not_found) stays open while its connection has verified models:
    // the video service binds a verified replacement and names it to the
    // member, and still rejects an explicitly chosen unverified model.
    const usable = verified && (provider.availableModels.includes(modelId) || capability === "video" && provider.availableModels.length > 0);
    if (!usable) throw new AiError(503, "AI_HARNESS_MODEL_UNVERIFIED", "该业务档位的媒体模型尚未完成当前密钥校验，请管理员重新获取模型列表", true);
    if (capability === "video") {
      const url = new URL(provider.baseUrl);
      if (url.hostname !== "www.75api.com" || url.pathname.replace(/\/$/, "") !== "/v1") {
        throw new AiError(503, "AI_VIDEO_PROTOCOL_UNSUPPORTED", "当前仅对已验证的 75API 视频协议开放执行；其他服务只能保存，不能发起付费生成");
      }
    }
    return { tier, capability, providerId: provider.id, providerName: provider.name, baseUrl: provider.baseUrl, encryptedKey: provider.encryptedKey, modelId, legacy: false,
      ...(capability === "image" && tierRoute.imageEditCapability ? { imageEditCapability: tierRoute.imageEditCapability } : {}),
      ...(capability === "image" && tierRoute.imageGenerationCapability ? { imageGenerationCapability: tierRoute.imageGenerationCapability } : {}) };
  }

  asProvider(route: ResolvedHarnessRoute, legacy: StoredProvider | null): StoredProvider {
    return {
      ...(legacy ?? {
        apiKeyConfigured: true,
        imageApiKeyConfigured: false,
        enabled: true,
        quickModel: route.modelId,
        deepModel: route.modelId,
        imageModel: "",
        imageBaseUrl: "",
        imageQuotaTokens: 0,
        imageStream: false,
        visionEnabled: false,
        visionInputReserveTokens: 4096,
        webSearchEnabled: false,
        webSearchQuotaTokens: 0,
        webSearchProtocol: "standard" as const,
        codeInterpreterEnabled: false,
        codeInterpreterQuotaTokens: 0,
        updatedAt: null,
      }),
      name: route.providerName,
      baseUrl: route.baseUrl,
      protocol: route.protocol,
      quickModel: route.modelId,
      deepModel: route.modelId,
      maxOutputTokens: route.maxOutputTokens,
      reasoningEffort: route.reasoningEffort,
      encryptedKey: route.encryptedKey,
      visionEnabled: route.capabilities.includes("vision"),
      webSearchEnabled: route.capabilities.includes("web_search") && Boolean(legacy?.webSearchEnabled),
      codeInterpreterEnabled: route.capabilities.includes("code_interpreter") && Boolean(legacy?.codeInterpreterEnabled),
      updatedAt: legacy?.updatedAt ?? null,
    };
  }

  startRun(userId: string, request: AiChatRequest, route: ResolvedHarnessRoute): string {
    const existing = this.store.harnessRun(userId, request.requestId);
    if (existing) return existing.id;
    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const capability = requestCapability(request);
    const strategy = route.policy.strategy;
    const maxToolSteps = strategy === "direct" || strategy === "multi_agent" ? 1 : route.policy.maxToolSteps;
    const strategySummary = strategy === "direct"
      ? "直接完成当前请求；如需工具，仅允许提出一个待确认操作。"
      : strategy === "multi_agent"
        ? `多 Agent 协作：由协调 Agent 判断是否拆分任务，最多 ${route.multiAgent?.maxConcurrency ?? 2} 个子 Agent 同时处理，完成后综合结果；如需工具，仅允许提出一个待确认操作。`
      : strategy === "react"
        ? `按“观察结果—提出下一步”的方式推进，最多 ${maxToolSteps} 个工具步骤。`
        : `先形成有界执行计划，再逐步执行，最多 ${maxToolSteps} 个工具步骤。`;
    const workflow = request.workflowId ? aiWorkflowTemplate(request.workflowId) : undefined;
    const strategyStep: AiHarnessStep = { id: crypto.randomUUID(), kind: "strategy", capability, title: "执行策略", summary: strategySummary, status: "succeeded", createdAt: now, updatedAt: now, strategy, maxToolSteps, ...(workflow ? { workflowId: workflow.id, workflowVersion: AI_WORKFLOW_VERSION } : {}) };
    // Quick-tier turns record how OpenSquilla (or the built-in fallback) routed them.
    const routeNote = openSquillaRouteStep(request);
    const routeStep: AiHarnessStep = { id: crypto.randomUUID(), kind: "route", capability, title: routeNote?.title ?? `${AI_BUSINESS_TIER_LABELS[request.mode]}档位`, summary: routeNote?.summary ?? "已按管理员配置选择业务档位；具体服务商与模型仅管理员可见。", status: "succeeded", createdAt: now, updatedAt: now };
    const workflowSteps: AiHarnessStep[] = workflow?.steps.map((step, index) => ({
      id: crypto.randomUUID(), kind: "workflow", capability, title: `${index + 1}. ${step.title}`,
      summary: "已按受限 Hub 模板加入本轮执行。", status: index === 0 ? "running" : "planned",
      createdAt: now, updatedAt: now, workflowId: workflow.id, workflowVersion: AI_WORKFLOW_VERSION, workflowStepId: step.id,
    })) ?? [];
    const planStep: AiHarnessStep | undefined = strategy === "plan_execute" ? { id: crypto.randomUUID(), kind: "plan", capability, title: "制定执行计划", summary: "正在整理有界步骤；不会展示模型内部思维。", status: "running", createdAt: now, updatedAt: now } : undefined;
    const modelStep: AiHarnessStep = { id: crypto.randomUUID(), kind: "model", capability, title: strategy === "react" ? "判断下一步" : "模型响应", summary: strategy === "react" ? "正在判断是否需要提出一个受控工具步骤。" : "正在等待模型返回结果。", status: planStep ? "planned" : "running", createdAt: now, updatedAt: now };
    this.store.createHarnessRun({
      id: runId, requestId: request.requestId, userId,
      conversationId: validConversationId(request.conversationId, request.requestId),
      tier: request.mode, providerId: route.providerId, capability,
      goalKind: capability, goalSummary: safeTaskGoal(request, capability),
      backgroundCapable: true,
      status: "running",
      reasoningSummary: workflow ? `正在执行 ${workflow.name}。` : strategy === "plan_execute" ? "正在整理有界执行计划。" : "已完成安全路由，正在处理这条消息。",
      startedAt: Date.now(), updatedAt: Date.now(),
    }, [strategyStep, routeStep, ...workflowSteps, ...(planStep ? [planStep] : []), modelStep]);
    return runId;
  }

  private runPolicy(userId: string, runId: string): { strategy: AiHarnessStrategy; maxToolSteps: number; workflowId?: AiHarnessStep["workflowId"] } {
    const metadata = this.store.harnessSteps(userId, runId).find(step => step.kind === "strategy");
    const strategy = metadata?.strategy ?? "direct";
    const configuredMax = Number.isInteger(metadata?.maxToolSteps) ? Number(metadata!.maxToolSteps) : 1;
    return { strategy, maxToolSteps: strategy === "direct" || strategy === "multi_agent" ? 1 : Math.max(1, Math.min(8, configuredMax)), ...(metadata?.workflowId ? { workflowId: metadata.workflowId } : {}) };
  }

  /** One verified application phase can complete at most one Hub node. A model
   * reply is never treated as proof that every future node ran. */
  private advanceWorkflow(userId: string, runId: string, activateNext: boolean): void {
    const steps = this.store.harnessSteps(userId, runId).filter(step => step.kind === "workflow");
    const currentIndex = steps.findIndex(step => step.status === "running");
    if (currentIndex < 0) return;
    const now = new Date().toISOString();
    const current = steps[currentIndex];
    this.store.saveHarnessStep(userId, runId, { ...current, status: "succeeded", summary: "已完成该受限 Hub 步骤。", updatedAt: now });
    if (activateNext) {
      const next = steps.slice(currentIndex + 1).find(step => step.status === "planned");
      if (next) this.store.saveHarnessStep(userId, runId, { ...next, status: "running", summary: "正在按受限 Hub 模板推进该步骤。", updatedAt: now });
    }
  }

  private failCurrentWorkflowStep(userId: string, runId: string): void {
    const current = this.store.harnessSteps(userId, runId).find(step => step.kind === "workflow" && step.status === "running");
    if (!current) return;
    this.store.saveHarnessStep(userId, runId, { ...current, status: "failed", summary: "Hub 步骤未能完成。", updatedAt: new Date().toISOString() });
  }

  private proposeTool(userId: string, requestId: string, capability: AiHarnessCapability): AiHarnessTrace {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const steps = this.store.harnessSteps(userId, run.id);
    const policy = this.runPolicy(userId, run.id);
    const existingActive = steps.find(step => step.kind === "tool" && step.capability === capability && (step.status === "waiting_approval" || step.status === "running"));
    if (existingActive) return this.trace(userId, requestId)!;
    const used = steps.filter(step => step.kind === "tool").length;
    if (used >= policy.maxToolSteps) throw new AiError(409, "AI_TOOL_STEP_LIMIT", `本次任务最多允许 ${policy.maxToolSteps} 个工具步骤，请新建任务继续`);
    if (policy.strategy === "direct" && used > 0) throw new AiError(409, "AI_DIRECT_TOOL_LIMIT", "直接执行策略只允许一个工具步骤");
    const now = new Date().toISOString();
    const proposalId = crypto.randomUUID();
    const sequence = used + 1;
    const safeSummary: Record<AiHarnessCapability, string> = {
      chat: "已提出一个文字处理步骤，确认前不会继续。", vision: "已提出一个图片理解步骤，确认前不会继续。",
      web_search: "已提出一个联网查询步骤，确认前不会执行。", code_interpreter: "已提出一个代码执行步骤，确认前不会执行。",
      image: "已提出一个图片生成步骤，确认前不会执行。",
      video: "已提出一个视频生成步骤，确认前不会执行。", presentation: "已提出一个演示文稿步骤，确认前不会执行。",
      computer: "已提出一个本机操作，确认前不会执行。",
    };
    const toolStep: AiHarnessStep = {
      id: crypto.randomUUID(), kind: "tool", capability, title: `工具提案 ${sequence}/${policy.maxToolSteps}`,
      summary: safeSummary[capability], status: "waiting_approval", createdAt: now, updatedAt: now,
      proposalId, sequence, requiresApproval: true, approvalStatus: "waiting",
    };
    const approvalStep: AiHarnessStep = {
      id: crypto.randomUUID(), kind: "approval", capability, title: "等待确认", summary: "尚未执行；确认仅授权这一个提案的一次执行。",
      status: "waiting_approval", createdAt: now, updatedAt: now, proposalId, sequence, requiresApproval: true, approvalStatus: "waiting",
    };
    this.store.saveHarnessStep(userId, run.id, toolStep);
    this.store.saveHarnessStep(userId, run.id, approvalStep);
    this.store.updateHarnessRun(userId, requestId, "waiting_approval", `已提出第 ${sequence} 个工具步骤，等待你的明确确认。`);
    return this.trace(userId, requestId)!;
  }

  /** Internal orchestration hook for a subsequent ReAct / plan-execute cycle. */
  proposeNextTool(userId: string, requestId: string, capability: AiHarnessCapability, _summary: string): AiHarnessTrace {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const policy = this.runPolicy(userId, run.id);
    if (policy.strategy === "direct") throw new AiError(409, "AI_DIRECT_TOOL_LIMIT", "直接执行策略不支持追加工具步骤");
    if (run.status !== "planned" && run.status !== "succeeded") throw new AiError(409, "AI_RUN_NOT_READY", "上一个步骤尚未完成，不能追加工具提案");
    const now = new Date().toISOString();
    const completedTools = this.store.harnessSteps(userId, run.id).filter(step => step.kind === "tool").length;
    if (completedTools >= policy.maxToolSteps) throw new AiError(409, "AI_TOOL_STEP_LIMIT", `本次任务最多允许 ${policy.maxToolSteps} 个工具步骤，请新建任务继续`);
    this.store.saveHarnessStep(userId, run.id, {
      id: crypto.randomUUID(), kind: "model", capability,
      title: policy.strategy === "react" ? "评估步骤结果" : "推进执行计划",
      summary: `已根据第 ${completedTools} 个步骤的已校验结果提出下一步；不展示模型内部思维。`,
      status: "succeeded", createdAt: now, updatedAt: now,
    });
    return this.proposeTool(userId, requestId, capability);
  }

  finishRun(userId: string, requestId: string, outcome: "succeeded" | "failed" | "uncertain", tool?: { capability: AiHarnessCapability; summary?: string }): AiHarnessTrace | undefined {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) return undefined;
    const now = new Date().toISOString();
    const steps = this.store.harnessSteps(userId, run.id);
    if (outcome === "succeeded" && tool?.summary) {
      // Re-apply the private-context charset and bound before persisting this
      // member-visible caption; never store the original user or provider
      // request body here. A caption (including one saved before parseToolPlan
      // normalized it) is sanitized, never allowed to fail a valid settlement.
      const summary = oneLineSummary(tool.summary);
      if (summary) this.store.updateHarnessGoal(userId, requestId, tool.capability, `完成已校验计划：${summary}`);
    }
    if (outcome === "succeeded") this.advanceWorkflow(userId, run.id, Boolean(tool));
    else this.failCurrentWorkflowStep(userId, run.id);
    const plan = steps.find(step => step.kind === "plan" && (step.status === "running" || step.status === "planned"));
    if (plan) this.store.saveHarnessStep(userId, run.id, { ...plan, status: outcome === "succeeded" ? "succeeded" : "failed", summary: outcome === "succeeded" ? "已形成有界执行计划；仅展示进度摘要。" : "执行计划未能完成。", updatedAt: now });
    const model = steps.find(step => step.kind === "model" && (step.status === "running" || step.status === "planned"));
    if (model) this.store.saveHarnessStep(userId, run.id, { ...model, status: outcome === "succeeded" ? "succeeded" : "failed", summary: outcome === "succeeded" ? "模型已返回并通过应用校验。" : outcome === "uncertain" ? "模型结果或用量状态不确定，已交由管理员核对。" : "模型请求未完成。", updatedAt: now });
    if (outcome === "succeeded" && tool) {
      return this.proposeTool(userId, requestId, tool.capability);
    } else {
      this.store.updateHarnessRun(userId, requestId, outcome, outcome === "succeeded" ? "已完成本轮任务并校验返回结果。" : outcome === "uncertain" ? "本轮结果状态不确定，已保留记录供管理员核对。" : "本轮任务未完成，可根据错误提示重试。");
    }
    return this.trace(userId, requestId);
  }

  trace(userId: string, requestId: string): AiHarnessTrace | undefined {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) return undefined;
    const steps = this.store.harnessSteps(userId, run.id);
    const policy = this.runPolicy(userId, run.id);
    const used = steps.filter(step => step.kind === "tool").length;
    const nextAction = run.status === "waiting_approval" ? "approve_tool" : run.status === "running" ? "poll" : run.status === "planned" ? "resume" : "none";
    const publicSteps = steps.map(({ continuationRequestId: _privateRequestId, ...step }) => step);
    return { runId: run.id, tier: run.tier, strategy: policy.strategy, status: run.status, reasoningSummary: run.reasoningSummary, nextAction, toolBudget: { used, max: policy.maxToolSteps, remaining: Math.max(0, policy.maxToolSteps - used) }, steps: publicSteps };
  }

  /** Private input for the next bounded decision. Only code-owned summaries
   * are returned; the original prompt, provider body and credentials are not
   * copied into Harness state. */
  decisionContext(userId: string, requestId: string): {
    goal: { kind: AiHarnessCapability; summary: string };
    results: Array<{ sequence: number; capability: AiHarnessCapability; summary: string }>;
  } {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const results = this.store.harnessSteps(userId, run.id)
      .filter(step => step.kind === "result" && step.status === "succeeded")
      .slice(-8)
      .map(step => {
        if (!Number.isInteger(step.sequence) || Number(step.sequence) < 1 || Number(step.sequence) > 8
          || !CAPABILITIES.has(step.capability) || !step.summary || step.summary.length > 240) {
          throw new AiError(500, "AI_HARNESS_CONTEXT_INVALID", "AI 任务上下文记录无效，已停止自动续跑");
        }
        return { sequence: Number(step.sequence), capability: step.capability, summary: step.summary };
      });
    return { goal: { kind: run.goalKind, summary: run.goalSummary }, results };
  }

  continuationState(userId: string, requestId: string): { requestId?: string; status: AiHarnessTrace["status"] } {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const step = this.store.harnessSteps(userId, run.id).find(item => item.kind === "model" && item.continuationRequestId && item.status === "running");
    return { ...(step?.continuationRequestId ? { requestId: step.continuationRequestId } : {}), status: run.status };
  }

  beginContinuation(userId: string, requestId: string, continuationRequestId: string): void {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const policy = this.runPolicy(userId, run.id);
    const steps = this.store.harnessSteps(userId, run.id);
    const used = steps.filter(step => step.kind === "tool").length;
    if (policy.strategy === "direct" || used >= policy.maxToolSteps) {
      this.store.updateHarnessRun(userId, requestId, "succeeded", "已达到本轮受限执行边界。");
      return;
    }
    if (run.status !== "planned") throw new AiError(409, "AI_RUN_NOT_READY", "任务尚未进入可恢复的下一步规划状态");
    if (steps.some(step => step.continuationRequestId === continuationRequestId)) return;
    const now = new Date().toISOString();
    this.store.saveHarnessStep(userId, run.id, {
      id: crypto.randomUUID(), kind: "model", capability: run.capability,
      title: policy.strategy === "react" ? "评估工具结果" : "推进下一步",
      summary: "正在请模型仅返回受限的完成/工具决策；不记录内部思维。",
      status: "running", createdAt: now, updatedAt: now, continuationRequestId,
    });
    this.store.updateHarnessRun(userId, requestId, "running", "正在评估已完成步骤并选择下一步。");
  }

  finishContinuation(userId: string, requestId: string, continuationRequestId: string, decision: AiHarnessContinuationDecision): AiHarnessTrace {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const step = this.store.harnessSteps(userId, run.id).find(item => item.continuationRequestId === continuationRequestId);
    if (!step) throw new AiError(409, "AI_AGENT_DECISION_MISSING", "没有找到已持久化的下一步决策");
    const now = new Date().toISOString();
    this.store.saveHarnessStep(userId, run.id, { ...step, status: "succeeded", summary: decision.action === "complete" ? "模型已确认当前受限任务完成。" : "模型已提出一个待确认工具步骤。", updatedAt: now });
    if (decision.action === "complete") {
      this.advanceWorkflow(userId, run.id, false);
      this.store.updateHarnessRun(userId, requestId, "succeeded", decision.summary);
    }
    else return this.proposeTool(userId, requestId, decision.capability);
    return this.trace(userId, requestId)!;
  }

  failContinuation(userId: string, requestId: string, continuationRequestId: string, outcome: "failed" | "uncertain"): AiHarnessTrace {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const step = this.store.harnessSteps(userId, run.id).find(item => item.continuationRequestId === continuationRequestId);
    if (step) this.store.saveHarnessStep(userId, run.id, { ...step, status: "failed", summary: outcome === "uncertain" ? "下一步决策状态不确定，已停止自动重试。" : "下一步决策未能完成。", updatedAt: new Date().toISOString() });
    this.failCurrentWorkflowStep(userId, run.id);
    this.store.updateHarnessRun(userId, requestId, outcome, outcome === "uncertain" ? "下一步状态不确定，为避免重复计费已停止自动重试。" : "下一步决策未能完成。");
    return this.trace(userId, requestId)!;
  }

  /** Rehydrates persisted state without replaying a model or tool call. */
  resume(userId: string, requestId: string): AiHarnessTrace {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    const stored = this.store.request(userId, requestId);
    if (run.status === "running" && stored?.status !== "pending") {
      if (stored?.status === "completed" && stored.result) {
        const plan = stored.result.toolPlan;
        const capability = plan ? plan.kind === "image" ? "image" : plan.kind === "video" ? "video" : "presentation" : stored.result.computerPlan ? "computer" : undefined;
        return this.finishRun(userId, requestId, "succeeded", capability ? { capability, summary: plan?.summary ?? stored.result.computerPlan?.summary } : undefined)!;
      }
      if (stored?.status === "failed" || stored?.status === "uncertain") return this.finishRun(userId, requestId, stored.status)!;
    }
    // Pending work is only polled. Resuming never resends an external request,
    // because its outcome or billing may be unknown after interruption.
    return this.trace(userId, requestId)!;
  }

  beginApprovedTool(userId: string, planRequestId: string, capability: AiHarnessCapability, executionRequestId: string): AiHarnessTrace | undefined {
    const run = this.store.harnessRun(userId, planRequestId);
    // Legacy plans created before harness traces existed remain executable
    // through the separately validated/claimed tool-plan record.
    if (!run) return undefined;
    const now = new Date().toISOString();
    const steps = this.store.harnessSteps(userId, run.id);
    const matching = steps.filter(item => item.kind === "tool" && item.capability === capability && (item.status === "waiting_approval" || item.status === "running" || item.status === "succeeded"));
    const step = matching.find(item => item.executionRequestId === executionRequestId)
      ?? matching.find(item => item.status === "waiting_approval")
      ?? matching.at(-1);
    if (!step) throw new AiError(409, "AI_TOOL_APPROVAL_MISSING", "没有找到可确认的工具提案");
    if (step.executionRequestId && step.executionRequestId !== executionRequestId) throw new AiError(409, "AI_TOOL_APPROVAL_CONSUMED", "这次确认已绑定另一条执行请求，不能重复使用");
    if (step.status === "running" || step.status === "succeeded") return this.trace(userId, planRequestId)!;
    const approval = steps.find(item => item.kind === "approval" && item.proposalId === step.proposalId);
    this.store.saveHarnessStep(userId, run.id, { ...step, status: "running", summary: "已确认一次执行，正在调用工具。", approvalStatus: "approved", executionRequestId, updatedAt: now });
    if (approval) this.store.saveHarnessStep(userId, run.id, { ...approval, status: "succeeded", summary: "已确认一次性执行授权。", approvalStatus: "approved", executionRequestId, updatedAt: now });
    this.store.updateHarnessRun(userId, planRequestId, "running", "已获得确认，正在执行工具调用。");
    return this.trace(userId, planRequestId)!;
  }

  finishApprovedTool(userId: string, planRequestId: string, capability: AiHarnessCapability, outcome: "succeeded" | "failed" | "uncertain"): void {
    const run = this.store.harnessRun(userId, planRequestId);
    if (!run) return;
    const now = new Date().toISOString();
    const steps = this.store.harnessSteps(userId, run.id);
    const matching = steps.filter(item => item.kind === "tool" && item.capability === capability && (item.status === "running" || item.status === "succeeded" || item.status === "failed"));
    const step = matching.find(item => item.status === "running") ?? matching.at(-1);
    if (!step) return;
    const finalStatus = outcome === "succeeded" ? "succeeded" : "failed";
    if (step.status !== finalStatus || step.approvalStatus !== "consumed") this.store.saveHarnessStep(userId, run.id, { ...step, status: finalStatus, approvalStatus: "consumed", summary: outcome === "succeeded" ? "工具已完成并返回结果。" : outcome === "uncertain" ? "工具结果状态不确定，已保留记录供管理员核对。" : "工具调用失败，可根据错误提示重试。", updatedAt: now });
    const resultId = `result:${step.id}`;
    const succeededSummary: Record<AiHarnessCapability, string> = {
      chat: "文字处理结果已通过应用完整性校验。",
      vision: "图片理解结果已通过应用完整性校验。",
      web_search: "联网查询结果已通过来源完整性校验。",
      code_interpreter: "代码执行结果已通过完整性校验并保存。",
      image: "图片生成结果已通过完整性校验并保存。",
      video: "视频生成结果已通过状态校验并保存。",
      presentation: "演示文稿结果已通过完整性校验并保存。",
      computer: "本机操作结果已经用户确认并完成校验。",
    };
    if (!steps.some(item => item.id === resultId)) this.store.saveHarnessStep(userId, run.id, { id: resultId, kind: "result", capability, title: "步骤结果", summary: outcome === "succeeded" ? succeededSummary[capability] : outcome === "uncertain" ? "结果状态不确定，禁止自动重试。" : "工具未完成，可在核对后重新规划。", status: finalStatus, createdAt: now, updatedAt: now, proposalId: step.proposalId, sequence: step.sequence, approvalStatus: "consumed", executionRequestId: step.executionRequestId });
    if (outcome !== "succeeded") {
      this.failCurrentWorkflowStep(userId, run.id);
      this.store.updateHarnessRun(userId, planRequestId, outcome, outcome === "uncertain" ? "工具状态不确定，已保留记录供管理员核对。" : "工具调用未完成。");
      return;
    }
    const policy = this.runPolicy(userId, run.id);
    const used = steps.filter(item => item.kind === "tool").length;
    if (policy.strategy !== "direct" && used < policy.maxToolSteps) {
      this.advanceWorkflow(userId, run.id, true);
      // A successful external tool is an observation, not proof that the whole
      // task is complete. Persist the resumable boundary before asking a model
      // for the next constrained decision.
      this.store.updateHarnessRun(userId, planRequestId, "planned", "工具结果已校验，等待恢复下一步受限决策。");
      return;
    }
    this.advanceWorkflow(userId, run.id, false);
    this.store.updateHarnessRun(userId, planRequestId, "succeeded", "工具已完成，并已达到本轮受限执行边界。");
  }

  cancelWaitingRun(userId: string, requestId: string): AiHarnessTrace {
    const run = this.store.harnessRun(userId, requestId);
    if (!run) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    if (run.status !== "planned" && run.status !== "waiting_approval") throw new AiError(409, "AI_RUN_CANNOT_CANCEL", "任务已开始执行，不能把取消当作服务商已停止或已退款");
    const now = new Date().toISOString();
    for (const step of this.store.harnessSteps(userId, run.id)) {
      if (step.status === "planned" || step.status === "waiting_approval" || (step.kind === "workflow" && step.status === "running")) this.store.saveHarnessStep(userId, run.id, { ...step, status: "cancelled", summary: "已取消，未执行该步骤。", approvalStatus: step.kind === "tool" || step.kind === "approval" ? "cancelled" : step.approvalStatus, updatedAt: now });
    }
    this.store.updateHarnessRun(userId, requestId, "cancelled", "已取消尚未执行的工具方案。");
    const planned = this.store.request(userId, requestId);
    if (planned?.result?.toolPlan && !planned.toolPlanConsumedBy) {
      planned.toolPlanConsumedBy = `cancelled:${requestId}`;
      planned.toolPlanConsumedAt = now;
      this.store.saveRequest(planned);
    }
    return this.trace(userId, requestId)!;
  }
}
