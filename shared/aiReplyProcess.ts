import type { AiRunEventPayload, AiToolProgress } from "./aiRunEvents";
import {
  AI_MULTI_AGENT_LIMITS, AI_SUBAGENT_ID, boundedMultilineText, readAiSubagentUpdate, subagentActivity, validSubagentError,
  validSubagentRole, validSubagentSourceNumbers, validSubagentSummary, validSubagentTask, validSubagentTitle,
  type AiMultiAgentPhase, type AiSubagentFailure, type AiSubagentStatus, type AiSubagentUpdate,
} from "./aiMultiAgent";

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
 * Exception (多 Agent 协作, `kind: "agents"`): each sub-agent keeps its role,
 * a bounded excerpt of the coordinator-written subtask (the member's own
 * request restated) and a one-line public summary, so the member can see who
 * did what; never the sub-agent's full answer or any reasoning.
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
/** 多 Agent 协作: one sub-agent ("employee") as persisted; only terminal statuses. */
export interface AiReplyProcessAgent {
  id: string;
  role: string;
  title: string;
  /** Subtask excerpt (≤ AI_MULTI_AGENT_LIMITS.persistedTaskCodePoints). */
  task: string;
  status: "done" | "failed" | "cancelled";
  /** The sub-agent's own one-line conclusion. */
  summary?: string;
  /** Application-owned failure text (timeout, provider error, stop). */
  error?: string;
  /** Server event timestamps (epoch ms). */
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  searchCount?: number;
  sourceCount?: number;
  /** 1-based numbers into the reply's own numbered source list. */
  sources?: number[];
}
/** 多 Agent 协作 as persisted: 任务分解, each sub-agent, then 结果综合. */
export interface AiReplyProcessAgentsStep {
  kind: "agents";
  phase: "done" | "failed" | "cancelled";
  maxConcurrency: number;
  agents: AiReplyProcessAgent[];
  synthesis?: "done" | "failed" | "cancelled";
  startedAt?: number;
  finishedAt?: number;
}
export type AiReplyProcessStep = AiReplyProcessThinkingStep | AiReplyProcessSearchStep | AiReplyProcessToolStep | AiReplyProcessAgentsStep;
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
/** Live sub-agent ("employee"): status transitions and a short activity line. */
export interface AiReplyProcessLiveAgent {
  id: string;
  role: string;
  title: string;
  /** Full subtask text as delegated. */
  task: string;
  search: boolean;
  status: AiSubagentStatus;
  /** Short live status line, e.g. "联网搜索：深圳 天气" / "撰写中：…". */
  activity?: string;
  failure?: AiSubagentFailure;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  chars?: number;
  preview?: string;
  searchQuery?: string;
  /** Distinct provider search calls seen live (app-local `search-N` ids). */
  searchCalls?: string[];
  summary?: string;
  error?: string;
  searchCount?: number;
  sourceCount?: number;
  sources?: number[];
}
/** Live 多 Agent 协作 state: planning → dispatching → working → synthesizing → done | failed | cancelled. */
export interface AiReplyProcessLiveAgents {
  kind: "agents";
  phase: AiMultiAgentPhase;
  maxConcurrency?: number;
  agents: AiReplyProcessLiveAgent[];
  /** The coordinator's own short status line. */
  coordinatorActivity: string;
  synthesis?: "running" | "done" | "failed" | "cancelled";
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
}
export type AiReplyProcessLiveStep = AiReplyProcessThinkingStep | AiReplyProcessLiveSearch | AiReplyProcessToolStep | AiReplyProcessLiveAgents;
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
    case "subagent_update": {
      const update = readAiSubagentUpdate(event.data);
      return update ? applySubagentUpdate(state, update, at) : state;
    }
    case "run_finished": {
      const settled = finishLiveAgents(state, "done", at);
      return settled.finishedAt === undefined && at !== undefined ? { ...settled, finishedAt: at } : settled;
    }
    case "run_failed":
      return finishLiveAgents(state, "failed", at);
    default:
      // answer_delta, usage_updated and reasoning_delta add nothing here.
      return state;
  }
}

const TERMINAL_PHASES = new Set<AiMultiAgentPhase>(["done", "failed", "cancelled"]);
const TERMINAL_AGENT = new Set<AiSubagentStatus>(["done", "failed", "cancelled"]);

/** The coordinator's own status line for the current phase. */
export function coordinatorActivity(step: { phase: AiMultiAgentPhase; agents: ReadonlyArray<{ status: AiSubagentStatus }> }): string {
  const total = step.agents.length;
  const finished = step.agents.filter(agent => TERMINAL_AGENT.has(agent.status)).length;
  switch (step.phase) {
    case "planning": return "正在分解任务";
    case "dispatching": return `已拆成 ${total} 个子任务，正在分派`;
    case "working": return `等待子 Agent 完成（${finished}/${total}）`;
    case "synthesizing": return `正在综合 ${total} 个子任务的结果`;
    case "done": return "已完成结果综合";
    case "failed": return "未能完成";
    case "cancelled": return "已停止";
  }
}

