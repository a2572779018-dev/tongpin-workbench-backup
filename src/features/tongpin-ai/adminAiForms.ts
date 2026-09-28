import type { AiQuota } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";

export function normalizeAiBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("请填写不含密钥或查询参数的 HTTPS API 地址。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|models|images\/generations)$/, "") || "/v1";
  return url.toString().replace(/\/+$/, "");
}

/** A price field typed as text: blank or anything but a whole number is invalid (never "0 = free" by accident). */
export function parseAdminPoints(value: string, label: string, { min = 0, max = 10_000_000 } = {}): { value: number; error: string } {
  const trimmed = value.trim();
  if (!trimmed) return { value: 0, error: `请填写${label}（${min} 到 ${max.toLocaleString("en-US")} 的整数）。` };
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) return { value: 0, error: `${label}需填写整数。` };
  const parsed = Number(trimmed);
  if (parsed < min || parsed > max) return { value: parsed, error: `${label}需在 ${min} 到 ${max.toLocaleString("en-US")} 之间。` };
  return { value: parsed, error: "" };
}

export function calculateAiQuotaLimit(
  amount: string,
  mode: "set" | "add",
  quota: AiQuota,
): { limitTokens: number; error: string } {
  const trimmed = amount.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    return { limitTokens: 0, error: "请填写有效的整数同频点数量。" };
  }
  const value = Number(trimmed);
  const limitTokens = mode === "add" ? quota.limitTokens + value : value;
  if (!Number.isSafeInteger(limitTokens) || limitTokens > 1_000_000_000) {
    return { limitTokens, error: "总限额不能超过 1,000,000,000 同频点。" };
  }
  if (mode === "add" && value === 0) {
    return { limitTokens, error: "追加同频点必须大于 0。" };
  }
  if (limitTokens < quota.usedTokens + quota.reservedTokens) {
    return { limitTokens, error: "总限额不能低于已使用和处理中预留的同频点之和。" };
  }
  return { limitTokens, error: "" };
}

/** Validation errors written by 同频's own server (never provider text), whose
 * message names the exact field or tier to fix. */
const OWN_VALIDATION_CODES = new Set([
  "AI_HARNESS_INVALID", "AI_HARNESS_TOOL_PROTOCOL", "AI_HARNESS_PROVIDER_MISSING", "AI_HARNESS_PROVIDER_NOT_FOUND", "AI_HARNESS_PROVIDER_IN_USE",
  "AI_HARNESS_IMAGE_ROUTE_REQUIRED", "AI_HARNESS_VIDEO_ROUTE_REQUIRED", "AI_HARNESS_REQUIRED", "AI_IMAGE_GENERATION_CAPABILITY_MISMATCH",
  "AI_IMAGE_EDIT_CAPABILITY_INVALID", "AI_IMAGE_GENERATION_CAPABILITY_INVALID", "AI_CAPABILITY_INVALID", "AI_IMAGE_QUOTA_REQUIRED",
  "AI_SEARCH_CONFIG_INVALID", "AI_CODE_INTERPRETER_CONFIG_INVALID", "AI_VISION_CONFIG_INVALID", "AI_VIDEO_SETTINGS_INVALID",
  "AI_VIDEO_KEY_REQUIRED", "AI_VIDEO_MODEL_INVALID", "AI_VIDEO_MODEL_UNAVAILABLE", "AI_QUOTA_INVALID",
]);

// Never surface an arbitrary upstream response: it may echo the administrator's key.
export function adminAiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  if (OWN_VALIDATION_CODES.has(error.code) && error.message && error.status >= 400 && error.status < 500) return error.message;
  const knownErrors: Record<string, string> = {
    AI_URL_INVALID: "请输入有效的 HTTPS API 地址。",
    AI_URL_UNSAFE: "请使用公网 HTTPS API 域名，不要包含端口、账号或查询参数。",
    AI_KEY_REQUIRED: "首次接入或更换 API 地址后，请重新填写密钥。",
    AI_IMAGE_KEY_REQUIRED: "首次接入或更换图片 API 地址后，请重新填写图片密钥。",
    AI_IMAGE_QUOTA_REQUIRED: "请设置每张图片折算的同频点后再启用图片生成。",
    AI_SEARCH_CONFIG_INVALID: "联网搜索需要 Responses 协议和大于 0 的折算同频点，请核对模型是否支持。",
    AI_CODE_INTERPRETER_CONFIG_INVALID: "代码执行需要 Responses 协议和大于 0 的折算同频点，请核对模型是否支持。",
    AI_VISION_CONFIG_INVALID: "每张图片的输入预留需填写 256 到 131072 之间的整数估算值。",
    AI_ASSET_STORAGE_FULL: "图片存储空间已满，请让成员下载并删除不再需要的图片。",
    AI_PROVIDER_AUTH: "API 密钥无效或无权访问，请核对服务商的密钥配置。",
    AI_PROVIDER_LIMIT: "服务商余额不足或请求频繁，请检查服务商账号后重试。",
    AI_PROVIDER_REDIRECT: "该地址发生跳转；为保护密钥，请填写服务商提供的最终 API 地址。",
    AI_HOST_NOT_ALLOWED: "该服务商域名尚未接入同频服务器，与你填写的密钥无关。",
    AI_MODELS_UNAVAILABLE: "服务商未提供可读取的模型列表，可手动填写模型 ID。",
    AI_AGENT_MODELS_UNVERIFIED: "当前密钥尚未完成 Agent 模型检查，请保存配置后重新检查。",
    AI_AGENT_QUICK_MODELS_UNAVAILABLE: "当前密钥没有返回同频支持的快速模型，成员请求尚未发送。",
    AI_AGENT_ASTRA_UNAVAILABLE: "当前密钥没有返回 Astra，深度思考与 Agent 联网搜索暂不可用。",
    AI_AGENT_VISION_MODEL_UNAVAILABLE: "当前已验证的快速模型不支持图片理解，请检查模型权限。",
    AI_CONNECTION_FAILED: "无法连接 AI 服务，请核对 API 地址或稍后重试。",
    AI_ENCRYPTION_UNAVAILABLE: "服务器安全存储尚未配置，暂时不能保存密钥。",
    AI_KEY_UNREADABLE: "已保存的密钥无法读取，请重新填写并保存密钥。",
    AI_CONFIG_CHANGED: "接入配置刚被修改，请重新填写密钥后保存。",
    AI_QUOTA_BELOW_USED: "额度状态已变化；请刷新后重新设置，总限额不能低于已用和处理中预留的同频点。",
    AI_HARNESS_MODEL_UNVERIFIED: "所选模型还没有通过当前密钥的模型列表校验，请在「服务与模型」读取模型后再试。",
  };
  if (knownErrors[error.code]) return knownErrors[error.code];
  if (error.code === "NETWORK_UNAVAILABLE") return "连接不上服务器，请稍后重试。";
  if (error.status === 401) return "登录已失效，请重新登录。";
  if (error.status === 403) return "仅管理员可管理 AI 接入和成员额度。";
  if (error.status === 404) return "AI 管理接口暂不可用，请确认服务器已更新。";
  if (error.status === 409) return "额度状态已变化，请刷新后重新设置。";
  if (error.status === 429) return "操作过于频繁，请稍后重试。";
  return fallback;
}
