import type { AiAdminVideoReconciliationJob, AiVideoJob, AiVideoList, AiVideoSettings, AiVideoModelCheck, AiVideoModelProfile } from "../../shared/aiVideo";
import type { AiMode } from "../../shared/ai";
import { VIDEO_MODELS, videoModel, videoSeconds, type VideoModelId } from "../../shared/aiVideoModels";
import { AiStore } from "./storage";
import { AiError, type SecretBox } from "./security";
import { object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";
import { h3VideoContentUrl, parseH3VideoInput, queryH3Video, submitH3Video, type H3VideoTask } from "./videoProvider";
import { aiVideoReferenceFingerprint, AI_VIDEO_REFERENCE_FINGERPRINT } from "../../shared/aiVideoReferences";
import { claimToolPlan, validateToolPlan } from "./toolPlans";
import { validConversationId, type AiHarness, type ResolvedHarnessMediaRoute } from "./harness";
import { DEFAULT_AI_TENANT_ID, tenantStorageKey } from "./tenant";
import { assertGeneratedReferenceJpeg, readGeneratedAssetReference, validateGeneratedAssetReferenceBinding, type GeneratedAssetReferenceSource } from "./generatedAssetReference";
import { bindSourceVideoReference, validateSourceVideoReferenceBinding } from "./sourceVideoReference";

const BASE = "https://www.75api.com/v1";
interface Settings {
  enabled: boolean;
  quotaPoints: number;
  encryptedKey?: string;
  defaultModel?: unknown;
  configVersion?: string;
  keyVersion?: string;
  verifiedConfigVersion?: string;
  verifiedKeyVersion?: string;
  verifiedModels?: unknown;
}
interface Job extends AiVideoJob { userId: string; providerId?: string; routingProviderId?: string; encryptedKey: string; pollAt: number; images?: string[]; referenceIds?: string[]; conversationId: string }
const now = () => new Date().toISOString();
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(id);
const randomHexId = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, "0")).join("");
async function referenceCapabilityId(tenantId: string, id: string): Promise<string> {
  // Preserve every legacy/default capability URL. Non-default tenants use a
  // distinct opaque provider-facing capability even when their logical ids collide.
  if (tenantId === DEFAULT_AI_TENANT_ID) return id;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ tenantId, id, kind: "video-reference" })));
  return Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, "0")).join("");
}
const configuredDefaultModel = (value: unknown): VideoModelId => {
  const model = typeof value === "string" ? videoModel(value) : undefined;
  return model?.generationEnabled ? model.id : "minimax_h3";
};
const verifiedModels = (settings: Settings): VideoModelId[] | null => {
  if (!settings.configVersion || !settings.keyVersion || settings.verifiedConfigVersion !== settings.configVersion || settings.verifiedKeyVersion !== settings.keyVersion || !Array.isArray(settings.verifiedModels)) return null;
  const ids = new Set(settings.verifiedModels.filter((id): id is string => typeof id === "string"));
  return VIDEO_MODELS.filter(model => model.generationEnabled && ids.has(model.id)).map(model => model.id);
};
// A saved key is not proof that its token group can call the selected model.
// Fail closed until the saved key/config version has completed a read-only
// model-list check; this prevents a member from discovering a bad mapping via a
// paid generation attempt.
const availableModels = (settings: Settings): VideoModelId[] => verifiedModels(settings) ?? [];
/** Member-safe generation constraints for one catalogue model. The server
 * catalogue is authoritative; clients use this instead of their bundled copy. */
export function memberVideoProfile(id: string): AiVideoModelProfile | undefined {
  const spec = videoModel(id);
  if (!spec?.generationEnabled) return undefined;
  return {
    label: spec.label,
    resolutions: [...spec.resolutions],
    seconds: Object.fromEntries(spec.resolutions.map(resolution => [resolution, videoSeconds(spec.id, resolution)])),
    maxImages: spec.maxImages,
    requiresImage: spec.requiresImage,
  };
}