function liveAgentsIndex(state: AiReplyProcessLive): number {
  return state.steps.findIndex(step => step.kind === "agents");
}

function putLiveAgents(state: AiReplyProcessLive, index: number, next: AiReplyProcessLiveAgents | undefined, at: number | undefined): AiReplyProcessLive {
  if (!next) return index < 0 ? state : { ...state, steps: state.steps.filter((_, position) => position !== index) };
  const stamped: AiReplyProcessLiveAgents = { ...next, coordinatorActivity: coordinatorActivity(next), ...(at !== undefined ? { updatedAt: at } : {}) };
  if (index >= 0) return { ...state, steps: state.steps.map((step, position) => position === index ? stamped : step) };
  if (state.steps.length >= AI_REPLY_PROCESS_LIMITS.steps) return state;
  return { ...state, steps: [...state.steps, stamped] };
}

function terminalAgent(agent: AiReplyProcessLiveAgent, phase: "done" | "failed" | "cancelled", at: number | undefined): AiReplyProcessLiveAgent {
  if (TERMINAL_AGENT.has(agent.status)) return agent;
  // A sub-agent still queued or running when the run ended never finished.
  const status = phase === "failed" ? "failed" : "cancelled";
  const next: AiReplyProcessLiveAgent = { ...agent, status, error: status === "failed" ? "未完成" : "已停止", ...(agent.startedAt !== undefined && at !== undefined ? { finishedAt: at } : {}) };
  return { ...next, activity: subagentActivity(next) };
}

function finishLiveAgents(state: AiReplyProcessLive, phase: "done" | "failed" | "cancelled", at: number | undefined): AiReplyProcessLive {
  const index = liveAgentsIndex(state);
  if (index < 0) return state;
  const current = state.steps[index] as AiReplyProcessLiveAgents;
  if (TERMINAL_PHASES.has(current.phase)) return state;
  if (!current.agents.length) return putLiveAgents(state, index, undefined, at);
  return putLiveAgents(state, index, { ...current, phase, agents: current.agents.map(agent => terminalAgent(agent, phase, at)),
    ...(current.synthesis === "running" ? { synthesis: phase } : {}), ...(at !== undefined ? { finishedAt: at } : {}) }, at);
}

/** Folds one validated `subagent_update` into the live 多 Agent 协作 step. A
 * terminal agent or run state is final; late events never regress it. */
function applySubagentUpdate(state: AiReplyProcessLive, update: AiSubagentUpdate, at: number | undefined): AiReplyProcessLive {
  const index = liveAgentsIndex(state);
  const current = index >= 0 ? state.steps[index] as AiReplyProcessLiveAgents : undefined;
  if (current && TERMINAL_PHASES.has(current.phase)) return state;
  const fresh = (): AiReplyProcessLiveAgents => ({ kind: "agents", phase: "planning", agents: [], coordinatorActivity: "", ...(at !== undefined ? { startedAt: at } : {}) });
  switch (update.phase) {
    case "planning":
      return current ? state : putLiveAgents(state, index, fresh(), at);
    case "direct":
      return current && !current.agents.length ? putLiveAgents(state, index, undefined, at) : state;
    case "plan": {
      if (current?.agents.length) return state;
      const agents = update.subtasks.map((item): AiReplyProcessLiveAgent => {
        const agent: AiReplyProcessLiveAgent = { id: item.id, role: item.role, title: item.title, task: item.task, search: item.search, status: "queued" };
        return { ...agent, activity: subagentActivity(agent) };
      });
      return putLiveAgents(state, index, { ...(current ?? fresh()), phase: "dispatching", maxConcurrency: update.maxConcurrency, agents }, at);
    }
    case "synthesis":
      return current?.agents.length ? putLiveAgents(state, index, { ...current, phase: "synthesizing", synthesis: "running" }, at) : state;
    case "finish":
      return finishLiveAgents(state, update.outcome, at);
    default: {
      if (!current) return state;
      const position = current.agents.findIndex(agent => agent.id === update.id);
      if (position < 0) return state;
      const agent = current.agents[position];
      if (TERMINAL_AGENT.has(agent.status)) return state;
      let next: AiReplyProcessLiveAgent;
      switch (update.phase) {
        case "start":
          next = { ...agent, status: "thinking", ...(agent.startedAt === undefined && at !== undefined ? { startedAt: at } : {}) };
          break;
        case "progress":
          next = { ...agent, status: agent.status === "searching" ? "searching" : "working", chars: update.chars, ...(update.preview ? { preview: update.preview } : {}) };
          break;
        case "search": {
          const calls = agent.searchCalls ?? [];
          const searchCalls = calls.includes(update.callId) || calls.length >= AI_MULTI_AGENT_LIMITS.searchesPerAgent ? calls : [...calls, update.callId];
          const active = update.status === "in_progress" || update.status === "searching";
          next = { ...agent, searchCalls, status: active ? "searching" : agent.chars ? "working" : "thinking", ...(update.query ? { searchQuery: update.query } : {}) };
          break;
        }
        case "stop":
          next = { ...agent, status: "done", durationMs: update.durationMs, ...(at !== undefined ? { finishedAt: at } : {}),
            ...(update.summary ? { summary: update.summary } : {}), ...(update.searchCount !== undefined ? { searchCount: update.searchCount } : {}),
            ...(update.sourceCount !== undefined ? { sourceCount: update.sourceCount } : {}), ...(update.sources?.length ? { sources: [...update.sources] } : {}) };
          break;
        case "error":
          next = { ...agent, status: update.reason === "cancelled" ? "cancelled" : "failed", failure: update.reason, error: update.message,
            ...(at !== undefined ? { finishedAt: at } : {}), ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}) };
          break;
      }
      next = { ...next, activity: subagentActivity(next) };
      const phase: AiMultiAgentPhase = current.phase === "dispatching" && update.phase === "start" ? "working" : current.phase;
      return putLiveAgents(state, index, { ...current, phase, agents: current.agents.map((item, itemIndex) => itemIndex === position ? next : item) }, at);
    }
  }
}

