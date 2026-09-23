import type { TongpinAIArtifact, TongpinAIConversation } from "./types";

/** Anaphora is a source request, not permission to edit an arbitrary latest
 * image. Only one intact image from this conversation can be inferred. */
export function generatedImageEditReferenceIds(
  conversation: TongpinAIConversation | null,
  artifacts: readonly TongpinAIArtifact[],
  prompt: string,
): string[] {
  if (!/(?:刚才|上一张|上张|这张|那张|同一张|同一个人物|同一位人物)/.test(prompt)) return [];
  if (!conversation) throw new Error("没有找到当前对话中的原图片，请先选择参考图；本次未提交生成。");
  for (const message of [...conversation.messages].reverse()) {
    if (message.role !== "assistant" || !message.artifactId) continue;
    const artifact = artifacts.find(item => item.id === message.artifactId && item.conversationId === conversation.id && item.kind === "图片");
    if (!artifact || !Array.isArray(artifact.data?.images)) continue;
    const images = artifact.data.images.flatMap((item): string[] => item && typeof item === "object" && !Array.isArray(item) && !item.deleted && typeof item.assetId === "string" ? [item.assetId] : []);
    if (images.length !== 1) throw new Error("上一条成果包含多张或已删除的图片，请明确选择参考图；本次未提交生成。");
    return [images[0]];
  }
  throw new Error("没有找到当前对话中可验证的原图片，请先选择参考图；本次未提交生成。");
}
