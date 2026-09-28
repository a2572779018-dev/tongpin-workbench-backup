import type { AiHarnessPublicStep, AiHarnessTrace } from "../../../shared/ai";
import { coordinatorActivity, readReplyProcess, type AiReplyProcessAgentsStep, type AiReplyProcessLive, type AiReplyProcessLiveAgents, type AiReplyProcessOutcome, type AiReplyProcessStep } from "../../../shared/aiReplyProcess";
import { subagentActivity, type AiMultiAgentPhase, type AiSubagentStatus } from "../../../shared/aiMultiAgent";
import type { AiCodeExecStatus, AiToolProgress } from "../../../shared/aiRunEvents";
import type { AiWorkflowLiveStep, AiWorkflowStepState, AiWorkflowUpdate } from "../../../shared/aiWorkflows";
import { readGeneratedImageSelection } from "./generatedImageSelection";
import { mediaTaskStatusText, type MediaTaskStatus } from "./mediaTaskClient";
import { displaySources } from "./sourceDisplay";
import { memberVisibleHarnessSteps } from "./tracePresentation";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";

/*
 * Ordered "process parts" for one assistant reply. The grouping and the
 * collapse rules are adapted from LibreChat v0.8.7 (MIT)
 * `client/src/components/Chat/Messages/Content/ContentParts.tsx`, `Part.tsx`,
 * `ToolCallGroup.tsx`, `Parts/Reasoning.tsx`, `ProgressText.tsx`,
 * `WebSearch.tsx` and `InProgressCall.tsx`: one ordered list of typed parts, a
 * per-part progress label, unfinished calls shown as not completed once the
 * reply stops, auto-expanded while the reply is live and collapsed to one
 * summary line once settled unless the viewer chose otherwise. Unlike
 * LibreChat's `useProgress`, nothing here advances on a timer: every part comes
 * from a real run event, the saved process record, the harness trace, or a
 * linked result card.
 */

export type ReplyProcessPartState = "running" | "waiting" | "done" | "failed";
export type ReplyProcessSearchStatus = AiToolProgress["status"] | "incomplete";
export type ReplyProcessExecStatus = AiCodeExecStatus | "incomplete" | "unsupported";
export type ReplyProcessToolKind = "image" | "video" | "presentation" | "computer" | "file";

export type ReplyProcessPart =
  /** How the quick tier was routed (OpenSquilla or the built-in fallback), from the trace's route step. */
  | { kind: "route"; key: "route"; label: string; detail: string; state: "done" }
  /** Harness trace steps; while a step-by-step Hub streams, its live step list
   * with `activity` naming the step now running. */
  | { kind: "plan"; key: "plan"; label: "任务进度" | "工具进度"; steps: AiHarnessPublicStep[]; completed: number; state: ReplyProcessPartState; activity?: string }
  | { kind: "thinking"; key: "thinking"; text: string; state: ReplyProcessPartState }
  | { kind: "search"; key: string; query?: string; status: ReplyProcessSearchStatus; sourceCount?: number; durationMs?: number; state: ReplyProcessPartState }
  /** Older saved replies only report how many searches ran. */
  | { kind: "search-total"; key: "search-total"; count: number; state: "done" }
  | { kind: "exec"; key: string; status: ReplyProcessExecStatus; language: "python"; code?: string; logs?: string; imageCount?: number; durationMs?: number; state: ReplyProcessPartState }
  | { kind: "tool"; key: string; tool: ReplyProcessToolKind; label: string; statusText: string; state: ReplyProcessPartState; hasCard: boolean }
  /** 多 Agent 协作: 任务分解, each sub-agent's card, then 结果综合. */
  | { kind: "agents"; key: "agents"; phase: AiMultiAgentPhase; maxConcurrency?: number; coordinatorActivity: string; agents: ReplyProcessAgentView[];
    synthesis?: "running" | "done" | "failed" | "cancelled"; state: ReplyProcessPartState;
    /** Server event times (epoch ms); `updatedAt` is the latest event seen (the finish time once persisted). */
    startedAt?: number; updatedAt?: number; finishedAt?: number };

