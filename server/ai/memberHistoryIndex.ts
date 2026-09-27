import type { AiWorkspaceConversation, AiWorkspaceMessage, AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiMemberMemoryRepository } from "./memberMemoryStore";
import { MEMBER_HISTORY_FTS_TABLE } from "./memberLearningSchema";
import { historyChunks, historyFingerprint, historyIndexText, historyMatchExpression, historyOwnerKey, type HistoryQuery } from "./memberHistoryText";
import type { AiSql } from "./storage";
import { DEFAULT_AI_TENANT_ID, normalizeAiTenantId, tenantStorageKey, tenantStorageValue } from "./tenant";

/*
 * Per-member full-text index of the member's own conversation messages
 * (Hermes `session_search`, adapted). One SQLite database holds every member,
 * so every row carries tenant_id + stored user id and every read filters on
 * both; the trigram FTS table is only a candidate generator whose hits are
 * re-filtered on those columns.
 *
 * Incremental: a committed V1 save or V2 write syncs only conversations whose
 * fingerprint changed, and inside them only added, edited or deleted messages.
 * Work per sync is budgeted; what does not fit is finished by the background
 * backfill queue. Purges (member opt-out, clear-all, organization switch-off)
 * bump a generation so old rows stop matching at once and are deleted later in
 * bounded batches.
 */

export const MEMBER_HISTORY_LIMITS = {
  /** Indexed characters per member (newest conversations win). */
  memberCharacters: 600_000,
  memberChunks: 3_000,
  /** Indexed characters per conversation (newest messages win). */
  conversationCharacters: 200_000,
  /** Work done inline on a save: small, so a save is never slowed noticeably. */
  liveBudget: { messages: 24, characters: 40_000 },
  /** Work per member per background tick. */
  backfillBudget: { messages: 80, characters: 120_000 },
  ftsCandidates: 80,
  scanCandidates: 120,
  purgeBatch: 400,
  queueMaxAttempts: 8,
} as const;

/** [messageId, fingerprint, chunks, at, role, characters]; chunks -1 = existed before a clear-all, -2 = over a size cap. */
type StoredMessage = [string, string, number, number, "u" | "a", number];
const SUPPRESSED = -1, CAPPED = -2;
/** Map marker for a conversation whose sync stopped part-way (never equals a fingerprint). */
const PARTIAL = "~partial";

interface StateRow {
  generation: number; mode: string; complete: number; source_version: number; source_revision: number; conversations: string;
  indexed_chars: number; indexed_chunks: number; indexed_messages: number; indexed_conversations: number; updated_at: number;
}
interface ConversationRow { conversation_id: string; generation: number; title: string; fingerprint: string; source_revision: number; status: string; messages: string; last_at: number; chars: number; chunks: number }

export interface HistorySourceConversation { id: string; title: string; messages: readonly AiWorkspaceMessage[]; revision?: number }
export interface HistorySyncInput {
  conversations: readonly HistorySourceConversation[];
  /** The list is the member's complete conversation set: missing ones were deleted. */
  full: boolean;
  version: 1 | 2;
  /** V1 snapshot revision being synced (full syncs only). */
  revision: number | null;
  /** New messages were just written (their time is "now" when no request date exists). */
  live: boolean;
  budget: { messages: number; characters: number };
}
export interface HistorySyncResult { complete: boolean; indexed: number; removed: number; truncated: boolean }
export interface HistoryCandidate { id: number; conversationId: string; messageId: string; role: "user" | "assistant"; body: string; at: number }
export interface HistoryOverview { indexedConversations: number; indexedMessages: number; pending: boolean }

const ftsState = new WeakMap<AiSql, boolean>();
/** Whether this database has the trigram FTS table (checked once per handle). */
export function memberHistoryFtsAvailable(sql: AiSql): boolean {
  let available = ftsState.get(sql);
  if (available === undefined) {
    try { available = sql.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name=?", MEMBER_HISTORY_FTS_TABLE).length === 1; }
    catch { available = false; }
    ftsState.set(sql, available);
  }
  return available;
}

function parseMessages(value: string): StoredMessage[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is StoredMessage => Array.isArray(item) && item.length === 6 && typeof item[0] === "string") : [];
  } catch { return []; }
}
function parseMap(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

interface IndexableMessage { id: string; role: "user" | "assistant"; content: string; requestId?: string; fingerprint: string }
/** User and assistant text only; replies still streaming or failed are skipped until settled. */
export function indexableHistoryMessages(messages: readonly AiWorkspaceMessage[]): IndexableMessage[] {
  const result: IndexableMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.role === "assistant" && message.status && message.status !== "ready" && message.status !== "stopped") continue;
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    result.push({ id: message.id, role: message.role, content: message.content, ...(message.requestId ? { requestId: message.requestId } : {}), fingerprint: historyFingerprint(message.role, message.content) });
  }
  return result;
}
export function historyConversationFingerprint(title: string, messages: readonly IndexableMessage[]): string {
  return historyFingerprint(title, messages.map(message => `${message.id}:${message.fingerprint}`).join(","));
}

