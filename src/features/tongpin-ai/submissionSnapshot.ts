import type { AiWorkspaceDocument, AiWorkspaceState } from "../../../shared/aiWorkspace";
import type { TongpinAIConversation, TongpinAIMode, TongpinAIProject } from "./types";

/** Owned by a submitted turn, never by the currently focused composer. */
export interface SubmissionSnapshot {
  conversationId: string;
  draftKey: string;
  conversation: TongpinAIConversation | null;
  project: TongpinAIProject | null;
  attachments: AiWorkspaceDocument[];
  mode: TongpinAIMode;
  skillIds: string[];
  webSearch: boolean;
}

export function captureSubmission(input: SubmissionSnapshot): SubmissionSnapshot {
  return structuredClone(input);
}

/** A background continuation may only replace its existing owner's messages.
 * In particular it must not restore a pre-await workspace or navigate to A. */
export function mergeContinuation(latest: AiWorkspaceState, conversation: TongpinAIConversation): AiWorkspaceState {
  if (!latest.conversations.some(item => item.id === conversation.id)) return latest;
  return { ...latest, conversations: latest.conversations.map(item => item.id === conversation.id ? conversation : item) };
}
