import type { AiWorkspaceArtifact, AiWorkspaceDocument, AiWorkspaceMessage } from "../../../shared/aiWorkspace";
import type { AiWorkspaceV2AppendAck, AiWorkspaceV2ArtifactResponse, AiWorkspaceV2Bootstrap, AiWorkspaceV2Context, AiWorkspaceV2MessagePage, AiWorkspaceV2WriteAck } from "../../../shared/aiWorkspaceV2";

export type WorkspaceV2Api = <T>(path: string, init?: RequestInit, timeoutMs?: number) => Promise<T>;
const ROOT = "/api/ai/workspace-v2";

/** The V2 browser boundary has no whole-account read or write method. */
export function workspaceV2Client(api: WorkspaceV2Api, accountId: string) {
  const headers = { "X-Tongpin-Account": accountId };
  const post = <T>(path: string, value: unknown) => api<T>(`${ROOT}${path}`, {
    method: "POST", headers, body: JSON.stringify(value),
  }, 30_000);
  return {
    bootstrap: () => api<AiWorkspaceV2Bootstrap>(`${ROOT}/bootstrap`, { headers }, 30_000),
    context: (conversationId: string) => api<AiWorkspaceV2Context>(`${ROOT}/conversations/${encodeURIComponent(conversationId)}/context`, { headers }, 30_000),
    messages: (conversationId: string, before?: string | null) => api<AiWorkspaceV2MessagePage>(
      `${ROOT}/conversations/${encodeURIComponent(conversationId)}/messages?limit=30${before ? `&before=${encodeURIComponent(before)}` : ""}`,
      { headers }, 30_000),
    artifact: (artifactId: string, conversationId: string) => api<AiWorkspaceV2ArtifactResponse>(
      `${ROOT}/artifacts/${encodeURIComponent(artifactId)}?conversationId=${encodeURIComponent(conversationId)}`, { headers }, 30_000),
    mutate: (epoch: number, ops: Array<{ kind: "conversation" | "draft" | "draftAttachment" | "manifest"; entityId: string; expectedRevision: number; action: "put" | "delete"; value?: unknown }>, mutationId = crypto.randomUUID()) =>
      post<AiWorkspaceV2WriteAck>("/mutate", { epoch, mutationId, ops }),
    rename: (epoch: number, conversationId: string, expectedRevision: number, title: string, mutationId = crypto.randomUUID()) =>
      post<AiWorkspaceV2WriteAck>("/rename-conversation", { epoch, mutationId, conversationId, expectedRevision, title }),
    appendUser: (epoch: number, conversationId: string, expectedRevision: number, message: AiWorkspaceMessage, mutationId = crypto.randomUUID()) =>
      post<AiWorkspaceV2AppendAck>("/append-user", { epoch, mutationId, conversationId, expectedRevision, message }),
    commitAssistant: (epoch: number, conversationId: string, expectedRevision: number, requestId: string, messageId: string, mutationId = crypto.randomUUID()) =>
      post<AiWorkspaceV2AppendAck>("/commit-assistant", { epoch, mutationId, conversationId, expectedRevision, requestId, messageId }),
    saveDraft: (epoch: number, conversationId: string, revision: number, draft: string, mutationId = crypto.randomUUID()) =>
      post<AiWorkspaceV2WriteAck>("/mutate", { epoch, mutationId, ops: [{ kind: "draft", entityId: conversationId, expectedRevision: revision, action: "put", value: draft }] }),
    saveDraftAttachments: (epoch: number, conversationId: string, revision: number, attachments: AiWorkspaceDocument[], mutationId = crypto.randomUUID()) =>
      post<AiWorkspaceV2WriteAck>("/mutate", { epoch, mutationId, ops: [{ kind: "draftAttachment", entityId: conversationId, expectedRevision: revision, action: "put", value: attachments }] }),
    readArtifact: async (artifactId: string, conversationId: string): Promise<AiWorkspaceArtifact> =>
      (await api<AiWorkspaceV2ArtifactResponse>(`${ROOT}/artifacts/${encodeURIComponent(artifactId)}?conversationId=${encodeURIComponent(conversationId)}`, { headers }, 30_000)).artifact,
  };
}
