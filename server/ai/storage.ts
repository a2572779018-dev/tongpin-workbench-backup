import type { AiChatResponse, AiHarnessCapability, AiHarnessConfig, AiHarnessRunStatus, AiHarnessStep, AiImageAsset, AiImageMimeType, AiImageResponse, AiMode, AiObservabilityAlert, AiObservabilityDashboard, AiObservabilitySlice, AiProviderConfig, AiQuota, AiRequestResult, AiUsageEntry } from "../../shared/ai";
import { AiError } from "./security";
import { DEFAULT_AI_TENANT_ID, normalizeAiTenantId, tenantStorageKey, tenantStorageValue } from "./tenant";
import { aiLatencyThresholds } from "./observabilityThresholds";
import type { AiRunEvent, AiRunEventPayload } from "../../shared/aiRunEvents";
import { applyAiModuleMigrations } from "./aiMigrations";
import { MEMBER_MEMORY_MIGRATIONS } from "./memberMemoryStore";

export interface AiSql {
  exec(query: string, ...bindings: Array<string | number | null>): void;
  all<T>(query: string, ...bindings: Array<string | number | null>): T[];
  transaction<T>(action: () => T): T;
}
export const AI_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_settings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_video_jobs (user_id TEXT NOT NULL, id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', data TEXT NOT NULL, PRIMARY KEY(user_id,id));
CREATE TABLE IF NOT EXISTS ai_video_references (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', public_id TEXT, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_quotas (user_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_requests (user_id TEXT NOT NULL, request_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', data TEXT NOT NULL, PRIMARY KEY(user_id, request_id));
CREATE TABLE IF NOT EXISTS ai_request_snapshots (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant_id,user_id,request_id,chunk_index));
CREATE TABLE IF NOT EXISTS ai_run_events (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant_id,user_id,request_id,seq));
CREATE TABLE IF NOT EXISTS ai_harness_runs (user_id TEXT NOT NULL, id TEXT NOT NULL, request_id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', conversation_id TEXT NOT NULL, tier TEXT NOT NULL, provider_id TEXT NOT NULL, capability TEXT NOT NULL, goal_kind TEXT NOT NULL, goal_summary TEXT NOT NULL, background_capable INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, reasoning_summary TEXT NOT NULL, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id,id), UNIQUE(user_id,request_id));
CREATE INDEX IF NOT EXISTS ai_harness_runs_user_time ON ai_harness_runs(user_id, started_at DESC);
CREATE TABLE IF NOT EXISTS ai_harness_steps (user_id TEXT NOT NULL, run_id TEXT NOT NULL, id TEXT NOT NULL, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', data TEXT NOT NULL, PRIMARY KEY(user_id,run_id,id));
CREATE INDEX IF NOT EXISTS ai_harness_steps_run ON ai_harness_steps(user_id,run_id);
CREATE TABLE IF NOT EXISTS ai_observability_events (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', user_id TEXT NOT NULL, tier TEXT NOT NULL, provider_id TEXT NOT NULL, capability TEXT NOT NULL, operation TEXT NOT NULL DEFAULT 'execution', success INTEGER NOT NULL, latency_ms INTEGER NOT NULL, first_visible_ms INTEGER, error_code TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ai_observability_time ON ai_observability_events(created_at DESC);
CREATE TABLE IF NOT EXISTS ai_observability_alerts (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', fingerprint TEXT NOT NULL, code TEXT NOT NULL, severity TEXT NOT NULL, tier TEXT NOT NULL, provider_id TEXT NOT NULL, capability TEXT NOT NULL, message TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, occurrence_count INTEGER NOT NULL, acknowledged_at INTEGER, acknowledged_by TEXT, resolved_at INTEGER);
CREATE INDEX IF NOT EXISTS ai_observability_alerts_tenant_time ON ai_observability_alerts(tenant_id,last_seen_at DESC);
CREATE INDEX IF NOT EXISTS ai_observability_alerts_active ON ai_observability_alerts(tenant_id,fingerprint,resolved_at);
CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', user_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_usage_user_time ON ai_usage(user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ai_assets (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}', user_id TEXT NOT NULL, mime_type TEXT NOT NULL, byte_length INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ai_assets_user ON ai_assets(user_id);
CREATE TABLE IF NOT EXISTS ai_asset_chunks (asset_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(asset_id, chunk_index));
`;
export interface StoredProvider extends AiProviderConfig {
  encryptedKey: string;
  encryptedImageKey?: string;
  modelConfigVersion?: string;
  modelKeyVersion?: string;
  verifiedModelConfigVersion?: string;
  verifiedModelKeyVersion?: string;
  verifiedModels?: unknown;
  verifiedModelsAt?: string;
}
type PublicHarnessProvider = AiHarnessConfig["providers"][number];

export type StoredHarnessProvider = PublicHarnessProvider & {
  encryptedKey: string;
  configVersion: string;
  keyVersion: string;
  verifiedConfigVersion?: string;
  verifiedKeyVersion?: string;
  /** Models the gateway lists but answered model_not_found for, bound to the
   * connection version that produced them. Re-reading models keeps them out;
   * a new key or address lifts the quarantine. */
  modelQuarantine?: { configVersion: string; keyVersion: string; models: string[] };
};
export interface StoredHarnessConfig extends Omit<AiHarnessConfig, "providers"> {
  providers: StoredHarnessProvider[];
}
export interface StoredHarnessRun {
  id: string;
  requestId: string;
  userId: string;
  conversationId: string;
  tier: AiMode;
  providerId: string;
  capability: AiHarnessCapability;
  /** Private, application-authored continuation context. It is never projected
   * into member traces or observability records. */
  goalKind: AiHarnessCapability;
  goalSummary: string;
  /** Only runs created by a background-aware application version may be
   * discovered by maintenance. Legacy rows migrate to false. */
  backgroundCapable?: boolean;
  status: AiHarnessRunStatus;
  reasoningSummary: string;
  startedAt: number;
  updatedAt: number;
}
export interface AiBackgroundHarnessCandidate {
  tenantId: string;
  userId: string;
  requestId: string;
}
export interface StoredRequest {
  requestId: string;
  userId: string;
  hash: string;
  status: "pending" | "completed" | "failed" | "uncertain";
  createdAt: string;
  expiresAt: number;
  inputReserve: number;
  outputReserve: number;
  convertedReserve?: number;
  /** "computer" = one Jev decision of the computer executor (points in convertedReserve). */
  kind?: "chat" | "image" | "computer";
  model: string;
  mode: AiMode;
  conversationId?: string;
  providerId?: string;
  harnessRunId?: string;
  attempt?: AiChatResponse["attempt"];
  generation?: import("../../shared/ai").AiGenerationDiagnostic;
  /** Request acceptance to the first emitted public answer fragment, if any. */
  firstVisibleMs?: number;
  toolPlanRequestId?: string;
  result?: Omit<AiChatResponse, "quota">;
  imageResult?: Omit<AiImageResponse, "quota">;
  error?: AiRequestResult["error"];
  /** Tool plans expire and may authorize exactly one persisted generation request. */
  toolPlanExpiresAt?: number;
  /** SHA-256 of the normalized project context and attachments used to create the plan. */
  toolPlanContextFingerprint?: string;
  toolPlanConsumedBy?: string;
  toolPlanConsumedAt?: string;
}
export interface StoredActiveVideoJob {
  id: string;
  userId: string;
  conversationId?: string;
  status: "submitting" | "queued" | "processing";
}
export interface StoredVideoConversationLock extends Omit<StoredActiveVideoJob, "status"> {
  status: StoredActiveVideoJob["status"] | "uncertain";
}
export function emptyQuota(): AiQuota {
  return { limitTokens: 0, usedTokens: 0, reservedTokens: 0, remainingTokens: 0, inputTokens: 0, outputTokens: 0 };
}
export class AiStore {
  readonly tenantId: string;
  constructor(readonly sql: AiSql, tenantId: string = DEFAULT_AI_TENANT_ID) { this.tenantId = normalizeAiTenantId(tenantId); }
  forTenant(tenantId: string): AiStore { return normalizeAiTenantId(tenantId) === this.tenantId ? this : new AiStore(this.sql, tenantId); }
  private userKey(userId: string): string { return tenantStorageKey(this.tenantId, userId); }
  private settingKey(id: string): string { return tenantStorageKey(this.tenantId, id); }
  initialize(): void {
    this.sql.exec(AI_SCHEMA);
    for (const table of ["ai_settings", "ai_video_jobs", "ai_video_references", "ai_quotas", "ai_requests", "ai_harness_runs", "ai_harness_steps", "ai_observability_events", "ai_observability_alerts", "ai_usage", "ai_assets"] as const) {
      const columns = this.sql.all<{ name: string }>(`PRAGMA table_info(${table})`);
      if (!columns.some(column => column.name === "tenant_id")) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '${DEFAULT_AI_TENANT_ID}'`);
    }
    const referenceColumns = this.sql.all<{ name: string }>("PRAGMA table_info(ai_video_references)");
    if (!referenceColumns.some(column => column.name === "public_id")) this.sql.exec("ALTER TABLE ai_video_references ADD COLUMN public_id TEXT");
    // Existing provider capability URLs remain valid for legacy default-tenant rows.
    this.sql.exec(`UPDATE ai_video_references SET public_id=id WHERE tenant_id='${DEFAULT_AI_TENANT_ID}' AND public_id IS NULL`);
    const observabilityColumns = this.sql.all<{ name: string }>("PRAGMA table_info(ai_observability_events)");
    if (!observabilityColumns.some(column => column.name === "operation")) this.sql.exec("ALTER TABLE ai_observability_events ADD COLUMN operation TEXT NOT NULL DEFAULT 'execution'");
    if (!observabilityColumns.some(column => column.name === "first_visible_ms")) this.sql.exec("ALTER TABLE ai_observability_events ADD COLUMN first_visible_ms INTEGER");
    const harnessRunColumns = this.sql.all<{ name: string }>("PRAGMA table_info(ai_harness_runs)");
    if (!harnessRunColumns.some(column => column.name === "goal_kind")) this.sql.exec("ALTER TABLE ai_harness_runs ADD COLUMN goal_kind TEXT NOT NULL DEFAULT 'chat'");
    if (!harnessRunColumns.some(column => column.name === "goal_summary")) this.sql.exec("ALTER TABLE ai_harness_runs ADD COLUMN goal_summary TEXT NOT NULL DEFAULT '完成当前对话任务，并根据已校验结果判断下一步。'");
    // Never opt historical/abandoned runs into paid background continuation.
    if (!harnessRunColumns.some(column => column.name === "background_capable")) this.sql.exec("ALTER TABLE ai_harness_runs ADD COLUMN background_capable INTEGER NOT NULL DEFAULT 0");
    this.sql.exec("CREATE INDEX IF NOT EXISTS ai_usage_tenant_user_time ON ai_usage(tenant_id,user_id,created_at DESC); CREATE INDEX IF NOT EXISTS ai_harness_runs_tenant_user ON ai_harness_runs(tenant_id,user_id,request_id); CREATE INDEX IF NOT EXISTS ai_observability_tenant_time ON ai_observability_events(tenant_id,created_at DESC); CREATE INDEX IF NOT EXISTS ai_observability_alerts_tenant_time ON ai_observability_alerts(tenant_id,last_seen_at DESC); CREATE INDEX IF NOT EXISTS ai_video_jobs_tenant_user ON ai_video_jobs(tenant_id,user_id,id); CREATE INDEX IF NOT EXISTS ai_video_references_tenant_user ON ai_video_references(tenant_id,user_id,id); CREATE UNIQUE INDEX IF NOT EXISTS ai_video_references_public ON ai_video_references(public_id) WHERE public_id IS NOT NULL;");
    // Numbered, module-owned migrations (ai_schema_migrations): member memory v1.
    applyAiModuleMigrations(this.sql, "member_memory", MEMBER_MEMORY_MIGRATIONS);
  }
  provider(): StoredProvider | null {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=? AND tenant_id=?", this.settingKey("provider"), this.tenantId)[0];
    return row ? JSON.parse(row.data) as StoredProvider : null;
  }
  saveProvider(value: StoredProvider): void {
    this.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.settingKey("provider"), this.tenantId, JSON.stringify(value));
  }
  quota(userId: string): AiQuota {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_quotas WHERE user_id=? AND tenant_id=?", this.userKey(userId), this.tenantId)[0];
    const q = row ? JSON.parse(row.data) as AiQuota : emptyQuota();
    return { ...q, remainingTokens: Math.max(0, q.limitTokens - q.usedTokens - q.reservedTokens) };
  }
  /** A zero-limit row or an old persona is not an entitlement. Keep prior grants after exhaustion. */
  hasAccess(userId: string): boolean {
    const quota = this.quota(userId);
    if (quota.limitTokens > 0 || quota.usedTokens > 0 || quota.reservedTokens > 0) return true;
    // Read the authoritative ledger, not the UI's bounded latest-200 usage list.
    // This also preserves legacy grants lowered back to zero before any generation.
    return this.sql.all<{ id: string }>("SELECT id FROM ai_usage WHERE user_id=? AND tenant_id=? AND json_extract(data,'$.kind')='quota' AND json_extract(data,'$.limitTokens')>0 LIMIT 1", this.userKey(userId), this.tenantId).length > 0;
  }
  assertAccess(userId: string): void {
    if (!this.hasAccess(userId)) throw new AiError(403, "AI_ACCESS_NOT_GRANTED", "管理员尚未为此账号开通 AI，请联系管理员分配额度");
  }
  saveQuota(userId: string, quota: AiQuota): void {
    this.sql.exec("INSERT INTO ai_quotas(user_id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.userKey(userId), this.tenantId, JSON.stringify(quota));
  }
  request(userId: string, requestId: string): StoredRequest | undefined {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_requests WHERE user_id=? AND request_id=? AND tenant_id=?", this.userKey(userId), requestId, this.tenantId)[0];
    return row ? JSON.parse(row.data) as StoredRequest : undefined;
  }
  saveRequestSnapshot(userId: string, requestId: string, value: unknown): void {
    const serialized = JSON.stringify(value);
    if (serialized.length > 1600 * 1024) throw new AiError(413, "AI_CONTEXT_TOO_LONG", "任务快照过大");
    // Immutable chunked snapshot; account scope is taken from authentication.
    for (let offset = 0; offset < serialized.length; offset += 32000) this.sql.exec("INSERT INTO ai_request_snapshots VALUES(?,?,?,?,?)", this.tenantId, this.userKey(userId), requestId, offset / 32000, serialized.slice(offset, offset + 32000));
  }
  requestSnapshot(userId: string, requestId: string): unknown {
    const rows = this.sql.all<{ data: string }>("SELECT data FROM ai_request_snapshots WHERE tenant_id=? AND user_id=? AND request_id=? ORDER BY chunk_index", this.tenantId, this.userKey(userId), requestId);
    return rows.length ? JSON.parse(rows.map(row => row.data).join("")) : undefined;
  }
  appendRunEvent(userId: string, requestId: string, payload: AiRunEventPayload): AiRunEvent {
    return this.sql.transaction(() => {
      const request = this.request(userId, requestId);
      if (!request) throw new AiError(404, "AI_REQUEST_NOT_FOUND", "没有找到这条请求");
      const seq = (this.sql.all<{ seq: number }>("SELECT MAX(seq) AS seq FROM ai_run_events WHERE tenant_id=? AND user_id=? AND request_id=?", this.tenantId, this.userKey(userId), requestId)[0]?.seq ?? 0) + 1;
      if (seq > 4096) throw new AiError(502, "AI_EVENT_LIMIT", "任务事件超过上限");
      const event: AiRunEvent = { ...payload, requestId, runId: request.attempt?.runId ?? request.harnessRunId ?? requestId,
        stepId: requestId, seq, timestamp: Date.now(), schemaVersion: 1, eventId: `${requestId}:${seq}`,
        attemptId: request.attempt?.attemptId ?? requestId,
        ...(request.conversationId ? { conversationId: request.conversationId } : {}),
      };
      this.sql.exec("INSERT INTO ai_run_events VALUES(?,?,?,?,?)", this.tenantId, this.userKey(userId), requestId, seq, JSON.stringify(event));
      return event;
    });
  }
  runEvents(userId: string, requestId: string, after = 0): AiRunEvent[] {
    return this.sql.all<{ data: string }>("SELECT data FROM ai_run_events WHERE tenant_id=? AND user_id=? AND request_id=? AND seq>? ORDER BY seq LIMIT 512", this.tenantId, this.userKey(userId), requestId, after).map(row => JSON.parse(row.data) as AiRunEvent);
  }
  pending(userId: string): StoredRequest[] {
    return this.sql.all<{ data: string }>("SELECT data FROM ai_requests WHERE user_id=? AND tenant_id=? AND json_extract(data,'$.status')='pending'", this.userKey(userId), this.tenantId).map(r => JSON.parse(r.data) as StoredRequest);
  }
  pendingForConversation(userId: string, conversationId: string): StoredRequest[] {
    return this.pending(userId).filter(request => (request.conversationId ?? "legacy") === conversationId);
  }
  /** Shared concurrency view for chat, image, presentation and video entrypoints.
   * Uncertain jobs keep their quota reservation for reconciliation, but are no
   * longer executing and therefore must not permanently consume a run slot. */
  activeVideoJobs(userId?: string): StoredActiveVideoJob[] {
    const rows = userId
      ? this.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND json_extract(data,'$.status') IN ('submitting','queued','processing')", this.tenantId, this.userKey(userId))
      : this.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND json_extract(data,'$.status') IN ('submitting','queued','processing')", this.tenantId);
    return rows.map(row => {
      const job = JSON.parse(row.data) as { id: string; userId: string; conversationId?: string; status: StoredActiveVideoJob["status"] };
      return { id: job.id, userId: job.userId, conversationId: job.conversationId, status: job.status };
    });
  }
  activeVideoForConversation(userId: string, conversationId: string): StoredVideoConversationLock[] {
    const rows = this.sql.all<{ data: string }>(
      "SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND (json_extract(data,'$.status') IN ('submitting','queued','processing') OR (json_extract(data,'$.status')='uncertain' AND json_extract(data,'$.reserved')=1))",
      this.tenantId, this.userKey(userId),
    );
    return rows.map(row => JSON.parse(row.data) as StoredVideoConversationLock)
      .filter(job => (job.conversationId ?? "legacy") === conversationId);
  }
  activeImageCount(): number {
    return this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_requests WHERE tenant_id=? AND json_extract(data,'$.status')='pending' AND json_extract(data,'$.kind')='image' AND json_extract(data,'$.expiresAt')>?", this.tenantId, Date.now())[0]?.count ?? 0;
  }
  saveRequest(value: StoredRequest): void {
    this.sql.exec("INSERT INTO ai_requests(user_id,request_id,tenant_id,data) VALUES(?,?,?,?) ON CONFLICT(user_id,request_id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.userKey(value.userId), value.requestId, this.tenantId, JSON.stringify(value));
  }
  addUsage(value: AiUsageEntry): void {
    this.sql.exec("INSERT INTO ai_usage(id,tenant_id,user_id,created_at,data) VALUES(?,?,?,?,?)", tenantStorageKey(this.tenantId, value.id), this.tenantId, this.userKey(value.userId), value.createdAt, JSON.stringify(value));
  }
  /** Called inside the generation settlement transaction. No base64 is stored in a single oversized SQLite row. */
  saveAsset(userId: string, mimeType: AiImageMimeType, base64: string, byteLength: number): AiImageResponse["images"][number] {
    this.assertAssetCapacity(userId, byteLength);
    const assetId = crypto.randomUUID();
    const storedAssetId = tenantStorageKey(this.tenantId, assetId);
    this.sql.exec("INSERT INTO ai_assets(id,tenant_id,user_id,mime_type,byte_length,created_at) VALUES(?,?,?,?,?,?)", storedAssetId, this.tenantId, this.userKey(userId), mimeType, byteLength, new Date().toISOString());
    const chunkSize = 256 * 1024;
    for (let offset = 0; offset < base64.length; offset += chunkSize) {
      this.sql.exec("INSERT INTO ai_asset_chunks(asset_id,chunk_index,data) VALUES(?,?,?)", storedAssetId, offset / chunkSize, base64.slice(offset, offset + chunkSize));
    }
    return { assetId, mimeType };
  }
  /** `reservedBytes` is room already promised to this member's other
   * in-flight images, which may be saved before this one. */
  assertAssetCapacity(userId: string, incomingBytes: number, reservedBytes = 0): void {
    const used = this.sql.all<{ bytes: number }>("SELECT COALESCE(SUM(byte_length),0) AS bytes FROM ai_assets WHERE tenant_id=? AND user_id=?", this.tenantId, this.userKey(userId))[0]?.bytes ?? 0;
    if (incomingBytes > 4 * 1024 * 1024 || used + reservedBytes + incomingBytes > 50 * 1024 * 1024) throw new AiError(409, "AI_ASSET_CAPACITY", "图片存储空间不足，请删除不需要的图片后重试");
  }
  asset(userId: string, assetId: string): AiImageAsset | null {
    const storedAssetId = tenantStorageKey(this.tenantId, assetId);
    const row = this.sql.all<{ mime_type: AiImageMimeType }>("SELECT mime_type FROM ai_assets WHERE id=? AND tenant_id=? AND user_id=?", storedAssetId, this.tenantId, this.userKey(userId))[0];
    if (!row) return null;
    const chunks = this.sql.all<{ data: string }>("SELECT data FROM ai_asset_chunks WHERE asset_id=? ORDER BY chunk_index", storedAssetId);
    return { assetId, mimeType: row.mime_type, base64: chunks.map(chunk => chunk.data).join("") };
  }
  /** Reauthorize an immutable image without reading or returning its base64 chunks. */
  assetMetadata(userId: string, assetId: string): { assetId: string; mimeType: AiImageMimeType; byteLength: number } | null {
    const storedAssetId = tenantStorageKey(this.tenantId, assetId);
    const row = this.sql.all<{ mime_type: AiImageMimeType; byte_length: number }>(
      "SELECT mime_type,byte_length FROM ai_assets WHERE id=? AND tenant_id=? AND user_id=?",
      storedAssetId, this.tenantId, this.userKey(userId),
    )[0];
    return row ? { assetId, mimeType: row.mime_type, byteLength: row.byte_length } : null;
  }
  deleteAsset(userId: string, assetId: string): void {
    this.sql.transaction(() => {
      const storedAssetId = tenantStorageKey(this.tenantId, assetId);
      const row = this.sql.all<{ id: string }>("SELECT id FROM ai_assets WHERE id=? AND tenant_id=? AND user_id=?", storedAssetId, this.tenantId, this.userKey(userId))[0];
      if (!row) throw new AiError(404, "AI_ASSET_NOT_FOUND", "图片不存在或已删除");
      this.sql.exec("DELETE FROM ai_asset_chunks WHERE asset_id=?", storedAssetId);
      this.sql.exec("DELETE FROM ai_assets WHERE id=? AND tenant_id=? AND user_id=?", storedAssetId, this.tenantId, this.userKey(userId));
    });
  }
  usage(userId?: string): AiUsageEntry[] {
    const rows = userId
      ? this.sql.all<{ data: string }>("SELECT data FROM ai_usage WHERE tenant_id=? AND user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200", this.tenantId, this.userKey(userId))
      : this.sql.all<{ data: string }>("SELECT data FROM ai_usage WHERE tenant_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200", this.tenantId);
    return rows.map(row => JSON.parse(row.data) as AiUsageEntry);
  }
  harness(): StoredHarnessConfig | null {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=? AND tenant_id=?", this.settingKey("harness"), this.tenantId)[0];
    return row ? JSON.parse(row.data) as StoredHarnessConfig : null;
  }
  saveHarness(value: StoredHarnessConfig): void {
    this.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.settingKey("harness"), this.tenantId, JSON.stringify(value));
  }
  createHarnessRun(value: StoredHarnessRun, steps: AiHarnessStep[]): void {
    const storedUserId = this.userKey(value.userId);
    this.sql.exec(
      "INSERT INTO ai_harness_runs(user_id,id,request_id,tenant_id,conversation_id,tier,provider_id,capability,goal_kind,goal_summary,background_capable,status,reasoning_summary,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      storedUserId, value.id, value.requestId, this.tenantId, value.conversationId, value.tier, value.providerId, value.capability, value.goalKind, value.goalSummary, value.backgroundCapable === true ? 1 : 0, value.status, value.reasoningSummary, value.startedAt, value.updatedAt,
    );
    for (const step of steps) this.saveHarnessStep(value.userId, value.id, step);
  }
  harnessRun(userId: string, requestId: string): StoredHarnessRun | null {
    const row = this.sql.all<Record<string, string | number>>("SELECT * FROM ai_harness_runs WHERE tenant_id=? AND user_id=? AND request_id=?", this.tenantId, this.userKey(userId), requestId)[0];
    if (!row) return null;
    const goalKind = String(row.goal_kind) as AiHarnessCapability;
    const goalSummary = String(row.goal_summary);
    if (!["chat", "vision", "web_search", "image", "video", "presentation", "computer"].includes(goalKind)
      || !goalSummary || goalSummary.length > 320 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(goalSummary)) throw new AiError(500, "AI_HARNESS_CONTEXT_INVALID", "AI 任务上下文记录无效，已停止自动续跑");
    return {
      id: String(row.id), requestId: String(row.request_id), userId, conversationId: String(row.conversation_id),
      tier: String(row.tier) as AiMode, providerId: String(row.provider_id), capability: String(row.capability) as AiHarnessCapability,
      goalKind, goalSummary,
      backgroundCapable: Number(row.background_capable) === 1,
      status: String(row.status) as AiHarnessRunStatus, reasoningSummary: String(row.reasoning_summary), startedAt: Number(row.started_at), updatedAt: Number(row.updated_at),
    };
  }
  /** System-only cross-tenant maintenance view. Callers must immediately scope
   * the service back to candidate.tenantId before reading or changing a run. */
  backgroundHarnessCandidates(limit = 4): AiBackgroundHarnessCandidate[] {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(8, limit)) : 4;
    const rows = this.sql.all<{ tenant_id: string; user_id: string; request_id: string }>(
      `SELECT r.tenant_id,r.user_id,r.request_id FROM ai_harness_runs r
       WHERE r.background_capable=1 AND (r.status='planned' OR (r.status='running' AND EXISTS (
         SELECT 1 FROM ai_harness_steps s WHERE s.tenant_id=r.tenant_id AND s.user_id=r.user_id AND s.run_id=r.id
         AND json_extract(s.data,'$.kind')='model' AND json_extract(s.data,'$.continuationRequestId') IS NOT NULL
       ))) ORDER BY r.updated_at ASC LIMIT ?`,
      bounded * 4,
    );
    const result: AiBackgroundHarnessCandidate[] = [];
    for (const row of rows) {
      try {
        const tenantId = normalizeAiTenantId(row.tenant_id);
        result.push({ tenantId, userId: tenantStorageValue(tenantId, row.user_id), requestId: row.request_id });
      } catch {
        // A corrupt row must not widen tenant scope or stop other valid runs.
      }
    }
    return result;
  }
  disableHarnessBackground(userId: string, requestId: string): void {
    this.sql.exec("UPDATE ai_harness_runs SET background_capable=0,updated_at=? WHERE tenant_id=? AND user_id=? AND request_id=?", Date.now(), this.tenantId, this.userKey(userId), requestId);
  }
  updateHarnessRun(userId: string, requestId: string, status: AiHarnessRunStatus, reasoningSummary: string): void {
    this.sql.exec("UPDATE ai_harness_runs SET status=?,reasoning_summary=?,updated_at=? WHERE tenant_id=? AND user_id=? AND request_id=?", status, reasoningSummary, Date.now(), this.tenantId, this.userKey(userId), requestId);
  }
  updateHarnessGoal(userId: string, requestId: string, goalKind: AiHarnessCapability, goalSummary: string): void {
    if (!["chat", "vision", "web_search", "image", "video", "presentation", "computer"].includes(goalKind)
      || !goalSummary || goalSummary.length > 320 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(goalSummary)) {
      throw new AiError(500, "AI_HARNESS_CONTEXT_INVALID", "AI 任务上下文记录无效，已停止自动续跑");
    }
    this.sql.exec("UPDATE ai_harness_runs SET goal_kind=?,goal_summary=?,updated_at=? WHERE tenant_id=? AND user_id=? AND request_id=?", goalKind, goalSummary, Date.now(), this.tenantId, this.userKey(userId), requestId);
  }
  saveHarnessStep(userId: string, runId: string, step: AiHarnessStep): void {
    this.sql.exec("INSERT INTO ai_harness_steps(user_id,run_id,id,tenant_id,data) VALUES(?,?,?,?,?) ON CONFLICT(user_id,run_id,id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.userKey(userId), runId, step.id, this.tenantId, JSON.stringify(step));
  }
  harnessSteps(userId: string, runId: string): AiHarnessStep[] {
    return this.sql.all<{ data: string }>("SELECT data FROM ai_harness_steps WHERE tenant_id=? AND user_id=? AND run_id=? ORDER BY json_extract(data,'$.createdAt'), rowid", this.tenantId, this.userKey(userId), runId).map(row => JSON.parse(row.data) as AiHarnessStep);
  }
  addObservability(value: { userId: string; tier: AiMode; providerId: string; capability: AiHarnessCapability; operation?: "planning" | "execution"; success: boolean; latencyMs: number; firstVisibleMs?: number; errorCode?: string }): void {
    const id = crypto.randomUUID();
    const providerId = /^[a-zA-Z0-9._:-]{1,120}$/.test(value.providerId) ? value.providerId : "unknown-provider";
    const errorCode = value.success ? null : /^[A-Z][A-Z0-9_]{1,95}$/.test(value.errorCode ?? "") ? value.errorCode! : "AI_UNKNOWN_ERROR";
    const operation = value.operation ?? "execution";
    const latencyMs = Math.max(0, Math.round(value.latencyMs));
    const firstVisibleMs = value.firstVisibleMs !== undefined && Number.isSafeInteger(value.firstVisibleMs) && value.firstVisibleMs >= 0
      ? value.firstVisibleMs : null;
    this.sql.exec("INSERT INTO ai_observability_events(id,tenant_id,user_id,tier,provider_id,capability,operation,success,latency_ms,first_visible_ms,error_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", tenantStorageKey(this.tenantId, id), this.tenantId, this.userKey(value.userId), value.tier, providerId, value.capability, operation, value.success ? 1 : 0, latencyMs, firstVisibleMs, errorCode, Date.now());
    this.syncObservabilityAlerts(this.observabilitySlices(60), { tier: value.tier, provider: providerId, capability: value.capability, operation, success: value.success, latencyMs });
  }
  private observabilitySlices(windowMinutes: number): AiObservabilitySlice[] {
    const requestedWindow = Number.isFinite(windowMinutes) ? Math.round(windowMinutes) : 60;
    const safeWindow = Math.max(5, Math.min(7 * 24 * 60, requestedWindow));
    const rows = this.sql.all<{ tier: string; provider_id: string; capability: string; operation: string; requests: number; successes: number; failures: number; average_latency_ms: number; max_latency_ms: number; first_visible_samples: number; average_first_visible_ms: number | null }>(
      `SELECT tier,provider_id,capability,operation,COUNT(*) requests,SUM(success) successes,SUM(CASE WHEN success=0 THEN 1 ELSE 0 END) failures,ROUND(AVG(latency_ms)) average_latency_ms,MAX(latency_ms) max_latency_ms,COUNT(first_visible_ms) first_visible_samples,ROUND(AVG(first_visible_ms)) average_first_visible_ms
       FROM ai_observability_events WHERE tenant_id=? AND created_at>=? GROUP BY tier,provider_id,capability,operation ORDER BY requests DESC`, this.tenantId, Date.now() - safeWindow * 60_000,
    );
    const errors = this.sql.all<{ tier: string; provider_id: string; capability: string; operation: string; error_code: string; count: number }>(
      `SELECT tier,provider_id,capability,operation,error_code,COUNT(*) count FROM ai_observability_events
       WHERE tenant_id=? AND created_at>=? AND success=0 AND error_code IS NOT NULL
       GROUP BY tier,provider_id,capability,operation,error_code ORDER BY count DESC,error_code`, this.tenantId, Date.now() - safeWindow * 60_000,
    );
    return rows.map(row => ({
      tier: row.tier as AiMode, provider: row.provider_id, capability: row.capability as AiHarnessCapability, operation: row.operation as "planning" | "execution",
      requests: Number(row.requests), successes: Number(row.successes), failures: Number(row.failures),
      successRate: Number(row.requests) ? Number(row.successes) / Number(row.requests) : 0,
      errorRate: Number(row.requests) ? Number(row.failures) / Number(row.requests) : 0,
      averageLatencyMs: Number(row.average_latency_ms), maxLatencyMs: Number(row.max_latency_ms),
      firstVisibleSamples: Number(row.first_visible_samples), averageFirstVisibleMs: row.average_first_visible_ms === null ? null : Number(row.average_first_visible_ms),
      errors: errors.filter(error => error.tier === row.tier && error.provider_id === row.provider_id && error.capability === row.capability && error.operation === row.operation).map(error => ({ code: error.error_code, count: Number(error.count) })),
    }));
  }
  private thresholdAlerts(slices: AiObservabilitySlice[]): Array<Omit<AiObservabilityAlert, "id" | "firstSeenAt" | "lastSeenAt" | "occurrences" | "acknowledgedAt" | "resolvedAt"> & { fingerprint: string }> {
    return slices.flatMap(item => {
      const suffix = `${item.tier}:${item.provider}:${item.capability}:${item.operation}`;
      const latency = aiLatencyThresholds(item.capability, item.operation);
      const result: Array<Omit<AiObservabilityAlert, "id" | "firstSeenAt" | "lastSeenAt" | "occurrences" | "acknowledgedAt" | "resolvedAt"> & { fingerprint: string }> = [];
      if (item.requests >= 4 && item.errorRate >= 0.5) result.push({ fingerprint: `errors:${suffix}`, severity: item.errorRate >= 0.8 ? "critical" : "warning", code: "HIGH_ERROR_RATE", message: `${item.tier} · ${item.capability} 错误率 ${(item.errorRate * 100).toFixed(0)}%`, tier: item.tier, provider: item.provider, capability: item.capability });
      if (item.requests >= 3 && item.maxLatencyMs >= latency.warningMs) result.push({ fingerprint: `latency:${suffix}`, severity: item.maxLatencyMs >= latency.criticalMs ? "critical" : "warning", code: "HIGH_LATENCY", message: `${item.tier} · ${item.capability} 最大响应 ${Math.round(item.maxLatencyMs / 1000)} 秒`, tier: item.tier, provider: item.provider, capability: item.capability });
      if (item.requests >= 3 && item.successes === 0) result.push({ fingerprint: `down:${suffix}`, severity: "critical", code: "PROVIDER_UNAVAILABLE", message: `${item.tier} · ${item.capability} 最近请求全部失败`, tier: item.tier, provider: item.provider, capability: item.capability });
      return result;
    });
  }
  private syncObservabilityAlerts(slices: AiObservabilitySlice[], trigger?: { tier: AiMode; provider: string; capability: AiHarnessCapability; operation: "planning" | "execution"; success: boolean; latencyMs: number }): void {
    const now = Date.now();
    const current = this.thresholdAlerts(slices);
    const active = this.sql.all<{ id: string; fingerprint: string }>("SELECT id,fingerprint FROM ai_observability_alerts WHERE tenant_id=? AND resolved_at IS NULL", this.tenantId);
    const activeByFingerprint = new Map(active.map(alert => [alert.fingerprint, alert]));
    const currentFingerprints = new Set(current.map(alert => alert.fingerprint));
    for (const alert of active) if (!currentFingerprints.has(alert.fingerprint)) this.sql.exec("UPDATE ai_observability_alerts SET resolved_at=?,last_seen_at=? WHERE tenant_id=? AND id=? AND resolved_at IS NULL", now, now, this.tenantId, alert.id);
    for (const alert of current) {
      const existing = activeByFingerprint.get(alert.fingerprint);
      if (existing) {
        const suffix = trigger ? `${trigger.tier}:${trigger.provider}:${trigger.capability}:${trigger.operation}` : "";
        const prefix = alert.code === "HIGH_ERROR_RATE" ? "errors" : alert.code === "HIGH_LATENCY" ? "latency" : "down";
        const matchingSample = trigger && alert.fingerprint === `${prefix}:${suffix}`
          && (alert.code === "HIGH_LATENCY" ? trigger.latencyMs >= aiLatencyThresholds(trigger.capability, trigger.operation).warningMs : !trigger.success);
        this.sql.exec("UPDATE ai_observability_alerts SET severity=?,message=?,last_seen_at=?,occurrence_count=occurrence_count+? WHERE tenant_id=? AND id=? AND resolved_at IS NULL", alert.severity, alert.message, now, matchingSample ? 1 : 0, this.tenantId, existing.id);
      } else {
        const id = crypto.randomUUID();
        this.sql.exec("INSERT INTO ai_observability_alerts(id,tenant_id,fingerprint,code,severity,tier,provider_id,capability,message,first_seen_at,last_seen_at,occurrence_count,acknowledged_at,acknowledged_by,resolved_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)", id, this.tenantId, alert.fingerprint, alert.code, alert.severity, alert.tier, alert.provider, alert.capability, alert.message, now, now, 1);
      }
    }
  }
  private observabilityAlertHistory(): AiObservabilityAlert[] {
    return this.observabilityAlertRows().map(({ fingerprint: _fingerprint, ...alert }) => alert);
  }
  private observabilityAlertRows(): Array<AiObservabilityAlert & { fingerprint: string }> {
    return this.sql.all<{ fingerprint: string; id: string; code: AiObservabilityAlert["code"]; severity: AiObservabilityAlert["severity"]; tier: string; provider_id: string; capability: string; message: string; first_seen_at: number; last_seen_at: number; occurrence_count: number; acknowledged_at: number | null; resolved_at: number | null }>(
      "SELECT fingerprint,id,code,severity,tier,provider_id,capability,message,first_seen_at,last_seen_at,occurrence_count,acknowledged_at,resolved_at FROM ai_observability_alerts WHERE tenant_id=? ORDER BY last_seen_at DESC LIMIT 100", this.tenantId,
    ).map(row => ({ fingerprint: String(row.fingerprint), id: row.id, code: row.code, severity: row.severity, tier: row.tier as AiMode, provider: row.provider_id, capability: row.capability as AiHarnessCapability, message: row.message, firstSeenAt: new Date(Number(row.first_seen_at)).toISOString(), lastSeenAt: new Date(Number(row.last_seen_at)).toISOString(), occurrences: Number(row.occurrence_count), acknowledgedAt: row.acknowledged_at === null ? null : new Date(Number(row.acknowledged_at)).toISOString(), resolvedAt: row.resolved_at === null ? null : new Date(Number(row.resolved_at)).toISOString() }));
  }

  acknowledgeObservabilityAlert(alertId: string, actorId: string): AiObservabilityAlert {
    const now = Date.now();
    this.sql.exec("UPDATE ai_observability_alerts SET acknowledged_at=COALESCE(acknowledged_at,?),acknowledged_by=COALESCE(acknowledged_by,?) WHERE tenant_id=? AND id=?", now, this.userKey(actorId), this.tenantId, alertId);
    const alert = this.observabilityAlertHistory().find(item => item.id === alertId);
    if (!alert) throw new AiError(404, "AI_OBSERVABILITY_ALERT_NOT_FOUND", "监控告警不存在或不属于当前组织");
    return alert;
  }
  observability(windowMinutes = 60): AiObservabilityDashboard {
    const requestedWindow = Number.isFinite(windowMinutes) ? Math.round(windowMinutes) : 60;
    const safeWindow = Math.max(5, Math.min(7 * 24 * 60, requestedWindow));
    const slices = this.observabilitySlices(safeWindow);
    // Alert lifecycle uses one canonical 60-minute window so a custom dashboard
    // query cannot accidentally resolve or reopen durable alert history.
    const alertSlices = safeWindow === 60 ? slices : this.observabilitySlices(60);
    this.syncObservabilityAlerts(alertSlices);
    const requests = slices.reduce((sum, item) => sum + item.requests, 0);
    const successes = slices.reduce((sum, item) => sum + item.successes, 0);
    const failures = slices.reduce((sum, item) => sum + item.failures, 0);
    const totals: AiObservabilitySlice = {
      tier: "all", provider: "all", capability: "chat", operation: "all", requests, successes, failures,
      successRate: requests ? successes / requests : 0, errorRate: requests ? failures / requests : 0,
      averageLatencyMs: requests ? Math.round(slices.reduce((sum, item) => sum + item.averageLatencyMs * item.requests, 0) / requests) : 0,
      maxLatencyMs: slices.reduce((max, item) => Math.max(max, item.maxLatencyMs), 0),
      firstVisibleSamples: slices.reduce((sum, item) => sum + item.firstVisibleSamples, 0),
      averageFirstVisibleMs: null,
      errors: slices.flatMap(item => item.errors).reduce<Array<{ code: string; count: number }>>((all, error) => {
        const existing = all.find(item => item.code === error.code);
        if (existing) existing.count += error.count; else all.push({ ...error });
        return all;
      }, []).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code)),
    };
    if (totals.firstVisibleSamples) totals.averageFirstVisibleMs = Math.round(slices.reduce((sum, item) => sum + (item.averageFirstVisibleMs ?? 0) * item.firstVisibleSamples, 0) / totals.firstVisibleSamples);
    const rows = this.observabilityAlertRows();
    const alertHistory = rows.map(({ fingerprint: _fingerprint, ...alert }) => alert);
    // Read-only enrichment: attach the live 60-minute metrics of the slice behind each
    // active alert so the admin UI can phrase rate / error codes without new writes.
    const sliceByKey = new Map(alertSlices.map(item => [`${item.tier}:${item.provider}:${item.capability}:${item.operation}`, item]));
    const alerts = rows.filter(alert => alert.resolvedAt === null).map(({ fingerprint, ...alert }): AiObservabilityAlert => {
      const slice = sliceByKey.get(fingerprint.slice(fingerprint.indexOf(":") + 1));
      return slice ? { ...alert, detail: { operation: slice.operation, requests: slice.requests, failures: slice.failures, errorRate: slice.errorRate, maxLatencyMs: slice.maxLatencyMs, errors: slice.errors.slice(0, 3) } } : alert;
    });
    return { generatedAt: new Date().toISOString(), windowMinutes: safeWindow, totals, slices, alerts, alertHistory };
  }
}
