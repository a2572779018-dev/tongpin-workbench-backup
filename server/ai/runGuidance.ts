import { AI_RUN_GUIDANCE_LIMITS, type AiRunGuidanceItem, type AiRunGuidanceStatus } from "../../shared/aiRunGuidance";
import type { AiChatRequest } from "../../shared/ai";
import { AiError } from "./security";
import type { AiSql, AiStore } from "./storage";

/**
 * Mid-run guidance ("steer") for multi-step runs.
 *
 * A member may add a short correction or supplement while a run is still
 * working. The text is stored per tenant + member + run and stays pending until
 * the run's step loop calls `takePendingGuidance` (or `withPendingGuidance`)
 * right before building its next model call; it is then injected as one extra
 * user message and marked delivered exactly once. Nothing here calls a model,
 * reserves quota or grants a tool: the step loop still validates every
 * decision against its own allowlist and approval rules.
 *
 * Scope: every function takes the tenant-scoped AiStore and the authenticated
 * member id. A run owned by another member or tenant is indistinguishable from
 * a missing one (404).
 *
 * Step-loop API (the whole surface other loops need):
 *   withPendingGuidance(store, userId, runRequestId, messages, { deliveredTo })
 *     → `messages` plus at most one extra user message; call right before each
 *       next model call. takePendingGuidance(...) returns the raw [{ id, text }].
 *   registerRunGuidanceTarget(fn): only when the run id is neither a harness run
 *     (ai_harness_runs.request_id) nor a pending chat request id.
 * Clients post to /api/ai/requests/:runRequestId/guidance (runGuidanceRoute).
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_run_guidance (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  guidance_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  delivered_to TEXT,
  PRIMARY KEY (tenant_id,user_id,request_id,guidance_id)
);
CREATE INDEX IF NOT EXISTS ai_run_guidance_run ON ai_run_guidance(tenant_id,user_id,request_id,status,seq);
CREATE INDEX IF NOT EXISTS ai_run_guidance_age ON ai_run_guidance(tenant_id,user_id,created_at);
`;

/** Prepended to the injected user message. Server-side only; never shown in the UI. */
export const AI_RUN_GUIDANCE_FRAMING = "以下是用户在任务进行中补充/纠正的信息，请据此修正或继续当前任务（仍须遵守原有输出格式、工具范围与确认规则）：";
/** Prepended to a follow-up turn marked `supplement: true`. Server-side only. */
export const AI_SUPPLEMENT_FRAMING = "以下是用户在你回复过程中补充/纠正的信息，请据此修正或继续上一条任务：";

const ID = /^[a-zA-Z0-9_-]{16,100}$/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ACTIVE_RUN_STATUSES = new Set(["planned", "running", "waiting_approval"]);
/** Bounds storage when a client repeatedly adds and withdraws items. */
const MAX_ROWS_PER_RUN = 20;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

type Row = {
  guidance_id: string; seq: number; text: string; text_hash: string;
  status: AiRunGuidanceStatus; created_at: number; delivered_at: number | null;
};

export type AiRunGuidanceTargetState = "active" | "terminal";
/** Resolves whether `requestId` names a run of this member that can still take
 * guidance. Return undefined when the id is not a run of this kind. */
export type AiRunGuidanceTarget = (store: AiStore, userId: string, requestId: string, now: number) => AiRunGuidanceTargetState | undefined;

const registeredTargets = new Set<AiRunGuidanceTarget>();

/** Extension point for other step loops (e.g. a multi-agent run) whose run
 * record is not a harness run or a pending chat request. Registered targets are
 * consulted before the built-in ones. Returns an unregister function. */
export function registerRunGuidanceTarget(target: AiRunGuidanceTarget): () => void {
  registeredTargets.add(target);
  return () => { registeredTargets.delete(target); };
}

const initialized = new WeakSet<AiSql>();
function ready(store: AiStore): AiStore {
  if (!initialized.has(store.sql)) {
    store.sql.exec(SCHEMA);
    initialized.add(store.sql);
  }
  return store;
}

/** Non-cryptographic 64-bit fingerprint used only to detect an id reused for
 * different text by the same member; the text itself is cleared once used. */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef ^ text.length, h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function invalid(message: string): never {
  throw new AiError(400, "AI_GUIDANCE_INVALID", message);
}

function validId(value: unknown, label: string): string {
  if (typeof value !== "string" || !ID.test(value)) invalid(`${label}无效`);
  return value;
}

/** Exactly `{ id, text }`. Account or tenant fields are never accepted from the body. */
export function parseRunGuidanceInput(body: unknown): { id: string; text: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) invalid("请提交补充内容");
  const value = body as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("text")) invalid("补充内容只能包含标识和文字");
  const id = validId(value.id, "补充标识");
  if (typeof value.text !== "string") invalid("补充内容必须是文字");
  const text = value.text.replace(/\r\n?/g, "\n").trim();
  if (!text) invalid("补充内容不能为空");
  if (Array.from(text).length > AI_RUN_GUIDANCE_LIMITS.characters) invalid(`每条补充最多 ${AI_RUN_GUIDANCE_LIMITS.characters} 字`);
  if (CONTROL.test(text)) invalid("补充内容包含不支持的控制字符");
  return { id, text };
}

