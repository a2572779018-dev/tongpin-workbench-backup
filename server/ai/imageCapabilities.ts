import {
  AI_IMAGE_EDIT_PROFILE_SPECS, AI_IMAGE_GENERATION_PROFILE_SPECS,
  type AiImageEditCapability, type AiImageEditProfile,
  type AiImageGenerationCapability, type AiImageGenerationProfile,
} from "../../shared/aiImageCapabilities";
import { AiError, safeBaseUrl } from "./security";

/** Used for admin writes and again before preparing a paid edit request. */
export function parseImageEditCapability(value: unknown): AiImageEditCapability | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new AiError(400, "AI_IMAGE_EDIT_CAPABILITY_INVALID", "图片编辑能力配置无效，请绑定有效的服务地址、模型和已支持的编辑协议", true); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 3 || !Object.hasOwn(item, "baseUrl") || !Object.hasOwn(item, "modelId") || !Object.hasOwn(item, "profile") ||
      typeof item.modelId !== "string" || !item.modelId.trim() || item.modelId.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.modelId) ||
      typeof item.profile !== "string" || !Object.hasOwn(AI_IMAGE_EDIT_PROFILE_SPECS, item.profile) ||
      typeof item.baseUrl !== "string" || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.baseUrl) || /\/(?:images\/(?:edits|generations)|responses|chat\/completions|models)\/*$/.test(item.baseUrl)) return fail();
  let baseUrl: string;
  try { baseUrl = safeBaseUrl(item.baseUrl); } catch { return fail(); }
  return { baseUrl, modelId: item.modelId.trim(), profile: item.profile as AiImageEditProfile };
}

/** Admin declaration, revalidated at the last preflight before a paid call. */
export function parseImageGenerationCapability(value: unknown): AiImageGenerationCapability | undefined {
  if (value === undefined) return undefined;
  const fail = (): never => { throw new AiError(400, "AI_IMAGE_GENERATION_CAPABILITY_INVALID", "图片生成协议配置无效，请核对服务地址、模型、协议与尺寸", true); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 4 || !Object.hasOwn(item, "baseUrl") || !Object.hasOwn(item, "modelId") ||
      !Object.hasOwn(item, "profile") || !Object.hasOwn(item, "size") ||
      typeof item.modelId !== "string" || !item.modelId.trim() || item.modelId.length > 200 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.modelId) ||
      typeof item.profile !== "string" || !Object.hasOwn(AI_IMAGE_GENERATION_PROFILE_SPECS, item.profile) ||
      typeof item.size !== "string" ||
      typeof item.baseUrl !== "string" || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(item.baseUrl) ||
      /\/(?:images\/(?:edits|generations)|responses|chat\/completions|models)\/*$/.test(item.baseUrl)) return fail();
  const profile = item.profile as AiImageGenerationProfile;
  if (!(AI_IMAGE_GENERATION_PROFILE_SPECS[profile].sizes as readonly string[]).includes(item.size)) return fail();
  let baseUrl: string;
  try { baseUrl = safeBaseUrl(item.baseUrl); } catch { return fail(); }
  return { baseUrl, modelId: item.modelId.trim(), profile, size: item.size };
}
