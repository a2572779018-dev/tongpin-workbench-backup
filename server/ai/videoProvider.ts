import { AiError, safeBaseUrl } from "./security";
import { object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";
import { videoModel, videoSeconds, type VideoModelId, type VideoResolution } from "../../shared/aiVideoModels";

/** 75api's documented adapter, not a claim about the official MiniMax API. */
export interface H3VideoInput {
  prompt: string;
  model?: VideoModelId;
  seconds: number;
  resolution: VideoResolution;
  aspectRatio: "16:9" | "9:16";
  images?: string[];
}
export interface H3VideoTask {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  progress: number;
}
export interface VideoConnection { baseUrl: string; apiKey: string }

export function parseH3VideoInput(value: unknown): H3VideoInput {
  const p = object(value);
  const model = videoModel(typeof p.model === "string" ? p.model : p.model === undefined ? "minimax_h3" : "");
  if (!model) throw new AiError(400, "AI_VIDEO_MODEL_INVALID", "请选择支持的视频模型", true);
  if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.length > 4000 || p.prompt.includes("\0")) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请输入 1–4000 字的视频描述", true);
  if (!(model.resolutions as readonly unknown[]).includes(p.resolution)) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请选择该模型支持的清晰度", true);
  if (!Number.isInteger(p.seconds) || !videoSeconds(model.id, p.resolution as VideoResolution).includes(Number(p.seconds))) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请选择该模型支持的视频时长", true);
  if (p.aspectRatio !== "16:9" && p.aspectRatio !== "9:16") throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请选择横屏或竖屏", true);
  if (p.audios !== undefined || p.attachments !== undefined || p.firstFrame !== undefined || p.lastFrame !== undefined) throw new AiError(400, "AI_VIDEO_REFERENCES_UNSUPPORTED", "当前视频接口不支持音频附件或精确首尾帧控制", true);
  if (p.images !== undefined && (!Array.isArray(p.images) || p.images.length > model.maxImages || p.images.some(url => typeof url !== "string" || !/^https:\/\/notify\.samhubs\.com\/api\/video-reference\/[a-f0-9]{64}$/.test(url)))) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请重新上传参考图片，数量不能超过模型限制", true);
  if (model.requiresImage && (!Array.isArray(p.images) || !p.images.length)) throw new AiError(400, "AI_VIDEO_IMAGE_REQUIRED", "该模型需要至少一张参考图片", true);
  return { ...(p.model !== undefined ? { model: model.id } : {}), prompt: p.prompt.trim(), seconds: Number(p.seconds), resolution: p.resolution as VideoResolution, aspectRatio: p.aspectRatio, ...(Array.isArray(p.images) && p.images.length ? { images: p.images as string[] } : {}) };
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !/^task_[a-zA-Z0-9_-]{8,128}$/.test(value)) throw new AiError(502, "AI_VIDEO_RESPONSE_INVALID", "视频服务没有返回有效任务编号，请核对服务商记录，勿重复生成");
  return value;
}

export function parseH3VideoTask(value: unknown, expectedId?: string): H3VideoTask {
  const root = object(value);
  // The documented query examples have different id/task_id values. id is the canonical resource URL ID.
  const id = taskId(root.id ?? root.task_id);
  if (expectedId && id !== expectedId) throw new AiError(502, "AI_VIDEO_RESPONSE_INVALID", "视频服务返回的任务不匹配，请核对服务商记录");
  const status = root.status;
  if (status !== "queued" && status !== "processing" && status !== "completed" && status !== "failed") throw new AiError(502, "AI_VIDEO_RESPONSE_INVALID", "视频任务状态无法识别，请稍后查询；不会重新提交生成");
  if (typeof root.progress !== "number" || !Number.isFinite(root.progress) || root.progress < 0 || root.progress > 100) throw new AiError(502, "AI_VIDEO_RESPONSE_INVALID", "视频任务进度无效，请稍后查询");
  // Do not return provider error text, URLs, prompts, headers or unknown fields.
  return { id, status, progress: root.progress };
}

/** A submission performs exactly one POST. Callers must persist a reservation/request ID BEFORE calling. */
export async function submitH3Video(transport: AiTransport, connection: VideoConnection, value: unknown): Promise<H3VideoTask> {
  const input = parseH3VideoInput(value);
  const response = await transport(`${safeBaseUrl(connection.baseUrl)}/videos`, {
    method: "POST", headers: { Authorization: `Bearer ${connection.apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ model: input.model ?? "minimax_h3", prompt: input.prompt, seconds: String(input.seconds), resolution: input.resolution, aspect_ratio: input.aspectRatio, ...(input.images ? { images: input.images } : {}) }),
    signal: AbortSignal.timeout(60_000), maxResponseBytes: 32 * 1024,
  });
  if (!response.ok) throw await readProviderHttpError(response, "video");
  return parseH3VideoTask(await readBoundedJson(response, 32 * 1024));
}

/** Queries cannot recreate or retry a paid submission. The caller owns polling and durable task state. */
export async function queryH3Video(transport: AiTransport, connection: VideoConnection, id: string): Promise<H3VideoTask> {
  const safeId = taskId(id);
  const response = await transport(`${safeBaseUrl(connection.baseUrl)}/videos/${safeId}`, {
    method: "GET", headers: { Authorization: `Bearer ${connection.apiKey}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000), maxResponseBytes: 32 * 1024,
  });
  if (!response.ok) throw await readProviderHttpError(response, "video");
  return parseH3VideoTask(await readBoundedJson(response, 32 * 1024), safeId);
}

/** Always derive the download endpoint from the authenticated job's canonical ID, never from video_url. */
export function h3VideoContentUrl(baseUrl: string, id: string): string {
  return `${safeBaseUrl(baseUrl)}/videos/${taskId(id)}/content`;
}
