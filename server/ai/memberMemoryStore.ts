import { AI_BUSINESS_TIERS, type AiMode } from "../../shared/ai";
import {
  AI_MEMORY_DEFAULT_SETTINGS, AI_MEMORY_ENTRY_DELIMITER, AI_MEMORY_LIMITS, AI_MEMORY_PRICE_MAX, AI_MEMORY_TARGET_LIMITS,
  type AiMemoryAdminSettings, type AiMemoryAdminStats, type AiMemoryReviewStatus, type AiMemoryTarget,
} from "../../shared/aiMemory";
import type { AiModuleMigration } from "./aiMigrations";
import { AiError } from "./security";
import type { AiSql } from "./storage";
import { DEFAULT_AI_TENANT_ID, normalizeAiTenantId, tenantStorageKey } from "./tenant";

/*
 * Bounded curated member memory. The entry semantics are a TypeScript port of
 * NousResearch Hermes Agent `tools/memory_tool_store.py` (commit d0288be5, MIT):
 * character budgets that count the "\n§\n" delimiter, add/replace/remove with
 * short unique-substring `old_text` matching (a whole-entry exact match wins),
 * duplicate adds as no-ops, all-or-nothing batches checked against the FINAL
 * budget, overflow errors that return the current entries instead of silently
 * dropping anything, and a refusal to empty a non-empty store through a batch.
 * Hermes keeps MEMORY.md/USER.md files; Tongpin keeps JSON arrays in the AI
 * SQLite database (Durable Object in production, node:sqlite for Express).
 */

export const MEMBER_MEMORY_ENTRY_DELIMITER = AI_MEMORY_ENTRY_DELIMITER;
const DELIMITER_LENGTH = Array.from(AI_MEMORY_ENTRY_DELIMITER).length;

/** Code points, like Python's len(): one 汉字 is one character. */
export function memoryCharLength(value: string): number {
  let count = 0;
  for (const _char of value) count += 1;
  return count;
}

/** Hermes `len(ENTRY_DELIMITER.join(entries))`. */
export function memoryUsage(entries: readonly string[]): number {
  if (!entries.length) return 0;
  return entries.reduce((sum, entry) => sum + memoryCharLength(entry), 0) + DELIMITER_LENGTH * (entries.length - 1);
}

export function memoryLimit(target: AiMemoryTarget): number { return AI_MEMORY_TARGET_LIMITS[target]; }

/** Store names used in error messages shown to the member and the reviewer. */
export const MEMBER_MEMORY_TARGET_NAMES: Readonly<Record<AiMemoryTarget, string>> = { memory: "工作笔记", user: "成员档案" };

export function formatMemoryUsage(used: number, limit: number): string {
  return `${used.toLocaleString("en-US")}/${limit.toLocaleString("en-US")}`;
}

/** Hermes `_usage_pct`: floor percentage capped at 100. */
export function memoryUsagePercent(used: number, limit: number): number {
  return limit > 0 ? Math.min(100, Math.floor((used / limit) * 100)) : 0;
}

/**
 * One compact single-line fact. Newlines/tabs collapse to spaces so an entry
 * can never forge a block header or delimiter line in the rendered prompt.
 */
export function normalizeMemoryEntry(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
}

export type MemoryMatch = { index: number } | { error: "ambiguous" | "none" };

/**
 * Hermes `_find_unique_match`: an entry exactly equal to `oldText` wins
 * outright, so a short entry stays addressable even when a longer sibling
 * contains it; otherwise the substring must select exactly one distinct entry.
 */
export function findUniqueMemoryMatch(entries: readonly string[], oldText: string): MemoryMatch {
  const exact = entries.flatMap((entry, index) => entry === oldText ? [index] : []);
  const matches = exact.length ? exact : entries.flatMap((entry, index) => entry.includes(oldText) ? [index] : []);
  if (new Set(matches.map(index => entries[index])).size > 1) return { error: "ambiguous" };
  return matches.length ? { index: matches[0] } : { error: "none" };
}

export interface MemoryBatchOperation {
  action: "add" | "replace" | "remove";
  /** Complete entry for add/replace: replace overwrites the WHOLE matched entry. */
  content?: string;
  /** Short unique substring that locates the entry for replace/remove. */
  oldText?: string;
  /** Pin to one exact entry (member edits by index); refused if it changed. */
  matchedEntry?: string;
}

