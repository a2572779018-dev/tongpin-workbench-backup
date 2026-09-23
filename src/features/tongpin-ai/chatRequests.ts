import type { AiChatRequest, AiChatResponse } from "../../../shared/ai";
import { fitAiChatMessages } from "../../../shared/aiContext";
import type { TongpinAIConversation, TongpinAIMessage, TongpinAIMode } from "./types";

// Only replay a request whose result is unknown or which never entered the ledger.
// A terminal provider rejection is cached by the server and cannot recover by replaying.
export function canRecoverChatRequest(code: string | undefined, interrupted: boolean) {
  return interrupted || code === undefined || [
    "NETWORK_UNAVAILABLE", "REQUEST_FAILED", "AI_REQUEST_IN_PROGRESS", "AI_STREAM_INTERRUPTED", "AI_REQUEST_UNCERTAIN", "AI_WAIT_TIMEOUT",
    "AI_NOT_CONFIGURED", "AI_QUOTA_EXHAUSTED", "AI_SEARCH_QUOTA_INSUFFICIENT", "AI_QUOTA_INSUFFICIENT",
  ].includes(code);
}

export function buildChatRequest(
  requestId: string,
  mode: TongpinAIMode,
  messages: TongpinAIMessage[],
): AiChatRequest {
  return {
    requestId,
    mode,
    messages: fitAiChatMessages(messages
      .filter((message) => message.content.trim() &&
        !["error", "thinking", "typing"].includes(message.status ?? "ready"))
      .map(({ role, content }) => ({ role, content }))),
  };
}

export function replaceChatMessage(
  conversations: TongpinAIConversation[],
  conversationId: string,
  messageId: string,
    patch: Partial<Pick<TongpinAIMessage, "content" | "analysisSummary" | "status" | "model" | "usage" | "artifactId" | "sources" | "trace" | "startedAt" | "taskPhase" | "completion" | "retryDisposition">>,
) {
  return conversations.map((conversation) => conversation.id === conversationId
    ? { ...conversation, messages: conversation.messages.map((message) =>
      message.id === messageId ? cleanMessagePatch(message, patch) : message) }
    : conversation);
}

function cleanMessagePatch(message: TongpinAIMessage, patch: Partial<TongpinAIMessage>): TongpinAIMessage {
  const next = { ...message, ...patch };
  if (patch.taskPhase === "completed") { delete next.completion; delete next.retryDisposition; }
  // Optional properties must stay JSON-only when saved, including explicit clears.
  return Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined)) as unknown as TongpinAIMessage;
}

const LEGACY_INTERRUPTED_NOTICE = "上次等待已中断，可以查询原任务结果；不会重复提交收费请求。";
const REQUEST_ID = /^[a-zA-Z0-9_-]{16,100}$/;

function canResumeOriginalRequest(message: TongpinAIMessage): boolean {
  if (message.role !== "assistant" || message.artifactId || !message.requestId || !REQUEST_ID.test(message.requestId)) return false;
  return message.status === "thinking" || message.status === "typing" ||
    message.status === "error" && message.taskPhase === "unknown" && message.content === LEGACY_INTERRUPTED_NOTICE;
}

/** Existing generation IDs are read-only recovery targets, never POST retries. */
export function interruptedChatRequests(conversations: TongpinAIConversation[]): Array<{ conversationId: string; messageId: string; requestId: string }> {
  const seen = new Set<string>();
  return conversations.flatMap(conversation => conversation.messages.flatMap(message => {
    if (!canResumeOriginalRequest(message) || seen.has(message.requestId!)) return [];
    seen.add(message.requestId!);
    return [{ conversationId: conversation.id, messageId: message.id, requestId: message.requestId! }];
  }));
}

export function recoverInterruptedMessages(conversations: TongpinAIConversation[]) {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => {
      if (canResumeOriginalRequest(message)) {
        // Preserve the first start timestamp, including after reload. A GET by
        // the original ID will replace this waiting state with the stored result.
        const { retryDisposition: _retryDisposition, ...rest } = message;
        return { ...rest, status: "thinking" as const, taskPhase: "running" as const,
          content: message.content === LEGACY_INTERRUPTED_NOTICE ? "" : message.content };
      }
      if (message.status === "thinking" || message.status === "typing") {
        return { ...message, status: "error" as const, taskPhase: "unknown" as const,
          content: message.content || "上次等待已中断，未保存有效任务编号，无法自动查询原结果。" };
      }
      return message;
    }),
  }));
}

export function completedReply(response: AiChatResponse, options: { preserveExistingTrace?: boolean } = {}) {
  return { content: response.content, ...(response.analysisSummary ? { analysisSummary: response.analysisSummary } : {}), ...(response.completion ? { completion: response.completion } : {}), taskPhase: response.completion ? "partial" as const : "completed" as const, status: "ready" as const, model: response.model, usage: response.usage, ...(response.sources ? { sources: response.sources } : {}), ...(!options.preserveExistingTrace && response.trace ? { trace: response.trace } : {}) };
}
