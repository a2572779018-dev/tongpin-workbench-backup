import { AiError, safeBaseUrl } from "./security";
import { object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";

/** 75api's documented adapter, not a claim about the official MiniMax API. */
export interface H3VideoInput {
  prompt: string;
  seconds: number;
  resolution: "480p" | "768p";
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
  if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.length > 4000 || p.prompt.includes("\0")) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请输入 1–4000 字的视频描述", true);
  if (!Number.isInteger(p.seconds) || Number(p.seconds) < 5 || Number(p.seconds) > 15) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "视频时长需为 5–15 秒的整数", true);
  if (p.resolution !== "480p" && p.resolution !== "768p") throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请选择 480p 或 768p", true);
  if (p.aspectRatio !== "16:9" && p.aspectRatio !== "9:16") throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请选择横屏或竖屏", true);
  if (p.audios !== undefined || p.attachments !== undefined || p.firstFrame !== undefined || p.lastFrame !== undefined) throw new AiError(400, "AI_VIDEO_REFERENCES_UNSUPPORTED", "当前视频接口不支持音频附件或精确首尾帧控制", true);
  if (p.images !== undefined && (!Array.isArray(p.images) || p.images.length > 8 || p.images.some(url => typeof url !== "string" || !/^https:\/\/notify\.samhubs\.com\/api\/video-reference\/[a-f0-9]{64}$/.test(url)))) throw new AiError(400, "AI_VIDEO_INPUT_INVALID", "请重新上传参考图片，最多 8 张", true);
  return { prompt: p.prompt.trim(), seconds: Number(p.seconds), resolution: p.resolution, aspectRatio: p.aspectRatio, ...(Array.isArray(p.images) && p.images.length ? { images: p.images as string[] } : {}) };
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
    body: JSON.stringify({ model: "minimax_h3", prompt: input.prompt, seconds: String(input.seconds), resolution: input.resolution, aspect_ratio: input.aspectRatio, ...(input.images ? { images: input.images } : {}) }),
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