/** One sub-agent as shown on its card (live or persisted). */
export interface ReplyProcessAgentView {
  id: string;
  role: string;
  title: string;
  task: string;
  status: AiSubagentStatus;
  activity?: string;
  summary?: string;
  error?: string;
  durationMs?: number;
  searchCount?: number;
  sourceCount?: number;
  /** 1-based numbers into the reply's own source list. */
  sources?: number[];
  /** Server event times (epoch ms). */
  startedAt?: number;
  finishedAt?: number;
  live: boolean;
}

export type ReplyProcessPhase = "running" | "waiting" | "settled";

export interface ReplyProcessView {
  parts: ReplyProcessPart[];
  phase: ReplyProcessPhase;
  /** True only while the reply itself is streaming (thinking/typing). */
  streaming: boolean;
  outcome: AiReplyProcessOutcome;
  durationMs?: number;
  startedAt?: number;
  searchCount: number;
  execCount: number;
  sourceCount?: number;
}

export const REPLY_PROCESS_OUTCOME_LABELS: Record<AiReplyProcessOutcome, string> = {
  completed: "完成",
  partial: "部分完成",
  stopped: "已停止",
  failed: "未完成",
};

const TOOL_LABELS: Record<ReplyProcessToolKind, string> = {
  image: "生成图片",
  video: "生成视频",
  presentation: "生成 PPT",
  computer: "电脑操作",
  file: "生成成果",
};

const MEDIA_STATUSES = new Set<MediaTaskStatus>(["queued", "planning", "awaiting_input", "awaiting_authorization", "running", "partial", "completed", "failed", "cancelled", "unknown"]);

export function isReplyStreaming(message: Pick<TongpinAIMessage, "status">): boolean {
  return message.status === "thinking" || message.status === "typing";
}

/** 0.4 秒 / 9.2 秒 / 12 秒 / 1 分 5 秒. Durations are real elapsed times only. */
export function formatProcessDuration(durationMs: number): string {
  const ms = Math.max(0, durationMs);
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))} 秒`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** Whole seconds for the summary line: "用时 9 秒". */
export function formatProcessTotal(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分钟`;
}

/** Provider-reported state only; mirrors the live search labels. */
export function replyProcessSearchLabel(part: Extract<ReplyProcessPart, { kind: "search" }>): string {
  const parts: string[] = [];
  if (part.status === "completed") parts.push("已完成");
  else if (part.status === "failed") parts.push("未完成");
  else if (part.status === "incomplete") parts.push("未完成");
  else parts.push(part.status === "searching" ? "搜索中" : "已发起");
  if (part.status === "completed" && part.sourceCount !== undefined) parts.push(`${part.sourceCount} 个来源`);
  if (part.durationMs !== undefined && (part.status === "completed" || part.status === "failed")) parts.push(formatProcessDuration(part.durationMs));
  return parts.join(" · ");
}

function searchState(status: ReplyProcessSearchStatus): ReplyProcessPartState {
  if (status === "completed") return "done";
  if (status === "failed" || status === "incomplete") return "failed";
  return "running";
}

/** Provider-reported state only; mirrors the live exec labels. An "unsupported"
 * call never actually ran, so no duration or output is ever attached to it. */
export function replyProcessExecLabel(part: Extract<ReplyProcessPart, { kind: "exec" }>): string {
  if (part.status === "unsupported") return "当前服务不支持代码执行";
  const parts: string[] = [];
  if (part.status === "completed") parts.push("已完成");
  else if (part.status === "failed" || part.status === "incomplete") parts.push("未完成");
  else parts.push(part.status === "interpreting" ? "运行中" : "已发起");
  if (part.status === "completed" && part.imageCount) parts.push(`生成了 ${part.imageCount} 张图`);
  if (part.durationMs !== undefined && (part.status === "completed" || part.status === "failed")) parts.push(formatProcessDuration(part.durationMs));
  return parts.join(" · ");
}

function execState(status: ReplyProcessExecStatus): ReplyProcessPartState {
  if (status === "completed") return "done";
  if (status === "failed" || status === "incomplete" || status === "unsupported") return "failed";
  return "running";
}

const ROUTE_TITLE_PREFIX = "路由：";

/** Only a quick-tier turn routed by OpenSquilla carries a "路由：" route step;
 * built-in fallbacks and older traces keep the plain "快速档位" step and show nothing. */
