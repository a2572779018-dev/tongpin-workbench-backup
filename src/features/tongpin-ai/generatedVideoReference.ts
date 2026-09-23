import { AI_MEDIA_LIMITS } from "../../../shared/aiMedia";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
import type { ExtractedAttachment } from "./attachments";
import type { VideoChatRequest } from "./videoChat";
import { generatedMediaForFollowup } from "./generatedMediaContext";

type Api = <T>(path: string, init?: RequestInit) => Promise<T>;
export type VideoReferenceImage = NonNullable<VideoChatRequest["referenceImages"]>[number];

export interface GeneratedImageCandidates { sourceArtifactId: string; assetIds: string[] }

/** The source must be a visible result in this conversation, not the account's
 * global latest asset or an arbitrary ID supplied by workspace JSON. */
export function generatedVideoReferenceCandidates(conversation: TongpinAIConversation | null, artifacts: TongpinAIArtifact[], prompt: string): GeneratedImageCandidates | undefined {
  const artifact = generatedMediaForFollowup(conversation, artifacts, prompt);
  if (!artifact || artifact.kind !== "图片" || !Array.isArray(artifact.data?.images)) return undefined;
  const assetIds = [...new Set(artifact.data.images.flatMap(item => item && typeof item === "object" && !Array.isArray(item) && !item.deleted && typeof item.assetId === "string" && /^[A-Za-z0-9_-]{8,160}$/.test(item.assetId) ? [item.assetId] : []))];
  return { sourceArtifactId: artifact.id, assetIds };
}

function exactSelectedImage(conversation: TongpinAIConversation, artifacts: TongpinAIArtifact[], selected: { sourceArtifactId: string; assetId: string }): string {
  const source = artifacts.find(item => item.id === selected.sourceArtifactId && item.conversationId === conversation.id && item.kind === "图片"
    && conversation.messages.some(message => message.role === "assistant" && message.artifactId === item.id));
  if (!source || !Array.isArray(source.data?.images) || !source.data.images.some(item => item && typeof item === "object" && !Array.isArray(item) && !item.deleted && item.assetId === selected.assetId)) {
    throw new Error("选中的图片已删除或不属于这段对话，本次未提交视频生成。");
  }
  return selected.assetId;
}

/** Authorize the original asset in this exact conversation before decoding it.
 * This is source preparation, not video generation or a paid model request. */
export async function generatedVideoReference(conversation: TongpinAIConversation, artifacts: TongpinAIArtifact[], prompt: string, api: Api, accountId: string, signal: AbortSignal,
  extract: (file: File, signal?: AbortSignal) => Promise<ExtractedAttachment>,
  selected?: { sourceArtifactId: string; assetId: string }): Promise<VideoReferenceImage | undefined> {
  const candidates = selected ? undefined : generatedVideoReferenceCandidates(conversation, artifacts, prompt);
  if (!selected && !candidates) return undefined;
  const assetId = selected ? exactSelectedImage(conversation, artifacts, selected) : candidates!.assetIds.length === 1 ? candidates!.assetIds[0] : undefined;
  if (!assetId) throw Error(candidates?.assetIds.length ? "这条成果有多张图片，请先选择要沿用的参考图。草稿已保留。" : "原图片没有可验证的资产标识，请重新选择参考图。草稿已保留。");
  const source = await api<{ assetId: string; conversationId: string; mimeType: string; base64: string; sourceFingerprint: string }>("/api/ai/video-references/generated-asset", {
    method: "POST", headers: { "X-Tongpin-Account": accountId }, body: JSON.stringify({ conversationId: conversation.id, assetId }), signal,
  });
  signal.throwIfAborted();
  if (source.assetId !== assetId || source.conversationId !== conversation.id || !["image/png", "image/jpeg", "image/webp"].includes(source.mimeType) || !source.sourceFingerprint || source.base64.length > AI_MEDIA_LIMITS.imageFileBytes * 4 / 3 + 4) throw Error("原图片授权或内容不匹配，未提交视频生成。");
  const bytes = Uint8Array.from(atob(source.base64), char => char.charCodeAt(0));
  const name = `参考图-${source.assetId}.${source.mimeType === "image/png" ? "png" : source.mimeType === "image/webp" ? "webp" : "jpg"}`;
  const result = await extract(new File([bytes], name, { type: source.mimeType }), signal);
  signal.throwIfAborted();
  const dataUrl = result.media?.kind === "image" && result.media.frames.length === 1 ? result.media.frames[0].dataUrl : undefined;
  if (!dataUrl?.startsWith("data:image/jpeg;base64,")) throw Error("原图片无法转换成视频参考图，未提交视频生成。");
  return { name, dataUrl, generatedAsset: { conversationId: conversation.id, assetId: source.assetId, sourceFingerprint: source.sourceFingerprint } };
}

export function videoReferenceUploadBody(image: VideoReferenceImage, conversationId: string) {
  return { dataUrl: image.dataUrl, conversationId, ...(image.generatedAsset ? { generatedAsset: image.generatedAsset } : {}), ...(image.sourceVideo ? { sourceVideo: { ...image.sourceVideo, conversationId } } : {}) };
}
