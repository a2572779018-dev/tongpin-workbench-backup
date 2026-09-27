import type { AiSource } from "../../shared/ai";
import { AI_CITATION_LIMITS, sourceIdentity } from "../../shared/aiCitations";
import {
  AI_MULTI_AGENT_LIMITS, boundedMultilineText, boundedText, validSubagentRole, type AiSubagentFailure, type AiSubagentPlanItem,
} from "../../shared/aiMultiAgent";

/*
 * Runtime-agnostic orchestration core for 同频「多 Agent 协作」. No Node-only
 * API: the same module runs in the Cloudflare Worker Durable Object and in Node.
 *
 * Adapted from, with attribution (see THIRD_PARTY_NOTICES.md):
 * - OpenAI Agents SDK JS v0.18.0 (MIT, Copyright (c) 2025 OpenAI), commit
 *   fdaf0a66ca6e9d89498909ad7cf64745630e8afb:
 *   `packages/agents-core/src/utils/abortSignals.ts#combineAbortSignals` and
 *   `packages/agents-core/src/runner/toolExecution.ts#executeToolRunsWithConcurrency`
 *   (bounded worker pool pulling from a shared index; every started worker is
 *   drained before returning). Unlike upstream, one task's failure never
 *   cancels its siblings: sub-agents are isolated.
 * - LibreChat `@librechat/agents` v3.2.46 (MIT, Copyright (c) 2024 LibreChat),
 *   tag v3.2.46 / commit b405dffb13ba15cbefa20e7bf4d971ce6963ec6a:
 *   `src/tools/subagent/SubagentExecutor.ts#execute` — the child receives only
 *   its task description (isolated context), the parent AbortSignal is passed
 *   to the child, and a child error becomes a bounded result instead of
 *   failing the parent (`truncateErrorMessage`, `filterSubagentResult`).
 */

// ---------------------------------------------------------------------------
// Abort signals (adapted from OpenAI Agents SDK `combineAbortSignals`)
// ---------------------------------------------------------------------------

export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): { signal?: AbortSignal; cleanup: () => void } {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (!active.length) return { cleanup: () => {} };
  const any = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof any === "function") {
    try { return { signal: any(active), cleanup: () => {} }; }
    catch { /* Fall back to manual composition for runtimes without AbortSignal.any. */ }
  }
  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
  for (const signal of active) {
    if (signal.aborted) { controller.abort(signal.reason); break; }
    const handler = () => { if (!controller.signal.aborted) controller.abort(signal.reason); };
    signal.addEventListener("abort", handler, { once: true });
    listeners.push({ signal, handler });
  }
  return { signal: controller.signal, cleanup: () => { for (const { signal, handler } of listeners) signal.removeEventListener("abort", handler); } };
}

// ---------------------------------------------------------------------------
// Bounded concurrency (adapted from OpenAI Agents SDK `executeToolRunsWithConcurrency`)
// ---------------------------------------------------------------------------

/**
 * Runs `run` for every item with at most `maxConcurrency` in flight, in item
 * order. `run` owns its errors (an isolated sub-agent never throws into the
 * pool); a thrown error is still contained by `failed`. When `signal` aborts,
 * workers stop taking new items, every started task is awaited, and items
 * never started are reported through `skipped`.
 */
export async function runWithConcurrencyLimit<T, R>(items: readonly T[], maxConcurrency: number, run: (item: T, index: number) => Promise<R>, options: {
  signal?: AbortSignal;
  skipped: (item: T, index: number) => R;
  failed: (item: T, index: number, error: unknown) => R;
}): Promise<R[]> {
  const results = new Array<R>(items.length);
  const settled = new Array<boolean>(items.length).fill(false);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < items.length && !options.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      try { results[index] = await run(items[index], index); }
      catch (error) { results[index] = options.failed(items[index], index, error); }
      settled[index] = true;
    }
  };
  const workerCount = Math.max(1, Math.min(Math.floor(maxConcurrency) || 1, items.length));
  // Drain every started worker before returning so no task outlives the run.
  await Promise.all(Array.from({ length: items.length ? workerCount : 0 }, worker));
  for (let index = 0; index < items.length; index += 1) if (!settled[index]) results[index] = options.skipped(items[index], index);
  return results;
}