export type MemoryBatchFailureCode = "empty_batch" | "invalid" | "no_match" | "ambiguous" | "stale" | "overflow" | "empty_store";

export type MemoryBatchResult =
  | { ok: true; entries: string[]; added: number; updated: number; removed: number; skipped: Array<{ index: number; code: MemoryBatchFailureCode; message: string }>; message: string }
  | { ok: false; code: MemoryBatchFailureCode; message: string; operationIndex?: number; usage: string; newTotal?: number };

/**
 * Apply operations against the FINAL budget (Hermes `apply_batch`), so one call
 * can free room and add. `atomic` (default, Hermes semantics): any malformed,
 * unmatched or ambiguous operation aborts the batch and nothing is written.
 * `skipInvalid` (background review): such operations are skipped and reported,
 * the budget and emptying checks still apply to the whole result.
 */
export function applyMemoryBatch(
  entries: readonly string[],
  operations: readonly MemoryBatchOperation[],
  limit: number,
  options: { label?: string; mode?: "atomic" | "skipInvalid"; allowEmptying?: boolean } = {},
): MemoryBatchResult {
  const label = options.label ?? "记忆";
  const usage = formatMemoryUsage(memoryUsage(entries), limit);
  if (!operations.length) return { ok: false, code: "empty_batch", message: "操作列表为空。", usage };
  const working = [...entries];
  let added = 0, updated = 0, removed = 0;
  const skipped: Array<{ index: number; code: MemoryBatchFailureCode; message: string }> = [];
  for (const [index, operation] of operations.entries()) {
    const position = `第 ${index + 1} 项操作（${operation.action ?? "未知"}）`;
    const failure = (code: MemoryBatchFailureCode, message: string): MemoryBatchResult | null => {
      if (options.mode === "skipInvalid") { skipped.push({ index, code, message: `${position}：${message}` }); return null; }
      return { ok: false, code, message: `${position}：${message}本批操作全部未执行（批量操作要么全部成功，要么全部不执行）。`, operationIndex: index, usage };
    };
    const content = normalizeMemoryEntry(operation.content ?? "");
    if (operation.action === "add") {
      if (!content) { const result = failure("invalid", "缺少条目内容。"); if (result) return result; continue; }
      // Idempotent: an exact duplicate is skipped, not a failure.
      if (!working.includes(content)) { working.push(content); added += 1; }
      continue;
    }
    if (operation.action !== "replace" && operation.action !== "remove") {
      const result = failure("invalid", "未知操作，请使用 add、replace 或 remove。"); if (result) return result; continue;
    }
    const oldText = normalizeMemoryEntry(operation.oldText ?? "");
    if (!oldText) { const result = failure("invalid", "缺少用于定位条目的 old_text。"); if (result) return result; continue; }
    if (operation.action === "replace" && !content) {
      const result = failure("invalid", "replace 需要完整的新条目内容（删除请使用 remove）。"); if (result) return result; continue;
    }
    let target: number;
    if (operation.matchedEntry !== undefined) {
      target = working.indexOf(operation.matchedEntry);
      if (target < 0) { const result = failure("stale", `条目已变化，未执行：“${operation.matchedEntry}”已不在当前${label}中。`); if (result) return result; continue; }
    } else {
      const match = findUniqueMemoryMatch(working, oldText);
      if ("error" in match) {
        const result = match.error === "ambiguous"
          ? failure("ambiguous", `“${oldText}”匹配到多条不同条目，请提供更具体的原文。`)
          : failure("no_match", `没有条目包含“${oldText}”。`);
        if (result) return result; continue;
      }
      target = match.index;
    }
    if (operation.action === "replace") {
      if (working[target] !== content) {
        // Replacing into an existing sibling de-duplicates instead of storing twice.
        if (working.includes(content)) working.splice(target, 1);
        else working[target] = content;
      }
      updated += 1;
    } else {
      working.splice(target, 1);
      removed += 1;
    }
  }
  if (entries.length && !working.length && !options.allowEmptying) {
    // Hermes #103419: a consolidation batch must not silently wipe a store.
    return { ok: false, code: "empty_store", message: `拒绝清空${label}：这批操作会删除原有的全部条目。请把重叠条目合并成更短的一条，而不是全部删除。`, usage };
  }
  const newTotal = memoryUsage(working);
  if (newTotal > limit) {
    return { ok: false, code: "overflow", newTotal, usage,
      message: `${label}当前 ${usage} 字；执行全部 ${operations.length} 项操作后将达到 ${formatMemoryUsage(newTotal, limit)} 字，超过上限。请在同一批操作中用 replace 把重叠条目合并成更短的一条，或用 remove 删除过时、不重要的条目腾出空间，然后重新提交完整的一批操作。` };
  }
  return { ok: true, entries: working, added, updated, removed, skipped, message: `已应用 ${operations.length - skipped.length} 项操作。` };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const MEMBER_MEMORY_MIGRATIONS: readonly AiModuleMigration[] = [{
  version: 1,
  description: "member memory stores, background review journal and frozen prompt snapshots",
  up(sql) {
    sql.exec(`
CREATE TABLE IF NOT EXISTS ai_member_memories (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  memory_entries TEXT NOT NULL DEFAULT '[]',
  user_entries TEXT NOT NULL DEFAULT '[]',
  learning_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT,
  updated_by TEXT,
  PRIMARY KEY (tenant_id, user_id)
);
CREATE TABLE IF NOT EXISTS ai_member_memory_reviews (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  cue TEXT NOT NULL DEFAULT 'none',
  attempts INTEGER NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  reserved_points INTEGER NOT NULL DEFAULT 0,
  charged_points INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, request_id)
);
CREATE INDEX IF NOT EXISTS ai_member_memory_reviews_due ON ai_member_memory_reviews(status, due_at);
CREATE INDEX IF NOT EXISTS ai_member_memory_reviews_user_time ON ai_member_memory_reviews(tenant_id, user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ai_member_memory_snapshots (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  block TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, user_id, conversation_id)
);
`);
  },
}];

export interface StoredMemberMemory {
  revision: number;
  memory: string[];
  user: string[];
  learningEnabled: boolean;
  updatedAt: string | null;
  updatedBy: "member" | "review" | null;
}

export type MemberMemoryReviewRowStatus = "queued" | "running" | "applied" | "unchanged" | "skipped" | "failed";
export type MemberMemoryCue = "none" | "remember" | "forget";

export interface MemberMemoryReviewRow {
  tenantId: string;
  storedUserId: string;
  requestId: string;
  conversationId: string;
  status: MemberMemoryReviewRowStatus;
  cue: MemberMemoryCue;
  attempts: number;
  dueAt: number;
  leaseUntil: number;
  reservedPoints: number;
  chargedPoints: number;
  added: number;
  updated: number;
  removed: number;
  inputTokens: number;
  outputTokens: number;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

interface MemoryRow { revision: number; memory_entries: string; user_entries: string; learning_enabled: number; updated_at: string | null; updated_by: string | null }
interface ReviewRow {
  tenant_id: string; user_id: string; request_id: string; conversation_id: string; status: MemberMemoryReviewRowStatus; cue: MemberMemoryCue;
  attempts: number; due_at: number; lease_until: number; reserved_points: number; charged_points: number;
  added: number; updated: number; removed: number; input_tokens: number; output_tokens: number; reason: string | null; created_at: number; updated_at: number;
}

const SETTINGS_ID = "member_memory";
/** Review journal retention: indicator lookups only need recent replies. */
const REVIEW_RETENTION_MS = 30 * 24 * 60 * 60_000;
const SNAPSHOTS_PER_MEMBER = 120;

function entriesFrom(value: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { parsed = undefined; }
  // Refuse to treat unreadable data as empty: a later save would wipe it (Hermes #26045 class).
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) throw new AiError(500, "AI_MEMORY_CORRUPT", "记忆数据无法读取，已停止写入以免覆盖；请联系管理员");
  return parsed as string[];
}
function reviewFrom(row: ReviewRow): MemberMemoryReviewRow {
  return {
    tenantId: row.tenant_id, storedUserId: row.user_id, requestId: row.request_id, conversationId: row.conversation_id,
    status: row.status, cue: row.cue, attempts: row.attempts, dueAt: row.due_at, leaseUntil: row.lease_until,
    reservedPoints: row.reserved_points, chargedPoints: row.charged_points, added: row.added, updated: row.updated,
    removed: row.removed, inputTokens: row.input_tokens, outputTokens: row.output_tokens, reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

export function parseMemoryAdminSettings(value: unknown, fallback: AiMemoryAdminSettings = AI_MEMORY_DEFAULT_SETTINGS): AiMemoryAdminSettings {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const enabled = typeof record.enabled === "boolean" ? record.enabled : fallback.enabled;
  const reviewTier = AI_BUSINESS_TIERS.includes(record.reviewTier as AiMode) ? record.reviewTier as AiMode : fallback.reviewTier;
  const pricePoints = Number.isSafeInteger(record.pricePoints) && Number(record.pricePoints) >= 0 && Number(record.pricePoints) <= AI_MEMORY_PRICE_MAX
    ? Number(record.pricePoints) : fallback.pricePoints;
  return { enabled, reviewTier, pricePoints };
}

/** Tenant-scoped persistence. Every member method keys rows by the authenticated user id only. */
export class AiMemberMemoryRepository {
  readonly tenantId: string;
  constructor(readonly sql: AiSql, tenantId: string = DEFAULT_AI_TENANT_ID) { this.tenantId = normalizeAiTenantId(tenantId); }
  forTenant(tenantId: string): AiMemberMemoryRepository {
    return normalizeAiTenantId(tenantId) === this.tenantId ? this : new AiMemberMemoryRepository(this.sql, tenantId);
  }
  userKey(userId: string): string { return tenantStorageKey(this.tenantId, userId); }

  settings(): AiMemoryAdminSettings {
    const row = this.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=? AND tenant_id=?", tenantStorageKey(this.tenantId, SETTINGS_ID), this.tenantId)[0];
    if (!row) return { ...AI_MEMORY_DEFAULT_SETTINGS };
    try { return parseMemoryAdminSettings(JSON.parse(row.data)); } catch { return { ...AI_MEMORY_DEFAULT_SETTINGS }; }
  }
  saveSettings(settings: AiMemoryAdminSettings): void {
    this.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data",
      tenantStorageKey(this.tenantId, SETTINGS_ID), this.tenantId, JSON.stringify(settings));
  }

  read(userId: string): StoredMemberMemory {
    const row = this.sql.all<MemoryRow>("SELECT revision,memory_entries,user_entries,learning_enabled,updated_at,updated_by FROM ai_member_memories WHERE tenant_id=? AND user_id=?", this.tenantId, this.userKey(userId))[0];
    if (!row) return { revision: 0, memory: [], user: [], learningEnabled: true, updatedAt: null, updatedBy: null };
    return {
      revision: row.revision, memory: entriesFrom(row.memory_entries), user: entriesFrom(row.user_entries), learningEnabled: row.learning_enabled !== 0,
      updatedAt: row.updated_at, updatedBy: row.updated_by === "member" || row.updated_by === "review" ? row.updated_by : null,
    };
  }
  /** Compare-and-set on `revision`; the caller runs this inside a transaction. */
  write(userId: string, expectedRevision: number, next: Pick<StoredMemberMemory, "memory" | "user" | "learningEnabled">, updatedBy: "member" | "review"): StoredMemberMemory {
    const current = this.read(userId);
    if (current.revision !== expectedRevision) throw new AiError(409, "AI_MEMORY_CONFLICT", "记忆刚刚已在其他地方更新，本次未覆盖；请刷新后再试");
    for (const [target, entries] of [["memory", next.memory], ["user", next.user]] as const) {
      if (memoryUsage(entries) > memoryLimit(target) || entries.some(entry => !entry || memoryCharLength(entry) > AI_MEMORY_LIMITS.entryCharacters)) {
        throw new AiError(409, "AI_MEMORY_FULL", "记忆容量已满，请先精简或删除部分条目");
      }
    }
    const revision = current.revision + 1;
    const updatedAt = new Date().toISOString();
    this.sql.exec(`INSERT INTO ai_member_memories(tenant_id,user_id,revision,memory_entries,user_entries,learning_enabled,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,user_id) DO UPDATE SET revision=excluded.revision,memory_entries=excluded.memory_entries,user_entries=excluded.user_entries,learning_enabled=excluded.learning_enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by`,
    this.tenantId, this.userKey(userId), revision, JSON.stringify(next.memory), JSON.stringify(next.user), next.learningEnabled ? 1 : 0, updatedAt, updatedBy);
    return { revision, memory: [...next.memory], user: [...next.user], learningEnabled: next.learningEnabled, updatedAt, updatedBy };
  }

  // Frozen per-conversation prompt blocks (Hermes' session-start snapshot).
  snapshot(userId: string, conversationId: string): { block: string; capturedAt: number } | undefined {
    const row = this.sql.all<{ block: string; captured_at: number }>("SELECT block,captured_at FROM ai_member_memory_snapshots WHERE tenant_id=? AND user_id=? AND conversation_id=?", this.tenantId, this.userKey(userId), conversationId)[0];
    return row ? { block: row.block, capturedAt: row.captured_at } : undefined;
  }
  saveSnapshot(userId: string, conversationId: string, block: string, capturedAt: number): void {
    const user = this.userKey(userId);
    this.sql.exec("INSERT INTO ai_member_memory_snapshots(tenant_id,user_id,conversation_id,block,captured_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,user_id,conversation_id) DO UPDATE SET block=excluded.block,captured_at=excluded.captured_at",
      this.tenantId, user, conversationId, block, capturedAt);
    this.sql.exec(`DELETE FROM ai_member_memory_snapshots WHERE tenant_id=? AND user_id=? AND conversation_id NOT IN (
      SELECT conversation_id FROM ai_member_memory_snapshots WHERE tenant_id=? AND user_id=? ORDER BY captured_at DESC LIMIT ${SNAPSHOTS_PER_MEMBER})`, this.tenantId, user, this.tenantId, user);
  }
  deleteSnapshots(userId: string): void {
    this.sql.exec("DELETE FROM ai_member_memory_snapshots WHERE tenant_id=? AND user_id=?", this.tenantId, this.userKey(userId));
  }

  // Background review journal.
  insertReview(userId: string, requestId: string, conversationId: string, cue: MemberMemoryCue, now: number): boolean {
    if (this.sql.all("SELECT request_id FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND request_id=?", this.tenantId, this.userKey(userId), requestId).length) return false;
    this.sql.exec("INSERT INTO ai_member_memory_reviews(tenant_id,user_id,request_id,conversation_id,status,cue,attempts,due_at,created_at,updated_at) VALUES(?,?,?,?,'queued',?,0,?,?,?)",
      this.tenantId, this.userKey(userId), requestId, conversationId, cue, now, now, now);
    this.sql.exec("DELETE FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND created_at<? AND status NOT IN ('queued','running')", this.tenantId, this.userKey(userId), now - REVIEW_RETENTION_MS);
    return true;
  }
  review(userId: string, requestId: string): MemberMemoryReviewRow | undefined {
    const row = this.sql.all<ReviewRow>("SELECT * FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND request_id=?", this.tenantId, this.userKey(userId), requestId)[0];
    return row ? reviewFrom(row) : undefined;
  }
  updateReview(userId: string, requestId: string, patch: Partial<Pick<MemberMemoryReviewRow, "status" | "attempts" | "dueAt" | "leaseUntil" | "reservedPoints" | "chargedPoints" | "added" | "updated" | "removed" | "inputTokens" | "outputTokens" | "reason">>, now: number): void {
    const columns: Record<string, string> = { status: "status", attempts: "attempts", dueAt: "due_at", leaseUntil: "lease_until", reservedPoints: "reserved_points", chargedPoints: "charged_points", added: "added", updated: "updated", removed: "removed", inputTokens: "input_tokens", outputTokens: "output_tokens", reason: "reason" };
    const keys = Object.keys(patch).filter(key => key in columns) as Array<keyof typeof patch>;
    if (!keys.length) return;
    this.sql.exec(`UPDATE ai_member_memory_reviews SET ${keys.map(key => `${columns[key]}=?`).join(",")},updated_at=? WHERE tenant_id=? AND user_id=? AND request_id=?`,
      ...keys.map(key => patch[key] as string | number | null), now, this.tenantId, this.userKey(userId), requestId);
  }
  /** Rows the member may see: only their own, only counts. */
  reviewStatuses(userId: string, requestIds: readonly string[]): AiMemoryReviewStatus[] {
    if (!requestIds.length) return [];
    const rows = this.sql.all<ReviewRow>(`SELECT * FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND request_id IN (${requestIds.map(() => "?").join(",")})`,
      this.tenantId, this.userKey(userId), ...requestIds);
    const byId = new Map(rows.map(row => [row.request_id, reviewFrom(row)]));
    return requestIds.map(requestId => {
      const row = byId.get(requestId);
      if (!row) return { requestId, status: "none" as const };
      if (row.status === "queued" || row.status === "running") return { requestId, status: "pending" as const };
      return { requestId, status: row.status, ...(row.status === "applied" ? { changes: { added: row.added, updated: row.updated, removed: row.removed } } : {}) };
    });
  }
  reviewsSince(userId: string, since: number): { count: number; lastCreatedAt: number | null; active: number } {
    const row = this.sql.all<{ count: number; last: number | null; active: number }>(
      "SELECT COUNT(*) AS count, MAX(created_at) AS last, SUM(CASE WHEN status IN ('queued','running') THEN 1 ELSE 0 END) AS active FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND created_at>=?",
      this.tenantId, this.userKey(userId), since)[0];
    return { count: row?.count ?? 0, lastCreatedAt: row?.last ?? null, active: row?.active ?? 0 };
  }
  /** Another review of this member holding an unexpired lease (one reviewer per member). */
  hasRunningReview(userId: string, exceptRequestId: string, now: number): boolean {
    return this.sql.all("SELECT request_id FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND request_id<>? AND status='running' AND lease_until>? LIMIT 1",
      this.tenantId, this.userKey(userId), exceptRequestId, now).length > 0;
  }
  /** Cross-tenant maintenance scan: due queued jobs and running jobs whose lease expired. */
  static dueReviews(sql: AiSql, now: number, limit: number): Array<{ tenantId: string; storedUserId: string; requestId: string }> {
    return sql.all<{ tenant_id: string; user_id: string; request_id: string }>(
      "SELECT tenant_id,user_id,request_id FROM ai_member_memory_reviews WHERE (status='queued' AND due_at<=?) OR (status='running' AND lease_until<=?) ORDER BY due_at LIMIT ?",
      now, now, limit).map(row => ({ tenantId: row.tenant_id, storedUserId: row.user_id, requestId: row.request_id }));
  }

  /** Clear-all: entries, prompt snapshots and settled review rows. Active jobs are cancelled, not deleted, so their reservations settle. */
  clear(userId: string, now: number): StoredMemberMemory {
    const current = this.read(userId);
    const next = this.write(userId, current.revision, { memory: [], user: [], learningEnabled: current.learningEnabled }, "member");
    this.deleteSnapshots(userId);
    this.sql.exec("DELETE FROM ai_member_memory_reviews WHERE tenant_id=? AND user_id=? AND status NOT IN ('queued','running')", this.tenantId, this.userKey(userId));
    this.sql.exec("UPDATE ai_member_memory_reviews SET status='skipped',reason='cleared',updated_at=? WHERE tenant_id=? AND user_id=? AND status='queued'", now, this.tenantId, this.userKey(userId));
    return next;
  }

  /** Organization aggregates for administrators. Never returns entry text or per-member data. */
  stats(now: number): AiMemoryAdminStats {
    const members = this.sql.all<{ with_memory: number | null; learning_off: number | null; entries: number | null }>(
      `SELECT SUM(CASE WHEN json_array_length(memory_entries)+json_array_length(user_entries)>0 THEN 1 ELSE 0 END) AS with_memory,
        SUM(CASE WHEN learning_enabled=0 THEN 1 ELSE 0 END) AS learning_off,
        SUM(json_array_length(memory_entries)+json_array_length(user_entries)) AS entries
       FROM ai_member_memories WHERE tenant_id=?`, this.tenantId)[0];
    const since = now - 7 * 24 * 60 * 60_000;
    const reviews = this.sql.all<{ status: string; count: number; points: number | null; input: number | null; output: number | null }>(
      "SELECT status, COUNT(*) AS count, SUM(charged_points) AS points, SUM(input_tokens) AS input, SUM(output_tokens) AS output FROM ai_member_memory_reviews WHERE tenant_id=? AND created_at>=? GROUP BY status", this.tenantId, since);
    const count = (status: string) => reviews.find(row => row.status === status)?.count ?? 0;
    return {
      membersWithMemory: members?.with_memory ?? 0,
      membersLearningOff: members?.learning_off ?? 0,
      totalEntries: members?.entries ?? 0,
      reviews7d: { applied: count("applied"), unchanged: count("unchanged"), skipped: count("skipped"), failed: count("failed") },
      points7d: reviews.reduce((sum, row) => sum + (row.points ?? 0), 0),
      tokens7d: { input: reviews.reduce((sum, row) => sum + (row.input ?? 0), 0), output: reviews.reduce((sum, row) => sum + (row.output ?? 0), 0) },
    };
  }
}
