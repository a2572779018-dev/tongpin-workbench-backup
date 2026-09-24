import type { AiAttachment, AiImageAsset } from "../../../shared/ai";
import type { AiVideoJob } from "../../../shared/aiVideo";
import { AI_MEDIA_LIMITS } from "../../../shared/aiMedia";
import type { TongpinAIArtifact, TongpinAIConversation } from "./types";
import type { ExtractedAttachment } from "./attachments";
import { videoBlobCache } from "./mediaCache";

type Api = <T>(path: string, init?: RequestInit, timeout?: number, mode?: "json" | "blob") => Promise<T>;
/** Resolve only artifacts actually referenced by this conversation, never the global latest job. */
export function generatedMediaForFollowup(conversation: TongpinAIConversation | null, artifacts: TongpinAIArtifact[], text: string) {
  if (!conversation) return undefined;
  // A confirmation inherits only an immediately preceding, concrete media
  // question in this conversation. "Yes" is never a global-latest selector.
  if (/^(是的?|好[的啊]?|可以|就这个|没错|确认|yes|ok)[。！!\s]*$/i.test(text.trim())) {
    const last = conversation.messages.at(-1);
    if (last?.role !== "assistant" || !/[?？]|是否|要不要/.test(last.content) || !/这张|这段|刚才|沿用|同一个|同一位/.test(last.content)) return undefined;
    text = last.content;
  }
  // Discussing a brief or generation settings does not require watching an unfinished result.
  if (/提示词|脚本|文案|prompt|分镜方案|生成参数/i.test(text) && !/画面|实际|成片|看完|观看/i.test(text)) return undefined;
  // A generated artifact being the last message is not consent to fetch it on
  // every later turn. Require an explicit visual/media reference so ordinary
  // chat (for example “你好” or “写一封邮件”) stays text-only.
  const asksAboutMedia = /视频|短片|成片|图片|图像|画面|播放|观看|看完|好看|评价|点评|配色|构图|镜头|节奏|这张|这段|这个视频|这个图片|刚才生成|上面生成|生成结果|生成成果|同一个人物|同一位人物|把[她他它]动起来|review|critique|\bvideo\b|\bimage\b/i.test(text);
  if (!asksAboutMedia) return undefined;
  // The requested output kind is not the source kind. "Use this picture to
  // make a video" must bind the picture, not exclude it because of 视频.
  const imageToVideo = /沿用.{0,15}(?:图|人物)|(?:这张|上张|刚才.{0,6}图|同一个人物|同一位人物|把[她他它]动起来)/.test(text) && /视频|短片|动起来|动态/.test(text);
  const kind = imageToVideo ? "image" : /视频|这段|video/i.test(text) ? "video" : /图片|这张|image/i.test(text) ? "image" : undefined;
  for (const message of [...conversation.messages].reverse()) {
    if (message.role !== "assistant" || message.status === "error") continue;
    const artifact = artifacts.find(a => a.id === message.artifactId && a.conversationId === conversation.id);
    if (!artifact) continue;
    const videoId = typeof artifact.data?.videoJobId === "string" ? artifact.data.videoJobId
      : typeof artifact.data?.mediaTaskServiceRequestId === "string" ? artifact.data.mediaTaskServiceRequestId : undefined;
    if (videoId && kind !== "image") {
      const id = videoId;
      if (conversation.messages.some(m => m.attachments?.some(a => a.media?.kind === "video" && a.name.includes(id)))) return undefined;
      return artifact;
    }
    if (Array.isArray(artifact.data?.images) && kind !== "video") {
      return artifact;
    }
  }
}

/** An explicit upload owns "this image/video". Only an unambiguous mention of
 * an earlier generated result may add that result to the same model request. */
export function generatedMediaForMixedFollowup(conversation: TongpinAIConversation | null, artifacts: TongpinAIArtifact[], text: string): TongpinAIArtifact | undefined {
  const references = [...text.matchAll(/(?:刚才|上面|前面|之前|此前|已)[^，。；;]{0,12}?(?:生成|制作|做出|产出)(?:的|出来的)?[\s，、]{0,3}(视频|短片|成片|图片|图像|照片)/g)]
    .map(match => /视频|短片|成片/.test(match[1]) ? "video" : "image");
  if (!references.length) return undefined;
  if (new Set(references).size !== 1) throw Error("请先指定要讨论的一项生成成果；草稿已保留，本次未发送");
  const kind = references[0];
  const artifact = generatedMediaForFollowup(conversation, artifacts, kind === "video" ? "评价刚才生成的视频画面" : "评价刚才生成的图片画面");
  if (!artifact) throw Error(`当前对话找不到刚才生成的${kind === "video" ? "视频" : "图片"}，请确认成果仍在本对话中；草稿已保留，本次未发送`);
  if (kind === "image" && Array.isArray(artifact.data?.images)
    && artifact.data.images.filter(image => image && typeof image === "object" && !Array.isArray(image) && !image.deleted && typeof image.assetId === "string").length > 1) {
    throw Error("这条生成成果包含多张图片，请先明确选择哪一张；草稿已保留，本次未发送");
  }
  return artifact;
}

