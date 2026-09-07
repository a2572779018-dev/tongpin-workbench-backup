import type { AiChatRequest, AiChatResponse } from "../../../shared/ai";
import type { TongpinAIConversation, TongpinAIMessage, TongpinAIMode } from "./types";

// Only replay a request whose result is unknown or which never entered the ledger.
// A terminal provider rejection is cached by the server and cannot recover by replaying.
export function canRecoverChatRequest(code: string | undefined, interrupted: boolean) {
  return interrupted || code === undefined || [
    "NETWORK_UNAVAILABLE", "REQUEST_FAILED", "AI_REQUEST_IN_PROGRESS",
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
    messages: messages
      .filter((message) => message.content.trim() &&
        !["error", "thinking", "typing"].includes(message.status ?? "ready"))
      .map(({ role, content }) => ({ role, content })),
  };
}

export function replaceChatMessage(
  conversations: TongpinAIConversation[],
  conversationId: string,
  messageId: string,
  patch: Partial<Pick<TongpinAIMessage, "content" | "status" | "model" | "usage" | "artifactId" | "sources">>,
) {
  return conversations.map((conversation) => conversation.id === conversationId
    ? { ...conversation, messages: conversation.messages.map((message) =>
      message.id === messageId ? { ...message, ...patch } : message) }
    : conversation);
}

export function recoverInterruptedMessages(conversations: TongpinAIConversation[]) {
  return conversations.map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) =>
      message.status === "thinking" || message.status === "typing"
        ? { ...message, status: "error" as const, content: "上次等待已中断，请在 Token 使用详情中查看扣额记录。" }
        : message),
  }));
}

export function completedReply(response: AiChatResponse) {
  return { content: response.content, status: "ready" as const, model: response.model, usage: response.usage, ...(response.sources ? { sources: response.sources } : {}) };
}
