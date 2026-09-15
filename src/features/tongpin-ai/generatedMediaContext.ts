import type { AiAttachment, AiImageAsset } from "../../../shared/ai";
import type { AiVideoJob } from "../../../shared/aiVideo";
import { AI_MEDIA_LIMITS } from "../../../shared/aiMedia";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
import type { ExtractedAttachment } from "./attachments";

type Api = <T>(path: string, init?: RequestInit, timeout?: number, mode?: "json" | "blob") => Promise<T>;
/** Resolve only artifacts actually referenced by this conversation, never the global latest job. */
export function generatedMediaForFollowup(conversation: TongpinAIConversation | null, artifacts: TongpinAIArtifact[], text: string) {
  if (!conversation) return undefined;
  const direct = conversation.messages.at(-1)?.artifactId;
  if (!direct && !/视频|图片|画面|好看|评价|点评|配色|构图|镜头|节奏|刚才|这个|这张|这段|怎么样|如何|美观|logo|review|critique|video|image/i.test(text)) return undefined;
  const kind = /视频|这段|video/i.test(text) ? "video" : /图片|这张|image/i.test(text) ? "image" : undefined;
  for (const message of [...conversation.messages].reverse()) {
    if (message.role !== "assistant" || message.status === "error") continue;
    const artifact = artifacts.find(a => a.id === message.artifactId && a.conversationId === conversation.id);
    if (!artifact) continue;
    if (typeof artifact.data?.videoJobId === "string" && kind !== "image") return artifact;
    if (Array.isArray(artifact.data?.images) && kind !== "video") return artifact;
  }
}

/** GET only. Re-reading an existing result must never generate/charge for a second video or image. */
export async function readGeneratedMedia(artifact: TongpinAIArtifact, api: Api, accountId: string, signal: AbortSignal,
  extract: (file: File, signal?: AbortSignal) => Promise<ExtractedAttachment>): Promise<AiAttachment[]> {
  const init = { headers: { "X-Tongpin-Account": accountId }, signal };
  const attachments: AiAttachment[] = [];
  const add = async (file: File) => {
    signal.throwIfAborted();
    const result = await extract(file, signal);
    signal.throwIfAborted();
    if (!result.media?.frames.length) throw Error("生成内容没有可读取画面，本次未发送，草稿已保留");
    for (const [index, frame] of result.media.frames.entries()) attachments.push({ name: `生成成果-${artifact.id.slice(0, 60)}-${index + 1}`, mediaType: "image/jpeg", dataUrl: frame.dataUrl,
      text: result.media.kind === "video" ? `这是当前对话刚生成的视频采样画面 ${index + 1}/${result.media.frames.length}，时间 ${frame.timeSeconds?.toFixed(2)} 秒，总长 ${result.media.durationSeconds?.toFixed(2)} 秒。仅依据这些画面评价，不含音频，不能声称看过未采样部分或听过声音。` : "这是当前对话中生成的图片，请依据实际画面回答追问。" });
  };
  if (typeof artifact.data?.videoJobId === "string") {
    const route = `/api/ai/videos/${encodeURIComponent(artifact.data.videoJobId)}`;
    const { job } = await api<{ job: AiVideoJob }>(route, init, 30000);
    if (job.status !== "completed") throw Error("这段视频尚未生成成功，暂时不能评价画面。草稿已保留。");
    const blob = await api<Blob>(`${route}/content`, init, 130000, "blob");
    if (blob.size > AI_MEDIA_LIMITS.videoFileBytes) throw Error("这段视频超过画面分析大小限制，请截取片段后分析。草稿已保留。");
    await add(new File([blob], "当前对话生成的视频.mp4", { type: "video/mp4" }));
  } else if (Array.isArray(artifact.data?.images)) {
    const images = artifact.data.images.filter(image => image && typeof image === "object" && !Array.isArray(image) && !image.deleted && typeof image.assetId === "string");
    if (!images.length) throw Error("生成图片已删除，无法读取画面。草稿已保留。");
    if (images.length > AI_MEDIA_LIMITS.requestFrames) throw Error("图片过多，请单独选择需要评价的图片");
    for (const image of images) {
      const id = (image as { assetId: string }).assetId;
      const asset = await api<AiImageAsset>(`/api/ai/assets/${encodeURIComponent(id)}`, init, 30000);
      signal.throwIfAborted();
      if (asset.assetId !== id || asset.base64.length > AI_MEDIA_LIMITS.imageFileBytes * 4 / 3 + 4) throw Error("图片内容无法安全读取");
      const bytes = Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0));
      await add(new File([bytes], `生成图片.${asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType === "image/webp" ? "webp" : "png"}`, { type: asset.mimeType }));
    }
  }
  return attachments;
}
