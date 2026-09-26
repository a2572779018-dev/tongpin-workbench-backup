import type { AiToolProgress } from "./aiRunEvents";
import { AI_TOOL_PROGRESS_STATUSES } from "./aiRunEvents";

/**
 * 同频「多 Agent 协作」(harness strategy `multi_agent`) shared contract.
 *
 * A coordinator call either answers directly or returns a bounded plan; up to
 * `maxSubtasks` isolated sub-agent calls then run with at most
 * `maxConcurrency` in flight, and a synthesis call writes the final answer.
 * The lifecycle envelope below mirrors LibreChat's `ON_SUBAGENT_UPDATE`
 * (`@librechat/agents` v3.2.46, MIT): phases are keyed by an application-local
 * child id (`agent-1`…`agent-5`) and never carry provider ids or hidden
 * reasoning. The coordinator-authored subtask text is the member's own request
 * restated, so it is shown to the member (and to the AI 员工办公室 view).
 */
export interface AiMultiAgentSettings {
  /** Sub-agents running at the same time (2–5). A plan may hold more subtasks; the rest queue. */
  maxConcurrency: number;
  /** Optional model on the tier's own text service. Absent: the tier's text model. */
  subAgentModelId?: string;
  /** Hard output cap for every sub-agent call. */
  subAgentMaxOutputTokens: number;
}

export const AI_MULTI_AGENT_LIMITS = Object.freeze({
  minConcurrency: 2,
  maxConcurrency: 5,
  defaultConcurrency: 3,
  /** Hard cap on planned subtasks per run, independent of concurrency. */
  maxSubtasks: 5,
  /** Sub-agents that may use web search in one run; bounds the search reservation. */
  maxSearchAgents: 3,
  minSubAgentOutputTokens: 256,
  maxSubAgentOutputTokens: 4096,
  defaultSubAgentOutputTokens: 2048,
  roleCodePoints: 8,
  titleCodePoints: 24,
  /** Full subtask text sent to the sub-agent and streamed in the plan event. */
  taskCodePoints: 1500,
  /** Subtask excerpt kept in the persisted reply process (storage bound). */
  persistedTaskCodePoints: 200,
  summaryCodePoints: 120,
  activityCodePoints: 80,
  previewCodePoints: 80,
  errorCodePoints: 120,
  queryCodePoints: 200,
  sourcesPerAgent: 8,
  /** 1-based numbers into a reply's numbered source list (AI_CITATION_LIMITS.sources). */
  sourceNumberMax: 40,
  searchesPerAgent: 5,
  /** Journaled `progress` updates per sub-agent; lifecycle phases are never dropped. */
  progressEventsPerAgent: 60,
  durationMs: 24 * 60 * 60 * 1000,
});

export const AI_MULTI_AGENT_DEFAULTS: Readonly<AiMultiAgentSettings> = Object.freeze({
  maxConcurrency: AI_MULTI_AGENT_LIMITS.defaultConcurrency,
  subAgentMaxOutputTokens: AI_MULTI_AGENT_LIMITS.defaultSubAgentOutputTokens,
});

export const AI_MULTI_AGENT_LABEL = "多 Agent 协作";
/** Role labels the coordinator is asked to choose from (any ≤8-character label is accepted). */
export const AI_SUBAGENT_ROLE_SUGGESTIONS: readonly string[] = Object.freeze(["研究员", "分析员", "撰稿员", "核对员", "策划员"]);

/** Overall run phase: planning → dispatching → working → synthesizing → done | failed | cancelled. */
export type AiMultiAgentPhase = "planning" | "dispatching" | "working" | "synthesizing" | "done" | "failed" | "cancelled";
/** One sub-agent ("employee"): queued → thinking ⇄ working / searching → done | failed | cancelled. */
export type AiSubagentStatus = "queued" | "thinking" | "working" | "searching" | "done" | "failed" | "cancelled";
export type AiSubagentFailure = "failed" | "timeout" | "cancelled";

const CONTROL = /[\u0000-\u001f\u007f]/;

/** Validates admin input for one tier. Shared by the server (authoritative)
 * and the admin form (early feedback); returns a Chinese message on error. */