export type MemberHistoryCaps = Pick<typeof MEMBER_HISTORY_LIMITS, "memberCharacters" | "memberChunks" | "conversationCharacters">;

/** Tenant-scoped repository. Member methods take the authenticated account id. */
export class AiMemberHistoryIndex {
  readonly tenantId: string;
  private readonly caps: { memberCharacters: number; memberChunks: number; conversationCharacters: number };
  /** `caps` exists for tests; production always uses MEMBER_HISTORY_LIMITS. */
  constructor(readonly sql: AiSql, tenantId: string = DEFAULT_AI_TENANT_ID, caps: Partial<MemberHistoryCaps> = {}) {
    this.tenantId = normalizeAiTenantId(tenantId);
    this.caps = { memberCharacters: caps.memberCharacters ?? MEMBER_HISTORY_LIMITS.memberCharacters, memberChunks: caps.memberChunks ?? MEMBER_HISTORY_LIMITS.memberChunks, conversationCharacters: caps.conversationCharacters ?? MEMBER_HISTORY_LIMITS.conversationCharacters };
  }
  userKey(userId: string): string { return tenantStorageKey(this.tenantId, userId); }
  private fts(): boolean { return memberHistoryFtsAvailable(this.sql); }

  // ------------------------------------------------------------------ state
  private state(user: string): StateRow | undefined {
    return this.sql.all<StateRow>("SELECT generation,mode,complete,source_version,source_revision,conversations,indexed_chars,indexed_chunks,indexed_messages,indexed_conversations,updated_at FROM ai_member_history_state WHERE tenant_id=? AND user_id=?", this.tenantId, user)[0];
  }
  private ensureState(user: string, now: number): StateRow {
    const existing = this.state(user);
    if (existing) return existing;
    this.sql.exec("INSERT INTO ai_member_history_state(tenant_id,user_id,generation,mode,complete,updated_at) VALUES(?,?,1,'sync',0,?)", this.tenantId, user, now);
    return this.state(user)!;
  }
  private saveState(user: string, state: StateRow, now: number): void {
    this.sql.exec(`UPDATE ai_member_history_state SET mode=?,complete=?,source_version=?,source_revision=?,conversations=?,indexed_chars=?,indexed_chunks=?,indexed_messages=?,
      indexed_conversations=(SELECT COUNT(*) FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=? AND chunks>0),updated_at=? WHERE tenant_id=? AND user_id=?`,
      state.mode, state.complete, state.source_version, state.source_revision, state.conversations, Math.max(0, state.indexed_chars), Math.max(0, state.indexed_chunks),
      Math.max(0, state.indexed_messages), this.tenantId, user, now, this.tenantId, user);
  }
  /** Current generation, or null when the member has never been indexed. */
  generation(userId: string): number | null { return this.state(this.userKey(userId))?.generation ?? null; }
  /** "baseline" after a clear-all until the existing messages are recorded as seen. */
  mode(userId: string): "sync" | "baseline" | null {
    const mode = this.state(this.userKey(userId))?.mode;
    return mode === "baseline" ? "baseline" : mode ? "sync" : null;
  }
  /** A V2 backfill pass visited every conversation. */
  markComplete(userId: string, version: 1 | 2): void {
    this.sql.exec("UPDATE ai_member_history_state SET complete=1,mode='sync',source_version=?,updated_at=? WHERE tenant_id=? AND user_id=?", version, Date.now(), this.tenantId, this.userKey(userId));
  }

  overview(userId: string): HistoryOverview {
    const user = this.userKey(userId);
    const state = this.state(user);
    const queued = this.sql.all("SELECT user_id FROM ai_member_history_queue WHERE tenant_id=? AND user_id=?", this.tenantId, user).length > 0;
    return { indexedConversations: state?.indexed_conversations ?? 0, indexedMessages: state?.indexed_messages ?? 0, pending: !state || state.complete === 0 || queued };
  }

