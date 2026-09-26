import type { AiVideoSettings } from "../../../shared/aiVideo";
import type { VideoModelId, VideoResolution } from "../../../shared/aiVideoModels";
import { videoModel } from "../../../shared/aiVideoModels";
import type { AiWorkspaceVideoDraftSettings } from "../../../shared/aiWorkspace";
import type { VideoChatRequest } from "./videoChat";
import { videoProfileBlocker, videoProfileFor, type ResolvedVideoProfile } from "./videoProfiles";

/** What the confirmation card shows: the exact model, duration and
 * resolution, plus why the tier default is not used when it is not. */
export interface VideoModelChoice {
  model: VideoModelId;
  label: string;
  seconds: number;
  resolution: VideoResolution;
  aspectRatio: "16:9" | "9:16";
  notice?: string;
}

const labelOf = (settings: AiVideoSettings, id: string) => videoProfileFor(settings, id)?.label ?? videoModel(id)?.label ?? id;

function choiceOf(profile: ResolvedVideoProfile, request: Pick<VideoChatRequest, "seconds" | "resolution" | "aspectRatio">, notice?: string): VideoModelChoice {
  return { model: profile.id, label: profile.label, seconds: request.seconds, resolution: request.resolution, aspectRatio: request.aspectRatio, ...(notice ? { notice } : {}) };
}

/** An explicit creation command starts with the member's last valid choice,
 * else the tier default. If that model cannot take this request the next
 * valid model is used and the reason is returned for the confirmation card;
 * the tier default is never replaced silently. No provider or price is guessed. */
export function naturalVideoRequest(
  requestId: string,
  prompt: string,
  settings: AiVideoSettings,
  previous: AiWorkspaceVideoDraftSettings | undefined,
  references: VideoChatRequest["referenceImages"] = [],
): { request: VideoChatRequest; choice: VideoModelChoice } {
  if (!settings.enabled || !settings.apiKeyConfigured) throw new Error("视频服务尚未配置，请联系管理员");
  const available = settings.availableModels;
  const referenceCount = references?.length ?? 0;
  const previousId = previous?.model && available.includes(previous.model) ? previous.model : undefined;
  const tierDefault = settings.defaultModel && available.includes(settings.defaultModel) ? settings.defaultModel : undefined;
  const preferred = previousId ?? tierDefault;
  const order = [...new Set([previousId, tierDefault, ...available].filter((id): id is VideoModelId => Boolean(id)))];
  const skipped: string[] = [];
  let profile: ResolvedVideoProfile | undefined;
  for (const id of order) {
    const candidate = videoProfileFor(settings, id);
    const blocker = candidate ? videoProfileBlocker(candidate, referenceCount) : "当前无法读取该模型的参数";
    if (!blocker) { profile = candidate; break; }
    if (id === previousId || id === tierDefault) skipped.push(`${id === tierDefault ? "档位默认模型" : "上次选择的模型"}「${labelOf(settings, id)}」${blocker}`);
  }
  if (!profile) {
    throw new Error(skipped.length
      ? `${skipped.join("；")}，当前档位没有其他可用模型；请添加参考图片或选择其他模型`
      : "当前档位没有与参考图匹配的视频模型，请选择其他模型或添加参考图片");
  }
  const notices = [
    ...(skipped.length && profile.id !== preferred ? [`${skipped.join("；")}，本次改用「${profile.label}」`] : []),
    ...(settings.defaultNotice && profile.id === settings.defaultModel ? [settings.defaultNotice] : []),
  ];
  const resolution = previous && profile.resolutions.includes(previous.resolution) ? previous.resolution : profile.resolutions[0];
  const durations = profile.seconds[resolution] ?? [];
  const seconds = previous && durations.includes(previous.seconds) ? previous.seconds : durations[0];
  if (!seconds) throw new Error("当前视频模型没有可用的时长，请重新选择");
  const request: VideoChatRequest = { requestId, prompt, originalPrompt: prompt, model: profile.id, seconds, resolution,
    aspectRatio: previous?.aspectRatio === "9:16" ? "9:16" : "16:9",
    ...(referenceCount ? { referenceImages: references } : {}) };
  return { request, choice: choiceOf(profile, request, notices.join("；") || undefined) };
}

/** A model the member picked explicitly is honored exactly or rejected with a
 * reason; it is never swapped for another model. The server revalidates. */
export function explicitVideoChoice(settings: AiVideoSettings, request: VideoChatRequest): VideoModelChoice {
  const profile = videoProfileFor(settings, request.model);
  if (!profile) throw new Error("所选视频模型当前不可用，请重新选择");
  const blocker = videoProfileBlocker(profile, request.referenceImages?.length ?? request.referenceIds?.length ?? 0);
  if (blocker) throw new Error(`所选模型「${profile.label}」${blocker}，请调整参考图片或选择其他模型`);
  if (!profile.resolutions.includes(request.resolution) || !(profile.seconds[request.resolution] ?? []).includes(request.seconds)) {
    throw new Error(`所选时长或清晰度不适用于「${profile.label}」，请重新选择`);
  }
  return choiceOf(profile, request);
}

/** Validate a persisted choice before rendering it on a task card. */
export function savedVideoChoice(value: unknown): VideoModelChoice | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const v = value as Partial<VideoModelChoice>;
  const text = (item: unknown, max: number) => typeof item === "string" && item.trim().length > 0 && item.length <= max && !/[\u0000-\u001f\u007f]/.test(item);
  if (!text(v.model, 120) || !text(v.label, 120) || !Number.isSafeInteger(v.seconds) || Number(v.seconds) <= 0
    || !text(v.resolution, 16) || (v.aspectRatio !== "16:9" && v.aspectRatio !== "9:16")
    || (v.notice !== undefined && !text(v.notice, 600))) return;
  return { model: v.model!, label: v.label!, seconds: Number(v.seconds), resolution: v.resolution!, aspectRatio: v.aspectRatio, ...(v.notice ? { notice: v.notice } : {}) };
}
