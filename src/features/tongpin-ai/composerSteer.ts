import type { AiHarnessTrace } from "../../../shared/ai";
import { AI_CHAT_CONTEXT_LIMITS } from "../../../shared/aiContext";
import type { AiMultiAgentPhase } from "../../../shared/aiMultiAgent";
import { readGeneratedImageSelection } from "./generatedImageSelection";
import { harnessTraceRequestId } from "./runTracePolling";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";

/**
 * Steering a running reply: while 同频 AI works, the member can keep typing.
 * Text sent then is a supplement/correction; it never stops or replaces the
 * running task. Pure rules only; the lifecycle lives in steerController.ts.
 */

/** idle → normal send; running + empty composer → spinner (stop);
 * running + text → send the text as a supplement. */
export type ComposerSendMode = "send" | "stop" | "steer";

export const COMPOSER_STEER_LABELS = Object.freeze({
  stop: "停止回复",
  stopTitle: "停止（Esc）",
  stopTitleWithoutEscape: "停止",
  steer: "发送补充（不打断当前任务）",
});

export function composerSendMode(input: { responding: boolean; draft: string; steerAvailable: boolean }): ComposerSendMode {
  if (!input.responding) return "send";
  return input.steerAvailable && input.draft.trim() ? "steer" : "stop";
}

/** Esc stops only a running reply whose composer is empty: pressing Esc after
 * typing a correction must never kill the task. */
export function escapeStopsReply(input: { canStop: boolean; draft: string }): boolean {
  return input.canStop && !input.draft.trim();
}

export function composerHintText(input: { responding: boolean; steerAvailable: boolean; draft: string; escapeStops: boolean }): string {
  if (input.responding && input.steerAvailable) {
    if (input.draft.trim()) return "Enter 发送补充，不会打断当前回复";
    return input.escapeStops ? "按 Esc 停止当前回复 · 也可直接输入补充或纠正" : "可直接输入补充或纠正，不会打断当前回复";
  }
  return input.escapeStops ? "按 Esc 停止当前回复" : "Enter 发送 · Shift + Enter 换行";
}

export type SteerItemStatus = "queued" | "sending" | "handed";

export interface SteerItem {
  /** Also the idempotency id of a guidance POST. */
  id: string;
  conversationId: string;
  text: string;
  createdAt: number;
  status: SteerItemStatus;
  /** Multi-step run that holds (or is being asked to hold) this item. */
  runRequestId?: string;
  /** A guidance POST/DELETE for this item is in flight. */
  delivering?: boolean;
  /** Withdrawn while its POST was in flight: hidden, never sent. */
  withdrawn?: boolean;
}

/** What the conversation shows for one pending supplement. */
export interface SteerBubble {
  id: string;
  text: string;
  status: SteerItemStatus;
  cancellable: boolean;
}

export const STEER_MAX_PENDING = 5;
/** Pending text per conversation: one request message (and one saved draft). */
export const STEER_MAX_CHARACTERS = AI_CHAT_CONTEXT_LIMITS.requestMessageCharacters;
export const STEER_STATUS_LABELS: Readonly<Record<SteerItemStatus, string>> = Object.freeze({
  queued: "等当前回复结束后自动发送",
  sending: "正在发送…",
  handed: "已交给 AI",
});

export function steerBubbles(items: readonly SteerItem[]): SteerBubble[] {
  return items.filter(item => !item.withdrawn).map(item => ({
    id: item.id, text: item.text, status: item.status,
    cancellable: item.status !== "sending" && !item.delivering,
  }));
}

/** Several supplements become one follow-up turn, oldest first. */
export function mergeSteerTexts(items: ReadonlyArray<Pick<SteerItem, "text" | "createdAt">>): string {
  return [...items].sort((left, right) => left.createdAt - right.createdAt)
    .map(item => item.text.trim()).filter(Boolean).join("\n");
}

/** Once a send is acknowledged, clear only what was sent; text typed while
 * the send was in flight stays in the composer. */
export function draftAfterSend(currentDraft: string, sentDraft: string): string {
  if (currentDraft === sentDraft) return "";
  return sentDraft && currentDraft.startsWith(sentDraft) ? currentDraft.slice(sentDraft.length).replace(/^\s+/, "") : currentDraft;
}

/** Returned text never replaces what the member typed since. */
export function appendDraftText(draft: string | undefined, text: string): string {
  const current = draft ?? "";
  return current.trim() ? `${current.replace(/\s+$/, "")}\n${text}` : text;
}

export type SteerTarget = { kind: "guidance"; runRequestId: string } | { kind: "followup" };

