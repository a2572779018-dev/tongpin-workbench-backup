import type { AiUsage } from "../../../shared/ai";
const number = (value: number) => value.toLocaleString("zh-CN");

export function aiUsageDescription(usage: AiUsage): string {
  if (usage.billingKind === "image_conversion") return `图片生成折算 ${number(usage.convertedTokens ?? usage.totalTokens)} 额度`;
  const text = `输入 ${number(usage.inputTokens)} / 输出 ${number(usage.outputTokens)} Token`;
  return text + ((usage.convertedTokens ?? 0) > 0 ? ` · 搜索折算 ${number(usage.convertedTokens!)} 额度` : "") + (usage.estimated ? " · 文本用量待核对" : "");
}

export function aiUsageTotal(usage: AiUsage): string {
  return number(usage.totalTokens) + (usage.billingKind === "image_conversion" || usage.billingKind === "tokens_with_search" ? " 额度" : " Token");
}