// ---------------------------------------------------------------------------
// Isolated sub-agent execution (adapted from LibreChat `SubagentExecutor.execute`)
// ---------------------------------------------------------------------------

const ERROR_MESSAGE_MAX_CHARS = 200;

/** LibreChat `truncateErrorMessage`. */
export function truncateErrorMessage(message: string): string {
  return message.length <= ERROR_MESSAGE_MAX_CHARS ? message : `${message.slice(0, ERROR_MESSAGE_MAX_CHARS)}...`;
}

export class MultiAgentTimeoutError extends Error {
  constructor() { super("子 Agent 超时"); this.name = "MultiAgentTimeoutError"; }
}

export type IsolatedOutcome<T> =
  | { ok: true; value: T; durationMs: number }
  | { ok: false; reason: AiSubagentFailure; error: unknown; durationMs: number };

/**
 * Runs one child with the parent's AbortSignal plus its own deadline. A child
 * error, timeout or cancellation is returned as a result — never thrown — so
 * one failing sub-agent cannot fail the run (LibreChat semantics).
 */
export async function runIsolatedSubagent<T>(options: { parentSignal: AbortSignal; timeoutMs: number; now?: () => number; run: (signal: AbortSignal) => Promise<T> }): Promise<IsolatedOutcome<T>> {
  const now = options.now ?? Date.now;
  const started = now();
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new MultiAgentTimeoutError()), Math.max(1, options.timeoutMs));
  const { signal, cleanup } = combineAbortSignals(options.parentSignal, deadline.signal);
  const classify = (error: unknown): IsolatedOutcome<T> => ({
    ok: false, error, durationMs: Math.max(0, now() - started),
    reason: options.parentSignal.aborted ? "cancelled" : deadline.signal.aborted ? "timeout" : "failed",
  });
  try {
    const value = await options.run(signal!);
    // A transport may return a partial stream after an abort; it is not a result.
    if (signal!.aborted) return classify(signal!.reason);
    return { ok: true, value, durationMs: Math.max(0, now() - started) };
  } catch (error) {
    return classify(error);
  } finally {
    clearTimeout(timer);
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// Plan parsing (robust to bad JSON)
// ---------------------------------------------------------------------------

export type MultiAgentPlan =
  | { kind: "plan"; subtasks: AiSubagentPlanItem[]; dropped: number; repaired: boolean }
  /** Not a plan at all: prose, a tool envelope or another JSON object. */
  | { kind: "none" }
  /** Looked like a plan but no usable subtask survived validation, or fewer
   * than two genuinely different subtasks did ("duplicate"). */
  | { kind: "invalid"; reason: "json" | "shape" | "empty" | "duplicate" };

const PLAN_KEY = /\{\s*"(?:subtasks|tasks)"\s*:/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Index just after the object that opens at `start`, or -1 when truncated. */
function objectEnd(text: string, start: number): number {
  let depth = 0, inString = false, escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") { depth -= 1; if (depth === 0) return index + 1; }
  }
  return -1;
}

/** The JSON object that should hold a plan: a leading (optionally fenced)
 * object, or an embedded `{"subtasks": …}` object after stray prose. */
function planCandidate(text: string): string | undefined {
  const unfenced = text.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```\s*$/, "").trim();
  let start = unfenced.startsWith("{") ? 0 : -1;
  if (start < 0) {
    const match = PLAN_KEY.exec(unfenced);
    if (!match) return undefined;
    start = match.index;
  }
  const end = objectEnd(unfenced, start);
  return end < 0 ? unfenced.slice(start) : unfenced.slice(start, end);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** A plan cut off by the output limit keeps its complete subtasks. */
function closeTruncatedPlan(candidate: string): string | undefined {
  const array = /"(?:subtasks|tasks)"\s*:\s*\[/.exec(candidate);
  if (!array) return undefined;
  let depth = 0, inString = false, escaped = false, lastItemEnd = -1;
  const arrayStart = array.index + array[0].length;
  for (let index = arrayStart; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0 && char === "}") lastItemEnd = index;
      if (depth < 0) return undefined;
    }
  }
  return lastItemEnd < 0 ? undefined : `${candidate.slice(0, lastItemEnd + 1)}]}`;
}

/** Conservative repairs, only tried after a strict parse failed. */
function repairedCandidates(candidate: string): string[] {
  const noTrailingCommas = (value: string) => value.replace(/,\s*([}\]])/g, "$1");
  const straightQuotes = (value: string) => value.replace(/[“”]/g, "\"");
  const variants = [noTrailingCommas(candidate), noTrailingCommas(straightQuotes(candidate))];
  const closed = closeTruncatedPlan(candidate);
  if (closed) variants.push(closed, noTrailingCommas(closed));
  return [...new Set(variants)];
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function readBoolean(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

/** The sub-agent's own assignment: the 「你负责：」 sentence when the task
 * follows the documented layout, else the whole task. */
export function subtaskAssignment(task: string): string {
  const match = /^\s*(?:你负责|负责|你的任务|任务)\s*[:：]\s*([^\n]+)/u.exec(task);
  return (match ? match[1] : task).trim();
}

function bigrams(text: string): Set<string> {
  const chars = [...text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase()];
  const grams = new Set<string>();
  if (chars.length === 1) grams.add(chars[0]);
  for (let index = 0; index + 1 < chars.length; index += 1) grams.add(chars[index] + chars[index + 1]);
  return grams;
}

/** Character-bigram Jaccard similarity (Chinese has no word boundaries). */
export function textSimilarity(left: string, right: string): number {
  const a = bigrams(left), b = bigrams(right);
  if (!a.size || !b.size) return a.size === b.size ? 1 : 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Two subtasks this alike are the same job handed out twice. */
const DUPLICATE_SIMILARITY = 0.8;
/** A subtask this close to the whole request just restates it. */
const RESTATED_SIMILARITY = 0.85;

/**
 * Parses the coordinator's plan. Accepts the documented object, a fenced
 * block, stray prose around an embedded plan, trailing commas, curly quotes
 * and a plan truncated mid-item; unknown fields are ignored. At most
 * `maxSubtasks` subtasks survive (plan order); search is kept for at most
 * `maxSearchAgents` of them and only when `searchAllowed`.
 */
export function parseMultiAgentPlan(content: string, options: { maxSubtasks?: number; searchAllowed: boolean; maxSearchAgents?: number; request?: string }): MultiAgentPlan {
  const text = content.trim();
  if (!text) return { kind: "invalid", reason: "empty" };
  const candidate = planCandidate(text);
  if (candidate === undefined) return { kind: "none" };
  let root = parseJson(candidate), repaired = false;
  if (root === undefined) {
    for (const variant of repairedCandidates(candidate)) {
      root = parseJson(variant);
      if (root !== undefined) { repaired = true; break; }
    }
  }
  const mentionsPlan = /"(?:subtasks|tasks)"\s*:/.test(candidate);
  if (root === undefined) return mentionsPlan ? { kind: "invalid", reason: "json" } : { kind: "none" };
  if (!isRecord(root) || !(Array.isArray(root.subtasks) || Array.isArray(root.tasks))) {
    return mentionsPlan ? { kind: "invalid", reason: "shape" } : { kind: "none" };
  }
  const items = (Array.isArray(root.subtasks) ? root.subtasks : root.tasks) as unknown[];
  const L = AI_MULTI_AGENT_LIMITS;
  const maxSubtasks = Math.max(1, Math.min(options.maxSubtasks ?? L.maxSubtasks, L.maxSubtasks));
  const maxSearchAgents = Math.max(0, Math.min(options.maxSearchAgents ?? L.maxSearchAgents, L.maxSearchAgents));
  const seen = new Set<string>();
  const accepted: Array<Omit<AiSubagentPlanItem, "id">> = [];
  const assignments: string[] = [];
  const request = options.request?.trim() ?? "";
  let usable = 0, duplicates = 0;
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const task = boundedMultilineText(firstString(raw.task, raw.description, raw.prompt, raw.instruction, raw.instructions), L.taskCodePoints);
    if (!task) continue;
    const identity = task.replace(/\s+/g, "").toLowerCase();
    if (seen.has(identity)) continue;
    seen.add(identity);
    // The same job handed out twice, or the whole request passed on as one
    // "subtask", is not a split: it never reaches a sub-agent.
    const assignment = subtaskAssignment(task);
    if (assignments.some(other => textSimilarity(other, assignment) >= DUPLICATE_SIMILARITY) ||
      (request && [...assignment].length >= 8 && textSimilarity(assignment, request) >= RESTATED_SIMILARITY)) {
      duplicates += 1;
      continue;
    }
    assignments.push(assignment);
    usable += 1;
    if (accepted.length >= maxSubtasks) continue;
    const wantsSearch = readBoolean(raw.search ?? raw.needsSearch ?? raw.webSearch ?? raw.web_search);
    const search = options.searchAllowed && wantsSearch && accepted.filter(item => item.search).length < maxSearchAgents;
    const roleCandidate = boundedText(firstString(raw.role, raw.agent, raw.type), 64);
    const role = roleCandidate && validSubagentRole(roleCandidate) ? roleCandidate : wantsSearch ? "研究员" : "分析员";
    // Titles name each agent's own part and are unique within the plan.
    const given = boundedText(firstString(raw.title, raw.name, raw.summary), L.titleCodePoints);
    const base = given && !accepted.some(item => item.title === given) ? given : boundedText(assignment, 16) ?? boundedText(task, 16)!;
    let title = base, suffix = 2;
    while (accepted.some(item => item.title === title)) title = `${boundedText(base, L.titleCodePoints - 3)}（${suffix++}）`;
    accepted.push({ role, title, task, search });
  }
  if (!accepted.length) return { kind: "invalid", reason: duplicates ? "duplicate" : items.length ? "shape" : "empty" };
  // A split needs at least two different parts; one survivor is answered directly.
  if (accepted.length < 2 && items.length >= 2) return { kind: "invalid", reason: "duplicate" };
  return { kind: "plan", subtasks: accepted.map((item, index) => ({ id: `agent-${index + 1}`, ...item })), dropped: usable - accepted.length + duplicates, repaired };
}

// ---------------------------------------------------------------------------
// Results, summaries and sources
// ---------------------------------------------------------------------------

/** The sub-agent's own one-line conclusion ("摘要：…"), else its first line. */
export function subagentSummary(content: string): string | undefined {
  const lines = content.replace(/\r\n?/g, "\n").split("\n")
    .map(line => line.trim().replace(/^(?:[#>*+-]+|\d+[.)、])\s*/, "").replace(/\*\*|__|`/g, "").trim())
    .filter(Boolean);
  for (const line of lines.slice(0, 6)) {
    const match = /^[【[]?(?:摘要|结论|总结)[】\]]?\s*[:：]\s*(.+)$/.exec(line);
    if (match) return boundedText(match[1], AI_MULTI_AGENT_LIMITS.summaryCodePoints);
  }
  return lines.length ? boundedText(lines[0], AI_MULTI_AGENT_LIMITS.summaryCodePoints) : undefined;
}

/** Merged, numbered source list shared by every sub-agent, in completion
 * order and deduplicated exactly like the reply's rendered source list. */
export class MultiAgentSources {
  readonly list: AiSource[] = [];
  private readonly numbers = new Map<string, number>();
  /** Adds one sub-agent's sources and returns their 1-based numbers. */
  add(sources: readonly AiSource[]): number[] {
    const own: number[] = [];
    for (const source of sources) {
      const key = sourceIdentity(source.url);
      let number = this.numbers.get(key);
      if (number === undefined) {
        if (this.list.length >= AI_CITATION_LIMITS.sources) continue;
        this.list.push({ title: source.title, url: source.url });
        number = this.list.length;
        this.numbers.set(key, number);
      }
      if (!own.includes(number) && own.length < AI_MULTI_AGENT_LIMITS.sourcesPerAgent) own.push(number);
    }
    return own;
  }
}
