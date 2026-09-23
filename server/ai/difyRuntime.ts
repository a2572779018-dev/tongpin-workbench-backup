import { createHash, randomBytes } from "node:crypto";
import type { AiAttachment, AiUsageEntry } from "../../shared/ai";
import type { AiVideoJob } from "../../shared/aiVideo";
import type { AiService } from "./service";
import type { AiSql, AiStore, StoredRequest } from "./storage";
import { AiError } from "./security";
import { tenantStorageKey } from "./tenant";
import { toolPlanContextFingerprint, validateToolPlan } from "./toolPlans";
import { validateGeneratedAssetReferenceBinding } from "./generatedAssetReference";
import { validateSourceVideoReferenceBinding } from "./sourceVideoReference";
import { DifyToolExecutionError, DifyToolGateway, DifyToolGatewayError, type DifyToolCallRecord, type DifyToolCallStore, type DifyToolExecutionContext, type DifyToolExecutionResult, type DifyToolGrantClaims, type DifyToolInvocation, type DifyToolReservation } from "./difyToolGateway";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_dify_tool_calls (
 scope TEXT PRIMARY KEY, run_scope TEXT NOT NULL, request_hash TEXT NOT NULL,
 status TEXT NOT NULL, read_only INTEGER NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ai_dify_tool_run ON ai_dify_tool_calls(run_scope,status);
CREATE TABLE IF NOT EXISTS ai_dify_tool_grants (
 token_hash TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, user_id TEXT NOT NULL,
 plan_id TEXT NOT NULL, request_id TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL,
 UNIQUE(tenant_id,user_id,plan_id), UNIQUE(tenant_id,user_id,request_id)
);`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const jsonHash = (value: unknown) => hash(JSON.stringify(value));
function invalid(code: string, message: string, status = 403): never { throw new DifyToolGatewayError(code, message, status); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("DIFY_TOOL_INPUT_INVALID", "Dify 工具参数无效", 400);
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{16,100}$/.test(value)) invalid("DIFY_TOOL_INPUT_INVALID", "Dify 请求编号无效", 400);
  return value;
}

/** Both local SQLite and Durable Object SQLite provide a synchronous atomic transaction. */
export class DifySqlToolCallStore implements DifyToolCallStore {
  constructor(private sql: AiSql, private now = Date.now) { sql.exec(SCHEMA); }
  async reserve(scope: string, runScope: string, requestHash: string, options = { readOnly: false }): Promise<DifyToolReservation> {
    return this.sql.transaction(() => {
      // A crashed process must never make an old reservation executable again.
      this.sql.exec("UPDATE ai_dify_tool_calls SET status='unknown',data=json_set(data,'$.status','unknown','$.errorCode','DIFY_TOOL_WORKER_LOST') WHERE run_scope=? AND status='running' AND expires_at<=?", runScope, this.now());
      const row = this.sql.all<{ data: string }>("SELECT data FROM ai_dify_tool_calls WHERE scope=?", scope)[0];
      if (row) {
        const record = JSON.parse(row.data) as DifyToolCallRecord;
        if (record.requestHash !== requestHash || record.runScope !== runScope) return { kind: "conflict" };
        if (record.status === "running") return { kind: "in_progress" };
        return { kind: "replay", record };
      }
      if (!options.readOnly) {
        if (this.sql.all("SELECT scope FROM ai_dify_tool_calls WHERE run_scope=? AND read_only=0 AND status='unknown' LIMIT 1", runScope).length) return { kind: "run_blocked" };
        if (this.sql.all("SELECT scope FROM ai_dify_tool_calls WHERE run_scope=? AND read_only=0 AND status='running' LIMIT 1", runScope).length) return { kind: "in_progress" };
      }
      const record: DifyToolCallRecord = { scope, runScope, requestHash, status: "running" };
      this.sql.exec("INSERT INTO ai_dify_tool_calls VALUES(?,?,?,?,?,?,?)", scope, runScope, requestHash, "running", options.readOnly ? 1 : 0, this.now() + 180_000, JSON.stringify(record));
      return { kind: "reserved" };
    });
  }
  async finish(scope: string, requestHash: string, update: Pick<DifyToolCallRecord, "status" | "result" | "errorCode">): Promise<void> {
    this.sql.transaction(() => {
      const row = this.sql.all<{ data: string }>("SELECT data FROM ai_dify_tool_calls WHERE scope=? AND request_hash=? AND status='running'", scope, requestHash)[0];
      if (!row) invalid("DIFY_TOOL_RESERVATION_LOST", "工具执行记录需人工核对", 409);
      const record = { ...JSON.parse(row.data), ...update };
      this.sql.exec("UPDATE ai_dify_tool_calls SET status=?,data=? WHERE scope=? AND request_hash=? AND status='running'", update.status, JSON.stringify(record), scope, requestHash);
    });
  }
}

export interface DifyRuntimeConfig {
  /** Deployment-only switch: never read from a member's request body. */
  enabled: boolean;
  appId: string;
}
type Service = Pick<AiService, "store" | "generateImage" | "video">;
interface Grant {
  claims: DifyToolGrantClaims;
  appId: string;
  planId: string;
  planHash: string;
  requestId: string;
  input: Record<string, unknown>;
  configHash: string;
}
type StoredVideo = AiVideoJob & { userId: string };

/** Explicit member approval creates an opaque, revocable, short-lived database capability.
 * No model-authored booleans or caller-supplied tenant / budget claims authorize a call.
 * Deployment is disabled until both runtime configuration and an active-principal check exist.
 */
export class DifyToolRuntime {
  private callStore?: DifySqlToolCallStore;
  constructor(private service: Service, private config?: DifyRuntimeConfig, private principalActive?: (tenantId: string, userId: string) => boolean | Promise<boolean>, private now = Date.now) {}
  private get store(): AiStore { return this.service.store; }
  private configured(): void {
    if (!this.config?.enabled || !this.config.appId.trim() || !this.principalActive) invalid("DIFY_RUNTIME_DISABLED", "Dify 尚未启用并完成运行环境配置", 503);
    this.callStore ??= new DifySqlToolCallStore(this.service.store.sql, this.now);
  }
  private async active(context: DifyToolExecutionContext): Promise<void> {
    this.configured();
    if (context.tenantId !== this.store.tenantId || !await this.principalActive!(context.tenantId, context.userId)) invalid("DIFY_TOOL_SCOPE_MISMATCH", "Dify 任务所属账号不可用");
    this.store.assertAccess(context.userId);
  }
  private settings() {
    const video = this.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE tenant_id=? AND id=?", this.store.tenantId, tenantStorageKey(this.store.tenantId, "video"))[0];
    return { provider: this.store.provider(), harness: this.store.harness(), video: video ? JSON.parse(video.data) as { quotaPoints?: number } : null };
  }
  private planHash(plan: StoredRequest): string {
    return jsonHash({ conversationId: plan.conversationId, mode: plan.mode, model: plan.model, result: plan.result?.toolPlan, context: plan.toolPlanContextFingerprint, expiresAt: plan.toolPlanExpiresAt });
  }
  private video(userId: string, requestId: string): StoredVideo | undefined {
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND id=?", this.store.tenantId, tenantStorageKey(this.store.tenantId, userId), requestId)[0];
    return row ? JSON.parse(row.data) as StoredVideo : undefined;
  }
  /** This method belongs only on an authenticated explicit-approval endpoint. */
  async issueGrant(context: DifyToolExecutionContext, value: unknown) {
    await this.active(context);
    const body = object(value);
    const planId = id(body.planRequestId), requestId = id(body.requestId);
    if (!Number.isSafeInteger(body.maxPoints) || Number(body.maxPoints) <= 0) invalid("DIFY_TOOL_BUDGET_INVALID", "请明确本次生成的最高同频点预算", 400);
    const plan = this.store.request(context.userId, planId);
    const tool = plan?.result?.toolPlan;
    if (!plan || !tool || !["image", "video"].includes(tool.kind) || !plan.conversationId) invalid("DIFY_TOOL_PLAN_MISMATCH", "缺少当前账号及会话的已保存生成方案");
    validateToolPlan(this.store, context.userId, planId, tool.kind, tool.prompt, { consumerRequestId: requestId });
    const run = this.store.harnessRun(context.userId, planId);
    if (run && (run.conversationId !== plan.conversationId || ["cancelled", "failed", "uncertain"].includes(run.status))) invalid("DIFY_TOOL_PLAN_MISMATCH", "生成方案所属任务已不可执行");
    const settings = this.settings();
    const points = tool.kind === "image" ? settings.provider?.imageQuotaTokens : settings.video?.quotaPoints;
    if (!Number.isSafeInteger(points) || !points || points <= 0 || points > Number(body.maxPoints) || this.store.quota(context.userId).remainingTokens < points) invalid("DIFY_TOOL_BUDGET_INVALID", "当前费用或可用余额不符合本次授权预算", 409);
    const input: Record<string, unknown> = { requestId, planRequestId: planId, conversationId: plan.conversationId, prompt: tool.prompt };
    let sourceAssetIds: string[] = [];
    if (tool.kind === "image") {
      const saved = this.store.requestSnapshot(context.userId, planId);
      const snapshot = saved ? object(saved) : {};
      const projectContext = typeof snapshot.projectContext === "string" ? snapshot.projectContext : undefined;
      const attachments = snapshot.attachments as AiAttachment[] | undefined;
      if (await toolPlanContextFingerprint(projectContext, attachments) !== plan.toolPlanContextFingerprint) invalid("DIFY_TOOL_PLAN_MISMATCH", "生成方案缺少可验证的输入快照");
      if (projectContext) input.projectContext = projectContext;
      if (attachments?.length) input.attachments = attachments;
    } else {
      const parameters = tool.videoParameters;
      if (!parameters) invalid("DIFY_TOOL_PLAN_MISMATCH", "视频方案缺少已保存参数");
      const refs = body.referenceIds ?? [];
      if (!Array.isArray(refs) || refs.some(value => typeof value !== "string") || new Set(refs).size !== refs.length || refs.length !== parameters.referenceCount) invalid("DIFY_TOOL_ASSET_SCOPE_MISMATCH", "视频参考素材与已保存方案不一致");
      sourceAssetIds = refs as string[];
      Object.assign(input, { model: parameters.model, seconds: parameters.seconds, resolution: parameters.resolution, aspectRatio: parameters.aspectRatio, referenceIds: sourceAssetIds });
      await this.checkReferences(context.userId, plan.conversationId, sourceAssetIds, parameters.referenceFingerprints);
    }
    const expiresAt = Math.min(this.now() + 10 * 60_000, plan.toolPlanExpiresAt ?? Date.parse(plan.createdAt) + 30 * 60_000);
    if (expiresAt <= this.now()) invalid("DIFY_TOOL_AUTH_EXPIRED", "生成方案已过期");
    const token = randomBytes(32).toString("hex");
    const claims: DifyToolGrantClaims = { audience: "tongpin-dify-tool", ...context, conversationId: plan.conversationId, runId: run?.id ?? planId, attemptId: requestId, allowedTools: [tool.kind === "image" ? "image.generate" : "video.submit", "request.get"], sourceAssetIds, budgetVersion: jsonHash(settings), maxPoints: points, expiresAt };
    const grant: Grant = { claims, appId: this.config!.appId, planId, planHash: this.planHash(plan), requestId, input, configHash: jsonHash(settings) };
    this.store.sql.transaction(() => {
      if (this.store.request(context.userId, requestId) || this.video(context.userId, requestId)) invalid("DIFY_TOOL_REQUEST_EXISTS", "该执行编号已有任务，请查询原任务", 409);
      if (this.store.sql.all("SELECT token_hash FROM ai_dify_tool_grants WHERE tenant_id=? AND user_id=? AND (plan_id=? OR request_id=?)", context.tenantId, context.userId, planId, requestId).length) invalid("DIFY_TOOL_GRANT_EXISTS", "该方案已经授权，请恢复原任务", 409);
      const current = this.store.request(context.userId, planId);
      if (!current || this.planHash(current) !== grant.planHash || current.toolPlanConsumedBy || jsonHash(this.settings()) !== grant.configHash) invalid("DIFY_TOOL_PLAN_MISMATCH", "方案或配置已改变，请重新确认", 409);
      this.store.sql.exec("INSERT INTO ai_dify_tool_grants VALUES(?,?,?,?,?,?,?)", hash(token), context.tenantId, context.userId, planId, requestId, expiresAt, JSON.stringify(grant));
    });
    return { authorization: token, claims, input: { requestId } };
  }
  private grant(token: string): Grant {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) invalid("DIFY_TOOL_AUTH_INVALID", "Dify 工具授权无效");
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_dify_tool_grants WHERE token_hash=? AND tenant_id=?", hash(token), this.store.tenantId)[0];
    if (!row) invalid("DIFY_TOOL_AUTH_INVALID", "Dify 工具授权无效");
    const grant = JSON.parse(row.data) as Grant;
    if (grant.claims.expiresAt <= this.now() || grant.appId !== this.config?.appId) invalid("DIFY_TOOL_AUTH_EXPIRED", "Dify 工具授权已过期或配置已改变");
    return grant;
  }
  private async checkReferences(userId: string, conversationId: string, ids: string[], fingerprints: string[]): Promise<void> {
    for (const [index, referenceId] of ids.entries()) {
      const row = this.store.sql.all<{ expires_at: number; data: string }>("SELECT expires_at,data FROM ai_video_references WHERE tenant_id=? AND user_id=? AND id=?", this.store.tenantId, tenantStorageKey(this.store.tenantId, userId), tenantStorageKey(this.store.tenantId, referenceId))[0];
      if (!row || row.expires_at <= this.now()) invalid("DIFY_TOOL_ASSET_SCOPE_MISMATCH", "视频参考素材不存在或已过期");
      const reference = JSON.parse(row.data) as { generatedAsset?: unknown; sourceVideo?: unknown; fingerprint?: string };
      // Fingerprints were computed on upload, before encryption, and attached to the saved plan.
      if (!/^[a-f0-9]{64}$/.test(reference.fingerprint ?? "") || reference.fingerprint !== fingerprints[index]) invalid("DIFY_TOOL_ASSET_SCOPE_MISMATCH", "视频参考素材内容与方案不一致");
      if (reference.generatedAsset !== undefined) await validateGeneratedAssetReferenceBinding(this.store, userId, reference.generatedAsset, conversationId);
      if (reference.sourceVideo !== undefined) await validateSourceVideoReferenceBinding(this.store, userId, reference.sourceVideo, conversationId);
    }
  }
  async invoke(value: unknown, context?: DifyToolExecutionContext): Promise<DifyToolExecutionResult> {
    this.configured();
    const body = object(value);
    const grant = this.grant(body.authorization as string);
    const trusted = { tenantId: grant.claims.tenantId, userId: grant.claims.userId };
    if (context && (context.tenantId !== trusted.tenantId || context.userId !== trusted.userId)) invalid("DIFY_TOOL_SCOPE_MISMATCH", "Dify 授权不属于当前账号");
    await this.active(trusted);
    if (!Array.isArray(body.sourceAssetIds) || body.sourceAssetIds.some(id => typeof id !== "string") || !body.input || typeof body.input !== "object") invalid("DIFY_TOOL_INPUT_INVALID", "Dify 工具参数无效", 400);
    const input = object(body.input);
    if (Object.keys(input).length !== 1 || input.requestId !== grant.requestId) invalid("DIFY_TOOL_PLAN_MISMATCH", "工具输入与已授权执行快照不一致");
    const gateway = new DifyToolGateway({ store: this.callStore!, now: this.now, verifyAuthorization: async () => grant.claims, isReadOnly: name => name === "request.get", execute: async invocation => this.execute(grant, invocation) });
    return gateway.invoke(body as unknown as DifyToolInvocation, trusted);
  }
  private accounting(grant: Grant, call: Omit<DifyToolInvocation, "authorization">, output: Record<string, unknown>): DifyToolExecutionResult {
    const entries = this.store.sql.all<{ data: string }>("SELECT data FROM ai_usage WHERE tenant_id=? AND user_id=? AND json_extract(data,'$.requestId')=?", this.store.tenantId, tenantStorageKey(this.store.tenantId, call.userId), grant.requestId).map(row => JSON.parse(row.data) as AiUsageEntry);
    const kind = grant.claims.allowedTools.includes("image.generate") ? "image" : "video";
    const request = this.store.request(call.userId, grant.requestId), video = this.video(call.userId, grant.requestId);
    const matches = kind === "image" ? request?.toolPlanRequestId === grant.planId && request?.conversationId === call.conversationId && request.status === "completed" : video?.planRequestId === grant.planId && video.conversationId === call.conversationId;
    if (!matches) throw new DifyToolExecutionError("DIFY_TOOL_LEDGER_INVALID", "工具结果未匹配已授权方案和会话", "unknown");
    if (entries.length === 1 && entries[0].kind === kind && entries[0].status === "completed" && entries[0].userId === call.userId && (kind === "image" || video?.status === "completed" && !video.reserved)) {
      const entry = entries[0];
      return { output, ledger: { ledgerEntryId: entry.id, tenantId: call.tenantId, userId: call.userId, runId: call.runId, toolCallId: call.toolCallId, chargedPoints: entry.totalTokens } };
    }
    if (kind === "video" && entries.length === 0 && video?.reserved && ["queued", "processing"].includes(video.status) && video.quotaPoints === grant.claims.maxPoints) return { output, accounting: { kind: "reserved", requestId: video.id, reservedPoints: video.quotaPoints } };
    throw new DifyToolExecutionError("DIFY_TOOL_LEDGER_INVALID", "工具未返回可核验的结算或预留记录", "unknown");
  }
  private async execute(grant: Grant, call: Omit<DifyToolInvocation, "authorization">): Promise<DifyToolExecutionResult> {
    if (call.toolName === "request.get") {
      const request = this.store.request(call.userId, grant.requestId), video = this.video(call.userId, grant.requestId);
      const record = request ?? video;
      if (record && record.conversationId !== call.conversationId) throw new DifyToolExecutionError("DIFY_TOOL_SCOPE_MISMATCH", "任务不属于当前会话", "not_started");
      return { output: { requestId: grant.requestId, status: record?.status ?? "not_started", ...(request?.imageResult ? { images: request.imageResult.images } : {}) }, accounting: { kind: "read_only" } };
    }
    try {
      const current = this.store.request(call.userId, grant.planId);
      if (!current || this.planHash(current) !== grant.planHash || jsonHash(this.settings()) !== grant.configHash) invalid("DIFY_TOOL_PLAN_MISMATCH", "方案或配置已改变，请重新确认", 409);
      const run = this.store.harnessRun(call.userId, grant.planId);
      if (run && (run.conversationId !== call.conversationId || ["cancelled", "failed", "uncertain"].includes(run.status))) invalid("DIFY_TOOL_PLAN_MISMATCH", "方案所属任务已停止", 409);
      validateToolPlan(this.store, call.userId, grant.planId, current.result!.toolPlan!.kind, current.result!.toolPlan!.prompt, { consumerRequestId: grant.requestId });
      if (this.store.request(call.userId, grant.requestId) || this.video(call.userId, grant.requestId)) invalid("DIFY_TOOL_REQUEST_EXISTS", "该执行编号已有任务，请查询原任务", 409);
      if (this.store.quota(call.userId).remainingTokens < grant.claims.maxPoints) invalid("DIFY_TOOL_BUDGET_INVALID", "本次预算已被其他任务占用", 409);
      if (call.toolName === "video.submit") await this.checkReferences(call.userId, call.conversationId, grant.claims.sourceAssetIds, current.result!.toolPlan!.videoParameters!.referenceFingerprints);
    } catch (error) { throw new DifyToolExecutionError(error instanceof AiError || error instanceof DifyToolGatewayError ? error.code : "DIFY_TOOL_PRECHECK_FAILED", "Dify 工具预检查未通过，本次未执行", "not_started"); }
    try {
      if (call.toolName === "image.generate") {
        const result = await this.service.generateImage(call.userId, grant.input);
        return this.accounting(grant, call, { requestId: result.requestId, status: "completed", images: result.images });
      }
      if (call.toolName === "video.submit") {
        const job = await this.service.video.submit(call.userId, grant.input);
        if (job.status === "uncertain" || job.status === "submitting") throw new DifyToolExecutionError("DIFY_TOOL_OUTCOME_UNKNOWN", "视频提交结果待核对", "unknown");
        if (job.status === "failed") throw new DifyToolExecutionError("DIFY_TOOL_REJECTED", "视频服务已拒绝本次请求", "not_started");
        return this.accounting(grant, call, { requestId: job.id, status: job.status });
      }
      throw new DifyToolExecutionError("DIFY_TOOL_NOT_ALLOWED", "不支持该工具", "not_started");
    } catch (error) {
      if (error instanceof DifyToolExecutionError) throw error;
      const request = this.store.request(call.userId, grant.requestId), video = this.video(call.userId, grant.requestId);
      const notStarted = !request && !video || request?.status === "failed" || video?.status === "failed" && !video.reserved;
      throw new DifyToolExecutionError("DIFY_TOOL_EXECUTION_FAILED", "工具执行失败，请查询原任务", notStarted ? "not_started" : "unknown");
    }
  }
}
