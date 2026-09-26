import type { AiVideoModelProfile, AiVideoSettings } from "../../../shared/aiVideo";
import { videoModel, videoSeconds, type VideoModelId, type VideoResolution } from "../../../shared/aiVideoModels";

export interface ResolvedVideoProfile extends AiVideoModelProfile { id: VideoModelId; label: string }

const RESOLUTION = /^[1-9][0-9]{2,3}p$/;

/** Accept only a well-formed member profile from the server. */
function validProfile(value: unknown): AiVideoModelProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const p = value as Partial<AiVideoModelProfile>;
  if (!Array.isArray(p.resolutions) || !p.resolutions.length || p.resolutions.some(item => typeof item !== "string" || !RESOLUTION.test(item))) return;
  if (!p.seconds || typeof p.seconds !== "object") return;
  const seconds: Partial<Record<VideoResolution, number[]>> = {};
  for (const resolution of p.resolutions) {
    const list = p.seconds[resolution];
    if (!Array.isArray(list) || !list.length || list.some(n => !Number.isSafeInteger(n) || n <= 0 || n > 600)) return;
    seconds[resolution] = [...list];
  }
  if (!Number.isSafeInteger(p.maxImages) || Number(p.maxImages) < 0 || Number(p.maxImages) > 32 || typeof p.requiresImage !== "boolean") return;
  return {
    ...(typeof p.label === "string" && p.label.trim() && p.label.length <= 120 ? { label: p.label.trim() } : {}),
    resolutions: [...p.resolutions], seconds, maxImages: Number(p.maxImages), requiresImage: p.requiresImage,
  };
}

function localProfile(id: string): AiVideoModelProfile | undefined {
  const spec = videoModel(id);
  if (!spec?.generationEnabled) return;
  return {
    label: spec.label, resolutions: [...spec.resolutions],
    seconds: Object.fromEntries(spec.resolutions.map(resolution => [resolution, videoSeconds(spec.id, resolution)])),
    maxImages: spec.maxImages, requiresImage: spec.requiresImage,
  };
}

/** Server profiles are authoritative. The bundled catalogue is used only for
 * servers that predate `profiles`, so a gateway model rename never depends on
 * this client's release. An available id is never dropped just because this
 * client does not know it. */
export function videoProfileFor(settings: Pick<AiVideoSettings, "availableModels" | "defaultModel" | "profile" | "profiles">, id: string | undefined): ResolvedVideoProfile | undefined {
  if (!id || !settings.availableModels.includes(id as VideoModelId)) return;
  let profile: AiVideoModelProfile | undefined;
  if (settings.profiles && typeof settings.profiles === "object") profile = validProfile(settings.profiles[id]);
  else {
    const local = localProfile(id);
    // Older servers still describe the tier default in `profile`.
    const server = id === settings.defaultModel ? validProfile(settings.profile) : undefined;
    profile = server ? { ...server, label: server.label ?? local?.label } : local;
  }
  if (!profile) return;
  return { ...profile, id: id as VideoModelId, label: profile.label ?? videoModel(id)?.label ?? id };
}

/** Every authorized model the member may pick, in the server's order. */
export function selectableVideoProfiles(settings: Pick<AiVideoSettings, "availableModels" | "defaultModel" | "profile" | "profiles">): ResolvedVideoProfile[] {
  return settings.availableModels.flatMap(id => { const profile = videoProfileFor(settings, id); return profile ? [profile] : []; });
}

/** Why a model cannot take this request, or undefined when it can. */
export function videoProfileBlocker(profile: AiVideoModelProfile, referenceCount: number): string | undefined {
  if (profile.requiresImage && referenceCount === 0) return "需要至少一张参考图片";
  if (referenceCount > profile.maxImages) return profile.maxImages ? `最多支持 ${profile.maxImages} 张参考图片（本次 ${referenceCount} 张）` : "不支持参考图片";
  return undefined;
}

export function videoChoiceSummary(choice: { label: string; seconds: number; resolution: string; aspectRatio?: string }): string {
  return [choice.label, `${choice.seconds} 秒`, choice.resolution, ...(choice.aspectRatio ? [choice.aspectRatio] : [])].join(" · ");
}