export function replyProcessRoutePart(trace: AiHarnessTrace | undefined): Extract<ReplyProcessPart, { kind: "route" }> | undefined {
  const step = trace?.steps.find(item => item.kind === "route" && item.title.startsWith(ROUTE_TITLE_PREFIX));
  if (!step) return undefined;
  return { kind: "route", key: "route", label: step.title.slice(ROUTE_TITLE_PREFIX.length).trim(), detail: step.summary, state: "done" };
}

/** "OpenSquilla v4.2 → C1 均衡" → "OpenSquilla C1 均衡" for the one-line summary. */
function routeSummaryLabel(label: string): string {
  const arrow = label.indexOf("→");
  return arrow < 0 ? label : `${label.slice(0, arrow).trim().split(" ")[0]} ${label.slice(arrow + 1).trim()}`;
}

function planPart(trace: AiHarnessTrace | undefined): Extract<ReplyProcessPart, { kind: "plan" }> | undefined {
  if (!trace) return undefined;
  const steps = memberVisibleHarnessSteps(trace);
  if (!steps.length) return undefined;
  const label = steps.some(step => step.kind === "tool" || step.kind === "approval" || step.kind === "result") ? "工具进度" : "任务进度";
  const completed = steps.filter(step => step.status === "succeeded").length;
  const state: ReplyProcessPartState = trace.status === "failed" || trace.status === "uncertain" || trace.status === "cancelled" ? "failed"
    : trace.status === "waiting_approval" || trace.status === "planned" ? "waiting"
    : trace.status === "running" ? "running" : "done";
  return { kind: "plan", key: "plan", label, steps, completed, state };
}

const WORKFLOW_STEP_STATUS: Record<AiWorkflowStepState, AiHarnessPublicStep["status"]> = {
  planned: "planned", running: "running", done: "succeeded", failed: "failed", skipped: "cancelled",
};

function workflowStepSummary(step: AiWorkflowLiveStep): string {
  const duration = step.durationMs !== undefined ? formatProcessDuration(step.durationMs) : "";
  switch (step.status) {
    case "planned": return "等待前面的步骤完成";
    case "running": return step.activity ?? "正在执行";
    case "done": return [step.activity ?? "已完成", duration].filter(Boolean).join(" · ");
    case "failed": return [step.activity ?? "未完成", duration].filter(Boolean).join(" · ");
    case "skipped": return step.activity ?? "未执行";
  }
}

/** A step-by-step Hub while it streams: the same 任务进度 list its settled
 * harness trace shows afterwards, fed by live `workflow_update` events. */
export function workflowPlanPart(update: AiWorkflowUpdate): Extract<ReplyProcessPart, { kind: "plan" }> {
  const steps = update.steps.map((step, index): AiHarnessPublicStep => ({
    id: `hub:${step.id}`, kind: "workflow", capability: "chat", title: `${index + 1}. ${step.title}`,
    summary: workflowStepSummary(step), status: WORKFLOW_STEP_STATUS[step.status], createdAt: "", updatedAt: "",
  }));
  const running = update.steps.findIndex(step => step.status === "running");
  const last = update.steps[update.steps.length - 1];
  const state: ReplyProcessPartState = last.status === "done" ? "done"
    : running >= 0 || update.steps.some(step => step.status === "planned") ? "running" : "failed";
  return { kind: "plan", key: "plan", label: "任务进度", steps, completed: update.steps.filter(step => step.status === "done").length, state,
    ...(running >= 0 ? { activity: `正在执行第 ${running + 1}/${update.steps.length} 步：${update.steps[running].title}` } : {}) };
}

