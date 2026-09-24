import { aiVideoReferenceFingerprint, AI_VIDEO_REFERENCE_FINGERPRINT } from "../../shared/aiVideoReferences";
import type { AiWorkspaceDocument } from "../../shared/aiWorkspace";
import { AiError } from "./security";
import type { AiStore } from "./storage";
import { readCurrentConversation } from "./workspaceCurrentReads";

export interface SourceVideoReferenceBinding {
  conversationId: string;
  documentId: string;
  name: string;
  timeSeconds: number;
  /** Fingerprint of the persisted, explicitly selected sample frame. */
  frameFingerprint: string;
}

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
function sourceInput(value: unknown): Omit<SourceVideoReferenceBinding, "frameFingerprint"> & { frameFingerprint?: unknown } {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (typeof raw.conversationId !== "string" || !ID.test(raw.conversationId)
    || typeof raw.documentId !== "string" || !ID.test(raw.documentId)
    || typeof raw.name !== "string" || !raw.name || raw.name.length > 240
    || typeof raw.timeSeconds !== "number" || !Number.isFinite(raw.timeSeconds) || raw.timeSeconds < 0) {
    throw new AiError(400, "AI_VIDEO_SOURCE_INVALID", "视频来源或所选画面无效，请重新选择参考帧");
  }
  return {
    conversationId: raw.conversationId,
    documentId: raw.documentId,
    name: raw.name,
    timeSeconds: raw.timeSeconds,
    frameFingerprint: raw.frameFingerprint,
  };
}

async function originalVideoDocument(store: AiStore, userId: string, source: ReturnType<typeof sourceInput>): Promise<AiWorkspaceDocument> {
  const conversation = (await readCurrentConversation(store, userId, source.conversationId))?.conversation;
  const matches = conversation?.messages
    .filter(message => message.role === "user")
    .flatMap(message => message.attachments ?? [])
    .filter(document => document.id === source.documentId) ?? [];
  if (matches.length !== 1 || matches[0].media?.kind !== "video" || !/^video\/(?:mp4|webm|quicktime|x-m4v)$/.test(matches[0].mimeType) || matches[0].name !== source.name) {
    throw new AiError(404, "AI_VIDEO_SOURCE_NOT_FOUND", "原视频不在当前对话中或已删除，请重新选择参考帧");
  }
  return matches[0];
}

async function selectedFrame(store: AiStore, userId: string, source: ReturnType<typeof sourceInput>) {
  const document = await originalVideoDocument(store, userId, source);
  const index = document.media?.selectedFrameIndex;
  const frame = Number.isInteger(index) && Number(index) >= 0 ? document.media?.frames[Number(index)] : undefined;
  if (!frame || frame.timeSeconds !== source.timeSeconds || !frame.dataUrl.startsWith("data:image/jpeg;base64,")) {
    throw new AiError(409, "AI_VIDEO_SOURCE_CHANGED", "原视频的参考帧已改变，请重新选择并整理视频任务");
  }
  return { frameFingerprint: await aiVideoReferenceFingerprint(frame.dataUrl), dataUrl: frame.dataUrl };
}

/** A reference to a local video is accepted only if the exact chosen sample is
 * already saved as a user attachment in this account's source conversation.
 * No full video or audio bytes are represented by this static sample.
 */
export async function bindSourceVideoReference(store: AiStore, userId: string, value: unknown, uploadedDataUrl: string): Promise<SourceVideoReferenceBinding> {
  const source = sourceInput(value);
  const frame = await selectedFrame(store, userId, source);
  const uploadedFingerprint = await aiVideoReferenceFingerprint(uploadedDataUrl);
  if (uploadedFingerprint !== frame.frameFingerprint) {
    throw new AiError(409, "AI_VIDEO_SOURCE_CHANGED", "上传的参考图与原视频所选画面不一致，请重新选择参考帧");
  }
  return { conversationId: source.conversationId, documentId: source.documentId, name: source.name, timeSeconds: source.timeSeconds, frameFingerprint: frame.frameFingerprint };
}

/** Repeat the same ownership, selection and content checks before a paid submit. */
export async function validateSourceVideoReferenceBinding(store: AiStore, userId: string, value: unknown, targetConversationId: string): Promise<SourceVideoReferenceBinding> {
  const source = sourceInput(value);
  if (source.conversationId !== targetConversationId) {
    throw new AiError(409, "AI_VIDEO_SOURCE_CONVERSATION", "参考画面来自其他对话，请在原对话中继续生成视频");
  }
  if (typeof source.frameFingerprint !== "string" || !AI_VIDEO_REFERENCE_FINGERPRINT.test(source.frameFingerprint)) {
    throw new AiError(400, "AI_VIDEO_SOURCE_INVALID", "参考画面的校验信息不完整，请重新选择");
  }
  const frame = await selectedFrame(store, userId, source);
  if (frame.frameFingerprint !== source.frameFingerprint) {
    throw new AiError(409, "AI_VIDEO_SOURCE_CHANGED", "原视频的参考画面已改变，请重新选择并整理视频任务");
  }
  return { conversationId: source.conversationId, documentId: source.documentId, name: source.name, timeSeconds: source.timeSeconds, frameFingerprint: source.frameFingerprint };
}
