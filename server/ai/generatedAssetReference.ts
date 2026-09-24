import type { AiImageAsset } from "../../shared/ai";
import type { AiWorkspaceArtifact, AiWorkspaceConversation } from "../../shared/aiWorkspace";
import { aiVideoReferenceFingerprint, AI_VIDEO_REFERENCE_FINGERPRINT } from "../../shared/aiVideoReferences";
import { validateImageBase64 } from "./capabilities";
import { AiError } from "./security";
import type { AiStore } from "./storage";
import { AiWorkspaceRepository, validateAiWorkspaceArtifactEntity, validateAiWorkspaceConversationEntity } from "./workspace";
import { currentWorkspaceVersion } from "./workspaceCurrentReads";
import { AiWorkspaceV2Store } from "./workspaceV2Store";

export interface GeneratedAssetReferenceBinding {
  assetId: string;
  conversationId: string;
  /** Hash of the original stored image, not of the client's normalized JPEG. */
  sourceFingerprint: string;
}

export interface GeneratedAssetReferenceSource extends AiImageAsset {
  conversationId: string;
  sourceFingerprint: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

function sourceIds(value: unknown): { assetId: string; conversationId: string; sourceFingerprint?: unknown } {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (typeof input.assetId !== "string" || !UUID.test(input.assetId)
    || typeof input.conversationId !== "string" || !CONVERSATION_ID.test(input.conversationId)) {
    throw new AiError(400, "AI_GENERATED_REFERENCE_INVALID", "请选择当前对话中已生成的图片作为视频参考");
  }
  return { assetId: input.assetId, conversationId: input.conversationId, sourceFingerprint: input.sourceFingerprint };
}

/**
 * Resolve only an explicitly selected, persisted image artifact attached to an
 * assistant message in this account's source conversation. An arbitrary asset
 * URL, a client-only artifact, or ownership of another conversation is not a
 * reference grant. No network/provider requests or quota reservations occur.
 *
 * PNG/WebP bytes remain honestly typed. The client must decode and normalize
 * them to a bounded JPEG before upload; the source hash survives that operation.
 */
export async function readGeneratedAssetReference(store: AiStore, userId: string, value: unknown): Promise<GeneratedAssetReferenceSource> {
  store.assertAccess(userId);
  const { assetId, conversationId } = sourceIds(value);
  const notFound = (): never => { throw new AiError(404, "AI_GENERATED_REFERENCE_NOT_FOUND", "该图片不在当前对话中、尚未同步或已删除，请重新选择参考图片"); };
  let conversation: AiWorkspaceConversation | undefined;
  let artifacts: AiWorkspaceArtifact[];
  if (currentWorkspaceVersion(store, userId) === 1) {
    const state = new AiWorkspaceRepository(store.sql).read(userId, store.tenantId).state;
    conversation = state?.conversations.find(item => item.id === conversationId);
    artifacts = state?.artifacts ?? [];
  } else {
    const workspace = new AiWorkspaceRepository(store.sql);
    const v2 = new AiWorkspaceV2Store(store.sql, workspace);
    const source = await v2.readActiveImageSourceEntities(userId, conversationId, assetId, store.tenantId);
    if (!source) return notFound();
    const [conversationEntity, artifactEntity] = source.batch.entities;
    if (!conversationEntity || conversationEntity.deleted || !artifactEntity || artifactEntity.deleted) return notFound();
    let artifact: AiWorkspaceArtifact;
    try {
      conversation = validateAiWorkspaceConversationEntity(conversationEntity.value);
      artifact = validateAiWorkspaceArtifactEntity(artifactEntity.value);
    } catch { throw new AiError(500, "AI_WORKSPACE_CORRUPT", "图片来源记录未通过校验，请联系管理员"); }
    if (conversation.id !== conversationId || artifact.id !== source.artifactId || artifact.conversationId !== conversationId ||
      artifact.projectId !== conversation.projectId) return notFound();
    artifacts = [artifact];
  }
  if (!conversation) return notFound();
  const attached = new Set(conversation.messages.filter(message => message.role === "assistant" && message.artifactId).map(message => message.artifactId));
  const hasImage = artifacts.some(artifact => artifact.conversationId === conversationId && (artifact.kind === "图片" || artifact.kind === "image") && attached.has(artifact.id)
    && Array.isArray(artifact.data?.images) && artifact.data.images.some(image => image !== null && typeof image === "object" && !Array.isArray(image) && image.assetId === assetId && !image.deleted));
  if (!hasImage) return notFound();
  const asset = store.asset(userId, assetId);
  if (!asset) return notFound();
  const verified = validateImageBase64(asset.base64);
  if (verified.mimeType !== asset.mimeType) throw new AiError(409, "AI_GENERATED_REFERENCE_INVALID", "原图片格式与记录不一致，请重新选择参考图片");
  const sourceFingerprint = await aiVideoReferenceFingerprint(`data:${asset.mimeType};base64,${asset.base64}`);
  return { ...asset, conversationId, sourceFingerprint };
}

/** Re-check source ownership/content at upload and before a paid video submit. */
export async function validateGeneratedAssetReferenceBinding(store: AiStore, userId: string, value: unknown, targetConversationId?: string): Promise<GeneratedAssetReferenceBinding> {
  const input = sourceIds(value);
  if (typeof input.sourceFingerprint !== "string" || !AI_VIDEO_REFERENCE_FINGERPRINT.test(input.sourceFingerprint)) {
    throw new AiError(400, "AI_GENERATED_REFERENCE_INVALID", "原图片校验信息不完整，请重新选择参考图片");
  }
  if (targetConversationId !== undefined && input.conversationId !== targetConversationId) {
    throw new AiError(409, "AI_GENERATED_REFERENCE_CONVERSATION", "参考图片来自其他对话，请在原对话中继续生成视频");
  }
  const source = await readGeneratedAssetReference(store, userId, input);
  if (source.sourceFingerprint !== input.sourceFingerprint) throw new AiError(409, "AI_GENERATED_REFERENCE_CHANGED", "原图片内容已经改变，请重新选择参考图片");
  return { assetId: input.assetId, conversationId: input.conversationId, sourceFingerprint: input.sourceFingerprint };
}

/** A source PNG may not be disguised as JPEG, nor silently dropped from video. */
export function assertGeneratedReferenceJpeg(dataUrl: string): void {
  try {
    if (!dataUrl.startsWith("data:image/jpeg;base64,") || validateImageBase64(dataUrl.slice("data:image/jpeg;base64,".length), 300000, 400).mimeType !== "image/jpeg") throw new Error("not JPEG");
  } catch {
    throw new AiError(400, "AI_VIDEO_IMAGE_INVALID", "参考图片尚未正确转换为 JPEG，请重新选择图片");
  }
}