/** A compact row for the tool whose own result card sits below the answer. */
export function replyProcessToolPart(artifact: TongpinAIArtifact | undefined): Extract<ReplyProcessPart, { kind: "tool" }> | undefined {
  if (!artifact) return undefined;
  const data = artifact.data ?? {};
  const base = { kind: "tool" as const, key: `tool:${artifact.id}`, hasCard: true };
  if (artifact.kind === "参考图片选择") {
    const selection = readGeneratedImageSelection(artifact);
    if (!selection) return undefined;
    return { ...base, tool: "video", label: "选择视频参考图", statusText: selection.status === "awaiting_selection" ? "等待选择图片" : "已取消选择",
      state: selection.status === "awaiting_selection" ? "waiting" : "failed" };
  }
  const tool: ReplyProcessToolKind = artifact.kind === "视频" ? "video" : artifact.kind === "图片" ? "image" : artifact.kind === "PPT" ? "presentation" : "file";
  const label = tool === "file" ? `生成${artifact.kind}` : TOOL_LABELS[tool];
  if (typeof data.mediaTaskRequestId === "string" && (tool === "image" || tool === "video")) {
    if (typeof data.mediaTaskSubmitError === "string") return { ...base, tool, label, statusText: "任务未提交", state: "failed" };
    const status: MediaTaskStatus = MEDIA_STATUSES.has(data.mediaTaskStatus as MediaTaskStatus) ? data.mediaTaskStatus as MediaTaskStatus : "queued";
    const state: ReplyProcessPartState = status === "completed" ? "done"
      : status === "failed" || status === "cancelled" || status === "unknown" ? "failed"
      : status === "awaiting_input" || status === "awaiting_authorization" ? "waiting" : "running";
    return { ...base, tool, label, statusText: mediaTaskStatusText(status, tool), state };
  }
  if (tool === "video" && typeof data.videoJobId === "string") {
    if (typeof data.videoSubmitError === "string") return { ...base, tool, label, statusText: "任务未提交", state: "failed" };
    const status = data.videoStatus;
    if (status === "completed") return { ...base, tool, label, statusText: "视频已生成", state: "done" };
    if (status === "failed") return { ...base, tool, label, statusText: "视频未生成", state: "failed" };
    if (status === "uncertain") return { ...base, tool, label, statusText: "生成结果待核对，请勿重复提交", state: "failed" };
    return { ...base, tool, label, statusText: status === "queued" ? "排队中" : "正在生成视频", state: "running" };
  }
  const statusText = tool === "image" ? "图片已生成" : tool === "presentation" ? "演示文稿已生成" : "已生成";
  return { ...base, tool, label, statusText, state: "done" };
}

const AGENT_PHASE_STATE: Record<AiMultiAgentPhase, ReplyProcessPartState> = {
  planning: "running", dispatching: "running", working: "running", synthesizing: "running", done: "done", failed: "failed", cancelled: "failed",
};

/** Live or persisted 多 Agent 协作 step → one part. A live step that is no
 * longer streaming shows its unfinished sub-agents as stopped. */
export function agentsPart(step: AiReplyProcessLiveAgents | AiReplyProcessAgentsStep, streaming: boolean): Extract<ReplyProcessPart, { kind: "agents" }> {
  const live = "coordinatorActivity" in step;
  const stalled = live && !streaming && !["done", "failed", "cancelled"].includes(step.phase);
  const phase: AiMultiAgentPhase = stalled ? "cancelled" : step.phase;
  const agents = step.agents.map((agent): ReplyProcessAgentView => {
    const unfinished = stalled && !["done", "failed", "cancelled"].includes(agent.status);
    const status: AiSubagentStatus = unfinished ? "cancelled" : agent.status;
    const view = { ...agent, status, ...(unfinished ? { error: "已停止" } : {}) };
    return { id: agent.id, role: agent.role, title: agent.title, task: agent.task, status,
      activity: live && !unfinished && "activity" in agent && agent.activity ? agent.activity : subagentActivity(view),
      ...(agent.summary ? { summary: agent.summary } : {}), ...(view.error ? { error: view.error } : {}),
      ...(agent.durationMs !== undefined ? { durationMs: agent.durationMs } : {}), ...(agent.searchCount !== undefined ? { searchCount: agent.searchCount } : {}),
      ...(agent.sourceCount !== undefined ? { sourceCount: agent.sourceCount } : {}), ...(agent.sources?.length ? { sources: agent.sources } : {}),
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}), ...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
      live: live && !unfinished && !["done", "failed", "cancelled"].includes(status) };
  });
  const synthesis = stalled && step.synthesis === "running" ? "cancelled" : step.synthesis;
  const updatedAt = live ? step.updatedAt : step.finishedAt;
  return { kind: "agents", key: "agents", phase, ...(step.maxConcurrency !== undefined ? { maxConcurrency: step.maxConcurrency } : {}),
    coordinatorActivity: live && !stalled ? step.coordinatorActivity : coordinatorActivity({ phase, agents }),
    agents, ...(synthesis ? { synthesis } : {}), state: AGENT_PHASE_STATE[phase],
    ...(step.startedAt !== undefined ? { startedAt: step.startedAt } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(step.finishedAt !== undefined ? { finishedAt: step.finishedAt } : {}) };
}

