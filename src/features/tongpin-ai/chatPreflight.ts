import type { AiChatPreflight } from "../../../shared/ai";
import type { AiWorkspaceConversation, AiWorkspaceState } from "../../../shared/aiWorkspace";
import { quotaRemainingSummary } from "./quotaFormatting";

// Reference/primitive comparison keeps draft checks cheap, even with large files.
export function sameSendContext(left: readonly unknown[], right: readonly unknown[]) {
  return left.length === right.length && left.every((value, index) => Object.is(value, right[index]));
}

export interface ChatPreflightTicket {
  controller: AbortController;
  context: readonly unknown[];
}

/** A synchronous lock: stale responses/finally blocks cannot own a later send. */
export class ChatPreflightGate {
  private pending: ChatPreflightTicket | null = null;
  get busy() { return this.pending !== null; }
  start(context: readonly unknown[]): ChatPreflightTicket | null {
    if (this.pending) return null;
    return this.pending = { controller: new AbortController(), context };
  }
  isCurrent(ticket: ChatPreflightTicket, context: readonly unknown[]) {
    return this.pending === ticket && !ticket.controller.signal.aborted && sameSendContext(ticket.context, context);
  }
  finish(ticket: ChatPreflightTicket) {
    if (this.pending !== ticket) return false;
    this.pending = null;
    return true;
  }
  cancel() {
    const pending = this.pending;
    this.pending = null;
    pending?.controller.abort();
    return Boolean(pending);
  }
  cancelIfChanged(context: readonly unknown[]) {
    return this.pending && !sameSendContext(this.pending.context, context) ? this.cancel() : false;
  }
}

/** Merge after the check, preserving changes outside the submitted conversation. */
export function withPreparedChatSend(latest: AiWorkspaceState, conversation: AiWorkspaceConversation, draftKey: string): AiWorkspaceState {
  const drafts = { ...latest.drafts };
  const draftAttachments = { ...latest.draftAttachments };
  // Missing and empty drafts hydrate identically. Removing the consumed entries
  // avoids accumulating thousands of empty keys and never deletes conversation data.
  delete drafts[draftKey];
  delete draftAttachments[draftKey];
  return {
    ...latest,
    conversations: [conversation, ...latest.conversations.filter(item => item.id !== conversation.id)],
    activeConversationId: conversation.id,
    view: "chat",
    drafts,
    draftAttachments,
  };
}

export function preflightNotice(result: AiChatPreflight) {
  const remaining = quotaRemainingSummary(result.quota).label;
  if (result.reason === "request_in_progress") return {
    title: "还有一条请求正在处理",
    message: `${remaining}，已扣除处理中预留。请等待上次请求完成后重试。本次未发送、未扣费。`,
    canDisableSearch: false,
  };
  if (result.reason === "quota_exhausted") return {
    title: "可用额度已用完",
    message: `${remaining}。${result.quota.reservedTokens > 0 ? "有任务正在预留同频点，请等待结算后重试。" : "请联系管理员追加同频点。"}本次未发送，草稿已保留。`,
    canDisableSearch: false,
  };
  return {
    title: result.reason === "search_quota_insufficient" ? "余额尚有，但不足以启动本次联网搜索" : "本次对话所需额度超过余额",
    message: `${remaining}，不足以预留本次请求所需的同频点。预留包含输入、回复${result.budget.searchInputReserve > 0 ? "和搜索内容" : ""}，不是实际扣费。本次未发送，草稿已保留。`,
    canDisableSearch: result.reason === "search_quota_insufficient" && result.withoutWebSearch?.canSend === true,
  };
}