/** GET only. Re-reading an existing result must never generate/charge for a second video or image. */
export async function readGeneratedMedia(artifact: TongpinAIArtifact, api: Api, accountId: string, cacheScope: string, signal: AbortSignal,
  extract: (file: File, signal?: AbortSignal) => Promise<ExtractedAttachment>): Promise<AiAttachment[]> {
  const init = { headers: { "X-Tongpin-Account": accountId }, signal };
  const attachments: AiAttachment[] = [];
  const add = async (file: File) => {
    signal.throwIfAborted();
    const result = await extract(file, signal);
    signal.throwIfAborted();
    if (!result.media?.frames.length) throw Error("生成内容没有可读取画面，本次未发送，草稿已保留");
    for (const [index, frame] of result.media.frames.entries()) attachments.push({ name: `生成成果-${artifact.id.slice(0, 60)}-${index + 1}`, mediaType: "image/jpeg", dataUrl: frame.dataUrl,
      text: result.media.kind === "video" ? `这是当前对话生成的视频采样画面 ${index + 1}/${result.media.frames.length}，时间 ${frame.timeSeconds?.toFixed(2)} 秒，实际总长 ${result.media.durationSeconds?.toFixed(2)} 秒。结合对话讨论这些内容，不含音频，不能声称看过未采样部分或听过声音。` : "这是当前对话中生成的图片，请依据实际画面回答追问。" });
  };
  const videoId = typeof artifact.data?.videoJobId === "string" ? artifact.data.videoJobId
    : typeof artifact.data?.mediaTaskServiceRequestId === "string" ? artifact.data.mediaTaskServiceRequestId : undefined;
  if (videoId) {
    const jobId = videoId;
    const route = `/api/ai/videos/${encodeURIComponent(jobId)}`;
    const job = await videoBlobCache.loadJob(cacheScope, jobId, async sharedSignal => {
      const result = await api<{ job: AiVideoJob }>(route, { ...init, signal: sharedSignal }, 30000);
      return result.job;
    }, signal);
    if (job.status !== "completed") throw Error("视频任务尚未完成，暂不能继续对话");
    if (job.id !== jobId || job.conversationId !== artifact.conversationId) throw Error("视频不属于当前对话或缺少可验证的对话记录，草稿已保留，本次未发送");
    signal.throwIfAborted();
    if (videoBlobCache.get(cacheScope, jobId)) {
      // A warm player Blob is not a lasting access grant. Check the current
      // owner/provider before supplying its frames to another model request.
      try {
        const checked = await api<{ available: true }>(`${route}/content/check`, init, 30000);
        if (checked.available !== true) throw Error("视频授权检查未通过，草稿已保留，本次未发送");
      } catch (error) {
        videoBlobCache.remove(cacheScope, jobId);
        throw error;
      }
    }
    const blob = await videoBlobCache.loadBlob(cacheScope, jobId,
      sharedSignal => api<Blob>(`${route}/content`, { ...init, signal: sharedSignal }, 130000, "blob"), signal);
    signal.throwIfAborted();
    if (blob.size > AI_MEDIA_LIMITS.videoFileBytes) throw Error("这段视频超过画面分析大小限制，请截取片段后分析。草稿已保留。");
    await add(new File([blob], "当前对话生成的视频.mp4", { type: "video/mp4" }));
  } else if (Array.isArray(artifact.data?.images)) {
    const images = artifact.data.images.filter(image => image && typeof image === "object" && !Array.isArray(image) && !image.deleted && typeof image.assetId === "string");
    if (!images.length) throw Error("生成图片已删除，无法读取画面。草稿已保留。");
    if (images.length > AI_MEDIA_LIMITS.requestFrames) throw Error("图片过多，请单独选择需要评价的图片");
    for (const image of images) {
      const id = (image as { assetId: string }).assetId;
      const asset = await api<AiImageAsset & { conversationId: string }>(`/api/ai/assets/${encodeURIComponent(id)}/conversation/${encodeURIComponent(artifact.conversationId)}`, init, 30000);
      signal.throwIfAborted();
      if (asset.assetId !== id || asset.conversationId !== artifact.conversationId || asset.base64.length > AI_MEDIA_LIMITS.imageFileBytes * 4 / 3 + 4) throw Error("图片内容或所属对话无法安全验证");
      const bytes = Uint8Array.from(atob(asset.base64), c => c.charCodeAt(0));
      await add(new File([bytes], `生成图片.${asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType === "image/webp" ? "webp" : "png"}`, { type: asset.mimeType }));
    }
  }
  return attachments;
}
