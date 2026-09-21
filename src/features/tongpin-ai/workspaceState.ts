import type {
  TongpinAIArtifact,
  TongpinAIConversation,
  TongpinAIMode,
  TongpinAIProject,
  TongpinAIWorkspaceView,
} from "./types";
import type { AiWorkspaceDocument, AiWorkspaceState } from "../../../shared/aiWorkspace";

export interface TongpinAIWorkspaceSession {
  view: TongpinAIWorkspaceView;
  mode: TongpinAIMode;
  conversations: TongpinAIConversation[];
  projects: TongpinAIProject[];
  artifacts: TongpinAIArtifact[];
  drafts: Record<string, string>;
  activeConversationId: string | null;
  activeProjectId: string | null;
  enabledSkillIds: Set<string>;
  sidebarCollapsed?: boolean;
  draftAttachments?: Record<string, AiWorkspaceDocument[]>;
  composerTool?: "text" | "presentation" | "image";
  webSearch?: boolean;
}

// Account-scoped memory survives navigation but is cleared when the renderer reloads.
// The existing desktop vault only accepts relationship graph documents.
const workspaceSessions = new Map<string, TongpinAIWorkspaceSession>();

export function loadWorkspaceSession(
  userId: string,
): TongpinAIWorkspaceSession {
  return (
    workspaceSessions.get(userId) ?? {
      view: "chat",
      mode: "quick",
      conversations: [],
      projects: [],
      artifacts: [],
      drafts: {},
      activeConversationId: null,
      activeProjectId: null,
      enabledSkillIds: new Set(),
    }
  );
}

export function saveWorkspaceSession(
  userId: string,
  session: TongpinAIWorkspaceSession,
) {
  workspaceSessions.set(userId, session);
}

export function serializeWorkspace(session: TongpinAIWorkspaceSession): AiWorkspaceState {
  const { draftAttachments: _sessionDraftAttachments, ...sessionWithoutDraftAttachments } = session;
  const drafts = Object.fromEntries(
    Object.entries(session.drafts).filter(([, value]) => value.length > 0),
  );
  const draftAttachments = session.draftAttachments
    ? Object.fromEntries(Object.entries(session.draftAttachments).filter(([, value]) => value.length > 0))
    : undefined;
  return {
    ...sessionWithoutDraftAttachments,
    drafts,
    ...(draftAttachments && Object.keys(draftAttachments).length ? { draftAttachments } : {}),
    enabledSkillIds: [...session.enabledSkillIds].sort(),
  };
}

export function hydrateWorkspace(state: AiWorkspaceState | null): TongpinAIWorkspaceSession {
  return state ? { ...state, enabledSkillIds: new Set(state.enabledSkillIds) } : {
    view: "chat", mode: "quick", conversations: [], projects: [], artifacts: [], drafts: {},
    activeConversationId: null, activeProjectId: null, enabledSkillIds: new Set(),
  };
}

export const AI_SERVICE_UNAVAILABLE_MESSAGE =
  "AI 服务尚未连接，暂时无法回复。你的消息已保留，本次未消耗额度。";

interface UnavailableMessageInput {
  conversations: TongpinAIConversation[];
  activeConversationId: string | null;
  projectId?: string;
  content: string;
  conversationId: string;
  userMessageId: string;
  responseMessageId: string;
  time: string;
}

/** Keep the user's turn when no provider is configured; never fabricate output or usage. */
export function submitUnavailableMessage(input: UnavailableMessageInput) {
  const content = input.content.trim();
  if (!content) return null;
  const existing = input.conversations.find(
    (conversation) => conversation.id === input.activeConversationId,
  );
  const conversation: TongpinAIConversation = {
    ...(existing ?? {
      id: input.conversationId,
      projectId: input.projectId,
      title: Array.from(content.split("\n")[0]).slice(0, 28).join(""),
      messages: [],
    }),
    timeLabel: "刚刚",
    messages: [
      ...(existing?.messages ?? []),
      { id: input.userMessageId, role: "user", content, time: input.time },
      {
        id: input.responseMessageId,
        role: "assistant",
        content: AI_SERVICE_UNAVAILABLE_MESSAGE,
        time: input.time,
        status: "error",
      },
    ],
  };
  return {
    conversationId: conversation.id,
    conversations: [
      conversation,
      ...input.conversations.filter((item) => item.id !== conversation.id),
    ],
  };
}

export function moveConversationToProject(
  conversations: TongpinAIConversation[],
  projects: TongpinAIProject[],
  conversationId: string,
  projectId?: string,
) {
  if (projectId && !projects.some((project) => project.id === projectId))
    return conversations;
  return conversations.map((conversation) =>
    conversation.id === conversationId
      ? { ...conversation, projectId }
      : conversation,
  );
}
