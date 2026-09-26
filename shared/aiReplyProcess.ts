import type { AiRunEventPayload, AiToolProgress } from "./aiRunEvents";

/**
 * Bounded record of what really happened while one assistant reply ran: the
 * order in which the public thinking summary and tool calls first appeared,
 * the provider-reported web-search metadata, and elapsed times measured from
 * real event timestamps.
 *
 * It never carries answer text, prompts, provider item ids, or raw reasoning.
 * `reasoning_delta` / provider `reasoning_content` / Responses `reasoning_text`
 * are ignored here: they are neither displayed nor stored. The public
 * thinking-summary text itself stays in the message's `analysisSummary`.
 */
export type AiReplyProcessOutcome = "completed" | "partial" | "stopped" | "failed";
/** A persisted search is settled: a live status that never reached a
 * provider-reported terminal state is stored as `incomplete`. */
export type AiReplyProcessSearchStatus = "completed" | "failed" | "incomplete";
export interface AiReplyProcessThinkingStep { kind: "thinking" }
export interface AiReplyProcessSearchStep {
  kind: "search";
  status: AiReplyProcessSearchStatus;
  query?: string;
  sourceCount?: number;
  /** First provider progress event to its first terminal event. */
  durationMs?: number;
}
/** Tool calls without their own result card. Media/PPT tool rows are derived
 * from the linked artifact instead, so they are never duplicated here. */
export interface AiReplyProcessToolStep { kind: "tool"; tool: "computer"; status: "handed_off" | "unavailable" }
export type AiReplyProcessStep = AiReplyProcessThinkingStep | AiReplyProcessSearchStep | AiReplyProcessToolStep;
export interface AiReplyProcess {
  version: 1;
  outcome: AiReplyProcessOutcome;
  steps: AiReplyProcessStep[];
  /** Wall time from the member's send to the settled reply, when measured live. */
  durationMs?: number;
}

export const AI_REPLY_PROCESS_LIMITS = Object.freeze({
  /** One thinking summary, the provider's bounded search calls and a tool step fit comfortably. */
  steps: 8,
  /** UTF-16 units; the provider stream already bounds a query to 200 code points. */
  queryCharacters: 400,
  queryCodePoints: 200,
  sourceCount: 10_000,
  durationMs: 24 * 60 * 60 * 1000,
});

/** Display-only live state for an in-flight reply. Timestamps are the
 * server's event timestamps, so per-call durations never mix clocks. */
export interface AiReplyProcessLiveSearch {
  kind: "search";
  callId: string;
  status: AiToolProgress["status"];
  query?: string;
  sourceCount?: number;
  startedAt?: number;
  endedAt?: number;
}
export type AiReplyProcessLiveStep = AiReplyProcessThinkingStep | AiReplyProcessLiveSearch | AiReplyProcessToolStep;
export interface AiReplyProcessLive {
  steps: AiReplyProcessLiveStep[];
  /** `run_started.data.startedAt`: when the server accepted the request. */
  runStartedAt?: number;
  /** Timestamp of the journaled `run_finished` event. */
  finishedAt?: number;
}

export const EMPTY_REPLY_PROCESS_LIVE: AiReplyProcessLive = Object.freeze({ steps: Object.freeze([]) }) as unknown as AiReplyProcessLive;

/** Any journaled or streamed run event; only its payload and server timestamp are read. */
export type AiReplyProcessEvent = AiRunEventPayload & { timestamp?: number };

const TERMINAL_SEARCH = new Set<AiToolProgress["status"]>(["completed", "failed"]);
const LIVE_SEARCH = new Set<AiToolProgress["status"]>(["in_progress", "searching", "completed", "failed"]);
const OUTCOMES = new Set<AiReplyProcessOutcome>(["completed", "partial", "stopped", "failed"]);
const PERSISTED_SEARCH = new Set<AiReplyProcessSearchStatus>(["completed", "failed", "incomplete"]);
const CONTROL = /[\u0000-\u001f\u007f]/;

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function validReplyProcessDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= AI_REPLY_PROCESS_LIMITS.durationMs ? value : undefined;
}

function boundedQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const bounded = [...clean].slice(0, AI_REPLY_PROCESS_LIMITS.queryCodePoints).join("");
  return bounded.length <= AI_REPLY_PROCESS_LIMITS.queryCharacters ? bounded : undefined;
}

function sourceCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, AI_REPLY_PROCESS_LIMITS.sourceCount) : undefined;
}

/**
 * Folds one real run event into the live process. Returns the same object when
 * the event carries no process information (answer text, usage, and any raw
 * provider reasoning), so callers can skip a render.
 */
export function applyReplyProcessEvent(state: AiReplyProcessLive, event: AiReplyProcessEvent): AiReplyProcessLive {
  const at = timestamp(event.timestamp);
  switch (event.type) {
    case "run_started": {
      const startedAt = timestamp(event.data.startedAt);
      return state.runStartedAt === undefined && startedAt !== undefined ? { ...state, runStartedAt: startedAt } : state;
    }
    case "public_summary_delta": {
      if (typeof event.data.delta !== "string" || !event.data.delta.trim()) return state;
      if (state.steps.some(step => step.kind === "thinking") || state.steps.length >= AI_REPLY_PROCESS_LIMITS.steps) return state;
      return { ...state, steps: [...state.steps, { kind: "thinking" }] };
    }
    case "tool_progress": {
      const progress = event.data;
      if (progress.tool !== "web_search" || typeof progress.callId !== "string" || !LIVE_SEARCH.has(progress.status)) return state;
      const index = state.steps.findIndex(step => step.kind === "search" && step.callId === progress.callId);
      const query = boundedQuery(progress.query);
      const sources = sourceCount(progress.sourceCount);
      if (index < 0) {
        if (state.steps.length >= AI_REPLY_PROCESS_LIMITS.steps) return state;
        const created: AiReplyProcessLiveSearch = { kind: "search", callId: progress.callId, status: progress.status,
          ...(query ? { query } : {}), ...(sources !== undefined ? { sourceCount: sources } : {}),
          ...(at !== undefined ? { startedAt: at } : {}),
          ...(at !== undefined && TERMINAL_SEARCH.has(progress.status) ? { endedAt: at } : {}) };
        return { ...state, steps: [...state.steps, created] };
      }
      const current = state.steps[index] as AiReplyProcessLiveSearch;
      // A provider-reported terminal state is final; late events never regress it.
      if (TERMINAL_SEARCH.has(current.status) && progress.status !== current.status) return state;
      const next: AiReplyProcessLiveSearch = { ...current, status: progress.status,
        ...(query ? { query } : {}), ...(sources !== undefined ? { sourceCount: sources } : {}),
        ...(current.endedAt === undefined && at !== undefined && TERMINAL_SEARCH.has(progress.status) ? { endedAt: at } : {}) };
      if (next.status === current.status && next.query === current.query && next.sourceCount === current.sourceCount && next.endedAt === current.endedAt) return state;
      return { ...state, steps: state.steps.map((step, position) => position === index ? next : step) };
    }
    case "run_finished":
      return state.finishedAt === undefined && at !== undefined ? { ...state, finishedAt: at } : state;
    default:
      // answer_delta, usage_updated and reasoning_delta add nothing here.
      return state;
  }
}

/** Appends a real tool hand-off (for example the computer-use safety flow). */
export function withReplyProcessTool(live: AiReplyProcessLive, step: AiReplyProcessToolStep): AiReplyProcessLive {
  if (live.steps.length >= AI_REPLY_PROCESS_LIMITS.steps) return live;
  return { ...live, steps: [...live.steps, { ...step }] };
}

