import type { AiMode } from "../../shared/ai";
import type { AiMediaTaskEvent } from "../../shared/aiRunEvents";
import { videoModel, videoSeconds, type VideoModelId, type VideoResolution } from "../../shared/aiVideoModels";
import { AiError } from "./security";
import type { AiStore } from "./storage";
import { tenantStorageKey, tenantStorageValue } from "./tenant";

export type MediaTaskStatus =
  | "queued" | "planning" | "awaiting_input" | "awaiting_authorization"
  | "running" | "partial" | "completed" | "failed" | "cancelled" | "unknown";
export type MediaTaskCapability = "image" | "video";
export type MediaTaskEntrypoint = "natural" | "mention_image" | "mention_video" | "menu";

/** This describes the grant visible at submission. A later explicit grant is
 * recorded separately; old snapshots are never rewritten to imply consent. */
export interface MediaTaskAuthorizationScope {
  grantId: string;
  capabilities: MediaTaskCapability[];
  sourceAssetIds: string[];
  maxPointsPerTool: number;
  budgetVersion: string;
  modelConfigVersion: string;
  automaticChoice: boolean;
  expiresAt: number;
}

export interface MediaTaskCreateInput {
  requestId: string;
  conversationId: string;
  entrypoint: MediaTaskEntrypoint;
  tier: AiMode;
  intent: MediaTaskCapability;
  /** Private task input. Media bytes must be stored as scoped assets, never here. */
  requestText: string;
  /** Server-sourced, bounded conversation history frozen when this task is
   * submitted. Old snapshots without this field remain valid. */
  contextMessages?: MediaTaskContextMessage[];
  /** Workspace revision used only as provenance; never queried again to
   * silently change the meaning of a submitted task. */
  contextRevision?: number;
  modelConfigVersion: string;
  sourceAssetIds: string[];
  /** Immutable source-content fingerprints captured before the grant. */
  sourceFingerprints?: string[];
  /** Resolved on the server before submission. Reference IDs belong to the
   * existing scoped video-reference store, and must be revalidated on use. */
  videoParameters?: MediaTaskVideoParameters;
  authorizationScope: MediaTaskAuthorizationScope | null;
  deadlineAt: number;
}

export interface MediaTaskContextMessage {
  sourceMessageId: string;
  role: "user" | "assistant";
  content: string;
}

export interface MediaTaskVideoParameters {
  model: VideoModelId;
  seconds: number;
  resolution: VideoResolution;
  aspectRatio: "16:9" | "9:16";
  referenceIds: string[];
}

export interface MediaTaskSnapshot extends MediaTaskCreateInput {
  tenantId: string;
  userId: string;
  runId: string;
  createdAt: number;
}

export interface MediaTaskQuestionOption {
  id: string;
  label: string;
  /** Advisory amount. The existing generation service must atomically reserve
   * and settle its authoritative amount when it submits the paid request. */
  estimatedPoints: number;
  /** Required for a timed automatic choice; manual choices can ask for detail. */
  capability?: MediaTaskCapability;
  sourceAssetIds?: string[];
}
export interface MediaTaskQuestion {
  questionId: string;
  options: MediaTaskQuestionOption[];
  defaultOptionId: string;
  deadlineAt: number;
  selectedOptionId?: string;
  selectedBy?: "user" | "timeout";
  selectedAt?: number;
  timeoutBlockedReason?: "not_authorized" | "configuration_changed" | "budget_changed" | "source_unavailable";
}
export interface MediaTaskFreeQuestion {
  questionId: string;
  prompt: string;
  deadlineAt: number;
  answer?: string;
  answeredAt?: number;
}
export interface MediaTaskToolSpec {
  capability: MediaTaskCapability;
  /** Stable across a planner retry. Not a provider task ID. */
  operationKey: string;
  estimatedPoints: number;
  sourceAssetIds: string[];
  /** Existing approved plan is consumed by the existing image/video service. */
  planRequestId?: string;
}
export interface MediaTaskTool extends MediaTaskToolSpec {
  toolCallId?: string;
  idempotencyKey?: string;
  grantId?: string;
  /** Frozen at the side-effect boundary, before the provider request. */
  inputSnapshot?: {
    tenantId: string; userId: string; conversationId: string; runId: string;
    stepId: string; attemptId: string; toolCallId: string; tier: AiMode;
    modelConfigVersion: string; budgetVersion: string; sourceAssetIds: string[];
    grantId: string;
    videoParameters?: MediaTaskVideoParameters;
  };
  /** Local service request ID used to poll the existing video job safely. */
  serviceRequestId?: string;
  submittedAt?: number;
  artifactIds?: string[];
  partialArtifactIds?: string[];
  partialReason?: string;
  errorCode?: string;
}
export interface MediaTaskRun {
  tenantId: string;
  userId: string;
  conversationId: string;
  requestId: string;
  runId: string;
  stepId: string;
  attemptId: string;
  version: number;
  status: MediaTaskStatus;
  createdAt: number;
  updatedAt: number;
  deadlineAt: number;
  dueAt: number | null;
  question?: MediaTaskQuestion;
  freeQuestion?: MediaTaskFreeQuestion;
  inputAnswers?: Array<{ questionId: string; answer: string; answeredAt: number }>;
  authorization?: MediaTaskAuthorizationScope;
  tool?: MediaTaskTool;
  cancelRequested?: boolean;
  errorCode?: string;
}
export interface MediaTaskExecutionGuard {
  /** Read from current server configuration, never a browser snapshot. */
  modelConfigVersion: string;
  /** Read from the authoritative current budget/accounting policy. */
  budgetVersion: string;
  availablePoints: number;
  /** True only after all selected assets were checked for this tenant/user. */
  sourceAssetsValid: boolean;
}
export type MediaTaskBeginResult = { kind: "started" | "already_started" | "not_authorized" | "configuration_changed" | "budget_changed" | "source_unavailable" | "unknown" | "expired"; run: MediaTaskRun };
export type MediaTaskChoiceResult = { kind: "selected" | "already_selected" | "not_due" | "not_authorized" | "configuration_changed" | "budget_changed" | "source_unavailable" | "expired"; run: MediaTaskRun };

