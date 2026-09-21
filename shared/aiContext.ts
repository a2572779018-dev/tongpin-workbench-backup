import type { AiChatRequest } from "./ai";
import { AI_WORKSPACE_LIMITS } from "./aiWorkspace";

export const AI_CHAT_CONTEXT_LIMITS = {
  requestMessages: 64,
  incomingMessages: AI_WORKSPACE_LIMITS.messagesPerConversation,
  requestTextBytes: 64_000,
  requestMessageCharacters: 24_000,
  persistedMessageCharacters: AI_WORKSPACE_LIMITS.messageCharacters,
  compressedHistoryBytes: 12_000,
} as const;

export const AI_CONTEXT_WINDOW_PREFIX = "【同频上下文窗口】";

export interface AiChatTextContext {
  projectContext?: string;
  attachments?: Array<{ name: string; text?: string; mediaType?: string }>;
}

type ChatMessage = AiChatRequest["messages"][number];
const encoder = new TextEncoder();

export class AiCurrentContextTooLongError extends Error {
  constructor() {
    super("本轮消息与当前资料超出分析上限，请缩短本轮内容或减少当前附件");
    this.name = "AiCurrentContextTooLongError";
  }
}

export function aiChatTextContextBytes(messages: ChatMessage[], extraContext: AiChatTextContext = {}): number {
  return encoder.encode(JSON.stringify({ messages, ...extraContext })).length;
}

function utf8Slice(value: string, maxBytes: number, fromEnd = false): string {
  if (maxBytes <= 0) return "";
  const characters = Array.from(value);
  let bytes = 0;
  const selected: string[] = [];
  const start = fromEnd ? characters.length - 1 : 0;
  const end = fromEnd ? -1 : characters.length;
  const step = fromEnd ? -1 : 1;
  for (let index = start; index !== end; index += step) {
    const character = characters[index];
    const size = encoder.encode(character).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    if (fromEnd) selected.unshift(character); else selected.push(character);
  }
  return selected.join("");
}

function compactHistoryMessage(message: ChatMessage): { message: ChatMessage; truncated: boolean } {
  const max = AI_CHAT_CONTEXT_LIMITS.compressedHistoryBytes;
  if (message.content.length <= AI_CHAT_CONTEXT_LIMITS.requestMessageCharacters && encoder.encode(message.content).length <= max) {
    return { message: { role: message.role, content: message.content }, truncated: false };
  }
  const marker = "\n……（较长历史消息已有界压缩）……\n";
  const remaining = Math.max(0, max - encoder.encode(marker).length);
  const head = utf8Slice(message.content, Math.ceil(remaining * 0.65));
  const tail = utf8Slice(message.content.slice(head.length), remaining - encoder.encode(head).length, true);
  return { message: { role: message.role, content: `${head}${marker}${tail}` }, truncated: true };
}

function windowNotice(): ChatMessage {
  return {
    role: "user",
    content: `${AI_CONTEXT_WINDOW_PREFIX}较早消息未全部重送，过长历史可能只保留首尾。请以下面保留的最近消息、本轮资料和采样画面为准；不得推测未提供的历史、视频画面或声音。`,
  };
}

/**
 * Builds a deterministic request-only context window. Persisted conversation
 * history is never changed. The final user turn and current project/attachment
 * metadata are immutable priorities; only older messages may be compressed or
 * omitted.
 */
export function fitAiChatMessages(messages: ChatMessage[], extraContext: AiChatTextContext = {}): ChatMessage[] {
  if (!messages.length) return [];
  const current = { role: messages.at(-1)!.role, content: messages.at(-1)!.content };
  if (current.content.length > AI_CHAT_CONTEXT_LIMITS.requestMessageCharacters
    || aiChatTextContextBytes([current], extraContext) > AI_CHAT_CONTEXT_LIMITS.requestTextBytes) {
    throw new AiCurrentContextTooLongError();
  }

  const history = messages.slice(0, -1);
  const hadWindow = history.some(message => message.content.startsWith(AI_CONTEXT_WINDOW_PREFIX));
  const candidates = history.filter(message => !message.content.startsWith(AI_CONTEXT_WINDOW_PREFIX));
  let selected: ChatMessage[] = [current];
  let changed = hadWindow;

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const compacted = compactHistoryMessage(candidates[index]);
    const next = [compacted.message, ...selected];
    const reserveNotice = changed || compacted.truncated || index > 0;
    const maxMessages = AI_CHAT_CONTEXT_LIMITS.requestMessages - (reserveNotice ? 1 : 0);
    if (next.length > maxMessages || aiChatTextContextBytes(next, extraContext) > AI_CHAT_CONTEXT_LIMITS.requestTextBytes) {
      changed = true;
      break;
    }
    selected = next;
    changed ||= compacted.truncated;
  }

  changed ||= selected.length - 1 < candidates.length;
  if (!changed) return selected;
  const notice = windowNotice();
  while (selected.length > 1 && (selected.length + 1 > AI_CHAT_CONTEXT_LIMITS.requestMessages
    || aiChatTextContextBytes([notice, ...selected], extraContext) > AI_CHAT_CONTEXT_LIMITS.requestTextBytes)) {
    selected.shift();
  }
  return selected.length + 1 <= AI_CHAT_CONTEXT_LIMITS.requestMessages
    && aiChatTextContextBytes([notice, ...selected], extraContext) <= AI_CHAT_CONTEXT_LIMITS.requestTextBytes
    ? [notice, ...selected]
    : selected;
}
