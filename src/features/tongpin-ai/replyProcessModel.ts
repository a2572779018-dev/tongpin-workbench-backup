import type { AiHarnessPublicStep, AiHarnessTrace } from "../../../shared/ai";
import { readReplyProcess, type AiReplyProcessLive, type AiReplyProcessOutcome, type AiReplyProcessStep } from "../../../shared/aiReplyProcess";
import type { AiToolProgress } from "../../../shared/aiRunEvents";
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
export type ReplyProcessToolKind = "image" | "video" | "presentation" | "computer" | "file";

export type ReplyProcessPart =
  | { kind: "plan"; key: "plan"; label: "任务进度" | "工具进度"; steps: AiHarnessPublicStep[]; completed: number; state: ReplyProcessPartState }
  | { kind: "thinking"; key: "thinking"; text: string; state: ReplyProcessPartState }
  | { kind: "search"; key: string; query?: string; status: ReplyProcessSearchStatus; sourceCount?: number; durationMs?: number; state: ReplyProcessPartState }
  /** Older saved replies only report how many searches ran. */
  | { kind: "search-total"; key: "search-total"; count: number; state: "done" }
  | { kind: "tool"; key: string; tool: ReplyProcessToolKind; label: string; statusText: string; state: ReplyProcessPartState; hasCard: boolean };

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

function stepParts(steps: readonly (AiReplyProcessStep | AiReplyProcessLive["steps"][number])[], summary: string | undefined, streaming: boolean): ReplyProcessPart[] {
  const parts: ReplyProcessPart[] = [];
  let searchIndex = 0;
  for (const step of steps) {
    if (step.kind === "thinking") {
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
  const plan = planPart(input.trace ?? message.trace);
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
  const parts: ReplyProcessPart[] = [...(plan ? [plan] : []), ...steps, ...(tool ? [tool] : [])];
  if (!parts.length) return null;

  const searches = parts.filter((part): part is Extract<ReplyProcessPart, { kind: "search" }> => part.kind === "search");
  const searchTotal = parts.find(part => part.kind === "search-total");
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
    searchCount: searchTotal?.kind === "search-total" ? searchTotal.count : searches.length,
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
  if (view.searchCount) segments.push(`搜索 ${view.searchCount} 次`);
  if (view.sourceCount) segments.push(`${view.sourceCount} 个来源`);
  for (const part of view.parts) if (part.kind === "tool") segments.push(part.label);
  const described = segments.length - (view.phase === "settled" && view.outcome !== "completed" ? 1 : 0);
  if (!described && view.parts.some(part => part.kind === "thinking")) segments.push("已思考");
  if (view.phase === "settled" && view.durationMs !== undefined) segments.push(`用时 ${formatProcessTotal(view.durationMs)}`);
  return segments.join(" · ");
}

/** What is happening right now, from the latest real state only. */
export function replyProcessActivity(view: ReplyProcessView, message: Pick<TongpinAIMessage, "content">): string {
  if (view.parts.some(part => part.kind === "search" && part.state === "running")) return "正在联网搜索";
  const tool = view.parts.find(part => part.kind === "tool" && (part.state === "running" || part.state === "waiting"));
  if (tool?.kind === "tool") return tool.statusText;
  const plan = view.parts.find(part => part.kind === "plan" && (part.state === "running" || part.state === "waiting"));
  if (plan?.kind === "plan") return plan.state === "waiting" ? "等待确认后继续" : "正在执行任务";
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
