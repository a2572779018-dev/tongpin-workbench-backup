import type { TongpinAIConversation } from "./types";

export const CHAT_MESSAGE_PAGE_SIZE = 40;
export const TYPEWRITER_FRAME_MS = 50;

/** Cosmetic playback is bounded; a long answer must not keep the whole app busy. */
export function typewriterDuration(content: string): number {
  return content ? Math.min(2_200, Math.max(320, content.length * 18)) : 0;
}

export function typewriterOffset(content: string, progress: number): number {
  const offset = Math.min(content.length, Math.max(0, Math.ceil(content.length * progress)));
  // Do not expose half of an emoji/supplementary character during playback.
  const previous = content.charCodeAt(offset - 1);
  return offset < content.length && previous >= 0xd800 && previous <= 0xdbff ? offset - 1 : offset;
}

/** The full received answer is saved immediately; visual playback is never persisted. */
export function conversationsForPersistence(conversations: TongpinAIConversation[]): TongpinAIConversation[] {
  return conversations.map(conversation => {
    if (!conversation.messages.some(message => message.status === "typing")) return conversation;
    return { ...conversation, messages: conversation.messages.map(message =>
      message.status === "typing" ? { ...message, status: "ready" as const } : message) };
  });
}