/** Durable video jobs are separate from short-lived chat reservations. No automatic paid retries. */
export class AiVideoService {
  constructor(private store: AiStore, private box: () => Promise<SecretBox>, private transport: AiTransport, private deploymentKey: () => string = () => "", private harness?: AiHarness) {}
  private userKey(userId: string): string { return tenantStorageKey(this.store.tenantId, userId); }
  private referenceKey(id: string): string { return tenantStorageKey(this.store.tenantId, id); }
  private settingKey(): string { return tenantStorageKey(this.store.tenantId, "video"); }
  private saved(): Settings {
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE tenant_id=? AND id=?", this.store.tenantId, this.settingKey())[0];
    return row ? JSON.parse(row.data) : { enabled: false, quotaPoints: 0 };
  }
  private harnessVideoConfigured(): boolean {
    const harness = this.store.harness();
    return Boolean(harness && Object.values(harness.tiers).some(route => route.enabled && route.capabilities.includes("video") && route.videoProviderId && route.videoModelId && harness.providers.some(provider => provider.id === route.videoProviderId && provider.enabled && provider.encryptedKey)));
  }
  private harnessVideoAccess(tier: AiMode): { route: ResolvedHarnessMediaRoute; models: VideoModelId[] } | null {
    const route = this.harness?.resolveMedia(tier, this.store.provider(), "video") ?? null;
    if (!route) return null;
    const configured = this.store.harness();
    const provider = configured?.providers.find(item => item.id === route.providerId);
    const providerModels = provider?.availableModels ?? [route.modelId];
    const models = VIDEO_MODELS.filter(model => model.generationEnabled && providerModels.includes(model.id)).map(model => model.id);
    if (!models.length) throw new AiError(503, "AI_HARNESS_MODEL_UNVERIFIED", "该业务档位的视频服务没有已验证的可用模型，请管理员重新获取模型列表", true);
    return { route, models };
  }
  private mediaRouteForModel(tier: AiMode, modelId: string): ResolvedHarnessMediaRoute | null {
    const access = this.harnessVideoAccess(tier);
    if (!access) return null;
    if (!access.models.includes(modelId as VideoModelId)) throw new AiError(403, "AI_VIDEO_MODEL_NOT_AUTHORIZED", "当前业务档位的视频服务未验证此模型，请重新选择");
    return { ...access.route, modelId };
  }
  /** Bind a member's explicit selection to the currently verified tier provider. */
  bindPlanModel(tier: AiMode, requested: unknown): VideoModelId {
    const access = this.harnessVideoAccess(tier);
    const legacy = this.saved();
    const allowed = access?.models ?? availableModels(legacy);
    const fallback = access?.route.modelId ?? configuredDefaultModel(legacy.defaultModel);
    const candidate = typeof requested === "string" && requested ? requested : fallback;
    const spec = videoModel(candidate);
    if (!spec?.generationEnabled || !allowed.includes(spec.id)) throw new AiError(403, "AI_VIDEO_MODEL_NOT_AUTHORIZED", "当前视频服务未验证此模型，请重新选择");
    return spec.id;
  }
  private writeSettings(settings: Settings) { this.store.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.settingKey(), this.store.tenantId, JSON.stringify(settings)); }
  settings(): AiVideoSettings {
    const s = this.saved(), verified = verifiedModels(s);
    return { enabled: s.enabled, quotaPoints: s.quotaPoints, apiKeyConfigured: Boolean(s.encryptedKey || this.deploymentKey() || this.harnessVideoConfigured()), defaultModel: configuredDefaultModel(s.defaultModel), availableModels: verified ?? [], modelsVerified: verified !== null };
  }
  /** Opaque version for a queued task. A key or tier-route change invalidates
   * an old approval without returning any provider configuration to members. */
  async configurationVersion(tier: AiMode): Promise<string> {
    const harness = this.store.harness();
    const route = harness?.tiers[tier];
    const provider = route?.videoProviderId ? harness?.providers.find(item => item.id === route.videoProviderId) : undefined;
    const bytes = new TextEncoder().encode(JSON.stringify({
      tenantId: this.store.tenantId, tier, video: this.saved(),
      route: route ?? null, provider: provider ?? null,
    }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  /** Planning may use fingerprints, never provider capability URLs. This
   * revalidates every source in the original conversation before a plan. */
  async referenceFingerprintsForTask(userId: string, referenceIds: string[], conversationId: string): Promise<string[]> {
    this.store.assertAccess(userId);
    const scopedConversationId = validConversationId(conversationId, referenceIds[0] ?? "reference");
    // The new durable task path accepts only references bound to its immutable
    // conversation. Older clients can still submit old unbound references via
    // the legacy endpoint, but cannot quietly move them into a new task.
    for (const id of referenceIds) {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new AiError(400, "AI_VIDEO_IMAGE_INVALID", "参考图片编号无效");
      const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_references WHERE tenant_id=? AND id=? AND user_id=?", this.store.tenantId, this.referenceKey(id), this.userKey(userId))[0];
      const stored = row ? JSON.parse(row.data) as { conversationId?: unknown; generatedAsset?: unknown; sourceVideo?: unknown } : null;
      if (!stored || stored.conversationId !== scopedConversationId) throw new AiError(409, "AI_VIDEO_SOURCE_CONVERSATION", "参考图片不属于当前对话，请重新选择");
    }
    return (await this.references(userId, referenceIds, scopedConversationId)).fingerprints;
  }
  private memberSettings(tier: AiMode = "quick"): AiVideoSettings {
    const admin = this.settings();
    let access: ReturnType<AiVideoService["harnessVideoAccess"]> = null;
    try {
      access = this.harnessVideoAccess(tier);
    } catch {
      return { enabled: admin.enabled, quotaPoints: admin.quotaPoints, apiKeyConfigured: false, availableModels: [], modelsVerified: false };
    }
    const models = access?.models ?? admin.availableModels;
    const selected = (access?.route.modelId && models.includes(access.route.modelId as VideoModelId) ? access.route.modelId as VideoModelId : undefined)
      ?? (admin.defaultModel && models.includes(admin.defaultModel) ? admin.defaultModel : models[0]);
    const spec = selected ? videoModel(selected) : undefined;
    const profiles = Object.fromEntries(models.flatMap(id => { const profile = memberVideoProfile(id); return profile ? [[id, profile]] : []; }));
    const configured = access?.route.modelId;
    const configuredSpec = configured ? videoModel(configured) : undefined;
    // The tier default is never replaced silently: when the configured model is
    // not currently usable the member is told which model is used instead.
    const defaultNotice = configured && selected && configured !== selected
      ? `档位默认模型「${configuredSpec?.label ?? configured}」当前不可用（服务商未开通或已暂停），本次将使用「${spec?.label ?? selected}」`
      : undefined;
    return {
      enabled: admin.enabled,
      quotaPoints: admin.quotaPoints,
      apiKeyConfigured: Boolean(spec && (access || admin.apiKeyConfigured)),
      availableModels: models,
      modelsVerified: Boolean(spec),
      ...(selected ? { defaultModel: selected } : {}),
      ...(spec ? { profile: memberVideoProfile(spec.id)! } : {}),
      profiles,
      ...(defaultNotice ? { defaultNotice } : {}),
    };
  }
  /** Read-only source for client JPEG normalization; never calls a video provider. */
  async generatedReferenceSource(userId: string, value: unknown): Promise<GeneratedAssetReferenceSource> {
    this.store.assertAccess(userId);
    const settings = this.settings();
    if (!settings.enabled || !settings.apiKeyConfigured) throw new AiError(403, "AI_VIDEO_DISABLED", "管理员尚未启用视频生成");
    return readGeneratedAssetReference(this.store, userId, value);
  }
  async uploadReference(userId: string, value: unknown): Promise<{ id: string }> {
    this.store.assertAccess(userId);
    const s = this.settings();
    if (!s.enabled || !s.apiKeyConfigured) throw new AiError(403, "AI_VIDEO_DISABLED", "管理员尚未启用视频生成");
    const p = object(value);
    if (typeof p.dataUrl !== "string" || p.dataUrl.length > 400000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(p.dataUrl)) throw new AiError(400, "AI_VIDEO_IMAGE_INVALID", "参考图片格式或大小不正确，请重新选择图片");
    if (p.generatedAsset !== undefined && p.sourceVideo !== undefined) throw new AiError(400, "AI_VIDEO_SOURCE_INVALID", "同一参考图不能同时绑定两种来源");
    if (p.generatedAsset !== undefined || p.sourceVideo !== undefined) assertGeneratedReferenceJpeg(p.dataUrl);
    const generatedAsset = p.generatedAsset === undefined ? undefined : await validateGeneratedAssetReferenceBinding(this.store, userId, p.generatedAsset);
    const sourceVideo = p.sourceVideo === undefined ? undefined : await bindSourceVideoReference(this.store, userId, p.sourceVideo, p.dataUrl);
    const conversationId = p.conversationId === undefined ? generatedAsset?.conversationId ?? sourceVideo?.conversationId : validConversationId(p.conversationId, "reference");
    if (conversationId && (generatedAsset && generatedAsset.conversationId !== conversationId || sourceVideo && sourceVideo.conversationId !== conversationId)) throw new AiError(409, "AI_VIDEO_SOURCE_CONVERSATION", "参考素材来自其他对话，请在原对话中继续生成");
    const box = await this.box(), chunks: string[] = [];
    for (let i = 0; i < p.dataUrl.length; i += 16000) chunks.push(await box.encrypt(p.dataUrl.slice(i, i + 16000)));
    const fingerprint = await aiVideoReferenceFingerprint(p.dataUrl);
    const id = randomHexId();
    const publicId = await referenceCapabilityId(this.store.tenantId, id);
    const storedUserId = this.userKey(userId);
    this.store.sql.transaction(() => {
      this.store.sql.exec("DELETE FROM ai_video_references WHERE tenant_id=? AND expires_at <= ?", this.store.tenantId, Date.now());
      const count = this.store.sql.all<{ n: number }>("SELECT COUNT(*) AS n FROM ai_video_references WHERE tenant_id=? AND user_id=?", this.store.tenantId, storedUserId)[0].n;
      if (count >= 32) throw new AiError(429, "AI_VIDEO_IMAGE_LIMIT", "暂存图片已达上限，请稍后再试");
      this.store.sql.exec("INSERT INTO ai_video_references(id,tenant_id,public_id,user_id,expires_at,data) VALUES(?,?,?,?,?,?)", this.referenceKey(id), this.store.tenantId, publicId, storedUserId, Date.now() + 24 * 60 * 60 * 1000, JSON.stringify({ chunks, fingerprint, ...(conversationId ? { conversationId } : {}), ...(generatedAsset ? { generatedAsset } : {}), ...(sourceVideo ? { sourceVideo } : {}) }));
    });
    return { id };
  }
  /** Unguessable, expiring capability URL for provider retrieval; no member credentials in the URL. */
  async referenceContent(id: string): Promise<Response> {
    const row = /^[a-f0-9]{64}$/.test(id) ? this.store.sql.all<{ data: string; expires_at: number }>("SELECT data,expires_at FROM ai_video_references WHERE public_id=?", id)[0] : undefined;
    if (!row || row.expires_at <= Date.now()) return new Response(null, { status: 404 });
    const box = await this.box();
    const stored = JSON.parse(row.data) as string[] | { chunks?: unknown };
    const chunks = Array.isArray(stored) ? stored : Array.isArray(stored.chunks) ? stored.chunks.filter((chunk): chunk is string => typeof chunk === "string") : [];
    const data = (await Promise.all(chunks.map(chunk => box.decrypt(chunk)))).join("");
    const bytes = Uint8Array.from(atob(data.slice(data.indexOf(",") + 1)), c => c.charCodeAt(0));
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
  }
  private async references(userId: string, value: unknown, conversationId: string): Promise<{ urls?: string[]; fingerprints: string[] }> {
    if (value === undefined) return { fingerprints: [] };
    if (!Array.isArray(value) || value.length > 9 || value.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))) throw new AiError(400, "AI_VIDEO_IMAGE_INVALID", "最多上传 9 张参考图片");
    const fingerprints: string[] = [];
    const urls: string[] = [];
    for (const id of value) {
      const row = this.store.sql.all<{ expires_at: number; data: string; public_id: string }>("SELECT expires_at,data,public_id FROM ai_video_references WHERE tenant_id=? AND id=? AND user_id=?", this.store.tenantId, this.referenceKey(id), this.userKey(userId))[0];
      if (!row || row.expires_at <= Date.now()) throw new AiError(400, "AI_VIDEO_IMAGE_INVALID", "参考图片已过期，请重新上传");
      const stored = JSON.parse(row.data) as { fingerprint?: unknown; conversationId?: unknown; generatedAsset?: unknown; sourceVideo?: unknown } | string[];
      if (Array.isArray(stored) || typeof stored.fingerprint !== "string" || !AI_VIDEO_REFERENCE_FINGERPRINT.test(stored.fingerprint)) throw new AiError(409, "AI_TOOL_PLAN_MISMATCH", "旧参考图片没有完整校验信息，请重新上传并整理视频任务");
      if (stored.conversationId !== undefined && stored.conversationId !== conversationId && stored.generatedAsset === undefined && stored.sourceVideo === undefined) throw new AiError(409, "AI_VIDEO_SOURCE_CONVERSATION", "参考图片来自其他对话，请在原对话中继续生成");
      if (stored.generatedAsset !== undefined) await validateGeneratedAssetReferenceBinding(this.store, userId, stored.generatedAsset, conversationId);
      if (stored.sourceVideo !== undefined) {
        const source = await validateSourceVideoReferenceBinding(this.store, userId, stored.sourceVideo, conversationId);
        if (source.frameFingerprint !== stored.fingerprint) throw new AiError(409, "AI_VIDEO_SOURCE_CHANGED", "视频参考画面与任务记录不一致，请重新选择");
      }
      fingerprints.push(stored.fingerprint);
      if (!/^[a-f0-9]{64}$/.test(row.public_id)) throw new AiError(409, "AI_TOOL_PLAN_MISMATCH", "参考图片缺少完整隔离信息，请重新上传并整理视频任务");
      urls.push(`https://notify.samhubs.com/api/video-reference/${row.public_id}`);
    }
    return { urls, fingerprints };
  }
  async configure(value: unknown): Promise<AiVideoSettings> {
    const p = object(value), existing = this.saved();
    const defaultModel = p.defaultModel === undefined ? configuredDefaultModel(existing.defaultModel) : p.defaultModel;
    const defaultSpec = typeof defaultModel === "string" ? videoModel(defaultModel) : undefined;
    if (!defaultSpec) throw new AiError(400, "AI_VIDEO_MODEL_INVALID", "请选择已接入的视频模型");
    if (!defaultSpec.generationEnabled) throw new AiError(409, "AI_VIDEO_MODEL_UNAVAILABLE", defaultSpec.unavailableReason);
    if (typeof p.enabled !== "boolean" || !Number.isSafeInteger(p.quotaPoints) || Number(p.quotaPoints) < 0 || Number(p.quotaPoints) > 10_000_000 || (p.enabled && !p.quotaPoints)) throw new AiError(400, "AI_VIDEO_SETTINGS_INVALID", "启用视频前，请设置每段视频的同频点折算值（1–1000 万）");
    if (p.apiKey !== undefined && (typeof p.apiKey !== "string" || p.apiKey.length > 4096 || /[\s\x00-\x1f]/.test(p.apiKey))) throw new AiError(400, "AI_KEY_INVALID", "视频密钥格式不正确");
    const encryptedKey = p.apiKey ? await (await this.box()).encrypt(String(p.apiKey)) : existing.encryptedKey;
    if (p.enabled && !encryptedKey && !this.deploymentKey() && !this.harnessVideoConfigured()) throw new AiError(400, "AI_VIDEO_KEY_REQUIRED", "请先在业务档位中配置视频服务密钥，或填写视频专用密钥");
    const next: Settings = {
      enabled: p.enabled,
      quotaPoints: Number(p.quotaPoints),
      defaultModel,
      configVersion: crypto.randomUUID(),
      keyVersion: p.apiKey ? crypto.randomUUID() : existing.keyVersion ?? crypto.randomUUID(),
      ...(encryptedKey ? { encryptedKey } : {}),
    };
    this.store.sql.transaction(() => {
      if (!p.apiKey && this.saved().encryptedKey !== existing.encryptedKey) throw new AiError(409, "AI_CONFIG_CHANGED", "配置已被修改，请刷新后重试");
      this.writeSettings(next);
    });
    return this.settings();
  }
  private async key(settings: Settings = this.saved()): Promise<string> { const key = settings.encryptedKey ? await (await this.box()).decrypt(settings.encryptedKey) : this.deploymentKey(); if (!key) throw new AiError(503, "AI_VIDEO_KEY_REQUIRED", "尚未配置视频密钥", true); return key; }
  async test(): Promise<AiVideoModelCheck> {
    let snapshot = this.saved();
    if (!snapshot.encryptedKey && !this.deploymentKey()) {
      const harness = this.store.harness();
      if (!harness) throw new AiError(503, "AI_VIDEO_KEY_REQUIRED", "尚未配置视频密钥", true);
      const ids = new Set<string>();
      for (const tier of Object.values(harness.tiers)) {
        if (!tier.videoProviderId || !tier.videoModelId) continue;
        const provider = harness.providers.find(item => item.id === tier.videoProviderId);
        const verified = provider && provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion;
        if (verified && provider.availableModels.includes(tier.videoModelId)) ids.add(tier.videoModelId);
      }
      const available = VIDEO_MODELS.filter(model => model.generationEnabled && ids.has(model.id)).map(model => model.id);
      return { ok: true, message: "已使用业务档位中绑定的模型列表；未进行生成。", models: VIDEO_MODELS.map(({ id, label }) => ({ id, label, listed: ids.has(id) })), availableModels: available };
    }
    if (!snapshot.configVersion || !snapshot.keyVersion) {
      const migrated: Settings = { ...snapshot, configVersion: crypto.randomUUID(), keyVersion: crypto.randomUUID() };
      this.store.sql.transaction(() => {
        if (JSON.stringify(this.saved()) !== JSON.stringify(snapshot)) throw new AiError(409, "AI_CONFIG_CHANGED", "视频配置已修改，请重新检查模型列表");
        this.writeSettings(migrated);
      });
      snapshot = migrated;
    }
    const response = await this.transport(`${BASE}/models`, { method: "GET", headers: { Authorization: `Bearer ${await this.key(snapshot)}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000), maxResponseBytes: 512000 });
    if (!response.ok) throw await readProviderHttpError(response, "models");
    const data = object(await readBoundedJson(response, 512000));
    if (!Array.isArray(data.data)) throw new AiError(502, "AI_VIDEO_MODEL_UNAVAILABLE", "服务商没有返回模型列表，请检查接入配置");
    const ids = new Set(data.data.map(row => String(object(row).id)));
    const verified = VIDEO_MODELS.filter(model => model.generationEnabled && ids.has(model.id)).map(model => model.id);
    this.store.sql.transaction(() => {
      const current = this.saved();
      if (current.configVersion !== snapshot.configVersion || current.keyVersion !== snapshot.keyVersion) throw new AiError(409, "AI_CONFIG_CHANGED", "视频配置已修改，请重新检查模型列表");
      this.writeSettings({ ...current, verifiedConfigVersion: current.configVersion, verifiedKeyVersion: current.keyVersion, verifiedModels: verified });
    });
    return { ok: true, message: "已读取并保存当前密钥可用的已接入模型；成员端只显示这些模型。不代表生成请求一定成功，未生成视频、未扣成员额度。", models: VIDEO_MODELS.map(({ id, label }) => ({ id, label, listed: ids.has(id) })), availableModels: verified };
  }
  private raw(userId: string, id: string): Job {
    if (!validId(id)) throw new AiError(400, "AI_VIDEO_ID_INVALID", "视频任务编号无效");
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND id=?", this.store.tenantId, this.userKey(userId), id)[0];
    if (!row) throw new AiError(404, "AI_VIDEO_NOT_FOUND", "视频任务不存在");
    return JSON.parse(row.data);
  }
  private write(job: Job) { this.store.sql.exec("INSERT INTO ai_video_jobs(user_id,id,tenant_id,data) VALUES(?,?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.userKey(job.userId), job.id, this.store.tenantId, JSON.stringify(job)); }
  private public(job: Job): AiVideoJob {
    const referenceIds = job.referenceIds ?? (job.images ?? []).map(url => url.split("/").at(-1)!).filter(id => /^[a-f0-9]{64}$/.test(id));
    return { referenceIds, id: job.id, prompt: job.prompt, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio, status: job.status, progress: job.progress, createdAt: job.createdAt, updatedAt: job.updatedAt, quotaPoints: job.quotaPoints, reserved: job.reserved, ...(job.planRequestId ? { planRequestId: job.planRequestId } : {}), ...(job.conversationId ? { conversationId: job.conversationId } : {}), ...(job.error ? { error: job.error } : {}), ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}) };
  }
  private recover(userId?: string) {
    this.store.sql.transaction(() => {
      const query = "SELECT data FROM ai_video_jobs WHERE tenant_id=? AND json_extract(data,'$.reserved')=1";
      for (const row of this.store.sql.all<{ data: string }>(query + (userId ? " AND user_id=?" : ""), this.store.tenantId, ...(userId ? [this.userKey(userId)] : []))) {
        const job: Job = JSON.parse(row.data);
        const age = Date.now() - Date.parse(job.createdAt);
        if ((job.status === "submitting" && age > 90_000) || (["queued", "processing"].includes(job.status) && age > 24 * 60 * 60 * 1000)
          || (job.status === "uncertain" && (!job.providerId || age > 24 * 60 * 60 * 1000))) {
          const stale: Job = { ...job, status: "failed", updatedAt: now(), error: "视频任务长时间没有结果，预留同频点已自动退回；服务商记录待管理员核对" };
          this.settle(stale, 0);
          this.write(stale);
        }
      }
    });
  }
  list(userId: string, tier: AiMode = "quick"): AiVideoList { this.store.assertAccess(userId); this.recover(userId); return { settings: this.memberSettings(tier), quota: this.store.quota(userId), jobs: this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? ORDER BY rowid DESC LIMIT 100", this.store.tenantId, this.userKey(userId)).map(r => this.public(JSON.parse(r.data))) }; }
  adminPending(): AiAdminVideoReconciliationJob[] {
    this.recover();
    return this.store.sql
      .all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND json_extract(data,'$.status')='uncertain' ORDER BY rowid DESC LIMIT 100", this.store.tenantId)
      .map((row) => {
        const job: Job = JSON.parse(row.data);
        return {
          id: job.id,
          userId: job.userId,
          ...(job.providerId ? { providerTaskId: job.providerId } : {}),
          status: "uncertain" as const,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
          quotaPoints: job.quotaPoints,
          reserved: job.reserved,
        };
      });
  }
  private settle(job: Job, points: number, actorId: string | null = null) {
    if (!job.reserved) return;
    const succeeded = job.status === "completed";
    const q = this.store.quota(job.userId);
    if (q.reservedTokens < job.quotaPoints) throw new AiError(409, "AI_VIDEO_QUOTA_CONFLICT", "视频预留额度异常，请管理员核查");
    this.store.saveQuota(job.userId, { ...q, reservedTokens: q.reservedTokens - job.quotaPoints, usedTokens: q.usedTokens + points });
    job.reserved = false;
    this.store.addUsage({ id: crypto.randomUUID(), userId: job.userId, requestId: job.id, kind: "video", status: succeeded ? "completed" : "failed", model: job.model ?? "minimax_h3", mode: null, createdAt: now(), reason: actorId ? points ? "管理员按服务商记录确认扣额，任务结果仍未验证" : "管理员已释放未知任务的预留额度" : succeeded ? "视频生成完成" : "视频未生成，已自动退回预留", limitTokens: null, actorId, inputTokens: 0, outputTokens: 0, totalTokens: points, convertedTokens: points, billingKind: "video_conversion", estimated: false, ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}) });
    const run = job.planRequestId ? this.store.harnessRun(job.userId, job.planRequestId) : null;
    this.store.addObservability({ userId: job.userId, tier: run?.tier ?? "standard", providerId: job.routingProviderId ?? "video-75api", capability: "video", operation: "execution", success: succeeded, latencyMs: Date.now() - Date.parse(job.createdAt), ...(!succeeded ? { errorCode: job.diagnostic ? `AI_PROVIDER_${job.diagnostic.category.toUpperCase()}` : actorId ? points ? "AI_VIDEO_RECONCILED_CHARGE_UNVERIFIED" : "AI_VIDEO_RECONCILED_RELEASE" : "AI_VIDEO_FAILED" } : {}) });
    if (job.planRequestId) this.harness?.finishApprovedTool(job.userId, job.planRequestId, "video", succeeded ? "succeeded" : actorId && points ? "uncertain" : "failed");
  }
  async submit(userId: string, value: unknown): Promise<AiVideoJob> {
    this.store.assertAccess(userId); this.recover(userId);
    const p = object(value);
    if (p.images !== undefined) throw new AiError(400, "AI_VIDEO_IMAGE_INVALID", "请使用上传的参考图片");
    if (!validId(p.requestId)) throw new AiError(400, "AI_VIDEO_ID_INVALID", "请提供有效视频请求编号");
    const conversationId = validConversationId(p.conversationId, p.requestId);
    if (typeof p.planRequestId !== "string") throw new AiError(409, "AI_TOOL_PLAN_REQUIRED", "请先让同频 AI 整理视频任务，再确认生成");
    if (!validId(p.planRequestId)) throw new AiError(400, "AI_TOOL_PLAN_INVALID", "工具方案标识无效，请重新整理任务");
    const planned = validateToolPlan(this.store, userId, p.planRequestId, "video", typeof p.prompt === "string" ? p.prompt : "", { consumerRequestId: p.requestId });
    const planRun = this.store.harnessRun(userId, p.planRequestId);
    const tier = planRun?.tier ?? "quick";
    const plannedParameters = planned.result.toolPlan.videoParameters;
    const submittedParameters = {
      model: p.model ?? plannedParameters?.model,
      seconds: p.seconds,
      resolution: p.resolution,
      aspectRatio: p.aspectRatio,
      referenceCount: Array.isArray(p.referenceIds) ? p.referenceIds.length : p.referenceIds === undefined ? 0 : -1,
    };
    if (!plannedParameters) throw new AiError(409, "AI_TOOL_PLAN_MISMATCH", "视频方案缺少已确认参数，请让同频 AI 重新整理后确认");
    const { referenceFingerprints: _plannedFingerprints, ...plannedParametersWithoutContent } = plannedParameters;
    if (JSON.stringify(plannedParametersWithoutContent) !== JSON.stringify(submittedParameters)) throw new AiError(409, "AI_TOOL_PLAN_MISMATCH", "视频模型、时长、清晰度、画幅或参考图已改变，请让同频 AI 重新整理后确认");
    const s = this.saved();
    if (!s.enabled || !s.quotaPoints) throw new AiError(403, "AI_VIDEO_DISABLED", "管理员尚未启用视频生成");
    const selectedSpec = videoModel(typeof submittedParameters.model === "string" ? submittedParameters.model : "");
    if (!selectedSpec) throw new AiError(400, "AI_VIDEO_MODEL_INVALID", "请选择已接入的视频模型");
    if (!selectedSpec.generationEnabled) throw new AiError(409, "AI_VIDEO_MODEL_UNAVAILABLE", selectedSpec.unavailableReason);
    const mediaRoute = this.mediaRouteForModel(tier, selectedSpec.id);
    if (!mediaRoute && !availableModels(s).includes(selectedSpec.id)) throw new AiError(403, "AI_VIDEO_MODEL_NOT_AUTHORIZED", "当前视频密钥尚未确认可使用此模型，请联系管理员检查模型列表");
    const id = p.requestId;
    const existing = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND id=?", this.store.tenantId, this.userKey(userId), id)[0];
    const existingJob: Job | undefined = existing ? JSON.parse(existing.data) : undefined;
    if (existingJob) {
      const submittedIds = Array.isArray(p.referenceIds) ? p.referenceIds : [];
      const storedIds = existingJob.referenceIds ?? (existingJob.images ?? []).map(url => url.split("/").at(-1));
      const same = existingJob.prompt === p.prompt && (existingJob.model ?? "minimax_h3") === selectedSpec.id
        && existingJob.seconds === p.seconds && existingJob.resolution === p.resolution && existingJob.aspectRatio === p.aspectRatio
        && (existingJob.conversationId ?? "legacy") === conversationId
        && JSON.stringify(storedIds) === JSON.stringify(submittedIds);
      if (!same) throw new AiError(409, "AI_VIDEO_REQUEST_CONFLICT", "相同请求编号不能用于不同的视频内容");
      return this.public(existingJob);
    }
    const references = await this.references(userId, p.referenceIds, conversationId);
    if (JSON.stringify(references.fingerprints) !== JSON.stringify(plannedParameters.referenceFingerprints)) throw new AiError(409, "AI_TOOL_PLAN_MISMATCH", "参考图片与已确认的同频 AI 方案不一致，请重新整理后确认");
    const input = parseH3VideoInput({ ...p, model: selectedSpec.id, images: references.urls });
    const key = mediaRoute ? await (await this.box()).decrypt(mediaRoute.encryptedKey) : await this.key(s), encryptedKey = await (await this.box()).encrypt(key);
    let job: Job = { ...input, userId, id, referenceIds: Array.isArray(p.referenceIds) ? [...p.referenceIds] : [], planRequestId: p.planRequestId, conversationId, status: "submitting", progress: 0, createdAt: now(), updatedAt: now(), quotaPoints: s.quotaPoints, reserved: true, encryptedKey, pollAt: 0, ...(mediaRoute ? { routingProviderId: mediaRoute.providerId } : {}) };
    const reserved = this.store.sql.transaction(() => {
      if (this.store.sql.all("SELECT id FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND id=?", this.store.tenantId, this.userKey(userId), id).length) return false;
      claimToolPlan(this.store, userId, p.planRequestId as string, "video", input.prompt, id);
      this.harness?.beginApprovedTool(userId, p.planRequestId as string, "video", id);
      if (JSON.stringify(this.saved()) !== JSON.stringify(s)) throw new AiError(409, "AI_CONFIG_CHANGED", "视频配置已修改，请重试");
      const active = this.store.activeVideoJobs();
      const activeForUser = active.filter(item => item.userId === userId);
      const ordinaryPending = this.store.pending(userId);
      if (this.store.activeVideoForConversation(userId, conversationId).length || this.store.pendingForConversation(userId, conversationId).length) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "当前对话已有一条 AI 任务正在处理，请稍候");
      if (activeForUser.length + ordinaryPending.length >= 3) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "当前已有 3 条任务并行处理，请等待任意一条完成");
      if (active.length >= 6) throw new AiError(429, "AI_VIDEO_BUSY", "视频任务较多，请稍后再生成");
      const q = this.store.quota(userId);
      if (q.remainingTokens < s.quotaPoints) throw new AiError(402, "AI_QUOTA_INSUFFICIENT", "同频点不足以生成这段视频，请联系管理员");
      this.store.saveQuota(userId, { ...q, reservedTokens: q.reservedTokens + s.quotaPoints }); this.write(job); return true;
    });
    if (!reserved) {
      const current = this.raw(userId, id);
      if ((current.conversationId ?? "legacy") !== conversationId || Object.entries({ ...input, model: input.model ?? "minimax_h3", images: input.images }).some(([k, v]) => JSON.stringify(k === "model" ? current.model ?? "minimax_h3" : current[k as keyof Job]) !== JSON.stringify(v))) throw new AiError(409, "AI_VIDEO_REQUEST_CONFLICT", "相同请求编号不能用于不同的视频内容");
      return this.public(current);
    }
    try {
      const task = await submitH3Video(this.transport, { baseUrl: BASE, apiKey: key }, input);
      job = this.applyTask(userId, id, task);
    } catch (error) {
      // Operator trace only: fixed error code + allowlisted diagnostic, never
      // the prompt, key, reference URLs or raw provider text.
      console.warn("[video-submit]", JSON.stringify({ job: id, model: input.model ?? "minimax_h3", code: error instanceof AiError ? error.code : "UNEXPECTED", name: error instanceof Error ? error.name : typeof error, diagnostic: error instanceof AiError ? error.diagnostic ?? null : null }));
      this.store.sql.transaction(() => {
        job = this.raw(userId, id);
        // Member points are never held hostage by a failed submission: the
        // reservation is always returned. When the provider outcome is not
        // provable (5xx/timeout) the diagnostic stays on the usage record so
        // an administrator can still check the provider's own billing.
        const rejected = error instanceof AiError && (error.definitelyNotSent || error.diagnostic?.billing === "rejected");
        // A gateway that lists a model but has no channel for it answers
        // model_not_found. Stop offering that model until an administrator
        // reads the provider's model list again.
        if (error instanceof AiError && error.diagnostic?.code === "model_not_found" && job.routingProviderId) this.quarantineModel(job.routingProviderId, input.model ?? "minimax_h3");
        job.status = "failed";
        job.error = `${error instanceof AiError ? error.message : "视频提交失败"}；预留同频点已自动退回${rejected ? "" : "，服务商记录待管理员核对"}`;
        job.diagnostic = error instanceof AiError ? error.diagnostic : undefined; job.updatedAt = now();
        this.settle(job, 0);
        this.write(job);
      });
    }
    return this.public(job);
  }
  private quarantineModel(providerId: string, modelId: string) {
    const harness = this.store.harness();
    const provider = harness?.providers.find(item => item.id === providerId);
    if (!harness || !provider?.availableModels.includes(modelId)) return;
    this.store.saveHarness({ ...harness, providers: harness.providers.map(item => item.id === providerId ? { ...item, availableModels: item.availableModels.filter(id => id !== modelId) } : item) });
    console.warn("[video-model-quarantine]", JSON.stringify({ provider: providerId, model: modelId }));
  }
  private applyTask(userId: string, id: string, task: H3VideoTask): Job {
    return this.store.sql.transaction(() => {
      const job = this.raw(userId, id);
      if (!job.reserved) return job;
      job.providerId = task.id; job.progress = task.progress; job.updatedAt = now();
      // New API refunds its task pre-charge when the upstream task ends in
      // `failed`, so a provider-confirmed failure releases the member's
      // reservation instead of parking it for manual reconciliation.
      job.status = task.status;
      const reason = task.errorCode === "reference_image_download_failed" ? "服务商无法下载参考图" : task.errorCode === "content_policy_violation" || task.errorCode === "moderation_blocked" ? "内容未通过服务商审核" : task.errorCode ? `服务商错误 ${task.errorCode}` : "服务商任务失败";
      job.error = task.status === "failed" ? `${reason}，已释放预留额度` : undefined;
      if (task.status === "failed") console.warn("[video-task]", JSON.stringify({ job: id, provider: task.id, errorCode: task.errorCode ?? null }));
      if (task.status === "completed") this.settle(job, job.quotaPoints);
      else if (task.status === "failed") this.settle(job, 0);
      this.write(job); return job;
    });
  }
  async refresh(userId: string, id: string): Promise<AiVideoJob> {
    this.store.assertAccess(userId); this.recover(userId);
    const job = this.raw(userId, id);
    // An uncertain job that already has a provider task ID may be re-queried:
    // a GET never resubmits, and the provider result settles the reservation.
    if (!job.providerId || !job.reserved || Date.now() - job.pollAt < 10000) return this.public(job);
    this.store.sql.transaction(() => { const current = this.raw(userId, id); current.pollAt = Date.now(); this.write(current); });
    try { const key = await (await this.box()).decrypt(job.encryptedKey); return this.public(this.applyTask(userId, id, await queryH3Video(this.transport, { baseUrl: BASE, apiKey: key }, job.providerId))); }
    catch (error) { throw error instanceof AiError ? error : new AiError(502, "AI_VIDEO_QUERY_FAILED", "视频进度查询失败，可稍后重试；不会重复提交视频"); }
  }
  reconcile(userId: string, id: string, actorId: string, value: unknown): AiVideoJob {
    const p = object(value);
    if (p.action !== "release" && p.action !== "charge") throw new AiError(400, "AI_VIDEO_RECONCILE_INVALID", "请选择释放预留或确认扣额");
    return this.store.sql.transaction(() => {
      const job = this.raw(userId, id);
      if (job.status !== "uncertain" || !job.reserved) throw new AiError(409, "AI_VIDEO_NOT_UNCERTAIN", "该任务不需要人工结算");
      this.settle(job, p.action === "charge" ? job.quotaPoints : 0, actorId);
      job.status = "failed"; job.error = p.action === "charge" ? "管理员已按服务商记录确认扣额" : "管理员已释放此任务预留额度"; job.updatedAt = now(); this.write(job); return this.public(job);
    });
  }
  async content(userId: string, id: string): Promise<Response> {
    this.store.assertAccess(userId); const job = this.raw(userId, id);
    if (job.status !== "completed" || !job.providerId) throw new AiError(409, "AI_VIDEO_NOT_READY", "视频尚未生成完成");
    const key = await (await this.box()).decrypt(job.encryptedKey);
    const response = await this.transport(h3VideoContentUrl(BASE, job.providerId), { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "video/mp4" }, signal: AbortSignal.timeout(120000), maxResponseBytes: 64 * 1024 * 1024 });
    if (!response.ok) throw await readProviderHttpError(response, "video");
    if (!response.body || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") ?? "")) { await response.body?.cancel(); throw new AiError(502, "AI_VIDEO_CONTENT_INVALID", "视频服务未返回 MP4 文件，请联系管理员"); }
    let size = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, c) { size += chunk.byteLength; if (size > 64 * 1024 * 1024) throw new Error("Video size limit"); c.enqueue(chunk); } }));
    return new Response(body, { headers: { "Content-Type": "video/mp4", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": 'inline; filename="tongpin-video.mp4"' } });
  }
  /** Verify current ownership and that the provider still serves the file, but cancel before reading the media body. */
  async checkContent(userId: string, id: string): Promise<{ available: true }> {
    this.store.assertAccess(userId); const job = this.raw(userId, id);
    if (job.status !== "completed" || !job.providerId) throw new AiError(409, "AI_VIDEO_NOT_READY", "视频尚未生成完成");
    const key = await (await this.box()).decrypt(job.encryptedKey);
    const response = await this.transport(h3VideoContentUrl(BASE, job.providerId), {
      method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "video/mp4", Range: "bytes=0-0" },
      signal: AbortSignal.timeout(30000), maxResponseBytes: 64 * 1024 * 1024,
    });
    if (!response.ok) throw await readProviderHttpError(response, "video");
    if (!response.body || !/^video\/mp4(?:;|$)/i.test(response.headers.get("content-type") ?? "")) {
      await response.body?.cancel();
      throw new AiError(502, "AI_VIDEO_CONTENT_INVALID", "视频服务未返回 MP4 文件，请联系管理员");
    }
    await response.body.cancel();
    return { available: true };
  }
}
