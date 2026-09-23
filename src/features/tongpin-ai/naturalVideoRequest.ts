import type { AiVideoSettings } from "../../../shared/aiVideo";
import { videoModel, videoSeconds } from "../../../shared/aiVideoModels";
import type { AiWorkspaceVideoDraftSettings } from "../../../shared/aiWorkspace";
import type { VideoChatRequest } from "./videoChat";

/** An explicit creation command starts with the member's last valid choices,
 * or the smallest authorized model profile. No provider or price is guessed. */
export function naturalVideoRequest(
  requestId: string,
  prompt: string,
  settings: AiVideoSettings,
  previous: AiWorkspaceVideoDraftSettings | undefined,
  references: VideoChatRequest["referenceImages"] = [],
): VideoChatRequest {
  if (!settings.enabled || !settings.apiKeyConfigured) throw new Error("视频服务尚未配置，请联系管理员");
  const preferred = [previous?.model, settings.defaultModel, ...settings.availableModels];
  const model = preferred.flatMap(id => id && settings.availableModels.includes(id) ? [videoModel(id)] : [])
    .find(item => item && (references?.length ?? 0) <= item.maxImages && (!item.requiresImage || Boolean(references?.length)));
  if (!model) throw new Error("当前档位没有与参考图匹配的视频模型，请选择其他模型或添加参考图片");
  const resolution = previous && (model.resolutions as readonly string[]).includes(previous.resolution) ? previous.resolution : model.resolutions[0];
  const durations = videoSeconds(model.id, resolution);
  const seconds = previous && durations.includes(previous.seconds) ? previous.seconds : durations[0];
  if (!seconds) throw new Error("当前视频模型没有可用的时长，请重新选择");
  return { requestId, prompt, originalPrompt: prompt, model: model.id, seconds, resolution,
    aspectRatio: previous?.aspectRatio === "9:16" ? "9:16" : "16:9",
    ...(references?.length ? { referenceImages: references } : {}) };
}
