import type { TongpinAIArtifact, TongpinAIConversation, TongpinAIMessage } from "./types";

export type ConversationTaskPhase = "queued" | "running" | "awaiting_input" | "failed" | "unknown" | "completed";
export interface ConversationTaskStatus { phase: ConversationTaskPhase; messageId: string; resultToken?: string; unread?: boolean }

export function messageTaskStatus(message: TongpinAIMessage, artifact?: TongpinAIArtifact): ConversationTaskStatus | undefined {
  if (message.role !== "assistant") return undefined;
  const base = { messageId: message.id };
  if (message.taskPhase === "unknown") return { ...base, phase: "unknown" };
  if (message.status === "error" || artifact?.data?.videoSubmitError) return { ...base, phase: "failed" };
  if (message.taskPhase === "awaiting_input" || message.taskPhase === "awaiting_authorization" || message.taskPhase === "partial") return { ...base, phase: "awaiting_input" };
  if (message.taskPhase === "queued") return { ...base, phase: "queued" };
  const video = typeof artifact?.data?.videoJobId === "string";
  if (video) {
    const status = artifact?.data?.videoStatus;
    if (status === "failed") return { ...base, phase: "failed" };
    if (status === "uncertain") return { ...base, phase: "unknown" };
    // A submitted video has no delivered result until the server says so.
    if (status !== "completed") return { ...base, phase: status === "queued" ? "queued" : "running" };
  }
  if (message.trace?.status === "waiting_approval") return { ...base, phase: "awaiting_input" };
  if (message.trace?.status === "uncertain") return { ...base, phase: "unknown" };
  if (message.trace?.status === "failed") return { ...base, phase: "failed" };
  if (message.status === "thinking" || message.status === "typing" || message.trace?.status === "running") return { ...base, phase: "running" };
  if (message.status === "stopped" || message.trace?.status === "cancelled") return undefined;
  if (message.content || artifact) return { ...base, phase: "completed", resultToken: `${message.id}:${video ? "video-ready" : message.requestId ?? "reply"}` };
  return undefined;
}

/** Aggregate all tasks, not only the last reply: a newer text turn must not hide
 * an earlier video still running in this conversation. */
export function conversationTaskStatus(conversation: TongpinAIConversation, artifacts: readonly TongpinAIArtifact[], seenToken?: string): ConversationTaskStatus | undefined {
  const owned = new Map(artifacts.filter(a => a.conversationId === conversation.id).map(a => [a.id, a]));
  const tasks = [...conversation.messages].reverse().flatMap(message => {
    const status = messageTaskStatus(message, owned.get(message.artifactId ?? "")); return status ? [status] : [];
  });
  const active = tasks.find(task => ["running", "queued", "awaiting_input", "unknown"].includes(task.phase));
  if (active) return active;
  const latest = tasks[0];
  return latest?.phase === "completed" ? { ...latest, unread: latest.resultToken !== seenToken } : latest;
}

function browserStorage(): Storage | undefined { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } }
function validReadMarkers(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([key, token]) => /^[a-zA-Z0-9_-]{1,120}$/.test(key) && typeof token === "string" && /^[a-zA-Z0-9_-]{1,120}:[a-zA-Z0-9_-]{1,120}$/.test(token)).slice(-5000)) as Record<string, string>;
}
export function readSeenResults(accountId: string, storage: Pick<Storage, "getItem"> | undefined = browserStorage()): Record<string, string> {
  try {
    const value: unknown = JSON.parse(storage?.getItem(`tongpin.ai.seen-results.v1:${accountId}`) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return validReadMarkers(value as Record<string, unknown>);
  } catch { return {}; }
}
export function saveSeenResults(accountId: string, seen: Record<string, string>, storage: Pick<Storage, "setItem"> | undefined = browserStorage()) {
  try { storage?.setItem(`tongpin.ai.seen-results.v1:${accountId}`, JSON.stringify(validReadMarkers(seen))); } catch { /* Read markers never block a task. */ }
}