  // ------------------------------------------------------------------ chunks
  private deleteChunks(user: string, conversationId: string, messageId?: string): void {
    const where = messageId === undefined ? "tenant_id=? AND user_id=? AND conversation_id=?" : "tenant_id=? AND user_id=? AND conversation_id=? AND message_id=?";
    const args = messageId === undefined ? [this.tenantId, user, conversationId] : [this.tenantId, user, conversationId, messageId];
    if (this.fts()) this.sql.exec(`DELETE FROM ${MEMBER_HISTORY_FTS_TABLE} WHERE rowid IN (SELECT id FROM ai_member_history_chunks WHERE ${where})`, ...args);
    this.sql.exec(`DELETE FROM ai_member_history_chunks WHERE ${where}`, ...args);
  }
  private insertChunks(user: string, generation: number, owner: string, conversationId: string, message: IndexableMessage, at: number, text: string): number {
    const chunks = historyChunks(text);
    for (const [index, body] of chunks.entries()) {
      const id = this.sql.all<{ id: number }>("INSERT INTO ai_member_history_chunks(tenant_id,user_id,generation,conversation_id,message_id,chunk_index,role,body,at) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id",
        this.tenantId, user, generation, conversationId, message.id, index, message.role, body, at)[0].id;
      if (this.fts()) this.sql.exec(`INSERT INTO ${MEMBER_HISTORY_FTS_TABLE}(rowid,owner,body) VALUES(?,?,?)`, id, owner, body);
    }
    return chunks.length;
  }

  /** Server request dates for assistant replies (the workspace only keeps "HH:mm"). */
  private requestTimes(user: string, requestIds: readonly string[]): Map<string, number> {
    const times = new Map<string, number>();
    const unique = [...new Set(requestIds)];
    for (let start = 0; start < unique.length; start += 50) {
      const batch = unique.slice(start, start + 50);
      try {
        for (const row of this.sql.all<{ request_id: string; created_at: string | null }>(
          `SELECT request_id, json_extract(data,'$.createdAt') AS created_at FROM ai_requests WHERE tenant_id=? AND user_id=? AND request_id IN (${batch.map(() => "?").join(",")})`,
          this.tenantId, user, ...batch)) {
          const at = row.created_at ? Date.parse(row.created_at) : NaN;
          if (Number.isFinite(at)) times.set(row.request_id, at);
        }
      } catch { /* No request ledger: dates stay unknown. */ }
    }
    return times;
  }