function stepParts(steps: readonly (AiReplyProcessStep | AiReplyProcessLive["steps"][number])[], summary: string | undefined, streaming: boolean): ReplyProcessPart[] {
  const parts: ReplyProcessPart[] = [];
  let searchIndex = 0;
  let execIndex = 0;
  for (const step of steps) {
    if (step.kind === "agents") {
      parts.push(agentsPart(step, streaming));
    } else if (step.kind === "thinking") {
      if (summary) parts.push({ kind: "thinking", key: "thinking", text: summary, state: "done" });
    } else if (step.kind === "search") {
      searchIndex += 1;
      const status: ReplyProcessSearchStatus = step.status;
      const live = "callId" in step;
      const durationMs = live
        ? step.startedAt !== undefined && step.endedAt !== undefined && step.endedAt > step.startedAt ? step.endedAt - step.startedAt : undefined
        : step.durationMs;
      // A stopped or failed reply leaves an unsettled search unfinished.
      const settledStatus: ReplyProcessSearchStatus = live && !streaming && status !== "completed" && status !== "failed" ? "incomplete" : status;
      parts.push({ kind: "search", key: live ? `search:${step.callId}` : `search:${searchIndex}`, status: settledStatus,
        ...(step.query ? { query: step.query } : {}), ...(step.sourceCount !== undefined ? { sourceCount: step.sourceCount } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}), state: searchState(settledStatus) });
    } else if (step.kind === "exec") {
      execIndex += 1;
      const live = "callId" in step;
      const status: ReplyProcessExecStatus = live ? (step.unsupported ? "unsupported" : step.status) : step.status;
      const durationMs = live
        ? step.startedAt !== undefined && step.endedAt !== undefined && step.endedAt > step.startedAt ? step.endedAt - step.startedAt : undefined
        : step.durationMs;
      // A stopped or failed reply leaves an unsettled execution unfinished.
      const settledStatus: ReplyProcessExecStatus = live && !streaming && status !== "completed" && status !== "failed" && status !== "unsupported" ? "incomplete" : status;
      parts.push({ kind: "exec", key: live ? `exec:${step.callId}` : `exec:${execIndex}`, status: settledStatus, language: "python",
        ...(step.code ? { code: step.code } : {}), ...(step.logs ? { logs: step.logs } : {}), ...(step.imageCount !== undefined ? { imageCount: step.imageCount } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}), state: execState(settledStatus) });
    } else if (step.kind === "tool") {
      parts.push({ kind: "tool", key: `tool:${step.tool}`, tool: step.tool, label: TOOL_LABELS[step.tool],
        statusText: step.status === "handed_off" ? "已转入安全确认流程" : "当前环境未接入安全桌面能力",
        state: step.status === "handed_off" ? "done" : "failed", hasCard: false });
    }
  }
  // A public summary can also arrive only with the final result (for example a
  // model-authored dispatch summary). It still belongs before the searches.
  if (summary && !parts.some(part => part.kind === "thinking")) parts.unshift({ kind: "thinking", key: "thinking", text: summary, state: "done" });
  return parts;
}

function legacyLiveSearches(message: TongpinAIMessage, streaming: boolean): ReplyProcessPart[] {
  return (message.liveThinking?.searches ?? []).map(progress => {
    const status: ReplyProcessSearchStatus = !streaming && progress.status !== "completed" && progress.status !== "failed" ? "incomplete" : progress.status;
    return { kind: "search" as const, key: `search:${progress.callId}`, status, ...(progress.query ? { query: progress.query } : {}),
      ...(progress.sourceCount !== undefined ? { sourceCount: progress.sourceCount } : {}), state: searchState(status) };
  });
}

