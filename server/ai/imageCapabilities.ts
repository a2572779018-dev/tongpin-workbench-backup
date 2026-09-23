import { AI_IMAGE_EDIT_PROFILE_SPECS, type AiImageEditCapability, type AiImageEditProfile } from "../../shared/aiImageCapabilities";
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