  // -------------------------------------------------------------------- sync
  /**
   * Bring the member's index in line with `input`. Runs in one transaction;
   * never throws for content reasons. Returns whether everything fit the budget.
   */
  sync(userId: string, input: HistorySyncInput): HistorySyncResult {
    const user = this.userKey(userId);
    const owner = historyOwnerKey(this.tenantId, user);
    return this.sql.transaction(() => {
      const now = Date.now();
      const state = this.ensureState(user, now);
      const generation = state.generation;
      const baseline = state.mode === "baseline";
      const map = parseMap(state.conversations);
      const seen = new Set<string>();
      let spentMessages = 0, spentChars = 0, truncated = false, indexed = 0, removed = 0;
      const overBudget = () => spentMessages >= input.budget.messages || spentChars >= input.budget.characters;

      for (const conversation of input.conversations) {
        seen.add(conversation.id);
        const messages = indexableHistoryMessages(conversation.messages);
        const fingerprint = historyConversationFingerprint(conversation.title, messages);
        if (map[conversation.id] === fingerprint) continue;
        if (truncated) continue;
        const row = this.sql.all<ConversationRow>("SELECT conversation_id,generation,title,fingerprint,source_revision,status,messages,last_at,chars,chunks FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=? AND conversation_id=?",
          this.tenantId, user, conversation.id)[0];
        const stored = new Map((row && row.generation === generation ? parseMessages(row.messages) : []).map(item => [item[0], item] as const));
        if (row && row.generation !== generation) this.deleteChunks(user, conversation.id);
        const current = new Map(messages.map(message => [message.id, message] as const));
        // Deleted or edited messages leave the index first.
        for (const [id, item] of stored) {
          const next = current.get(id);
          if (next && next.fingerprint === item[1]) continue;
          if (item[2] > 0) {
            this.deleteChunks(user, conversation.id, id);
            state.indexed_chunks -= item[2]; state.indexed_chars -= item[5]; state.indexed_messages -= 1;
          }
          stored.delete(id); removed += 1;
        }
        // Dates: a reply has its request's server time; a question takes the
        // time of the reply after it; otherwise the previous known time, or
        // "now" for a message that was just written.
        const fresh = messages.filter(message => !stored.has(message.id));
        const times = this.requestTimes(user, fresh.flatMap(message => message.requestId ? [message.requestId] : []));
        const ats = new Map<string, number>();
        let following = 0;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          const own = stored.get(message.id)?.[3] || (message.requestId ? times.get(message.requestId) : undefined) || 0;
          if (own) following = own;
          ats.set(message.id, own || following);
        }
        let previous = 0;
        for (const message of messages) {
          const at = ats.get(message.id) ?? 0;
          if (at) previous = at; else ats.set(message.id, input.live ? now : previous);
        }
        // Newest first: recent messages are indexed first and survive the
        // per-conversation cap. Messages already indexed are always carried
        // over, even when the budget stops new work part-way.
        const next = new Map<string, StoredMessage>();
        let conversationChars = 0, complete = true;
        for (const message of [...messages].reverse()) {
          const existing = stored.get(message.id);
          if (existing) {
            if (existing[2] > 0 && conversationChars + existing[5] > this.caps.conversationCharacters) {
              this.deleteChunks(user, conversation.id, message.id);
              state.indexed_chunks -= existing[2]; state.indexed_chars -= existing[5]; state.indexed_messages -= 1;
              next.set(message.id, [existing[0], existing[1], CAPPED, existing[3], existing[4], 0]);
              continue;
            }
            if (existing[2] > 0) conversationChars += existing[5];
            next.set(message.id, existing);
            continue;
          }
          const at = ats.get(message.id) ?? 0;
          const role = message.role === "user" ? "u" : "a";
          if (baseline) { next.set(message.id, [message.id, message.fingerprint, SUPPRESSED, at, role, 0]); continue; }
          if (overBudget()) { truncated = true; complete = false; continue; }
          const text = historyIndexText(message.content);
          const chars = Array.from(text).length;
          if (conversationChars + chars > this.caps.conversationCharacters) { next.set(message.id, [message.id, message.fingerprint, CAPPED, at, role, 0]); continue; }
          const chunks = text ? this.insertChunks(user, generation, owner, conversation.id, message, at, text) : 0;
          spentMessages += 1; spentChars += chars; indexed += 1;
          if (chunks) { conversationChars += chars; state.indexed_chunks += chunks; state.indexed_chars += chars; state.indexed_messages += 1; }
          next.set(message.id, [message.id, message.fingerprint, chunks, at, role, chunks ? chars : 0]);
        }
        const ordered = messages.flatMap(message => next.has(message.id) ? [next.get(message.id)!] : []);
        const lastAt = ordered.reduce((max, item) => Math.max(max, item[3]), 0);
        const chunkTotal = ordered.reduce((sum, item) => sum + Math.max(0, item[2]), 0);
        const charTotal = ordered.reduce((sum, item) => sum + (item[2] > 0 ? item[5] : 0), 0);
        const status = baseline ? "suppressed" : complete ? "indexed" : "partial";
        this.sql.exec(`INSERT INTO ai_member_history_conversations(tenant_id,user_id,conversation_id,generation,title,fingerprint,source_revision,status,messages,last_at,chars,chunks,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(tenant_id,user_id,conversation_id) DO UPDATE SET generation=excluded.generation,title=excluded.title,fingerprint=excluded.fingerprint,source_revision=excluded.source_revision,status=excluded.status,messages=excluded.messages,last_at=excluded.last_at,chars=excluded.chars,chunks=excluded.chunks,updated_at=excluded.updated_at`,
        this.tenantId, user, conversation.id, generation, conversation.title.slice(0, 200), fingerprint, conversation.revision ?? 0, status, JSON.stringify(ordered), lastAt, charTotal, chunkTotal, now);
        // Every stored conversation has a map entry (deletion detection needs
        // only the map); a partial one gets a marker that never matches.
        map[conversation.id] = complete ? fingerprint : PARTIAL;
      }
      if (input.full) {
        for (const id of Object.keys(map)) {
          if (seen.has(id)) continue;
          const item = this.sql.all<{ conversation_id: string; chunks: number; chars: number; messages: string; generation: number }>("SELECT conversation_id,chunks,chars,messages,generation FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=? AND conversation_id=?", this.tenantId, user, id)[0];
          if (item) removed += this.dropConversation(user, item, state, generation);
          delete map[id];
        }
      }
      this.enforceMemberCaps(user, state, generation, map);
      state.conversations = JSON.stringify(map);
      if (baseline && input.full) state.mode = "sync";
      if (input.full) {
        state.complete = truncated ? 0 : 1;
        state.source_version = input.version;
        if (!truncated && input.revision !== null) state.source_revision = input.revision;
      } else if (truncated) state.complete = 0;
      this.saveState(user, state, now);
      return { complete: !truncated, indexed, removed, truncated };
    });
  }

  /** V2 backfill: conversations no longer in the directory leave the index. */
  dropMissingConversations(userId: string, present: ReadonlySet<string>): number {
    const user = this.userKey(userId);
    return this.sql.transaction(() => {
      const state = this.state(user);
      if (!state) return 0;
      const map = parseMap(state.conversations);
      let removed = 0;
      for (const item of this.sql.all<{ conversation_id: string; chunks: number; chars: number; messages: string; generation: number }>("SELECT conversation_id,chunks,chars,messages,generation FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=?", this.tenantId, user)) {
        if (present.has(item.conversation_id)) continue;
        removed += this.dropConversation(user, item, state, state.generation);
        delete map[item.conversation_id];
      }
      state.conversations = JSON.stringify(map);
      this.saveState(user, state, Date.now());
      return removed;
    });
  }

  /** Stored V2 revisions, to skip unchanged conversations during a V2 backfill. */
  conversationRevisions(userId: string): Map<string, number> {
    const user = this.userKey(userId);
    const generation = this.state(user)?.generation;
    return new Map(this.sql.all<{ conversation_id: string; source_revision: number; generation: number; status: string }>(
      "SELECT conversation_id,source_revision,generation,status FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=?", this.tenantId, user)
      .filter(row => row.generation === generation && row.status !== "partial").map(row => [row.conversation_id, row.source_revision]));
  }

  private dropConversation(user: string, item: { conversation_id: string; chunks: number; chars: number; messages: string; generation: number }, state: StateRow, generation: number): number {
    this.deleteChunks(user, item.conversation_id);
    this.sql.exec("DELETE FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=? AND conversation_id=?", this.tenantId, user, item.conversation_id);
    if (item.generation !== generation) return 0;
    const messages = parseMessages(item.messages);
    state.indexed_chunks -= item.chunks; state.indexed_chars -= item.chars;
    state.indexed_messages -= messages.filter(message => message[2] > 0).length;
    return messages.length;
  }

  /** Over the member cap: the least recently active conversations stop being searchable. */
  private enforceMemberCaps(user: string, state: StateRow, generation: number, map: Record<string, string>): void {
    for (let guard = 0; guard < 500 && (state.indexed_chars > this.caps.memberCharacters || state.indexed_chunks > this.caps.memberChunks); guard += 1) {
      const victim = this.sql.all<ConversationRow>("SELECT conversation_id,generation,title,fingerprint,source_revision,status,messages,last_at,chars,chunks FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=? AND generation=? AND chunks>0 ORDER BY last_at ASC, updated_at ASC LIMIT 1",
        this.tenantId, user, generation)[0];
      if (!victim) break;
      this.deleteChunks(user, victim.conversation_id);
      const messages = parseMessages(victim.messages);
      state.indexed_chunks -= victim.chunks; state.indexed_chars -= victim.chars;
      state.indexed_messages -= messages.filter(message => message[2] > 0).length;
      const capped = messages.map((message): StoredMessage => message[2] > 0 ? [message[0], message[1], CAPPED, message[3], message[4], 0] : message);
      this.sql.exec("UPDATE ai_member_history_conversations SET status='capped',messages=?,chars=0,chunks=0,updated_at=? WHERE tenant_id=? AND user_id=? AND conversation_id=?",
        JSON.stringify(capped), Date.now(), this.tenantId, user, victim.conversation_id);
      // Still "done": a capped conversation is only revisited when it changes.
      map[victim.conversation_id] = victim.fingerprint;
    }
  }

  // ------------------------------------------------------------------ search
  /**
   * Candidate chunks for a query from the member's own index, excluding one
   * conversation. FTS trigram phrases for 3+ character terms, a bounded
   * substring scan (this member's rows only) for 2-character terms or when the
   * runtime has no FTS. Ranking happens in the caller.
   */
  candidates(userId: string, query: HistoryQuery, options: { excludeConversationId?: string; roles?: ReadonlyArray<"user" | "assistant"> } = {}): HistoryCandidate[] {
    const user = this.userKey(userId);
    const generation = this.state(user)?.generation;
    if (generation === undefined || !query.units.length) return [];
    const exclude = options.excludeConversationId ?? "";
    const rows = new Map<number, HistoryCandidate>();
    const add = (row: { id: number; conversation_id: string; message_id: string; role: string; body: string; at: number }) => {
      if (rows.has(row.id) || (row.role !== "user" && row.role !== "assistant")) return;
      if (options.roles && !options.roles.includes(row.role)) return;
      rows.set(row.id, { id: row.id, conversationId: row.conversation_id, messageId: row.message_id, role: row.role, body: row.body, at: row.at });
    };
    const fts = this.fts();
    if (fts && query.ftsTerms.length) {
      try {
        for (const row of this.sql.all<{ id: number; conversation_id: string; message_id: string; role: string; body: string; at: number }>(
          `SELECT c.id,c.conversation_id,c.message_id,c.role,c.body,c.at FROM ${MEMBER_HISTORY_FTS_TABLE} JOIN ai_member_history_chunks c ON c.id=${MEMBER_HISTORY_FTS_TABLE}.rowid
           WHERE ${MEMBER_HISTORY_FTS_TABLE} MATCH ? AND c.tenant_id=? AND c.user_id=? AND c.generation=? AND c.conversation_id<>? ORDER BY ${MEMBER_HISTORY_FTS_TABLE}.rank LIMIT ?`,
          historyMatchExpression(historyOwnerKey(this.tenantId, user), query.ftsTerms), this.tenantId, user, generation, exclude, MEMBER_HISTORY_LIMITS.ftsCandidates)) add(row);
      } catch { /* A malformed index never fails a reply: fall through to the scan. */ }
    }
    const scanTerms = (fts ? query.shortTerms : [...query.shortTerms, ...query.segments]).filter((term, index, all) => all.indexOf(term) === index).slice(0, 8);
    if (scanTerms.length) {
      for (const row of this.sql.all<{ id: number; conversation_id: string; message_id: string; role: string; body: string; at: number }>(
        `SELECT id,conversation_id,message_id,role,body,at FROM ai_member_history_chunks WHERE tenant_id=? AND user_id=? AND generation=? AND conversation_id<>? AND (${scanTerms.map(() => "instr(lower(body),?)>0").join(" OR ")}) ORDER BY at DESC, id DESC LIMIT ?`,
        this.tenantId, user, generation, exclude, ...scanTerms, MEMBER_HISTORY_LIMITS.scanCandidates)) add(row);
    }
    return [...rows.values()];
  }

  /** Titles of the member's other indexed conversations that mention `term`. */
  titleMentions(userId: string, terms: readonly string[], excludeConversationId?: string): string[] {
    const user = this.userKey(userId);
    const generation = this.state(user)?.generation;
    if (generation === undefined || !terms.length) return [];
    const bounded = terms.slice(0, 6);
    return this.sql.all<{ term: string }>(
      `SELECT DISTINCT t.value AS term FROM json_each(?) t JOIN ai_member_history_conversations c ON instr(lower(c.title), t.value)>0
       WHERE c.tenant_id=? AND c.user_id=? AND c.generation=? AND c.conversation_id<>?`,
      JSON.stringify(bounded), this.tenantId, user, generation, excludeConversationId ?? "").map(row => row.term);
  }

  conversationTitles(userId: string, conversationIds: readonly string[]): Map<string, string> {
    const user = this.userKey(userId);
    const ids = [...new Set(conversationIds)].slice(0, 40);
    if (!ids.length) return new Map();
    return new Map(this.sql.all<{ conversation_id: string; title: string }>(
      `SELECT conversation_id,title FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=? AND conversation_id IN (${ids.map(() => "?").join(",")})`,
      this.tenantId, user, ...ids).map(row => [row.conversation_id, row.title]));
  }

  // ------------------------------------------------------------ lifecycle
  /**
   * Stop matching everything indexed so far (generation bump) and queue the
   * old rows for deletion. `baseline`: the next sync records the member's
   * existing messages as already seen instead of indexing them (clear-all);
   * `sync`: the next sync indexes everything again (re-enable).
   */
  reset(userId: string, mode: "sync" | "baseline", options: { enqueue?: boolean } = {}): void {
    const user = this.userKey(userId);
    this.sql.transaction(() => {
      const now = Date.now();
      const state = this.state(user);
      if (!state) {
        this.sql.exec("INSERT INTO ai_member_history_state(tenant_id,user_id,generation,mode,complete,updated_at) VALUES(?,?,1,?,0,?)", this.tenantId, user, mode, now);
      } else {
        const generation = state.generation + 1;
        this.sql.exec(`UPDATE ai_member_history_state SET generation=?,mode=?,complete=0,source_revision=-1,conversations='{}',indexed_chars=0,indexed_chunks=0,indexed_messages=0,indexed_conversations=0,updated_at=? WHERE tenant_id=? AND user_id=?`,
          generation, mode, now, this.tenantId, user);
        this.sql.exec("INSERT INTO ai_member_history_purges(tenant_id,user_id,below_generation,created_at) VALUES(?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET below_generation=excluded.below_generation",
          this.tenantId, user, generation, now);
      }
      this.sql.exec("DELETE FROM ai_member_history_conversations WHERE tenant_id=? AND user_id=?", this.tenantId, user);
      if (options.enqueue) this.enqueueStored(user, mode === "baseline" ? "baseline" : "backfill", now);
      else this.sql.exec("DELETE FROM ai_member_history_queue WHERE tenant_id=? AND user_id=?", this.tenantId, user);
    });
  }

  /** The organization switched recall (or memory) off: every member's index is purged. */
  resetTenant(): void {
    this.sql.transaction(() => {
      const now = Date.now();
      this.sql.exec(`UPDATE ai_member_history_state SET generation=generation+1,mode='sync',complete=0,source_revision=-1,conversations='{}',indexed_chars=0,indexed_chunks=0,indexed_messages=0,indexed_conversations=0,updated_at=? WHERE tenant_id=?`, now, this.tenantId);
      this.sql.exec(`INSERT INTO ai_member_history_purges(tenant_id,user_id,below_generation,created_at) SELECT tenant_id,user_id,generation,? FROM ai_member_history_state WHERE tenant_id=? ON CONFLICT(tenant_id,user_id) DO UPDATE SET below_generation=excluded.below_generation`, now, this.tenantId);
      this.sql.exec("DELETE FROM ai_member_history_conversations WHERE tenant_id=?", this.tenantId);
      this.sql.exec("DELETE FROM ai_member_history_queue WHERE tenant_id=?", this.tenantId);
    });
  }

  enqueue(userId: string, reason: string, dueAt = Date.now()): void { this.enqueueStored(this.userKey(userId), reason, dueAt); }
  private enqueueStored(user: string, reason: string, dueAt: number): void {
    this.sql.exec("INSERT INTO ai_member_history_queue(tenant_id,user_id,reason,due_at,attempts) VALUES(?,?,?,?,0) ON CONFLICT(tenant_id,user_id) DO UPDATE SET reason=excluded.reason,due_at=MIN(ai_member_history_queue.due_at,excluded.due_at)",
      this.tenantId, user, reason, dueAt);
  }

  /** Members of this organization whose V1 workspace moved past the indexed revision (or never indexed). */
  enqueueDrift(now = Date.now()): number {
    try {
      const before = this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_member_history_queue WHERE tenant_id=?", this.tenantId)[0]?.count ?? 0;
      this.sql.exec(`INSERT OR IGNORE INTO ai_member_history_queue(tenant_id,user_id,reason,due_at,attempts)
        SELECT w.tenant_id,w.user_id,'reconcile',?,0 FROM ai_workspaces w
        LEFT JOIN ai_member_history_state s ON s.tenant_id=w.tenant_id AND s.user_id=w.user_id
        LEFT JOIN ai_member_memories m ON m.tenant_id=w.tenant_id AND m.user_id=w.user_id
        WHERE w.tenant_id=? AND COALESCE(m.learning_enabled,1)=1
          AND (s.user_id IS NULL OR s.complete=0 OR s.mode='baseline' OR (w.schema_version=1 AND s.source_revision<>w.revision))`, now, this.tenantId);
      return (this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_member_history_queue WHERE tenant_id=?", this.tenantId)[0]?.count ?? 0) - before;
    } catch { return 0; }
  }

  // ---------------------------------------------------------- maintenance
  /** Cross-tenant: due backfill jobs. */
  static dueQueue(sql: AiSql, now: number, limit: number): Array<{ tenantId: string; userId: string; reason: string; attempts: number }> {
    const result: Array<{ tenantId: string; userId: string; reason: string; attempts: number }> = [];
    for (const row of sql.all<{ tenant_id: string; user_id: string; reason: string; attempts: number }>("SELECT tenant_id,user_id,reason,attempts FROM ai_member_history_queue WHERE due_at<=? ORDER BY due_at LIMIT ?", now, limit)) {
      try { result.push({ tenantId: normalizeAiTenantId(row.tenant_id), userId: tenantStorageValue(row.tenant_id, row.user_id), reason: row.reason, attempts: row.attempts }); }
      catch { sql.exec("DELETE FROM ai_member_history_queue WHERE tenant_id=? AND user_id=?", row.tenant_id, row.user_id); }
    }
    return result;
  }
  finishQueued(userId: string, done: boolean, now = Date.now()): void {
    const user = this.userKey(userId);
    if (done) this.sql.exec("DELETE FROM ai_member_history_queue WHERE tenant_id=? AND user_id=?", this.tenantId, user);
    else this.sql.exec("UPDATE ai_member_history_queue SET due_at=?,attempts=0 WHERE tenant_id=? AND user_id=?", now, this.tenantId, user);
  }
  failQueued(userId: string, attempts: number, now = Date.now()): void {
    const user = this.userKey(userId);
    if (attempts + 1 >= MEMBER_HISTORY_LIMITS.queueMaxAttempts) { this.sql.exec("DELETE FROM ai_member_history_queue WHERE tenant_id=? AND user_id=?", this.tenantId, user); return; }
    // 1, 4, 16, 64 … minutes.
    this.sql.exec("UPDATE ai_member_history_queue SET due_at=?,attempts=? WHERE tenant_id=? AND user_id=?", now + 60_000 * 4 ** attempts, attempts + 1, this.tenantId, user);
  }

  /** Cross-tenant: delete rows of superseded generations in bounded batches. */
  static runPurges(sql: AiSql, limit: number): number {
    let deleted = 0;
    const fts = memberHistoryFtsAvailable(sql);
    for (const purge of sql.all<{ tenant_id: string; user_id: string; below_generation: number }>("SELECT tenant_id,user_id,below_generation FROM ai_member_history_purges ORDER BY created_at LIMIT ?", Math.max(1, limit))) {
      sql.transaction(() => {
        const ids = sql.all<{ id: number }>("SELECT id FROM ai_member_history_chunks WHERE tenant_id=? AND user_id=? AND generation<? ORDER BY id LIMIT ?",
          purge.tenant_id, purge.user_id, purge.below_generation, MEMBER_HISTORY_LIMITS.purgeBatch).map(row => row.id);
        if (ids.length) {
          const maxId = ids[ids.length - 1];
          if (fts) sql.exec(`DELETE FROM ${MEMBER_HISTORY_FTS_TABLE} WHERE rowid IN (SELECT id FROM ai_member_history_chunks WHERE tenant_id=? AND user_id=? AND generation<? AND id<=?)`, purge.tenant_id, purge.user_id, purge.below_generation, maxId);
          sql.exec("DELETE FROM ai_member_history_chunks WHERE tenant_id=? AND user_id=? AND generation<? AND id<=?", purge.tenant_id, purge.user_id, purge.below_generation, maxId);
          deleted += ids.length;
        }
        if (ids.length < MEMBER_HISTORY_LIMITS.purgeBatch) sql.exec("DELETE FROM ai_member_history_purges WHERE tenant_id=? AND user_id=? AND below_generation=?", purge.tenant_id, purge.user_id, purge.below_generation);
      });
    }
    return deleted;
  }

  /** Organization aggregates (no text). */
  stats(): { indexedMembers: number; indexedMessages: number } {
    const row = this.sql.all<{ members: number | null; messages: number | null }>("SELECT SUM(CASE WHEN indexed_messages>0 THEN 1 ELSE 0 END) AS members, SUM(indexed_messages) AS messages FROM ai_member_history_state WHERE tenant_id=?", this.tenantId)[0];
    return { indexedMembers: row?.members ?? 0, indexedMessages: row?.messages ?? 0 };
  }
}

// ---------------------------------------------------------------------------
// Workspace sources
// ---------------------------------------------------------------------------

/** V1: the whole snapshot is the source (conversation order is newest first). */
export function historySourceFromState(state: AiWorkspaceState | null): HistorySourceConversation[] {
  return (state?.conversations ?? []).map(conversation => ({ id: conversation.id, title: conversation.title, messages: conversation.messages }));
}
export function historySourceFromConversation(conversation: AiWorkspaceConversation, revision?: number): HistorySourceConversation {
  return { id: conversation.id, title: conversation.title, messages: conversation.messages, ...(revision !== undefined ? { revision } : {}) };
}

/** Whether history is indexed for this member now: organization memory + recall on, member learning on. */
export function memberHistoryEligible(sql: AiSql, tenantId: string, userId: string): boolean {
  try {
    const repository = new AiMemberMemoryRepository(sql, tenantId);
    const settings = repository.settings();
    return settings.enabled && settings.recallEnabled && repository.read(userId).learningEnabled;
  } catch { return false; }
}
