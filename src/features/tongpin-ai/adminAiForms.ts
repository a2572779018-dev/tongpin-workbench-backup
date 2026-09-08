import type { AiProviderConfig, AiProviderInput, AiQuota } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";

export function normalizeAiBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("请填写不含密钥或查询参数的 HTTPS API 地址。");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:chat\/completions|responses|models|images\/generations)$/, "") || "/v1";
  return url.toString().replace(/\/+$/, "");
}

export function validateAiProviderConnection(baseUrl: string, apiKey: string, saved: AiProviderConfig | null): string {
  let normalized: string;
  try { normalized = normalizeAiBaseUrl(baseUrl); }
  catch { return "请填写有效的 HTTPS API 地址，不要在地址中包含密钥。"; }
  if ((!saved?.apiKeyConfigured || normalizeAiBaseUrl(saved.baseUrl) !== normalized) && !apiKey.trim()) {
    return saved?.apiKeyConfigured ? "修改 API 地址后，请重新填写该服务的密钥。" : "请填写 API 密钥。";
  }
  return "";
}

export function validateAiProviderInput(
  input: AiProviderInput,
  saved: AiProviderConfig | null,
): string {
  const connectionError = validateAiProviderConnection(input.baseUrl, input.apiKey ?? "", saved);
  if (connectionError) return connectionError;
  if (!input.name.trim()) return "请填写服务名称。";
  if (!input.quickModel.trim() || !input.deepModel.trim()) {
    return "请填写快速模式和深度思考模式的模型 ID。";
  }
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 16 || input.maxOutputTokens > 32_768) {
    return "单次最大输出请填写 16–32,768 之间的整数。";
  }
  for (const amount of [input.imageQuotaTokens ?? 0, input.webSearchQuotaTokens ?? 0]) {
    if (!Number.isSafeInteger(amount) || amount < 0 || amount > 10_000_000) return "工具折算同频点需填写 0 到 10,000,000 之间的整数。";
  }
  const visionReserve = input.visionInputReserveTokens ?? 4096;
  if (!Number.isSafeInteger(visionReserve) || visionReserve < 256 || visionReserve > 131072) return "每张图片的输入预留需填写 256 到 131072 之间的整数估算值。";
  if (input.webSearchProtocol !== undefined && input.webSearchProtocol !== "standard" && input.webSearchProtocol !== "compatible") return "请选择标准或兼容搜索接口。";
  if (input.imageModel?.trim() && !(input.imageQuotaTokens && input.imageQuotaTokens > 0)) return "启用图片模型前，请设置每张图片折算的同频点。";
  if (input.imageBaseUrl?.trim()) {
    let base: string;
    try { base = normalizeAiBaseUrl(input.imageBaseUrl); } catch { return "请填写有效的图片 HTTPS API 地址。"; }
    const previous = saved?.imageBaseUrl ? normalizeAiBaseUrl(saved.imageBaseUrl) : "";
    if ((!saved?.imageApiKeyConfigured || previous !== base) && !input.imageApiKey?.trim()) return "首次接入或更换图片 API 地址后，请重新填写图片密钥。";
  } else if (input.imageApiKey?.trim()) return "填写独立图片密钥时，还需填写图片 API 地址。";
  if (input.webSearchEnabled && (input.protocol !== "responses" || !(input.webSearchQuotaTokens && input.webSearchQuotaTokens > 0))) return "联网搜索需要 Responses 协议，并设置每次搜索折算的同频点。";
  return "";
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

// Never surface an arbitrary upstream response: it may echo the administrator's key.
export function adminAiErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiRequestError)) return fallback;
  const knownErrors: Record<string, string> = {
    AI_URL_INVALID: "请输入有效的 HTTPS API 地址。",
    AI_URL_UNSAFE: "请使用公网 HTTPS API 域名，不要包含端口、账号或查询参数。",
    AI_KEY_REQUIRED: "首次接入或更换 API 地址后，请重新填写密钥。",
    AI_IMAGE_KEY_REQUIRED: "首次接入或更换图片 API 地址后，请重新填写图片密钥。",
    AI_IMAGE_QUOTA_REQUIRED: "请设置每张图片折算的同频点后再启用图片生成。",
    AI_SEARCH_CONFIG_INVALID: "联网搜索需要 Responses 协议和大于 0 的折算同频点，请核对模型是否支持。",
    AI_VISION_CONFIG_INVALID: "每张图片的输入预留需填写 256 到 131072 之间的整数估算值。",
    AI_ASSET_STORAGE_FULL: "图片存储空间已满，请让成员下载并删除不再需要的图片。",
    AI_PROVIDER_AUTH: "API 密钥无效或无权访问，请核对服务商的密钥配置。",
    AI_PROVIDER_LIMIT: "服务商余额不足或请求频繁，请检查服务商账号后重试。",
    AI_PROVIDER_REDIRECT: "该地址发生跳转；为保护密钥，请填写服务商提供的最终 API 地址。",
    AI_MODELS_UNAVAILABLE: "服务商未提供可读取的模型列表，可手动填写模型 ID。",
    AI_CONNECTION_FAILED: "无法连接 AI 服务，请核对 API 地址或稍后重试。",
    AI_ENCRYPTION_UNAVAILABLE: "服务器安全存储尚未配置，暂时不能保存密钥。",
    AI_KEY_UNREADABLE: "已保存的密钥无法读取，请重新填写并保存密钥。",
    AI_CONFIG_CHANGED: "接入配置刚被修改，请重新填写密钥后保存。",
    AI_QUOTA_BELOW_USED: "额度状态已变化；请刷新后重新设置，总限额不能低于已用和处理中预留的同频点。",
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