export function readAiMultiAgentSettings(value: unknown, tierMaxOutputTokens: number): { settings?: AiMultiAgentSettings; error?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "多 Agent 协作设置格式不正确" };
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some(key => key !== "maxConcurrency" && key !== "subAgentModelId" && key !== "subAgentMaxOutputTokens")) return { error: "多 Agent 协作设置包含不支持的字段" };
  const { minConcurrency, maxConcurrency, minSubAgentOutputTokens, maxSubAgentOutputTokens } = AI_MULTI_AGENT_LIMITS;
  if (!Number.isInteger(raw.maxConcurrency) || Number(raw.maxConcurrency) < minConcurrency || Number(raw.maxConcurrency) > maxConcurrency) {
    return { error: `最多并行子 Agent 需为 ${minConcurrency} 到 ${maxConcurrency} 的整数` };
  }
  if (tierMaxOutputTokens < minSubAgentOutputTokens) return { error: `开启多 Agent 协作前，请把本档位单次输出上限设为至少 ${minSubAgentOutputTokens}` };
  const outputCap = Math.min(maxSubAgentOutputTokens, tierMaxOutputTokens);
  if (!Number.isInteger(raw.subAgentMaxOutputTokens) || Number(raw.subAgentMaxOutputTokens) < minSubAgentOutputTokens || Number(raw.subAgentMaxOutputTokens) > outputCap) {
    return { error: `每个子 Agent 输出上限需为 ${minSubAgentOutputTokens} 到 ${outputCap} 的整数（不超过本档位单次输出上限）` };
  }
  let subAgentModelId: string | undefined;
  if (raw.subAgentModelId !== undefined && raw.subAgentModelId !== "") {
    if (typeof raw.subAgentModelId !== "string" || !raw.subAgentModelId.trim() || raw.subAgentModelId.trim().length > 160 || CONTROL.test(raw.subAgentModelId)) return { error: "子 Agent 模型 ID 格式不正确" };
    subAgentModelId = raw.subAgentModelId.trim();
  }
  return { settings: { maxConcurrency: Number(raw.maxConcurrency), subAgentMaxOutputTokens: Number(raw.subAgentMaxOutputTokens), ...(subAgentModelId ? { subAgentModelId } : {}) } };
}

export interface AiSubagentPlanItem {
  /** Stable application-local id, `agent-1`…`agent-5`, in plan order. */
  id: string;
  /** Short role label chosen by the coordinator, e.g. 研究员 / 分析员 / 撰稿员 / 核对员. */
  role: string;
  title: string;
  /** The subtask exactly as delegated (the sub-agent's only input), ≤ taskCodePoints. */
  task: string;
  /** Whether this sub-agent may use web search. */
  search: boolean;
}
/** One journaled `subagent_update` event (`AiRunEventPayload`). Status text is
 * application-owned; `preview`/`summary` are bounded excerpts of the
 * sub-agent's own public answer; search fields are provider-reported. */
export type AiSubagentUpdate =
  /** Overall → planning: the coordinator decides whether to split the request. */
  | { phase: "planning" }
  /** Overall → dispatching (任务分解): the validated plan; every subtask starts queued. */
  | { phase: "plan"; maxConcurrency: number; subtasks: AiSubagentPlanItem[] }
  /** The coordinator answered directly; no sub-agent runs and the step is dropped. */
  | { phase: "direct" }
  /** Sub-agent → thinking; overall → working. */
  | { phase: "start"; id: string }
  /** Droppable live tail of the sub-agent's answer text; sub-agent → working. */
  | { phase: "progress"; id: string; chars: number; preview?: string }
  /** Sub-agent → searching while `in_progress`/`searching`, back afterwards. */
  | { phase: "search"; id: string; callId: string; status: AiToolProgress["status"]; query?: string; sourceCount?: number }
  /** Sub-agent → done. `sources` are 1-based numbers into the reply's source list. */
  | { phase: "stop"; id: string; durationMs: number; summary?: string; searchCount?: number; sourceCount?: number; sources?: number[] }
  /** Sub-agent → failed (reason failed/timeout) or cancelled. */
  | { phase: "error"; id: string; reason: AiSubagentFailure; message: string; durationMs?: number }
  /** Overall → synthesizing (结果综合); its text arrives as ordinary answer deltas. */
  | { phase: "synthesis" }
  /** Overall → done / failed / cancelled, journaled just before run_finished / run_failed. */
  | { phase: "finish"; outcome: "done" | "failed" | "cancelled" };

