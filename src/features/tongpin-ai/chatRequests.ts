import type { AiChatRequest, AiChatResponse } from "../../../shared/ai";
import { fitAiChatMessages } from "../../../shared/aiContext";
import type { TongpinAIConversation, TongpinAIMessage, TongpinAIMode } from "./types";

// Only replay a request whose result is unknown or which never entered the ledger.
// A terminal provider rejection is cached by the server and cannot recover by replaying.
export function canRecoverChatRequest(code: string | undefined, interrupted: boolean) {
  return interrupted || code === undefined || [
    "NETWORK_UNAVAILABLE", "REQUEST_FAILED", "AI_REQUEST_IN_PROGRESS", "AI_STREAM_INTERRUPTED", "AI_REQUEST_UNCERTAIN",
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

export function recoverInterruptedMessages(conversations: TongpinAIConversation[]) {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.status === "thinking" || message.status === "typing"
        ? { ...message, status: "error" as const, taskPhase: "unknown" as const, content: message.content || "上次等待已中断，可以查询原任务结果；不会重复提交收费请求。" }
        : message),
  }));
}

export function completedReply(response: AiChatResponse, options: { preserveExistingTrace?: boolean } = {}) {
  return { content: response.content, ...(response.analysisSummary ? { analysisSummary: response.analysisSummary } : {}), ...(response.completion ? { completion: response.completion } : {}), taskPhase: response.completion ? "partial" as const : "completed" as const, status: "ready" as const, model: response.model, usage: response.usage, ...(response.sources ? { sources: response.sources } : {}), ...(!options.preserveExistingTrace && response.trace ? { trace: response.trace } : {}) };
}
