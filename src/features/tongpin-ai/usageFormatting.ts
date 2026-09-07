import type { AiUsage, AiProviderDiagnostic } from "../../../shared/ai";
import { formatAiPoints } from "./quotaFormatting";
const number = (value: number) => value.toLocaleString("zh-CN");

export function aiUsageDescription(usage: AiUsage): string {
  if (usage.billingKind === "image_conversion") return `图片生成折算 ${formatAiPoints(usage.convertedTokens ?? usage.totalTokens)}`;
  const text = `输入 ${number(usage.inputTokens)} / 输出 ${number(usage.outputTokens)} Token`;
  return text + ((usage.convertedTokens ?? 0) > 0 ? ` · 搜索折算 ${formatAiPoints(usage.convertedTokens!)}` : "") + (usage.estimated ? " · 文本用量待核对" : "");
}

export function aiUsageTotal(usage: AiUsage): string {
  return formatAiPoints(usage.totalTokens);
}

export function aiDiagnosticDescription(diagnostic: AiProviderDiagnostic): string {
  const labels: Record<AiProviderDiagnostic["category"], string> = {
    authentication: "密钥或分组权限异常", rate_limit: "服务商额度或频率限制", redirect: "接口重定向",
    invalid_request: "接口参数不被接受", timeout: "服务商处理超时", conflict: "服务商请求冲突",
    upstream_unavailable: "服务商暂时故障", rejected: "服务商拒绝请求",
  };
  return `HTTP ${diagnostic.httpStatus} · ${labels[diagnostic.category] ?? "服务商异常"}`;
}
