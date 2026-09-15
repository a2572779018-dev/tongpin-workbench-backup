import type { AiVideoJob } from "../../../shared/aiVideo";
import { videoModel, videoSeconds } from "../../../shared/aiVideoModels";
import type { VideoChatRequest } from "./videoChat";

export function savedVideoRequest(value: unknown): VideoChatRequest | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as VideoChatRequest, model = videoModel(r.model ?? "minimax_h3");
  if (!model || typeof r.requestId !== "string" || typeof r.prompt !== "string" || r.prompt.length > 4000 || !model.resolutions.includes(r.resolution as never) || !videoSeconds(model.id, r.resolution).includes(r.seconds) || !["16:9", "9:16"].includes(r.aspectRatio)) return;
  if (r.referenceImages !== undefined && (!Array.isArray(r.referenceImages) || r.referenceImages.length > model.maxImages || r.referenceImages.some(i => !i || typeof i.name !== "string" || typeof i.dataUrl !== "string" || i.dataUrl.length > 400000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(i.dataUrl)))) return;
  return { requestId: r.requestId, prompt: r.prompt, model: model.id, seconds: r.seconds, resolution: r.resolution, aspectRatio: r.aspectRatio, referenceImages: r.referenceImages ?? [] };
}

/** Restoring is GET-only. The composer creates a fresh paid request only after confirmation. */
export async function restoreVideoRequest(job: AiVideoJob, saved: unknown, readImage: (id: string) => Promise<string>): Promise<VideoChatRequest> {
  if (job.reserved || !["failed", "completed"].includes(job.status)) throw Error("原任务尚未结算，请先核对原任务，不能重复生成");
  const cached = savedVideoRequest(saved);
  if (cached && cached.requestId === job.id && (!job.referenceIds || cached.referenceImages?.length === job.referenceIds.length)) return cached;
  if (!Array.isArray(job.referenceIds)) throw Error("这条旧记录尚未提供参考图信息，请更新服务端后重试；不会按无图任务生成");
  const referenceImages = [];
  for (const [index, id] of job.referenceIds.entries()) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("参考图片记录无效");
    referenceImages.push({ name: `参考图 ${index + 1}.jpg`, dataUrl: await readImage(id) });
  }
  const restored = savedVideoRequest({ requestId: job.id, prompt: job.prompt, model: job.model, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio, referenceImages });
  if (!restored) throw Error("视频参数或参考图无法恢复，请重新检查");
  return restored;
}
