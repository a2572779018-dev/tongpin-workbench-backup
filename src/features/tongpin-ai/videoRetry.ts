import type { AiVideoJob } from "../../../shared/aiVideo";
import { VIDEO_MODELS, videoModel, videoSeconds } from "../../../shared/aiVideoModels";
import type { VideoChatRequest } from "./videoChat";

const PLAN_ID = /^[a-zA-Z0-9_-]{16,100}$/;

function optionalText(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && Boolean(value.trim()) && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value));
}

function savedPlanMetadata(value: unknown): Pick<VideoChatRequest, "originalPrompt" | "planSummary" | "planRequestId"> | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as VideoChatRequest;
  if (!optionalText(r.originalPrompt, 24000) || !optionalText(r.planSummary, 240) || (r.planRequestId !== undefined && (typeof r.planRequestId !== "string" || !PLAN_ID.test(r.planRequestId)))) return;
  // A restored plan is usable only as one complete, server-bound unit. Keeping a
  // summary without its request ID would silently turn the second click into an
  // unbound generation request.
  if ((r.planSummary === undefined) !== (r.planRequestId === undefined)) return;
  return {
    ...(r.originalPrompt !== undefined ? { originalPrompt: r.originalPrompt } : {}),
    ...(r.planSummary !== undefined ? { planSummary: r.planSummary } : {}),
    ...(r.planRequestId !== undefined ? { planRequestId: r.planRequestId } : {}),
  };
}

export function savedVideoRequest(value: unknown): VideoChatRequest | undefined {
  if (!value || typeof value !== "object") return;
  const r = value as VideoChatRequest, plan = savedPlanMetadata(r);
  const referenceCount = r.referenceImages?.length ?? r.referenceIds?.length ?? 0;
  const model = r.model ? videoModel(r.model) : VIDEO_MODELS.find(item => item.generationEnabled && item.resolutions.includes(r.resolution as never) && videoSeconds(item.id, r.resolution).includes(r.seconds) && referenceCount <= item.maxImages && (!item.requiresImage || referenceCount > 0));
  if (!model || typeof r.requestId !== "string" || !PLAN_ID.test(r.requestId) || typeof r.prompt !== "string" || !r.prompt.trim() || r.prompt.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(r.prompt) || !model.resolutions.includes(r.resolution as never) || !videoSeconds(model.id, r.resolution).includes(r.seconds) || !["16:9", "9:16"].includes(r.aspectRatio)) return;
  if (!plan) return;
  if (r.referenceImages !== undefined && (!Array.isArray(r.referenceImages) || r.referenceImages.length > model.maxImages || r.referenceImages.some(i => !i || typeof i.name !== "string" || !i.name.trim() || i.name.length > 160 || /[\u0000-\u001f\u007f]/.test(i.name) || typeof i.dataUrl !== "string" || i.dataUrl.length > 400000 || !/^data:image\/jpeg;base64,\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(i.dataUrl)))) return;
  if (r.referenceIds !== undefined && (!Array.isArray(r.referenceIds) || r.referenceIds.length > model.maxImages || r.referenceIds.some(id => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))) return;
  if ((r.referenceImages?.length ?? 0) && (r.referenceIds?.length ?? 0)) return;
  return { requestId: r.requestId, prompt: r.prompt, ...(r.model ? { model: model.id } : {}), seconds: r.seconds, resolution: r.resolution, aspectRatio: r.aspectRatio, ...plan, ...(r.referenceIds?.length ? { referenceIds: [...r.referenceIds] } : {}), referenceImages: r.referenceImages ?? [] };
}

/** Builds the local failed-job card when validation rejects before a server job exists. */
export function failedVideoSubmission(value: unknown, error: string | undefined): AiVideoJob | undefined {
  const saved = savedVideoRequest(value);
  if (!saved || typeof error !== "string" || !error.trim()) return;
  return {
    id: saved.requestId,
    prompt: saved.prompt,
    ...(saved.model ? { model: saved.model } : {}),
    seconds: saved.seconds,
    resolution: saved.resolution,
    aspectRatio: saved.aspectRatio,
    status: "failed",
    progress: 0,
    quotaPoints: 0,
    reserved: false,
    createdAt: "",
    updatedAt: "",
    error: error.trim(),
    ...(saved.referenceIds ? { referenceIds: [...saved.referenceIds] } : {}),
    ...(saved.planRequestId ? { planRequestId: saved.planRequestId } : {}),
  };
}

/** Restoring is GET-only. The composer creates a fresh paid request only after confirmation. */
export async function restoreVideoRequest(job: AiVideoJob, saved: unknown, readImage: (id: string) => Promise<string>): Promise<VideoChatRequest> {
  if (job.reserved || !["failed", "completed"].includes(job.status)) throw Error("原任务尚未结算，请先核对原任务，不能重复生成");
  const cached = savedVideoRequest(saved);
  const savedPlan = saved && typeof saved === "object" && (saved as VideoChatRequest).requestId === job.id ? savedPlanMetadata(saved) : undefined;
  const originalPrompt = savedPlan?.originalPrompt ?? job.prompt;
  const freshDraft = (request: VideoChatRequest): VideoChatRequest => {
    const { planSummary: _usedSummary, planRequestId: _usedPlanId, ...draft } = request;
    return { ...draft, originalPrompt };
  };
  if (cached && cached.requestId === job.id && (!job.referenceIds || cached.referenceImages?.length === job.referenceIds.length)) {
    return freshDraft(cached);
  }
  if (!Array.isArray(job.referenceIds)) throw Error("这条旧记录尚未提供参考图信息，请更新服务端后重试；不会按无图任务生成");
  const referenceImages = [];
  for (const [index, id] of job.referenceIds.entries()) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error("参考图片记录无效");
    referenceImages.push({ name: `参考图 ${index + 1}.jpg`, dataUrl: await readImage(id) });
  }
  const restored = savedVideoRequest({
    requestId: job.id, prompt: job.prompt, model: job.model, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio,
    originalPrompt,
    referenceImages,
  });
  if (!restored) throw Error("视频参数或参考图无法恢复，请重新检查");
  return freshDraft(restored);
}