function settledOutcome(message: TongpinAIMessage, recorded: AiReplyProcessOutcome | undefined, tool: ReplyProcessPart | undefined): AiReplyProcessOutcome {
  if (tool?.state === "failed") return "failed";
  if (recorded) return recorded;
  if (message.status === "error") return "failed";
  if (message.status === "stopped") return "stopped";
  if (message.completion?.state === "partial") return "partial";
  return "completed";
}

/**
 * Builds the ordered parts that actually happened for one assistant message,
 * or null when there is nothing beyond the answer itself. Order: harness plan,
 * then the public thinking summary and each search call in the order they
 * first appeared, then the tool call whose card is attached below.
 */
export function replyProcessView(input: { message: TongpinAIMessage; artifact?: TongpinAIArtifact; trace?: AiHarnessTrace }): ReplyProcessView | null {
  const { message, artifact } = input;
  if (message.role !== "assistant") return null;
  const streaming = isReplyStreaming(message);
  const summary = message.analysisSummary?.trim() ? message.analysisSummary.trim() : undefined;
  const recorded = readReplyProcess(message.process);
  const live = streaming && message.liveProcess?.steps.length ? message.liveProcess : undefined;
  // A streaming step-by-step Hub shows its live steps; the trace takes over once it settles.
  const liveWorkflow = streaming ? message.liveProcess?.workflow : undefined;
  const plan = liveWorkflow ? workflowPlanPart(liveWorkflow) : planPart(input.trace ?? message.trace);
  const route = replyProcessRoutePart(input.trace ?? message.trace);
  const tool = replyProcessToolPart(artifact);

  let steps: ReplyProcessPart[];
  if (live) steps = stepParts(live.steps, summary, true);
  else if (recorded) steps = stepParts(recorded.steps, summary, false);
  else {
    steps = stepParts([], summary, streaming);
    const legacy = legacyLiveSearches(message, streaming);
    if (legacy.length) steps.push(...legacy);
    else if (!streaming && message.usage?.searchCalls) steps.push({ kind: "search-total", key: "search-total", count: message.usage.searchCalls, state: "done" });
  }
  // The summary is "live" only while it is the newest part and no answer text
  // has arrived; afterwards it is a finished part like any other.
  const last = steps.at(-1);
  if (streaming && last?.kind === "thinking" && !message.content.trim()) last.state = "running";
  const parts: ReplyProcessPart[] = [...(route ? [route] : []), ...(plan ? [plan] : []), ...steps, ...(tool ? [tool] : [])];
  if (!parts.length) return null;

  const searches = parts.filter((part): part is Extract<ReplyProcessPart, { kind: "search" }> => part.kind === "search");
  const execs = parts.filter((part): part is Extract<ReplyProcessPart, { kind: "exec" }> => part.kind === "exec");
  const searchTotal = parts.find(part => part.kind === "search-total");
  // Sub-agent searches live on their own cards; the summary still counts them.
  const agentSearches = parts.reduce((sum, part) => part.kind === "agents" ? sum + part.agents.reduce((count, agent) => count + (agent.searchCount ?? 0), 0) : sum, 0);
  const reported = searches.filter(part => part.sourceCount !== undefined);
  const citedSources = displaySources(message.sources);
  const citedCount = citedSources.visible.length + citedSources.folded.length;
  const sourceCount = reported.length ? reported.reduce((sum, part) => sum + (part.sourceCount ?? 0), 0) : citedCount || undefined;
  const running = streaming || parts.some(part => part.state === "running");
  const waiting = !running && parts.some(part => part.state === "waiting");
  // The recorded time covers the chat call only; a tool task (media, PPT or the
  // computer hand-off) runs on past it, so no total is claimed for it.
  const durationMs = parts.some(part => part.kind === "tool") ? undefined : recorded?.durationMs;
  return {
    parts,
    phase: running ? "running" : waiting ? "waiting" : "settled",
    streaming,
    outcome: settledOutcome(message, streaming ? undefined : recorded?.outcome, tool),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(message.startedAt !== undefined && Number.isSafeInteger(message.startedAt) ? { startedAt: message.startedAt } : {}),
    searchCount: searchTotal?.kind === "search-total" ? searchTotal.count : searches.length + agentSearches,
    execCount: execs.length,
    ...(sourceCount !== undefined ? { sourceCount } : {}),
  };
}