function targetState(store: AiStore, userId: string, requestId: string, now: number): AiRunGuidanceTargetState | undefined {
  for (const target of registeredTargets) {
    const state = target(store, userId, requestId, now);
    if (state) return state;
  }
  // The harness run outlives its planning request (e.g. a PPT plan run stays
  // "planned" for a background continuation), so it is authoritative.
  const run = store.harnessRun(userId, requestId);
  if (run) return ACTIVE_RUN_STATUSES.has(run.status) ? "active" : "terminal";
  const request = store.request(userId, requestId);
  if (request) return request.status === "pending" && request.expiresAt > now ? "active" : "terminal";
  return undefined;
}

function rowFor(store: AiStore, userId: string, requestId: string, guidanceId: string): Row | undefined {
  return store.sql.all<Row>(
    "SELECT guidance_id,seq,text,text_hash,status,created_at,delivered_at FROM ai_run_guidance WHERE tenant_id=? AND user_id=? AND request_id=? AND guidance_id=?",
    store.tenantId, userId, requestId, guidanceId,
  )[0];
}

function view(row: Row): AiRunGuidanceItem {
  return {
    id: row.guidance_id, status: row.status, createdAt: row.created_at,
    ...(row.delivered_at !== null && row.delivered_at !== undefined ? { deliveredAt: row.delivered_at } : {}),
  };
}

/** POST /api/ai/requests/:requestId/guidance. Idempotent by the client id:
 * replaying the same id and text returns the stored item even after the run
 * ended; the same id with different text is a conflict. */
export function submitRunGuidance(store: AiStore, userId: string, requestIdValue: unknown, body: unknown, now = Date.now()): { guidance: AiRunGuidanceItem; created: boolean } {
  store.assertAccess(userId);
  const requestId = validId(requestIdValue, "任务标识");
  const input = parseRunGuidanceInput(body);
  const hash = fingerprint(input.text);
  ready(store);
  return store.sql.transaction(() => {
    const existing = rowFor(store, userId, requestId, input.id);
    if (existing) {
      if (existing.text_hash !== hash) throw new AiError(409, "AI_GUIDANCE_CONFLICT", "相同补充标识不能用于不同内容");
      return { guidance: view(existing), created: false };
    }
    const state = targetState(store, userId, requestId, now);
    if (!state) throw new AiError(404, "AI_RUN_NOT_FOUND", "没有找到这次任务记录");
    if (state !== "active") throw new AiError(409, "AI_RUN_NOT_ACTIVE", "这次任务已结束，补充内容会作为新消息发送");
    const counts = store.sql.all<{ total: number; live: number; seq: number | null }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status!='cancelled' THEN 1 ELSE 0 END) AS live, MAX(seq) AS seq FROM ai_run_guidance WHERE tenant_id=? AND user_id=? AND request_id=?",
      store.tenantId, userId, requestId,
    )[0];
    if (Number(counts?.live ?? 0) >= AI_RUN_GUIDANCE_LIMITS.itemsPerRun || Number(counts?.total ?? 0) >= MAX_ROWS_PER_RUN) {
      throw new AiError(409, "AI_GUIDANCE_LIMIT", `这次任务最多补充 ${AI_RUN_GUIDANCE_LIMITS.itemsPerRun} 条，其余内容会在回复结束后发送`);
    }
    store.sql.exec("DELETE FROM ai_run_guidance WHERE tenant_id=? AND user_id=? AND created_at<?", store.tenantId, userId, now - RETENTION_MS);
    store.sql.exec(
      "INSERT INTO ai_run_guidance(tenant_id,user_id,request_id,guidance_id,seq,text,text_hash,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      store.tenantId, userId, requestId, input.id, Number(counts?.seq ?? 0) + 1, input.text, hash, "pending", now,
    );
    return { guidance: view(rowFor(store, userId, requestId, input.id)!), created: true };
  });
}

/** GET /api/ai/requests/:requestId/guidance: statuses only, oldest first. */
export function listRunGuidance(store: AiStore, userId: string, requestIdValue: unknown): { guidance: AiRunGuidanceItem[] } {
  store.assertAccess(userId);
  const requestId = validId(requestIdValue, "任务标识");
  ready(store);
  const rows = store.sql.all<Row>(
    "SELECT guidance_id,seq,text,text_hash,status,created_at,delivered_at FROM ai_run_guidance WHERE tenant_id=? AND user_id=? AND request_id=? ORDER BY seq",
    store.tenantId, userId, requestId,
  );
  return { guidance: rows.map(view) };
}

/** DELETE /api/ai/requests/:requestId/guidance/:guidanceId. Only a pending item
 * can be withdrawn; one the run already took stays delivered (409). */
