import { AI_WORKSPACE_LIMITS, type AiWorkspaceState, type AiWorkspaceStorageUsage } from "../../../shared/aiWorkspace";

export type WorkspaceStorageLevel = "normal" | "warning" | "critical";

/** Warning/critical thresholds are shares of the whole-account V1 snapshot cap. */
export const WORKSPACE_STORAGE_WARNING_RATIO = 0.7;
export const WORKSPACE_STORAGE_CRITICAL_RATIO = 0.9;

const MEGABYTE = 1024 * 1024;
const utf8Length = (text: string) => new TextEncoder().encode(text).length;

/** Accept only a well-formed, finite usage object; older servers omit it entirely. */
export function workspaceStorageFrom(value: unknown): AiWorkspaceStorageUsage | null {
  if (!value || typeof value !== "object") return null;
  const { usedBytes, limitBytes } = value as Record<string, unknown>;
  if (typeof usedBytes !== "number" || typeof limitBytes !== "number") return null;
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || usedBytes < 0 || limitBytes <= 0) return null;
  return { usedBytes, limitBytes };
}

export function workspaceStorageLevel(storage: AiWorkspaceStorageUsage): WorkspaceStorageLevel {
  const ratio = storage.usedBytes / storage.limitBytes;
  if (ratio >= WORKSPACE_STORAGE_CRITICAL_RATIO) return "critical";
  if (ratio >= WORKSPACE_STORAGE_WARNING_RATIO) return "warning";
  return "normal";
}

/** One decimal, binary megabytes (the limit is exactly 8 × 1024 × 1024 bytes). */
export function formatWorkspaceMegabytes(bytes: number): string {
  const value = Math.max(0, bytes) / MEGABYTE;
  if (value > 0 && value < 0.1) return "0.1";
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
}

export function workspaceStorageLabel(storage: AiWorkspaceStorageUsage): string {
  return `云端资料 ${formatWorkspaceMegabytes(storage.usedBytes)} / ${formatWorkspaceMegabytes(storage.limitBytes)} MB`;
}

export function workspaceStoragePercent(storage: AiWorkspaceStorageUsage): number {
  return Math.min(100, Math.max(0, Math.round((storage.usedBytes / storage.limitBytes) * 100)));
}

/**
 * Plain wording, verified against storage: generated images live in the separate
 * image asset store and generated videos are fetched from the video job service,
 * so only their small reference IDs sit in this snapshot. Uploaded attachments
 * (document text, image and sampled video frames) are stored inside it.
 */
export function workspaceStorageHint(level: WorkspaceStorageLevel): string {
  if (level === "critical") return "空间快满了，新对话可能无法保存。请删除不需要的旧对话，或删掉带大附件的对话（上传的图片、视频截图、文档都算在内）。AI 生成的图片和视频另外存放，不占这里的空间。";
  if (level === "warning") return "空间已用七成以上。建议先导出备份，再删除不需要的旧对话或大附件。AI 生成的图片和视频另外存放，不占这里的空间。";
  return "保存对话、上传的附件和成果文字。AI 生成的图片和视频另外存放，不计入这里。";
}

export interface WorkspaceConversationSize {
  id: string;
  title: string;
  bytes: number;
  messageCount: number;
  attachmentCount: number;
}

type SizeState = Pick<AiWorkspaceState, "conversations" | "artifacts" | "drafts" | "draftAttachments" | "videoDraftSettings">;

/**
 * Approximate serialized bytes each conversation contributes to the snapshot:
 * the conversation itself, its artifacts, and its draft text/attachments/settings.
 * Computed on demand only; never during ordinary rendering.
 */
export function workspaceConversationSizes(state: SizeState): WorkspaceConversationSize[] {
  const artifactBytes = new Map<string, number>();
  for (const artifact of state.artifacts) {
    artifactBytes.set(artifact.conversationId, (artifactBytes.get(artifact.conversationId) ?? 0) + utf8Length(JSON.stringify(artifact)) + 1);
  }
  return state.conversations.map(conversation => {
    const draft = state.drafts[conversation.id];
    const draftAttachments = state.draftAttachments?.[conversation.id];
    const videoDraft = state.videoDraftSettings?.[conversation.id];
    const bytes = utf8Length(JSON.stringify(conversation)) + 1
      + (artifactBytes.get(conversation.id) ?? 0)
      + (draft === undefined ? 0 : utf8Length(JSON.stringify(draft)))
      + (draftAttachments === undefined ? 0 : utf8Length(JSON.stringify(draftAttachments)))
      + (videoDraft === undefined ? 0 : utf8Length(JSON.stringify(videoDraft)));
    const attachmentCount = conversation.messages.reduce((total, message) => total + (message.attachments?.length ?? 0), 0)
      + (draftAttachments?.length ?? 0);
    return { id: conversation.id, title: conversation.title, bytes, messageCount: conversation.messages.length, attachmentCount };
  });
}

export function largestWorkspaceConversations(state: SizeState, count = 5): WorkspaceConversationSize[] {
  return workspaceConversationSizes(state)
    .sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title, "zh-CN"))
    .slice(0, Math.max(0, count));
}

/** Local estimate for when the server has not reported usage (e.g. before the first save response). */
export function estimateWorkspaceStorage(state: unknown): AiWorkspaceStorageUsage {
  return { usedBytes: state ? utf8Length(JSON.stringify(state)) : 0, limitBytes: AI_WORKSPACE_LIMITS.stateBytes };
}

/** A self-contained single-conversation backup (conversation + its artifacts + drafts). */
export function conversationExportJson(state: SizeState, conversationId: string): string | null {
  const conversation = state.conversations.find(item => item.id === conversationId);
  if (!conversation) return null;
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    conversation,
    artifacts: state.artifacts.filter(item => item.conversationId === conversationId),
    draft: state.drafts[conversationId] ?? null,
    draftAttachments: state.draftAttachments?.[conversationId] ?? [],
  }, null, 2);
}

export function conversationExportFilename(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 60) || "对话";
  return `同频-AI-对话-${safe}.json`;
}

export function isWorkspaceSpaceRejection(code: string | undefined): boolean {
  return code === "AI_WORKSPACE_TOO_LARGE" || code === "PAYLOAD_TOO_LARGE";
}