function settleAgentsStep(step: AiReplyProcessLiveAgents, outcome: AiReplyProcessOutcome): AiReplyProcessAgentsStep | undefined {
  if (!step.agents.length || step.maxConcurrency === undefined) return undefined;
  const phase: AiReplyProcessAgentsStep["phase"] = TERMINAL_PHASES.has(step.phase) ? step.phase as AiReplyProcessAgentsStep["phase"]
    : outcome === "stopped" ? "cancelled" : outcome === "failed" ? "failed" : "done";
  const agents = step.agents.map((live): AiReplyProcessAgent => {
    const agent = terminalAgent(live, phase, undefined);
    const task = boundedMultilineText(agent.task, AI_MULTI_AGENT_LIMITS.persistedTaskCodePoints) ?? agent.title;
    const durationMs = validReplyProcessDuration(agent.durationMs) ?? (agent.startedAt !== undefined && agent.finishedAt !== undefined && agent.finishedAt >= agent.startedAt ? validReplyProcessDuration(agent.finishedAt - agent.startedAt) : undefined);
    return { id: agent.id, role: agent.role, title: agent.title, task, status: agent.status as AiReplyProcessAgent["status"],
      ...(agent.summary ? { summary: agent.summary } : {}), ...(agent.error ? { error: agent.error } : {}),
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}), ...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}), ...(agent.searchCount !== undefined ? { searchCount: agent.searchCount } : {}),
      ...(agent.sourceCount !== undefined ? { sourceCount: Math.min(agent.sourceCount, AI_REPLY_PROCESS_LIMITS.sourceCount) } : {}),
      ...(agent.sources?.length ? { sources: [...agent.sources] } : {}) };
  });
  const synthesis = step.synthesis === "running" ? phase : step.synthesis;
  const settled: AiReplyProcessAgentsStep = { kind: "agents", phase, maxConcurrency: step.maxConcurrency, agents,
    ...(synthesis ? { synthesis } : {}), ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}),
    ...(step.finishedAt !== undefined && (step.startedAt === undefined || step.finishedAt >= step.startedAt) ? { finishedAt: step.finishedAt } : {}) };
  return isAiReplyProcessAgentsStep(settled) ? settled : undefined;
}

function epochMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Strict structural check for a persisted 多 Agent 协作 step. Shared by the
 * client reader and the server's workspace validation. */
