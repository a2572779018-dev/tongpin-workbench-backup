import type { AiWorkspaceArtifact, AiWorkspaceDocument, AiWorkspaceMessage, AiWorkspaceProject, AiWorkspaceState } from "./aiWorkspace";

export interface AiWorkspaceV2DirectoryItem {
  entityId: string;
  title: string;
  timeLabel: string;
  projectId?: string;
  ordinal: number;
  revision: number;
}
export type AiWorkspaceV2Bootstrap = { schemaVersion: 1 } | {
  schemaVersion: 2;
  epoch: number;
  manifestRevision: number;
  manifest: { base: Omit<AiWorkspaceState, "conversations" | "projects" | "artifacts" | "drafts" | "draftAttachments" | "videoDraftSettings">;
    hasDraftAttachments: boolean; hasVideoDraftSettings: boolean };
  conversations: AiWorkspaceV2DirectoryItem[];
  projects: AiWorkspaceV2DirectoryItem[];
};
export interface AiWorkspaceV2MessagePage { epoch: number; revision: number; messages: AiWorkspaceMessage[]; hasMore: boolean; nextBefore: string | null }
export interface AiWorkspaceV2Entity<T> { kind: string; entityId: string; revision: number; ordinal: number; deleted: boolean; value: T }
export interface AiWorkspaceV2Context { epoch: number; conversation: AiWorkspaceV2DirectoryItem; draft: AiWorkspaceV2Entity<string> | null;
  draftAttachment: AiWorkspaceV2Entity<AiWorkspaceDocument[]> | null; project: AiWorkspaceV2Entity<AiWorkspaceProject> | null }
export interface AiWorkspaceV2ArtifactResponse { epoch: number; artifact: AiWorkspaceArtifact }
export interface AiWorkspaceV2WriteAck { epoch: number; entities: Array<{ kind: string; entityId: string; revision: number; deleted: boolean }> }
export interface AiWorkspaceV2AppendAck { epoch: number; entityId: string; revision: number; messageIds: string[] }