const ACTIVE_RUN = new Set<AiHarnessTrace["status"]>(["running", "planned", "waiting_approval"]);
/** 多 Agent 协作 phases after which the run still reaches a guidance checkpoint
 * (before the sub-agents or before synthesis). */
const GUIDED_AGENT_PHASES = new Set<AiMultiAgentPhase>(["planning", "dispatching", "working"]);

type SteerRunMessage = Pick<TongpinAIMessage, "role" | "trace" | "requestId" | "harnessPlanRequestId" | "status" | "liveProcess">;

/** The request id of a Pro 多 Agent 协作 reply that is streaming and will still
 * take guidance at its next checkpoint. Its live process carries the agents step
 * long before any harness trace reaches the client. */
export function activeMultiAgentRequestId(message?: Pick<TongpinAIMessage, "role" | "requestId" | "status" | "liveProcess">): string | undefined {
  if (message?.role !== "assistant" || (message.status !== "thinking" && message.status !== "typing")) return undefined;
  if (!message.requestId || message.requestId.startsWith("draft-")) return undefined;
  // A step-by-step Hub takes guidance before each later step: while its last
  // step has not started yet, a supplement still reaches a later model call.
  const workflow = message.liveProcess?.workflow;
  if (workflow) return workflow.steps[workflow.steps.length - 1].status === "planned" ? message.requestId : undefined;
  const agents = message.liveProcess?.steps.find(step => step.kind === "agents");
  return agents?.kind === "agents" && GUIDED_AGENT_PHASES.has(agents.phase) ? message.requestId : undefined;
}

/** The request id of a multi-step run (any harness strategy other than
 * "direct", or a streaming 多 Agent 协作 reply) that will still make another
 * model step, if `message` carries one. */
export function activeMultiStepRunRequestId(message?: SteerRunMessage): string | undefined {
  const multiAgent = activeMultiAgentRequestId(message);
  if (multiAgent) return multiAgent;
  const trace = message?.role === "assistant" ? message.trace : undefined;
  if (!trace || trace.strategy === "direct" || !ACTIVE_RUN.has(trace.status) || trace.toolBudget.remaining <= 0) return undefined;
  return harnessTraceRequestId(message!);
}

/** Guidance goes to an active multi-step run; everything else waits and is
 * sent as one follow-up turn when the current reply ends. */
export function steerDeliveryTarget(message?: SteerRunMessage): SteerTarget {
  const runRequestId = activeMultiStepRunRequestId(message);
  return runRequestId ? { kind: "guidance", runRequestId } : { kind: "followup" };
}

/** The newest assistant message, without copying the history. */
export function latestAssistantMessage<T extends Pick<TongpinAIMessage, "role">>(messages: readonly T[] | undefined): T | undefined {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) if (messages![index].role === "assistant") return messages![index];
  return undefined;
}

export function steerRunActive(messages: readonly TongpinAIMessage[] | undefined, runRequestId: string): boolean {
  return Boolean(messages?.some(message => activeMultiStepRunRequestId(message) === runRequestId));
}

/** A confirmation card is waiting for the member (media cost authorization,
 * a media task question, or picking a reference image). Steering is off then. */
export function awaitingUserConfirmation(message?: Pick<TongpinAIMessage, "role" | "taskPhase">, artifact?: TongpinAIArtifact): boolean {
  if (message?.role !== "assistant") return false;
  if (message.taskPhase === "awaiting_authorization") return true;
  const data = artifact?.data;
  if (data && typeof data.mediaTaskRequestId === "string" && !data.mediaTaskSubmitError
    && (data.mediaTaskStatus === "awaiting_authorization" || data.mediaTaskStatus === "awaiting_input")) return true;
  return readGeneratedImageSelection(artifact)?.status === "awaiting_selection";
}

/** Why a queued follow-up cannot be sent now (the text goes back to the composer). */
export function supplementBlockReason(state: {
  onboarded: boolean; serviceConnected: boolean; connectionError: boolean; availabilityBlocked: boolean;
  quotaInsufficient: boolean; syncBlocked: boolean; computerActive: boolean; awaitingConfirmation: boolean;
}): string | undefined {
  if (!state.onboarded || !state.serviceConnected || state.connectionError || state.availabilityBlocked) return "AI 服务暂不可用，补充内容已放回输入框";
  if (state.quotaInsufficient) return "AI 额度不足，补充内容已放回输入框";
  if (state.syncBlocked) return "对话记录尚未同步，补充内容已放回输入框";
  if (state.computerActive) return "已进入电脑操作确认流程，补充内容已放回输入框";
  if (state.awaitingConfirmation) return "AI 正在等你确认，补充内容已放回输入框";
  return undefined;
}