export function isAiReplyProcessAgentsStep(value: unknown): value is AiReplyProcessAgentsStep {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const step = value as Record<string, unknown>;
  if (!Object.keys(step).every(key => ["kind", "phase", "maxConcurrency", "agents", "synthesis", "startedAt", "finishedAt"].includes(key))) return false;
  const L = AI_MULTI_AGENT_LIMITS;
  if (step.kind !== "agents" || !["done", "failed", "cancelled"].includes(String(step.phase))) return false;
  if (!Number.isInteger(step.maxConcurrency) || Number(step.maxConcurrency) < L.minConcurrency || Number(step.maxConcurrency) > L.maxConcurrency) return false;
  if (step.synthesis !== undefined && !["done", "failed", "cancelled"].includes(String(step.synthesis))) return false;
  if (step.startedAt !== undefined && !epochMs(step.startedAt)) return false;
  if (step.finishedAt !== undefined && (!epochMs(step.finishedAt) || (epochMs(step.startedAt) && step.finishedAt < step.startedAt))) return false;
  if (!Array.isArray(step.agents) || !step.agents.length || step.agents.length > L.maxSubtasks) return false;
  const ids = new Set<string>();
  for (const raw of step.agents) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    const agent = raw as Record<string, unknown>;
    if (!Object.keys(agent).every(key => ["id", "role", "title", "task", "status", "summary", "error", "startedAt", "finishedAt", "durationMs", "searchCount", "sourceCount", "sources"].includes(key))) return false;
    if (typeof agent.id !== "string" || !AI_SUBAGENT_ID.test(agent.id) || ids.has(agent.id)) return false;
    ids.add(agent.id);
    if (!validSubagentRole(agent.role) || !validSubagentTitle(agent.title) || !validSubagentTask(agent.task, L.persistedTaskCodePoints)) return false;
    if (!["done", "failed", "cancelled"].includes(String(agent.status))) return false;
    if (agent.summary !== undefined && !validSubagentSummary(agent.summary)) return false;
    if (agent.error !== undefined && !validSubagentError(agent.error)) return false;
    if (agent.startedAt !== undefined && !epochMs(agent.startedAt)) return false;
    if (agent.finishedAt !== undefined && (!epochMs(agent.finishedAt) || (epochMs(agent.startedAt) && agent.finishedAt < agent.startedAt))) return false;
    if (agent.durationMs !== undefined && validReplyProcessDuration(agent.durationMs) === undefined) return false;
    if (agent.searchCount !== undefined && !(Number.isSafeInteger(agent.searchCount) && Number(agent.searchCount) >= 0 && Number(agent.searchCount) <= L.searchesPerAgent)) return false;
    if (agent.sourceCount !== undefined && !(Number.isSafeInteger(agent.sourceCount) && Number(agent.sourceCount) >= 0 && Number(agent.sourceCount) <= AI_REPLY_PROCESS_LIMITS.sourceCount)) return false;
    if (agent.sources !== undefined && !validSubagentSourceNumbers(agent.sources)) return false;
  }
  return true;
}

/** Appends a real tool hand-off (for example the computer-use safety flow). */
export function withReplyProcessTool(live: AiReplyProcessLive, step: AiReplyProcessToolStep): AiReplyProcessLive {
  if (live.steps.length >= AI_REPLY_PROCESS_LIMITS.steps) return live;
  return { ...live, steps: [...live.steps, { ...step }] };
}

/** Bounded persisted form. Returns undefined when nothing real happened. */
export function settleReplyProcess(live: AiReplyProcessLive, options: { outcome: AiReplyProcessOutcome; durationMs?: number }): AiReplyProcess | undefined {
  const steps: AiReplyProcessStep[] = live.steps.slice(0, AI_REPLY_PROCESS_LIMITS.steps).flatMap((step): AiReplyProcessStep[] => {
    if (step.kind === "agents") {
      const agents = settleAgentsStep(step, options.outcome);
      return agents ? [agents] : [];
    }
    if (step.kind !== "search") return [{ ...step }];
    const status: AiReplyProcessSearchStatus = step.status === "completed" || step.status === "failed" ? step.status : "incomplete";
    const query = boundedQuery(step.query);
    const sources = sourceCount(step.sourceCount);
    // A call first seen already finished has no observed duration.
    const durationMs = step.startedAt !== undefined && step.endedAt !== undefined && step.endedAt > step.startedAt ? validReplyProcessDuration(step.endedAt - step.startedAt) : undefined;
    return [{ kind: "search", status, ...(query ? { query } : {}), ...(sources !== undefined ? { sourceCount: sources } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}) }];
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
  let thinking = false, agents = false;
  const steps: AiReplyProcessStep[] = [];
  for (const raw of source.steps.slice(0, AI_REPLY_PROCESS_LIMITS.steps)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as Record<string, unknown>;
    if (step.kind === "thinking" && !thinking) { thinking = true; steps.push({ kind: "thinking" }); }
    else if (step.kind === "agents" && !agents && isAiReplyProcessAgentsStep(step)) {
      agents = true;
      steps.push(structuredCloneAgents(step));
    }
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

/** Copies only the validated fields of a persisted agents step. */
function structuredCloneAgents(step: AiReplyProcessAgentsStep): AiReplyProcessAgentsStep {
  return { ...step, agents: step.agents.map(agent => ({ ...agent, ...(agent.sources ? { sources: [...agent.sources] } : {}) })) };
}
