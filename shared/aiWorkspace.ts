import type { AiMode, AiSource, AiUsage } from "./ai";

/** JSON-only workspace payload. Provider credentials and executable code never belong here. */
export type AiWorkspaceJson = null | boolean | number | string | AiWorkspaceJson[] | { [key: string]: AiWorkspaceJson };

/** Only bounded, locally compressed visual frames; never original video, audio or file paths. */
export interface AiWorkspaceMedia {
  kind: "image" | "video";
  frames: Array<{ dataUrl: string; timeSeconds?: number }>;
  durationSeconds?: number;
}

export interface AiWorkspaceDocument {
  id: string;
  name: string;
  mimeType: string;
  content: string;
  createdAt?: string;
  media?: AiWorkspaceMedia;
}

export interface AiWorkspaceMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  time: string;
  status?: "thinking" | "typing" | "ready" | "error" | "stopped";
  artifactId?: string;
  requestId?: string;
  model?: string;
  usage?: AiUsage;
  attachments?: AiWorkspaceDocument[];
  sources?: AiSource[];
}

export interface AiWorkspaceConversation {
  id: string;
  title: string;
  timeLabel: string;
  projectId?: string;
  messages: AiWorkspaceMessage[];
}

export interface AiWorkspaceProject {
  id: string;
  title: string;
  timeLabel: string;
  instructions?: string;
  contextDocuments?: AiWorkspaceDocument[];
}

export interface AiWorkspaceArtifact {
  id: string;
  conversationId: string;
  projectId?: string;
  title: string;
  kind: string;
  updatedLabel: string;
  summary: string;
  sections: Array<{ heading: string; lines: string[] }>;
  data?: { [key: string]: AiWorkspaceJson };
}

export interface AiWorkspaceState {
  view: "chat" | "project" | "skills";
  mode: AiMode;
  conversations: AiWorkspaceConversation[];
  projects: AiWorkspaceProject[];
  artifacts: AiWorkspaceArtifact[];
  drafts: Record<string, string>;
  draftAttachments?: Record<string, AiWorkspaceDocument[]>;
  composerTool?: "text" | "presentation" | "image";
  webSearch?: boolean;
  activeConversationId: string | null;
  activeProjectId: string | null;
  enabledSkillIds: string[];
  sidebarCollapsed?: boolean;
}

export interface AiWorkspaceSnapshot {
  revision: number;
  schemaVersion: 1;
  updatedAt: string | null;
  state: AiWorkspaceState | null;
}

export interface AiWorkspaceSaveRequest {
  expectedRevision: number;
  mutationId: string;
  state: AiWorkspaceState;
}

/** Rejections never truncate a snapshot or silently remove older conversations. */
export const AI_WORKSPACE_LIMITS = {
  stateBytes: 2 * 1024 * 1024,
  requestBytes: 2 * 1024 * 1024 + 4096,
  projects: 100,
  conversations: 500,
  messagesPerConversation: 500,
  totalMessages: 5000,
  messageCharacters: 128000,
  artifacts: 500,
  documentsPerContainer: 20,
  documentCharacters: 100000,
  draftCharacters: 24000,
  titleCharacters: 200,
  instructionsCharacters: 24000,
} as const;