export function cancelRunGuidance(store: AiStore, userId: string, requestIdValue: unknown, guidanceIdValue: unknown): { guidance: AiRunGuidanceItem } {
  store.assertAccess(userId);
  const requestId = validId(requestIdValue, "任务标识");
  const guidanceId = validId(guidanceIdValue, "补充标识");
  ready(store);
  return store.sql.transaction(() => {
    const row = rowFor(store, userId, requestId, guidanceId);
    if (!row) throw new AiError(404, "AI_GUIDANCE_NOT_FOUND", "没有找到这条补充");
    if (row.status === "delivered") throw new AiError(409, "AI_GUIDANCE_DELIVERED", "AI 已读取这条补充，无法撤回");
    if (row.status === "pending") {
      store.sql.exec("UPDATE ai_run_guidance SET status='cancelled',text='' WHERE tenant_id=? AND user_id=? AND request_id=? AND guidance_id=?",
        store.tenantId, userId, requestId, guidanceId);
    }
    return { guidance: view(rowFor(store, userId, requestId, guidanceId)!) };
  });
}

/**
 * For step loops: takes this run's pending guidance (oldest first, at most the
 * per-run limit) and marks it delivered, so each item reaches exactly one model
 * call. Call it right before building the next model call; include every
 * returned text in that call. `deliveredTo` records which model request carried
 * it (diagnostics only). Opens no transaction of its own, so it may also be
 * called inside a step loop's claim transaction.
 */
export function takePendingGuidance(store: AiStore, userId: string, requestId: string, options: { deliveredTo?: string; now?: number } = {}): Array<{ id: string; text: string }> {
  if (!ID.test(requestId)) return [];
  ready(store);
  const pending = store.sql.all<Row>(
    "SELECT guidance_id,seq,text,text_hash,status,created_at,delivered_at FROM ai_run_guidance WHERE tenant_id=? AND user_id=? AND request_id=? AND status='pending' ORDER BY seq LIMIT ?",
    store.tenantId, userId, requestId, AI_RUN_GUIDANCE_LIMITS.itemsPerRun,
  );
  if (!pending.length) return [];
  // One guarded statement flips pending→delivered at most once per row; RETURNING
  // reports exactly which rows this call took. The text then lives only in the
  // model request that carries it.
  const taken = new Set(store.sql.all<{ guidance_id: string }>(
    `UPDATE ai_run_guidance SET status='delivered',text='',delivered_at=?,delivered_to=? WHERE tenant_id=? AND user_id=? AND request_id=? AND status='pending' AND guidance_id IN (${pending.map(() => "?").join(",")}) RETURNING guidance_id`,
    options.now ?? Date.now(), options.deliveredTo ?? null, store.tenantId, userId, requestId, ...pending.map(row => row.guidance_id),
  ).map(row => row.guidance_id));
  return pending.filter(row => taken.has(row.guidance_id) && row.text).map(row => ({ id: row.guidance_id, text: row.text }));
}

/** One extra user message carrying the taken guidance, or undefined when none. */
export function runGuidanceMessage(items: ReadonlyArray<{ text: string }>, framing = AI_RUN_GUIDANCE_FRAMING): { role: "user"; content: string } | undefined {
  const texts = items.map(item => item.text.trim()).filter(Boolean);
  if (!texts.length) return undefined;
  return { role: "user", content: `${framing}\n${texts.length === 1 ? texts[0] : texts.map((text, index) => `${index + 1}. ${text}`).join("\n")}` };
}

/** Convenience for step loops: `messages` plus the pending guidance message. */
export function withPendingGuidance(
  store: AiStore, userId: string, requestId: string,
  messages: AiChatRequest["messages"],
  options: { deliveredTo?: string; now?: number; framing?: string } = {},
): AiChatRequest["messages"] {
  const message = runGuidanceMessage(takePendingGuidance(store, userId, requestId, options), options.framing);
  return message ? [...messages, message] : messages;
}

/** Frames the latest user turn of a `supplement: true` chat request. A
 * "continue" retry keeps its own latest instruction untouched. */
export function supplementFramedMessages(request: Pick<AiChatRequest, "messages" | "supplement" | "retryMode">): AiChatRequest["messages"] {
  if (request.supplement !== true || request.retryMode === "continue") return request.messages;
  const last = request.messages.length - 1;
  if (last < 0 || request.messages[last].role !== "user") return request.messages;
  return request.messages.map((message, index) => index === last ? { ...message, content: `${AI_SUPPLEMENT_FRAMING}\n${message.content}` } : message);
}

/** Shared by the Express and Worker routers so both expose the same contract:
 * POST   /api/ai/requests/:requestId/guidance            { id, text }
 * GET    /api/ai/requests/:requestId/guidance
 * DELETE /api/ai/requests/:requestId/guidance/:guidanceId */
export function runGuidanceRoute(store: AiStore, userId: string, method: string, requestId: string, guidanceId?: string, body?: unknown): unknown {
  if (method === "POST" && guidanceId === undefined) return submitRunGuidance(store, userId, requestId, body);
  if (method === "GET" && guidanceId === undefined) return listRunGuidance(store, userId, requestId);
  if (method === "DELETE" && guidanceId !== undefined) return cancelRunGuidance(store, userId, requestId, guidanceId);
  throw new AiError(404, "NOT_FOUND", "请求的接口不存在");
}