export function hasReplyProcess(message: TongpinAIMessage, artifact?: TongpinAIArtifact): boolean {
  return replyProcessView({ message, artifact }) !== null;
}

/** The collapsed one-line summary, e.g. "搜索 2 次 · 11 个来源 · 用时 9 秒". */
export function replyProcessSummary(view: ReplyProcessView): string {
  const segments: string[] = [];
  if (view.phase === "settled" && view.outcome !== "completed") segments.push(REPLY_PROCESS_OUTCOME_LABELS[view.outcome]);
  const plan = view.parts.find(part => part.kind === "plan");
  if (plan?.kind === "plan") segments.push(`${plan.label} ${plan.completed}/${plan.steps.length} 步`);
  const agents = view.parts.find(part => part.kind === "agents");
  if (agents?.kind === "agents") segments.push(`多 Agent 协作 ${agents.agents.filter(agent => agent.status === "done").length}/${agents.agents.length}`);
  if (view.searchCount) segments.push(`搜索 ${view.searchCount} 次`);
  if (view.execCount) segments.push(`代码执行 ${view.execCount} 次`);
  if (view.sourceCount) segments.push(`${view.sourceCount} 个来源`);
  for (const part of view.parts) if (part.kind === "tool") segments.push(part.label);
  const described = segments.length - (view.phase === "settled" && view.outcome !== "completed" ? 1 : 0);
  if (!described && view.parts.some(part => part.kind === "thinking")) segments.push("已思考");
  const route = view.parts.find(part => part.kind === "route");
  if (route?.kind === "route") segments.unshift(routeSummaryLabel(route.label));
  if (view.phase === "settled" && view.durationMs !== undefined) segments.push(`用时 ${formatProcessTotal(view.durationMs)}`);
  return segments.join(" · ");
}

/** What is happening right now, from the latest real state only. */
export function replyProcessActivity(view: ReplyProcessView, message: Pick<TongpinAIMessage, "content">): string {
  if (view.parts.some(part => part.kind === "search" && part.state === "running")) return "正在联网搜索";
  if (view.parts.some(part => part.kind === "exec" && part.state === "running")) return "正在执行代码";
  const agents = view.parts.find(part => part.kind === "agents" && part.state === "running");
  if (agents?.kind === "agents") return agents.coordinatorActivity;
  const tool = view.parts.find(part => part.kind === "tool" && (part.state === "running" || part.state === "waiting"));
  if (tool?.kind === "tool") return tool.statusText;
  const plan = view.parts.find(part => part.kind === "plan" && (part.state === "running" || part.state === "waiting"));
  if (plan?.kind === "plan") return plan.state === "waiting" ? "等待确认后继续" : plan.activity ?? "正在执行任务";
  if (view.streaming && !message.content) return view.parts.some(part => part.kind === "thinking") ? "正在思考" : "正在处理";
  return view.streaming ? "正在生成回答" : replyProcessSummary(view);
}

/** Conversation-level "过程详情：全部展开 / 全部收起". Each click bumps the
 * revision, which overrides any per-reply choice made before it. */
export interface ReplyProcessDetails { expanded: boolean; revision: number }
export interface ReplyProcessChoice { expanded: boolean; revision: number }

export function nextReplyProcessDetails(current: ReplyProcessDetails): ReplyProcessDetails {
  return { expanded: !current.expanded, revision: current.revision + 1 };
}

/**
 * Expanded while the reply streams, collapsed once settled unless the viewer
 * prefers details expanded. A viewer's own click on one reply wins until the
 * next conversation-level toggle; a toggle made during streaming applies to
 * the live reply too.
 */
export function isReplyProcessExpanded(input: { streaming: boolean; details: ReplyProcessDetails; choice?: ReplyProcessChoice; mountedRevision: number }): boolean {
  if (input.choice && input.choice.revision === input.details.revision) return input.choice.expanded;
  if (input.streaming && input.mountedRevision === input.details.revision) return true;
  return input.details.expanded;
}
