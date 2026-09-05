import type { TongpinAIWorkspaceSession } from "./workspaceState";

export type ConversationOperationState = Pick<TongpinAIWorkspaceSession,
  "conversations" | "projects" | "artifacts" | "drafts" | "draftAttachments" |
  "activeConversationId" | "activeProjectId" | "view">;

/** Resolve again after awaits: a rendered callback may refer to a deleted target. */
export function liveConversation(
  state: Pick<ConversationOperationState, "conversations">,
  deleting: ReadonlySet<string>,
  conversationId: string,
  messageId?: string,
) {
  if (deleting.has(conversationId)) return undefined;
  const conversation = state.conversations.find(item => item.id === conversationId);
  return conversation && (!messageId || conversation.messages.some(message => message.id === messageId))
    ? conversation : undefined;
}

/** Apply deletion to the latest selection, never the selection captured before I/O. */
export function withoutConversation<T extends ConversationOperationState>(state: T, conversationId: string): T {
  const conversation = state.conversations.find(item => item.id === conversationId);
  if (!conversation) return state;
  const drafts = { ...state.drafts };
  const draftAttachments = { ...state.draftAttachments };
  delete drafts[conversationId];
  delete draftAttachments[conversationId];
  const selected = state.activeConversationId === conversationId;
  const projectId = conversation.projectId && state.projects.some(project => project.id === conversation.projectId)
    ? conversation.projectId : null;
  return {
    ...state,
    conversations: state.conversations.filter(item => item.id !== conversationId),
    artifacts: state.artifacts.filter(item => item.conversationId !== conversationId),
    drafts,
    draftAttachments,
    ...(selected ? {
      activeConversationId: null,
      activeProjectId: projectId,
      view: state.view === "skills" ? "skills" : projectId ? "project" : "chat",
    } : {}),
  };
}