export const AI_SUBAGENT_ID = /^agent-[1-5]$/;
const SEARCH_CALL_ID = /^search-\d{1,3}$/;

function codePoints(value: string): number { return [...value].length; }
/** Collapses whitespace/control characters and bounds to `maxCodePoints` (with "…"). */
export function boundedText(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const points = [...clean];
  return points.length > maxCodePoints ? `${points.slice(0, Math.max(1, maxCodePoints - 1)).join("")}…` : clean;
}
/** Like boundedText but keeps line breaks (subtask text is multi-line). */
export function boundedMultilineText(value: unknown, maxCodePoints: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return undefined;
  const points = [...clean];
  return points.length > maxCodePoints ? `${points.slice(0, Math.max(1, maxCodePoints - 1)).join("")}…` : clean;
}
function exactText(value: unknown, maxCodePoints: number, multiline = false): value is string {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim() && codePoints(value) <= maxCodePoints
    && !(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : CONTROL).test(value);
}
function count(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function keysWithin(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
export function validSubagentSourceNumbers(value: unknown): value is number[] {
  return Array.isArray(value) && value.length <= AI_MULTI_AGENT_LIMITS.sourcesPerAgent && new Set(value).size === value.length
    && value.every(item => typeof item === "number" && Number.isSafeInteger(item) && item >= 1 && item <= AI_MULTI_AGENT_LIMITS.sourceNumberMax);
}
export function validSubagentRole(value: unknown): value is string { return exactText(value, AI_MULTI_AGENT_LIMITS.roleCodePoints); }
export function validSubagentTitle(value: unknown): value is string { return exactText(value, AI_MULTI_AGENT_LIMITS.titleCodePoints); }
export function validSubagentTask(value: unknown, maxCodePoints: number = AI_MULTI_AGENT_LIMITS.taskCodePoints): value is string {
  return exactText(value, maxCodePoints, true);
}
export function validSubagentSummary(value: unknown): value is string { return exactText(value, AI_MULTI_AGENT_LIMITS.summaryCodePoints); }
export function validSubagentError(value: unknown): value is string { return exactText(value, AI_MULTI_AGENT_LIMITS.errorCodePoints); }

/** Strict reader for a journaled/streamed update; undefined when invalid. */
export function readAiSubagentUpdate(value: unknown): AiSubagentUpdate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const L = AI_MULTI_AGENT_LIMITS;
  const id = typeof data.id === "string" && AI_SUBAGENT_ID.test(data.id) ? data.id : undefined;
  switch (data.phase) {
    case "planning": case "direct": case "synthesis":
      return Object.keys(data).length === 1 ? { phase: data.phase } : undefined;
    case "finish":
      return keysWithin(data, ["phase", "outcome"]) && ["done", "failed", "cancelled"].includes(String(data.outcome))
        ? { phase: "finish", outcome: data.outcome as "done" | "failed" | "cancelled" } : undefined;
    case "plan": {
      if (!keysWithin(data, ["phase", "maxConcurrency", "subtasks"]) || !Number.isInteger(data.maxConcurrency)
        || Number(data.maxConcurrency) < L.minConcurrency || Number(data.maxConcurrency) > L.maxConcurrency
        || !Array.isArray(data.subtasks) || !data.subtasks.length || data.subtasks.length > L.maxSubtasks) return undefined;
      const subtasks: AiSubagentPlanItem[] = [];
      for (const raw of data.subtasks) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const item = raw as Record<string, unknown>;
        if (!keysWithin(item, ["id", "role", "title", "task", "search"]) || typeof item.id !== "string" || !AI_SUBAGENT_ID.test(item.id)
          || subtasks.some(existing => existing.id === item.id) || !validSubagentRole(item.role) || !validSubagentTitle(item.title)
          || !validSubagentTask(item.task) || typeof item.search !== "boolean") return undefined;
        subtasks.push({ id: item.id, role: item.role, title: item.title, task: item.task, search: item.search });
      }
      return { phase: "plan", maxConcurrency: Number(data.maxConcurrency), subtasks };
    }
    case "start":
      return id && Object.keys(data).length === 2 ? { phase: "start", id } : undefined;
    case "progress":
      if (!id || !keysWithin(data, ["phase", "id", "chars", "preview"]) || !count(data.chars, 1_000_000)) return undefined;
      if (data.preview !== undefined && !exactText(data.preview, L.previewCodePoints)) return undefined;
      return { phase: "progress", id, chars: data.chars, ...(data.preview !== undefined ? { preview: data.preview as string } : {}) };
    case "search":
      if (!id || !keysWithin(data, ["phase", "id", "callId", "status", "query", "sourceCount"]) || typeof data.callId !== "string" || !SEARCH_CALL_ID.test(data.callId)
        || !AI_TOOL_PROGRESS_STATUSES.includes(data.status as AiToolProgress["status"])) return undefined;
      if (data.query !== undefined && !exactText(data.query, L.queryCodePoints)) return undefined;
      if (data.sourceCount !== undefined && !count(data.sourceCount, 10_000)) return undefined;
      return { phase: "search", id, callId: data.callId, status: data.status as AiToolProgress["status"],
        ...(data.query !== undefined ? { query: data.query as string } : {}), ...(data.sourceCount !== undefined ? { sourceCount: data.sourceCount as number } : {}) };
    case "stop":
      if (!id || !keysWithin(data, ["phase", "id", "durationMs", "summary", "searchCount", "sourceCount", "sources"]) || !count(data.durationMs, L.durationMs)) return undefined;
      if (data.summary !== undefined && !validSubagentSummary(data.summary)) return undefined;
      if (data.searchCount !== undefined && !count(data.searchCount, L.searchesPerAgent)) return undefined;
      if (data.sourceCount !== undefined && !count(data.sourceCount, 10_000)) return undefined;
      if (data.sources !== undefined && !validSubagentSourceNumbers(data.sources)) return undefined;
      return { phase: "stop", id, durationMs: data.durationMs,
        ...(data.summary !== undefined ? { summary: data.summary as string } : {}),
        ...(data.searchCount !== undefined ? { searchCount: data.searchCount as number } : {}),
        ...(data.sourceCount !== undefined ? { sourceCount: data.sourceCount as number } : {}),
        ...(data.sources !== undefined ? { sources: [...data.sources as number[]] } : {}) };
    case "error":
      if (!id || !keysWithin(data, ["phase", "id", "reason", "message", "durationMs"]) || !["failed", "timeout", "cancelled"].includes(String(data.reason))
        || !validSubagentError(data.message)) return undefined;
      if (data.durationMs !== undefined && !count(data.durationMs, L.durationMs)) return undefined;
      return { phase: "error", id, reason: data.reason as AiSubagentFailure, message: data.message as string,
        ...(data.durationMs !== undefined ? { durationMs: data.durationMs as number } : {}) };
    default:
      return undefined;
  }
}

/** Live status line for one sub-agent, e.g. "联网搜索：深圳 天气". Display only. */
export function subagentActivity(agent: { status: AiSubagentStatus; searchQuery?: string; preview?: string; summary?: string; error?: string }): string | undefined {
  const L = AI_MULTI_AGENT_LIMITS;
  switch (agent.status) {
    case "queued": return "排队等待";
    case "thinking": return "正在思考";
    case "searching": return boundedText(agent.searchQuery ? `联网搜索：${agent.searchQuery}` : "正在联网搜索", L.activityCodePoints);
    case "working": return boundedText(agent.preview ? `撰写中：${agent.preview}` : "正在撰写", L.activityCodePoints);
    case "done": return agent.summary ?? "已完成";
    case "failed": case "cancelled": return agent.error ?? (agent.status === "failed" ? "未完成" : "已取消");
  }
}
