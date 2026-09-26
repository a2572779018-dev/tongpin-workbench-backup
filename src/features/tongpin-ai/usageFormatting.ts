import type { AiUsage, AiProviderDiagnostic } from "../../../shared/ai";
import { formatAiPoints } from "./quotaFormatting";
const number = (value: number) => value.toLocaleString("zh-CN");

export function aiUsageDescription(usage: AiUsage): string {
  if (usage.billingKind === "video_conversion") return `视频生成折算 ${formatAiPoints(usage.convertedTokens ?? usage.totalTokens)}`;
  if (usage.billingKind === "image_conversion") return `图片生成折算 ${formatAiPoints(usage.convertedTokens ?? usage.totalTokens)}`;
  if (usage.billingKind === "speech_to_text_conversion") return `语音转文字折算 ${formatAiPoints(usage.convertedTokens ?? usage.totalTokens)}${usage.estimated ? " · 待核对" : ""}`;
  if (usage.billingKind === "text_to_speech_conversion") return `朗读折算 ${formatAiPoints(usage.convertedTokens ?? usage.totalTokens)}${usage.estimated ? " · 待核对" : ""}`;
  if (usage.billingKind === "memory_conversion") return `记忆更新折算 ${formatAiPoints(usage.convertedTokens ?? usage.totalTokens)}`;
  const text = `输入 ${number(usage.inputTokens)} / 输出 ${number(usage.outputTokens)} Token`;
  const calls = Number.isSafeInteger(usage.searchCalls) && Number(usage.searchCalls) > 0 ? ` ${number(usage.searchCalls!)} 次` : "";
  return text + ((usage.convertedTokens ?? 0) > 0 ? ` · 搜索${calls}折算 ${formatAiPoints(usage.convertedTokens!)}` : "") + ((usage.tokenUsageEstimated ?? usage.estimated) ? " · 文本用量待核对" : "");
}

export function aiUsageTotal(usage: AiUsage): string {
  return formatAiPoints(usage.totalTokens);
}

export function aiDiagnosticDescription(diagnostic: AiProviderDiagnostic): string {
  const labels: Record<AiProviderDiagnostic["category"], string> = {
    authentication: "密钥或分组权限异常", rate_limit: "服务商额度或频率限制", redirect: "接口重定向",
    permission: "模型或分组权限被拒绝", access_denied: "服务商拒绝访问，原因待核查", gateway_block: "服务商安全网关拦截",
    invalid_request: "接口参数不被接受", timeout: "服务商处理超时", conflict: "服务商请求冲突",
    upstream_unavailable: "服务商暂时故障", rejected: "服务商拒绝请求",
  };
  return `HTTP ${diagnostic.httpStatus} · ${labels[diagnostic.category] ?? "服务商异常"}`;
}