const MEDIA_TASK_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_media_task_runs (
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, run_id TEXT NOT NULL,
  request_id TEXT NOT NULL, conversation_id TEXT NOT NULL, status TEXT NOT NULL,
  due_at INTEGER, deadline_at INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (tenant_id,user_id,run_id), UNIQUE (tenant_id,user_id,request_id)
);
CREATE INDEX IF NOT EXISTS ai_media_task_due ON ai_media_task_runs(tenant_id,due_at);
CREATE INDEX IF NOT EXISTS ai_media_task_conversation ON ai_media_task_runs(tenant_id,user_id,conversation_id);
CREATE TABLE IF NOT EXISTS ai_media_task_snapshots (
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, run_id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (tenant_id,user_id,run_id)
);
CREATE TABLE IF NOT EXISTS ai_media_task_events (
  tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, run_id TEXT NOT NULL,
  seq INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY (tenant_id,user_id,run_id,seq)
);
`;

const IDENTIFIER = /^[a-zA-Z0-9_-]{1,120}$/;
const VERSION = /^[a-zA-Z0-9._:-]{1,120}$/;
const ENTRYPOINTS = new Set<MediaTaskEntrypoint>(["natural", "mention_image", "mention_video", "menu"]);
const TIERS = new Set<AiMode>(["quick", "standard", "deep", "pro"]);
const CAPABILITIES = new Set<MediaTaskCapability>(["image", "video"]);
const RECOVERY_POLL_MS = 10_000;

function invalid(message: string): never { throw new AiError(400, "AI_MEDIA_TASK_INVALID", message); }
function conflict(message: string): never { throw new AiError(409, "AI_MEDIA_TASK_CONFLICT", message); }
function validId(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) invalid(`${label}无效`);
  return value;
}
function validVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !VERSION.test(value)) invalid(`${label}无效`);
  return value;
}
function points(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000_000) invalid("预算额度无效");
  return Number(value);
}
function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid(`${label}无效`);
  return Number(value);
}
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 16) invalid(`${label}无效`);
  const parsed = value.map(item => validId(item, label));
  if (new Set(parsed).size !== parsed.length) invalid(`${label}重复`);
  return parsed;
}
function grant(value: MediaTaskAuthorizationScope): MediaTaskAuthorizationScope {
  if (!value || !Array.isArray(value.capabilities) || !value.capabilities.length || value.capabilities.length > 2
    || value.capabilities.some(item => !CAPABILITIES.has(item)) || new Set(value.capabilities).size !== value.capabilities.length
    || typeof value.automaticChoice !== "boolean") invalid("授权范围无效");
  if (points(value.maxPointsPerTool) === 0) invalid("授权预算必须大于零");
  return {
    grantId: validId(value.grantId, "授权标识"), capabilities: [...value.capabilities],
    sourceAssetIds: ids(value.sourceAssetIds, "授权素材"), maxPointsPerTool: points(value.maxPointsPerTool),
    budgetVersion: validVersion(value.budgetVersion, "预算版本"),
    modelConfigVersion: validVersion(value.modelConfigVersion, "模型配置版本"),
    automaticChoice: value.automaticChoice, expiresAt: timestamp(value.expiresAt, "授权期限"),
  };
}
function videoParameters(value: MediaTaskVideoParameters): MediaTaskVideoParameters {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some(key => !["model", "seconds", "resolution", "aspectRatio", "referenceIds"].includes(key))
    || typeof value.model !== "string") invalid("视频参数无效");
  const model = videoModel(value.model);
  if (!model?.generationEnabled || !(model.resolutions as readonly string[]).includes(value.resolution)
    || !Number.isInteger(value.seconds) || !videoSeconds(model.id, value.resolution).includes(value.seconds)
    || (value.aspectRatio !== "16:9" && value.aspectRatio !== "9:16")
    || !Array.isArray(value.referenceIds) || value.referenceIds.length > model.maxImages
    || value.referenceIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    || new Set(value.referenceIds).size !== value.referenceIds.length
    || (model.requiresImage && !value.referenceIds.length)) invalid("视频模型、时长、清晰度、画幅或参考图不兼容");
  return {
    model: model.id, seconds: value.seconds, resolution: value.resolution,
    aspectRatio: value.aspectRatio, referenceIds: [...value.referenceIds],
  };
}
function createInput(value: MediaTaskCreateInput): MediaTaskCreateInput {
  if (!ENTRYPOINTS.has(value.entrypoint) || !TIERS.has(value.tier) || !CAPABILITIES.has(value.intent)) invalid("任务入口或类型无效");
  if (value.videoParameters !== undefined && value.intent !== "video") invalid("图片任务不能携带视频参数");
  if (typeof value.requestText !== "string" || !value.requestText.trim() || value.requestText.length > 12_000 || /\u0000/.test(value.requestText)) invalid("任务描述无效");
  if (value.contextRevision !== undefined && (!Number.isSafeInteger(value.contextRevision) || value.contextRevision < 0)) invalid("会话版本无效");
  if (value.contextMessages !== undefined && (!Array.isArray(value.contextMessages) || value.contextMessages.length > 12)) invalid("会话上下文无效");
  let contextLength = 0;
  const contextMessages = value.contextMessages?.map(item => {
    if (!item || (item.role !== "user" && item.role !== "assistant")
      || typeof item.sourceMessageId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(item.sourceMessageId)
      || typeof item.content !== "string" || !item.content.trim() || item.content.length > 1200 || /\u0000/.test(item.content)) invalid("会话上下文无效");
    contextLength += item.content.length;
    return { sourceMessageId: item.sourceMessageId, role: item.role, content: item.content.trim() };
  });
  if (contextLength > 6000 || (contextMessages && new Set(contextMessages.map(item => item.sourceMessageId)).size !== contextMessages.length)) invalid("会话上下文过长或重复");
  const sourceAssetIds = ids(value.sourceAssetIds, "参考素材");
  if (value.sourceFingerprints !== undefined && (!Array.isArray(value.sourceFingerprints)
    || value.sourceFingerprints.length !== sourceAssetIds.length
    || value.sourceFingerprints.some(item => typeof item !== "string" || !/^[a-f0-9]{64}$/.test(item)))) invalid("参考素材指纹无效");
  return {
    requestId: validId(value.requestId, "请求标识"), conversationId: validId(value.conversationId, "会话标识"),
    entrypoint: value.entrypoint, tier: value.tier, intent: value.intent, requestText: value.requestText.trim(),
    ...(contextMessages?.length ? { contextMessages } : {}),
    ...(value.contextRevision !== undefined ? { contextRevision: value.contextRevision } : {}),
    modelConfigVersion: validVersion(value.modelConfigVersion, "模型配置版本"),
    sourceAssetIds,
    ...(value.sourceFingerprints !== undefined ? { sourceFingerprints: [...value.sourceFingerprints] } : {}),
    ...(value.videoParameters !== undefined ? { videoParameters: videoParameters(value.videoParameters) } : {}),
    authorizationScope: value.authorizationScope === null ? null : grant(value.authorizationScope),
    deadlineAt: timestamp(value.deadlineAt, "任务截止时间"),
  };
}
function toolSpec(value: MediaTaskToolSpec): MediaTaskToolSpec {
  if (!CAPABILITIES.has(value.capability)) invalid("工具能力无效");
  if (points(value.estimatedPoints) === 0) invalid("媒体工具必须声明预计额度");
  return {
    capability: value.capability, operationKey: validId(value.operationKey, "步骤标识"),
    estimatedPoints: points(value.estimatedPoints), sourceAssetIds: ids(value.sourceAssetIds, "工具素材"),
    ...(value.planRequestId ? { planRequestId: validId(value.planRequestId, "方案标识") } : {}),
  };
}
function options(value: MediaTaskQuestionOption[]): MediaTaskQuestionOption[] {
  if (!Array.isArray(value) || !value.length || value.length > 6) invalid("选项数量无效");
  const result = value.map(item => {
    if (typeof item.label !== "string" || !item.label.trim() || item.label.length > 120 || /[\u0000-\u001f\u007f]/.test(item.label)) invalid("选项内容无效");
    if (item.capability !== undefined && !CAPABILITIES.has(item.capability)) invalid("选项能力无效");
    return {
      id: validId(item.id, "选项标识"), label: item.label.trim(), estimatedPoints: points(item.estimatedPoints),
      ...(item.capability ? { capability: item.capability } : {}),
      ...(item.sourceAssetIds ? { sourceAssetIds: ids(item.sourceAssetIds, "选项素材") } : {}),
    };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) invalid("选项标识重复");
  return result;
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

/** Persisted coordination only. Planning and generation are supplied by the
 * existing service adapters, which retain their own one-time plan claims,
 * atomic quota reservations and provider idempotency. */
export class MediaTaskRuntime {
  constructor(readonly store: AiStore, private readonly now: () => number = () => Date.now()) {
    // Additive for existing Node SQLite and Cloudflare SQLite-backed DOs.
    this.store.sql.exec(MEDIA_TASK_SCHEMA);
  }
  forTenant(tenantId: string): MediaTaskRuntime { return new MediaTaskRuntime(this.store.forTenant(tenantId), this.now); }
  private userKey(userId: string): string { return tenantStorageKey(this.store.tenantId, validId(userId, "用户标识")); }
  private save(run: MediaTaskRun): void {
    this.store.sql.exec(
      "UPDATE ai_media_task_runs SET status=?,due_at=?,deadline_at=?,data=? WHERE tenant_id=? AND user_id=? AND run_id=?",
      run.status, run.dueAt, run.deadlineAt, JSON.stringify(run), this.store.tenantId, this.userKey(run.userId), run.runId,
    );
  }
  private load(userId: string, runId: string): MediaTaskRun | null {
    const row = this.store.sql.all<{ data: string }>(
      "SELECT data FROM ai_media_task_runs WHERE tenant_id=? AND user_id=? AND run_id=?",
      this.store.tenantId, this.userKey(userId), validId(runId, "任务标识"),
    )[0];
    return row ? JSON.parse(row.data) as MediaTaskRun : null;
  }
  private required(userId: string, runId: string): MediaTaskRun {
    const run = this.load(userId, runId);
    if (!run) throw new AiError(404, "AI_MEDIA_TASK_NOT_FOUND", "没有找到这条任务");
    return run;
  }
  private update(run: MediaTaskRun): MediaTaskRun {
    run.version += 1;
    run.updatedAt = this.now();
    this.save(run);
    return clone(run);
  }
  private appendArtifactReady(run: MediaTaskRun): void {
    if (run.status !== "completed" || !run.tool?.artifactIds?.length) conflict("成果尚未完成");
    const seq = (this.store.sql.all<{ seq: number }>(
      "SELECT MAX(seq) AS seq FROM ai_media_task_events WHERE tenant_id=? AND user_id=? AND run_id=?",
      this.store.tenantId, this.userKey(run.userId), run.runId,
    )[0]?.seq ?? 0) + 1;
    if (seq > 4096) throw new AiError(502, "AI_EVENT_LIMIT", "任务事件超过上限");
    const event: AiMediaTaskEvent = {
      type: "artifact_ready", data: { capability: run.tool.capability, artifactIds: [...run.tool.artifactIds] },
      requestId: run.requestId, runId: run.runId, stepId: run.stepId, seq, timestamp: this.now(),
    };
    this.store.sql.exec(
      "INSERT INTO ai_media_task_events(tenant_id,user_id,run_id,seq,data) VALUES(?,?,?,?,?)",
      this.store.tenantId, this.userKey(run.userId), run.runId, seq, JSON.stringify(event),
    );
  }
  get(userId: string, runId: string): MediaTaskRun | null { return clone(this.load(userId, runId)); }
  events(userId: string, runId: string, after = 0): AiMediaTaskEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new AiError(400, "AI_EVENT_CURSOR_INVALID", "事件游标无效");
    this.required(userId, runId);
    return this.store.sql.all<{ data: string }>(
      "SELECT data FROM ai_media_task_events WHERE tenant_id=? AND user_id=? AND run_id=? AND seq>? ORDER BY seq LIMIT 512",
      this.store.tenantId, this.userKey(userId), runId, after,
    ).map(row => JSON.parse(row.data) as AiMediaTaskEvent);
  }
  snapshot(userId: string, runId: string): MediaTaskSnapshot | null {
    const row = this.store.sql.all<{ data: string }>(
      "SELECT data FROM ai_media_task_snapshots WHERE tenant_id=? AND user_id=? AND run_id=?",
      this.store.tenantId, this.userKey(userId), validId(runId, "任务标识"),
    )[0];
    return row ? JSON.parse(row.data) as MediaTaskSnapshot : null;
  }
  submit(userId: string, value: MediaTaskCreateInput): MediaTaskRun {
    const normalized = createInput(value);
    const storedUserId = this.userKey(userId);
    return this.store.sql.transaction(() => {
      const prior = this.store.sql.all<{ data: string }>(
        "SELECT data FROM ai_media_task_runs WHERE tenant_id=? AND user_id=? AND request_id=?",
        this.store.tenantId, storedUserId, normalized.requestId,
      )[0];
      if (prior) {
        const run = JSON.parse(prior.data) as MediaTaskRun;
        const snapshot = this.snapshot(userId, run.runId);
        if (!snapshot || JSON.stringify(createInput(snapshot)) !== JSON.stringify(normalized)) conflict("相同请求标识对应不同任务输入");
        return clone(run);
      }
      const now = this.now();
      if (normalized.deadlineAt <= now) invalid("任务截止时间必须晚于提交时间");
      const runId = crypto.randomUUID();
      const snapshot: MediaTaskSnapshot = { ...normalized, tenantId: this.store.tenantId, userId, runId, createdAt: now };
      const run: MediaTaskRun = {
        tenantId: this.store.tenantId, userId, conversationId: normalized.conversationId,
        requestId: normalized.requestId, runId, stepId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
        version: 1, status: "queued", createdAt: now, updatedAt: now,
        deadlineAt: normalized.deadlineAt, dueAt: now,
        ...(normalized.authorizationScope ? { authorization: normalized.authorizationScope } : {}),
      };
      this.store.sql.exec(
        "INSERT INTO ai_media_task_snapshots(tenant_id,user_id,run_id,data) VALUES(?,?,?,?)",
        this.store.tenantId, storedUserId, runId, JSON.stringify(snapshot),
      );
      this.store.sql.exec(
        "INSERT INTO ai_media_task_runs(tenant_id,user_id,run_id,request_id,conversation_id,status,due_at,deadline_at,data) VALUES(?,?,?,?,?,?,?,?,?)",
        this.store.tenantId, storedUserId, runId, run.requestId, run.conversationId, run.status, run.dueAt, run.deadlineAt, JSON.stringify(run),
      );
      return clone(run);
    });
  }
  /** A scheduler may discover work, but discovery does not invoke a tool. */
  due(limit = 8, at = this.now()): MediaTaskRun[] {
    const bounded = Math.max(1, Math.min(32, Math.trunc(limit) || 8));
    return this.store.sql.all<{ data: string }>(
      "SELECT data FROM ai_media_task_runs WHERE tenant_id=? AND due_at<=? AND status IN ('queued','planning','awaiting_input','awaiting_authorization','running','partial') ORDER BY due_at ASC LIMIT ?",
      this.store.tenantId, at, bounded,
    ).map(row => JSON.parse(row.data) as MediaTaskRun);
  }
  /** Maintenance view only. Re-scope to the returned tenant before mutation. */
  dueCandidates(limit = 8, at = this.now()): Array<{ tenantId: string; userId: string; runId: string }> {
    const bounded = Math.max(1, Math.min(32, Math.trunc(limit) || 8));
    const rows = this.store.sql.all<{ tenant_id: string; user_id: string; run_id: string }>(
      "SELECT tenant_id,user_id,run_id FROM ai_media_task_runs WHERE due_at<=? AND status IN ('queued','planning','awaiting_input','awaiting_authorization','running','partial') ORDER BY due_at ASC LIMIT ?",
      at, bounded,
    );
    const candidates: Array<{ tenantId: string; userId: string; runId: string }> = [];
    for (const row of rows) {
      try { candidates.push({ tenantId: row.tenant_id, userId: tenantStorageValue(row.tenant_id, row.user_id), runId: row.run_id }); }
      catch { /* A malformed tenant key must not widen maintenance scope. */ }
    }
    return candidates;
  }
  /** A disabled account must not monopolize the bounded scheduler window.
   * This changes only the next inspection time, never consent or paid state. */
  deferInactive(userId: string, runId: string): MediaTaskRun {
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.dueAt === null || run.dueAt > this.now() || !["queued", "planning", "awaiting_input", "awaiting_authorization", "running", "partial"].includes(run.status)) {
        return clone(run);
      }
      run.dueAt = this.now() + 5 * 60_000;
      return this.update(run);
    });
  }
  claimPlanning(userId: string, runId: string): MediaTaskRun | null {
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "queued") return null;
      if (run.deadlineAt <= this.now()) {
        run.status = "failed"; run.errorCode = "AI_MEDIA_TASK_DEADLINE"; run.dueAt = null;
        this.update(run);
        return null;
      }
      run.status = "planning";
      // An interrupted paid planner request must be reconciled, not replayed.
      run.dueAt = Math.min(run.deadlineAt, this.now() + RECOVERY_POLL_MS);
      return this.update(run);
    });
  }
  /** Read-only reconciliation may defer its next inspection; never reissue a
   * request solely because it remains pending in the provider journal. */
  schedulePoll(userId: string, runId: string): MediaTaskRun {
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (!["planning", "running", "partial"].includes(run.status)) return clone(run);
      run.dueAt = Math.min(run.deadlineAt, this.now() + RECOVERY_POLL_MS);
      return this.update(run);
    });
  }
  /** Unknown planner outcomes freeze the task rather than resending it. */
  failPlanning(userId: string, runId: string, errorCode: string, outcome: "failed" | "unknown" = "failed"): MediaTaskRun {
    validVersion(errorCode, "错误代码");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "planning") conflict("当前任务不在规划中");
      run.status = outcome;
      run.errorCode = errorCode;
      run.dueAt = null;
      return this.update(run);
    });
  }
  /** Clarification is distinct from selecting parameters or authorizing cost. */
  awaitInput(userId: string, runId: string, prompt: string, deadlineAt: number): MediaTaskRun {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > 500 || /[\u0000-\u001f\u007f]/.test(prompt)) invalid("追问内容无效");
    timestamp(deadlineAt, "追问期限");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "planning") conflict("当前任务不能追问");
      if (deadlineAt <= this.now() || deadlineAt > run.deadlineAt) invalid("追问期限超出任务范围");
      run.freeQuestion = { questionId: crypto.randomUUID(), prompt: prompt.trim(), deadlineAt };
      run.status = "awaiting_input";
      run.dueAt = deadlineAt;
      return this.update(run);
    });
  }
  answerInput(userId: string, runId: string, questionId: string, answer: string): MediaTaskRun {
    validId(questionId, "问题标识");
    if (typeof answer !== "string" || !answer.trim() || answer.trim().length > 2000 || /\u0000/.test(answer)) invalid("回答内容无效");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      const question = run.freeQuestion;
      if (!question || question.questionId !== questionId) conflict("追问已失效");
      if (question.answer !== undefined) {
        if (question.answer !== answer.trim()) conflict("追问已经由另一份回答完成");
        return clone(run);
      }
      if (run.status !== "awaiting_input" || question.deadlineAt <= this.now() || run.deadlineAt <= this.now()) conflict("追问已过期");
      question.answer = answer.trim();
      question.answeredAt = this.now();
      run.inputAnswers = [...(run.inputAnswers ?? []), { questionId, answer: question.answer, answeredAt: question.answeredAt }];
      run.stepId = crypto.randomUUID();
      run.attemptId = crypto.randomUUID();
      run.status = "queued";
      run.dueAt = this.now();
      return this.update(run);
    });
  }
  /** An unanswered clarification expires without selecting an option, granting
   * budget, or starting a provider call. */
  expireInput(userId: string, runId: string): MediaTaskRun {
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "awaiting_input" || !run.freeQuestion || run.freeQuestion.answer !== undefined) return clone(run);
      if (run.freeQuestion.deadlineAt > this.now()) return clone(run);
      run.status = "failed";
      run.errorCode = "AI_MEDIA_TASK_INPUT_TIMEOUT";
      run.dueAt = null;
      return this.update(run);
    });
  }
  openQuestion(userId: string, runId: string, input: { options: MediaTaskQuestionOption[]; defaultOptionId: string; deadlineAt: number }): MediaTaskRun {
    const normalizedOptions = options(input.options);
    const defaultOptionId = validId(input.defaultOptionId, "默认选项");
    if (!normalizedOptions.some(item => item.id === defaultOptionId)) invalid("默认选项不在有效选项内");
    const deadlineAt = timestamp(input.deadlineAt, "选择截止时间");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "planning") conflict("当前任务不能打开选择");
      if (run.deadlineAt <= this.now() || deadlineAt > run.deadlineAt) invalid("选择截止时间超出任务期限");
      run.question = { questionId: crypto.randomUUID(), options: normalizedOptions, defaultOptionId, deadlineAt };
      run.status = "awaiting_input";
      run.dueAt = deadlineAt;
      return this.update(run);
    });
  }
  grantAuthorization(userId: string, runId: string, input: MediaTaskAuthorizationScope): MediaTaskRun {
    const authorization = grant(input);
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (["running", "partial", "completed", "failed", "cancelled", "unknown"].includes(run.status)) conflict("当前任务不能更改授权");
      if (run.deadlineAt <= this.now()) conflict("任务已超过截止时间");
      if (authorization.expiresAt <= this.now()) invalid("授权已过期");
      run.authorization = authorization;
      if (run.status === "awaiting_input" && run.question && run.question.deadlineAt <= this.now()) run.dueAt = this.now();
      if (run.status === "awaiting_authorization") run.dueAt = this.now();
      return this.update(run);
    });
  }
  settleQuestion(userId: string, runId: string, questionId: string, optionId: string, source: "user" | "timeout", guard?: MediaTaskExecutionGuard): MediaTaskChoiceResult {
    validId(questionId, "问题标识"); validId(optionId, "选项标识");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      const question = run.question;
      if (!question || question.questionId !== questionId) conflict("选择卡已失效");
      if (question.selectedOptionId) return { kind: "already_selected", run: clone(run) };
      if (run.status !== "awaiting_input") conflict("当前任务不等待选择");
      if (run.deadlineAt <= this.now()) {
        run.status = "failed"; run.errorCode = "AI_MEDIA_TASK_DEADLINE"; run.dueAt = null;
        return { kind: "expired", run: this.update(run) };
      }
      const selected = question.options.find(item => item.id === optionId);
      if (!selected) invalid("选项无效");
      if (source === "timeout") {
        if (this.now() < question.deadlineAt) return { kind: "not_due", run: clone(run) };
        const blocked = (kind: MediaTaskQuestion["timeoutBlockedReason"]): MediaTaskChoiceResult => {
          question.timeoutBlockedReason = kind;
          run.dueAt = null;
          return { kind: kind!, run: this.update(run) };
        };
        if (optionId !== question.defaultOptionId || !run.authorization?.automaticChoice || run.authorization.expiresAt <= this.now() || !guard
          || !selected.capability || !run.authorization.capabilities.includes(selected.capability)
          || !selected.sourceAssetIds || selected.sourceAssetIds.some(id => !run.authorization!.sourceAssetIds.includes(id))
          || selected.estimatedPoints > run.authorization.maxPointsPerTool) return blocked("not_authorized");
        if (guard.modelConfigVersion !== run.authorization.modelConfigVersion) return blocked("configuration_changed");
        if (guard.budgetVersion !== run.authorization.budgetVersion || guard.availablePoints < selected.estimatedPoints) return blocked("budget_changed");
        if (!guard.sourceAssetsValid) return blocked("source_unavailable");
      }
      question.selectedOptionId = optionId;
      question.selectedBy = source;
      question.selectedAt = this.now();
      delete question.timeoutBlockedReason;
      run.status = "planning";
      run.dueAt = this.now();
      return { kind: "selected", run: this.update(run) };
    });
  }
  stageTool(userId: string, runId: string, value: MediaTaskToolSpec): MediaTaskRun {
    const spec = toolSpec(value);
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.tool?.operationKey === spec.operationKey && JSON.stringify(toolSpec(run.tool)) === JSON.stringify(spec)) return clone(run);
      if (run.status !== "planning") conflict("当前任务不能提交工具方案");
      if (run.deadlineAt <= this.now()) conflict("任务已超过截止时间");
      if (run.tool) conflict("当前任务已有工具步骤");
      run.stepId = crypto.randomUUID();
      run.tool = spec;
      run.status = "awaiting_authorization";
      // A grant frozen with an explicit submission may proceed after a
      // scheduler restart. No grant means this task remains a proposal.
      run.dueAt = run.authorization ? this.now() : null;
      return this.update(run);
    });
  }
  /** A stale explicit grant cannot keep a scheduler hot-looping. The tool
   * remains a draft until the member confirms a fresh bound authorization. */
  pauseAuthorization(userId: string, runId: string, reason: string): MediaTaskRun {
    validVersion(reason, "授权暂停原因");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "awaiting_authorization") return clone(run);
      run.errorCode = reason;
      run.dueAt = null;
      return this.update(run);
    });
  }
  beginTool(userId: string, runId: string, guard: MediaTaskExecutionGuard): MediaTaskBeginResult {
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status === "unknown") return { kind: "unknown", run: clone(run) };
      if (run.status === "running" && run.tool?.toolCallId) return { kind: "already_started", run: clone(run) };
      if (run.status !== "awaiting_authorization" || !run.tool) conflict("当前任务没有待执行工具");
      if (run.deadlineAt <= this.now()) {
        run.status = "failed"; run.errorCode = "AI_MEDIA_TASK_DEADLINE"; run.dueAt = null;
        return { kind: "expired", run: this.update(run) };
      }
      const authorization = run.authorization;
      const tool = run.tool;
      if (!authorization || authorization.expiresAt <= this.now() || !authorization.capabilities.includes(tool.capability)
        || tool.estimatedPoints > authorization.maxPointsPerTool
        || tool.sourceAssetIds.some(id => !authorization.sourceAssetIds.includes(id))) return { kind: "not_authorized", run: clone(run) };
      const snapshot = this.snapshot(userId, runId);
      if (!snapshot || snapshot.modelConfigVersion !== guard.modelConfigVersion || authorization.modelConfigVersion !== guard.modelConfigVersion) return { kind: "configuration_changed", run: clone(run) };
      if (authorization.budgetVersion !== guard.budgetVersion || !Number.isSafeInteger(guard.availablePoints) || guard.availablePoints < tool.estimatedPoints) return { kind: "budget_changed", run: clone(run) };
      if (!guard.sourceAssetsValid) return { kind: "source_unavailable", run: clone(run) };
      tool.toolCallId = crypto.randomUUID();
      tool.idempotencyKey = `tongpin-media-${tool.toolCallId}`;
      tool.grantId = authorization.grantId;
      tool.inputSnapshot = {
        tenantId: run.tenantId, userId: run.userId, conversationId: run.conversationId, runId: run.runId,
        stepId: run.stepId, attemptId: run.attemptId, toolCallId: tool.toolCallId,
        tier: snapshot.tier, modelConfigVersion: snapshot.modelConfigVersion,
        budgetVersion: authorization.budgetVersion, sourceAssetIds: [...tool.sourceAssetIds], grantId: authorization.grantId,
        ...(snapshot.videoParameters ? { videoParameters: snapshot.videoParameters } : {}),
      };
      run.status = "running";
      run.dueAt = Math.min(run.deadlineAt, this.now() + RECOVERY_POLL_MS);
      return { kind: "started", run: this.update(run) };
    });
  }
  recordToolSubmission(userId: string, runId: string, toolCallId: string, serviceRequestId: string, pollAt: number): MediaTaskRun {
    validId(toolCallId, "工具调用标识"); validId(serviceRequestId, "服务任务标识"); timestamp(pollAt, "查询时间");
    if (serviceRequestId !== toolCallId) conflict("服务任务必须沿用工具调用标识");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status !== "running" || run.tool?.toolCallId !== toolCallId) conflict("工具调用状态不匹配");
      if (run.tool.serviceRequestId) {
        if (run.tool.serviceRequestId !== serviceRequestId) conflict("工具提交结果不一致");
        run.dueAt = Math.min(run.deadlineAt, pollAt);
        return this.update(run);
      }
      run.tool.serviceRequestId = serviceRequestId;
      run.tool.submittedAt = this.now();
      run.dueAt = Math.min(run.deadlineAt, pollAt);
      return this.update(run);
    });
  }
  completeTool(userId: string, runId: string, toolCallId: string, artifactIds: string[]): MediaTaskRun {
    validId(toolCallId, "工具调用标识");
    const readyAssets = ids(artifactIds, "成果素材");
    if (!readyAssets.length) invalid("成果尚未就绪");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.tool?.toolCallId !== toolCallId) conflict("工具调用状态不匹配");
      if (run.status === "completed") {
        if (JSON.stringify(run.tool.artifactIds) !== JSON.stringify(readyAssets)) conflict("成果记录不一致");
        return clone(run);
      }
      if (!["running", "partial", "unknown"].includes(run.status)) conflict("当前任务不能确认成果");
      run.tool.artifactIds = readyAssets;
      run.status = "completed";
      run.dueAt = null;
      const completed = this.update(run);
      this.appendArtifactReady(run);
      return completed;
    });
  }
  recordPartial(userId: string, runId: string, toolCallId: string, artifactIds: string[], reason: string): MediaTaskRun {
    validId(toolCallId, "工具调用标识");
    const partialAssets = ids(artifactIds, "部分成果素材");
    if (!partialAssets.length || typeof reason !== "string" || !VERSION.test(reason)) invalid("部分成果依据无效");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.tool?.toolCallId !== toolCallId || !["running", "partial"].includes(run.status)) conflict("工具调用状态不匹配");
      if (run.status === "partial" && JSON.stringify(run.tool.partialArtifactIds) === JSON.stringify(partialAssets) && run.tool.partialReason === reason) return clone(run);
      run.tool.partialArtifactIds = partialAssets;
      run.tool.partialReason = reason;
      run.status = "partial";
      run.dueAt = run.deadlineAt;
      return this.update(run);
    });
  }
  failTool(userId: string, runId: string, toolCallId: string, errorCode: string, outcome: "failed" | "unknown"): MediaTaskRun {
    validId(toolCallId, "工具调用标识"); validVersion(errorCode, "错误代码");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.tool?.toolCallId !== toolCallId || !["running", "partial", "unknown"].includes(run.status)) conflict("工具调用状态不匹配");
      run.tool.errorCode = errorCode;
      run.status = outcome;
      run.errorCode = errorCode;
      run.dueAt = null;
      return this.update(run);
    });
  }
  cancel(userId: string, runId: string): MediaTaskRun {
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (["completed", "failed", "cancelled"].includes(run.status)) return clone(run);
      if (run.cancelRequested) return clone(run);
      if (["running", "partial", "unknown"].includes(run.status)) {
        // The provider may already be charging; only its acknowledged cancel or
        // a reconciliation can decide the final state.
        run.cancelRequested = true;
        run.dueAt = this.now();
      } else {
        run.status = "cancelled";
        run.dueAt = null;
      }
      return this.update(run);
    });
  }
  /** Only call after the adapter verifies the provider acknowledged cancellation. */
  acknowledgeCancel(userId: string, runId: string, toolCallId: string): MediaTaskRun {
    validId(toolCallId, "工具调用标识");
    return this.store.sql.transaction(() => {
      const run = this.required(userId, runId);
      if (run.status === "cancelled" && run.tool?.toolCallId === toolCallId) return clone(run);
      if (!run.cancelRequested || run.tool?.toolCallId !== toolCallId || !["running", "partial", "unknown"].includes(run.status)) conflict("取消结果与任务不匹配");
      run.status = "cancelled";
      run.dueAt = null;
      return this.update(run);
    });
  }
  /** Expiry freezes ambiguous in-flight work. It does not send or retry a paid call. */
  sweepExpired(at = this.now()): number {
    const rows = this.store.sql.all<{ user_id: string; run_id: string }>(
      "SELECT user_id,run_id FROM ai_media_task_runs WHERE tenant_id=? AND deadline_at<=? AND status IN ('queued','planning','awaiting_input','awaiting_authorization','running','partial')",
      this.store.tenantId, at,
    );
    let count = 0;
    for (const row of rows) this.store.sql.transaction(() => {
      const userId = tenantStorageValue(this.store.tenantId, row.user_id);
      const run = this.required(userId, row.run_id);
      if (run.deadlineAt > at || !["queued", "planning", "awaiting_input", "awaiting_authorization", "running", "partial"].includes(run.status)) return;
      run.status = run.tool?.toolCallId || run.status === "planning" ? "unknown" : "failed";
      run.errorCode = "AI_MEDIA_TASK_DEADLINE";
      run.dueAt = null;
      this.update(run);
      count += 1;
    });
    return count;
  }
}