/** Bounded persisted form. Returns undefined when nothing real happened. */
export function settleReplyProcess(live: AiReplyProcessLive, options: { outcome: AiReplyProcessOutcome; durationMs?: number }): AiReplyProcess | undefined {
  const steps: AiReplyProcessStep[] = live.steps.slice(0, AI_REPLY_PROCESS_LIMITS.steps).map(step => {
    if (step.kind !== "search") return { ...step };
    const status: AiReplyProcessSearchStatus = step.status === "completed" || step.status === "failed" ? step.status : "incomplete";
    const query = boundedQuery(step.query);
    const sources = sourceCount(step.sourceCount);
    // A call first seen already finished has no observed duration.
    const durationMs = step.startedAt !== undefined && step.endedAt !== undefined && step.endedAt > step.startedAt ? validReplyProcessDuration(step.endedAt - step.startedAt) : undefined;
    return { kind: "search", status, ...(query ? { query } : {}), ...(sources !== undefined ? { sourceCount: sources } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}) };
  });
  if (!steps.length || !OUTCOMES.has(options.outcome)) return undefined;
  const durationMs = validReplyProcessDuration(options.durationMs);
  return { version: 1, outcome: options.outcome, steps, ...(durationMs !== undefined ? { durationMs } : {}) };
}

/** Rebuilds the persisted process from a request's journaled events. Only a
 * journal that reached `run_finished` is trusted to have settled statuses. */
export function replyProcessFromRunEvents(events: Iterable<AiReplyProcessEvent>, outcome: AiReplyProcessOutcome): AiReplyProcess | undefined {
  let live = EMPTY_REPLY_PROCESS_LIVE;
  for (const event of events) live = applyReplyProcessEvent(live, event);
  if (live.finishedAt === undefined) return undefined;
  const durationMs = live.runStartedAt !== undefined ? live.finishedAt - live.runStartedAt : undefined;
  return settleReplyProcess(live, { outcome, durationMs });
}

/** Defensive read of a stored value for display. Invalid steps are dropped;
 * an unknown version or outcome yields undefined. The server applies the
 * strict equivalent before anything is saved. */
export function readReplyProcess(value: unknown): AiReplyProcess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 || !OUTCOMES.has(source.outcome as AiReplyProcessOutcome) || !Array.isArray(source.steps)) return undefined;
  let thinking = false;
  const steps: AiReplyProcessStep[] = [];
  for (const raw of source.steps.slice(0, AI_REPLY_PROCESS_LIMITS.steps)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as Record<string, unknown>;
    if (step.kind === "thinking" && !thinking) { thinking = true; steps.push({ kind: "thinking" }); }
    else if (step.kind === "search" && PERSISTED_SEARCH.has(step.status as AiReplyProcessSearchStatus)) {
      const query = typeof step.query === "string" && step.query.trim() && step.query.length <= AI_REPLY_PROCESS_LIMITS.queryCharacters && !CONTROL.test(step.query) ? step.query : undefined;
      const sources = typeof step.sourceCount === "number" && Number.isSafeInteger(step.sourceCount) && step.sourceCount >= 0 && step.sourceCount <= AI_REPLY_PROCESS_LIMITS.sourceCount ? step.sourceCount : undefined;
      const durationMs = validReplyProcessDuration(step.durationMs);
      steps.push({ kind: "search", status: step.status as AiReplyProcessSearchStatus, ...(query ? { query } : {}),
        ...(sources !== undefined ? { sourceCount: sources } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
    } else if (step.kind === "tool" && step.tool === "computer" && (step.status === "handed_off" || step.status === "unavailable")) {
      steps.push({ kind: "tool", tool: "computer", status: step.status });
    }
  }
  if (!steps.length) return undefined;
  const durationMs = validReplyProcessDuration(source.durationMs);
  return { version: 1, outcome: source.outcome as AiReplyProcessOutcome, steps, ...(durationMs !== undefined ? { durationMs } : {}) };
}
