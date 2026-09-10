import type { AiVideoJob, AiVideoList, AiVideoSettings } from "../../shared/aiVideo";
import { AiStore } from "./storage";
import { AiError, type SecretBox } from "./security";
import { object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";
import { h3VideoContentUrl, parseH3VideoInput, queryH3Video, submitH3Video, type H3VideoTask } from "./videoProvider";

const BASE = "https://www.75api.com/v1";
interface Settings { enabled: boolean; quotaPoints: number; encryptedKey?: string }
interface Job extends AiVideoJob { userId: string; providerId?: string; encryptedKey: string; pollAt: number }
const now = () => new Date().toISOString();
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-zA-Z0-9_-]{16,100}$/.test(id);

/** Durable video jobs are separate from short-lived chat reservations. No automatic paid retries. */
export class AiVideoService {
  constructor(private store: AiStore, private box: () => Promise<SecretBox>, private transport: AiTransport, private deploymentKey: () => string = () => "") {}
  private saved(): Settings { const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0]; return row ? JSON.parse(row.data) : { enabled: false, quotaPoints: 0 }; }
  settings(): AiVideoSettings { const s = this.saved(); return { enabled: s.enabled, quotaPoints: s.quotaPoints, apiKeyConfigured: Boolean(s.encryptedKey || this.deploymentKey()) }; }
  async configure(value: unknown): Promise<AiVideoSettings> {
    const p = object(value), existing = this.saved();
    if (typeof p.enabled !== "boolean" || !Number.isSafeInteger(p.quotaPoints) || Number(p.quotaPoints) < 0 || Number(p.quotaPoints) > 10_000_000 || (p.enabled && !p.quotaPoints)) throw new AiError(400, "AI_VIDEO_SETTINGS_INVALID", "启用视频前，请设置每段视频的同频点折算值（1–1000 万）");
    if (p.apiKey !== undefined && (typeof p.apiKey !== "string" || p.apiKey.length > 4096 || /[\s\x00-\x1f]/.test(p.apiKey))) throw new AiError(400, "AI_KEY_INVALID", "视频密钥格式不正确");
    const encryptedKey = p.apiKey ? await (await this.box()).encrypt(String(p.apiKey)) : existing.encryptedKey;
    if (p.enabled && !encryptedKey && !this.deploymentKey()) throw new AiError(400, "AI_VIDEO_KEY_REQUIRED", "请先配置视频专用密钥");
    this.store.sql.transaction(() => {
      if (!p.apiKey && this.saved().encryptedKey !== existing.encryptedKey) throw new AiError(409, "AI_CONFIG_CHANGED", "配置已被修改，请刷新后重试");
      this.store.sql.exec("INSERT INTO ai_settings(id,data) VALUES('video',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", JSON.stringify({ enabled: p.enabled, quotaPoints: p.quotaPoints, ...(encryptedKey ? { encryptedKey } : {}) }));
    });
    return this.settings();
  }
  private async key(): Promise<string> { const s = this.saved(); const key = s.encryptedKey ? await (await this.box()).decrypt(s.encryptedKey) : this.deploymentKey(); if (!key) throw new AiError(503, "AI_VIDEO_KEY_REQUIRED", "尚未配置视频密钥", true); return key; }
  async test(): Promise<{ ok: true; message: string }> {
    const response = await this.transport(`${BASE}/models`, { method: "GET", headers: { Authorization: `Bearer ${await this.key()}`, Accept: "application/json" }, signal: AbortSignal.timeout(20_000), maxResponseBytes: 512000 });
    if (!response.ok) throw await readProviderHttpError(response, "models");
    const data = object(await readBoundedJson(response, 512000));
    if (!Array.isArray(data.data) || !data.data.some(row => object(row).id === "minimax_h3")) throw new AiError(502, "AI_VIDEO_MODEL_UNAVAILABLE", "视频密钥的模型列表中没有 minimax_h3，请检查模型权限");
    return { ok: true, message: "已验证 H3 模型权限；未生成视频，未扣成员额度" };
  }
  private raw(userId: string, id: string): Job {
    if (!validId(id)) throw new AiError(400, "AI_VIDEO_ID_INVALID", "视频任务编号无效");
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE user_id=? AND id=?", userId, id)[0];
    if (!row) throw new AiError(404, "AI_VIDEO_NOT_FOUND", "视频任务不存在");
    return JSON.parse(row.data);
  }
  private write(job: Job) { this.store.sql.exec("INSERT INTO ai_video_jobs(user_id,id,data) VALUES(?,?,?) ON CONFLICT(user_id,id) DO UPDATE SET data=excluded.data", job.userId, job.id, JSON.stringify(job)); }
  private public(job: Job): AiVideoJob {
    return { id: job.id, prompt: job.prompt, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio, status: job.status, progress: job.progress, createdAt: job.createdAt, updatedAt: job.updatedAt, quotaPoints: job.quotaPoints, reserved: job.reserved, ...(job.error ? { error: job.error } : {}), ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}) };
  }
  private recover(userId?: string) {
    this.store.sql.transaction(() => {
      const query = "SELECT data FROM ai_video_jobs WHERE json_extract(data,'$.reserved')=1";
      for (const row of this.store.sql.all<{ data: string }>(query + (userId ? " AND user_id=?" : ""), ...(userId ? [userId] : []))) {
        const job: Job = JSON.parse(row.data);
        const age = Date.now() - Date.parse(job.createdAt);
        if ((job.status === "submitting" && age > 90_000) || (["queued", "processing"].includes(job.status) && age > 24 * 60 * 60 * 1000)) this.write({ ...job, status: "uncertain", updatedAt: now(), error: "任务结果待核对，请管理员查看服务商任务记录，勿重复生成" });
      }
    });
  }
  list(userId: string): AiVideoList { this.store.assertAccess(userId); this.recover(userId); return { settings: this.settings(), quota: this.store.quota(userId), jobs: this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE user_id=? ORDER BY rowid DESC LIMIT 100", userId).map(r => this.public(JSON.parse(r.data))) }; }
  adminPending() { this.recover(); return this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE json_extract(data,'$.status')='uncertain' ORDER BY rowid DESC LIMIT 100").map(r => { const j: Job = JSON.parse(r.data); return { ...this.public(j), userId: j.userId }; }); }
  private settle(job: Job, points: number, actorId: string | null = null) {
    if (!job.reserved) return;
    const q = this.store.quota(job.userId);
    if (q.reservedTokens < job.quotaPoints) throw new AiError(409, "AI_VIDEO_QUOTA_CONFLICT", "视频预留额度异常，请管理员核查");
    this.store.saveQuota(job.userId, { ...q, reservedTokens: q.reservedTokens - job.quotaPoints, usedTokens: q.usedTokens + points });
    job.reserved = false;
    this.store.addUsage({ id: crypto.randomUUID(), userId: job.userId, requestId: job.id, kind: "video", status: points ? "completed" : "failed", model: "minimax_h3", mode: null, createdAt: now(), reason: actorId ? "管理员按服务商记录核对视频结算" : points ? "视频生成完成" : "服务商拒绝视频请求，已释放预留", limitTokens: null, actorId, inputTokens: 0, outputTokens: 0, totalTokens: points, convertedTokens: points, billingKind: "video_conversion", estimated: false, ...(job.diagnostic ? { diagnostic: job.diagnostic } : {}) });
  }
  async submit(userId: string, value: unknown): Promise<AiVideoJob> {
    this.store.assertAccess(userId); this.recover(userId);
    const p = object(value), input = parseH3VideoInput(p);
    if (!validId(p.requestId)) throw new AiError(400, "AI_VIDEO_ID_INVALID", "请提供有效视频请求编号");
    const id = p.requestId;
    const existing = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE user_id=? AND id=?", userId, id)[0];
    if (existing) {
      const job: Job = JSON.parse(existing.data);
      if (Object.entries(input).some(([k, v]) => job[k as keyof Job] !== v)) throw new AiError(409, "AI_VIDEO_REQUEST_CONFLICT", "相同请求编号不能用于不同的视频内容");
      return this.public(job);
    }
    const s = this.saved();
    if (!s.enabled || !s.quotaPoints) throw new AiError(403, "AI_VIDEO_DISABLED", "管理员尚未启用视频生成");
    const key = await this.key(), encryptedKey = await (await this.box()).encrypt(key);
    let job: Job = { ...input, userId, id, status: "submitting", progress: 0, createdAt: now(), updatedAt: now(), quotaPoints: s.quotaPoints, reserved: true, encryptedKey, pollAt: 0 };
    const reserved = this.store.sql.transaction(() => {
      if (this.store.sql.all("SELECT id FROM ai_video_jobs WHERE user_id=? AND id=?", userId, id).length) return false;
      if (JSON.stringify(this.saved()) !== JSON.stringify(s)) throw new AiError(409, "AI_CONFIG_CHANGED", "视频配置已修改，请重试");
      const active = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE json_extract(data,'$.reserved')=1");
      if (active.length >= 2 || active.some(r => JSON.parse(r.data).userId === userId)) throw new AiError(409, "AI_VIDEO_BUSY", "已有视频任务正在处理或待核对，请稍后再生成");
      const q = this.store.quota(userId);
      if (q.remainingTokens < s.quotaPoints) throw new AiError(402, "AI_QUOTA_INSUFFICIENT", "同频点不足以生成这段视频，请联系管理员");
      this.store.saveQuota(userId, { ...q, reservedTokens: q.reservedTokens + s.quotaPoints }); this.write(job); return true;
    });
    if (!reserved) {
      const current = this.raw(userId, id);
      if (Object.entries(input).some(([k, v]) => current[k as keyof Job] !== v)) throw new AiError(409, "AI_VIDEO_REQUEST_CONFLICT", "相同请求编号不能用于不同的视频内容");
      return this.public(current);
    }
    try {
      const task = await submitH3Video(this.transport, { baseUrl: BASE, apiKey: key }, input);
      job = this.applyTask(userId, id, task);
    } catch (error) {
      this.store.sql.transaction(() => {
        job = this.raw(userId, id);
        job.status = error instanceof AiError && (error.definitelyNotSent || error.diagnostic?.billing === "rejected") ? "failed" : "uncertain";
        job.error = error instanceof AiError ? error.message : "视频提交结果待核对，请管理员查看服务商记录；不会自动重试";
        job.diagnostic = error instanceof AiError ? error.diagnostic : undefined; job.updatedAt = now();
        if (job.status === "failed") this.settle(job, 0);
        this.write(job);
      });
    }
    return this.public(job);
  }
  private applyTask(userId: string, id: string, task: H3VideoTask): Job {
    return this.store.sql.transaction(() => {
      const job = this.raw(userId, id);
      if (!job.reserved) return job;
      job.providerId = task.id; job.progress = task.progress; job.updatedAt = now();
      job.status = task.status === "failed" ? "uncertain" : task.status;
      job.error = task.status === "failed" ? "服务商任务失败，费用尚需管理员核对" : undefined;
      if (task.status === "completed") this.settle(job, job.quotaPoints);
      this.write(job); return job;
    });
  }
  async refresh(userId: string, id: string): Promise<AiVideoJob> {
    this.store.assertAccess(userId); this.recover(userId);
    const job = this.raw(userId, id);
    if (!job.providerId || !job.reserved || job.status === "uncertain" || Date.now() - job.pollAt < 10000) return this.public(job);
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
}
