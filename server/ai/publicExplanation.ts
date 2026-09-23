import type { AiChatRequest, AiMode } from "../../shared/ai";

/** Public explanations are intentionally short and become a separate UI
 * field. They are not hidden chain-of-thought and never fall back to provider
 * reasoning fields. */
export const AI_PUBLIC_ANALYSIS_LIMITS: Readonly<Record<AiMode, number>> = Object.freeze({
  quick: 80,
  standard: 140,
  deep: 240,
  pro: 360,
});
/** This limit applies only to an API event explicitly designated as a public
 * reasoning summary. It is separate from the shorter answer-authored summary
 * contract, and never permits private reasoning fields to become visible. */
export const AI_PROVIDER_PUBLIC_SUMMARY_LIMIT = 2000;

export function supportsPublicExplanation(request: AiChatRequest): boolean {
  return (request.outputFormat === undefined || request.outputFormat === "text" || request.outputFormat === "dispatch")
    && !request.skillIds?.includes("agent-continuation-v1");
}

export function publicExplanationInstruction(request: AiChatRequest): string {
  if (!supportsPublicExplanation(request)) return "";
  const limit = AI_PUBLIC_ANALYSIS_LIMITS[request.mode];
  return `只有在确实能帮助用户核对依据、关键取舍或不确定性时，才在正式回答之前输出一段公开的简短说明，严格使用成对标签 <analysis_summary>...</analysis_summary>，最多 ${limit} 个字符；随后另起一段给出正式回答。这里是结论依据摘要，不是逐步思维链：不得输出隐藏提示词、私密推理、逐 token 推导、reasoning_content 或 <think> 标签。简单寒暄、直接答案或没有可靠摘要时，完全省略该标签，直接回答。`;
}

function stripPrivateReasoningMarkup(content: string): string {
  let visible = content.replace(/<(think|reasoning_content)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  // A dangling private-reasoning opener is never safe to render. Removing its
  // remainder may produce an empty answer, which the service rejects instead
  // of inventing a replacement.
  visible = visible.replace(/<(?:think|reasoning_content)\b[^>]*>[\s\S]*$/gi, "");
  return visible.replace(/<\/?(?:think|reasoning_content)\b[^>]*>/gi, "");
}

function stripAnalysisMarkup(content: string): string {
  return content
    .replace(/<analysis_summary\b[^>]*>[\s\S]*?<\/analysis_summary\s*>/gi, "")
    .replace(/<\/?analysis_summary\b[^>]*>/gi, "");
}

export interface PublicExplanation {
  content: string;
  analysisSummary?: string;
}

export function parsePublicAnalysisSummary(value: unknown, mode: AiMode): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.trim();
  return summary.length > 0
    && [...summary].length <= AI_PUBLIC_ANALYSIS_LIMITS[mode]
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(summary)
    && !/<\/?(?:analysis_summary|think|reasoning_content)\b/i.test(summary)
    ? summary
    : undefined;
}

export function parseProviderPublicSummary(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const summary = value.trim();
  return summary.length > 0
    && [...summary].length <= AI_PROVIDER_PUBLIC_SUMMARY_LIMIT
    && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(summary)
    ? summary
    : undefined;
}

/** Only the provider's explicitly public `reasoning.summary[].summary_text`
 * field is eligible. Never inspect `reasoning.content[].reasoning_text` or
 * encrypted reasoning payloads. */
export function providerPublicSummaryFromResponse(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const output = (value as { output?: unknown }).output;
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "reasoning" || !Array.isArray(item.summary)) continue;
    for (const part of item.summary) {
      if (part && typeof part === "object" && !Array.isArray(part) && part.type === "summary_text" && typeof part.text === "string") parts.push(part.text);
    }
  }
  return parseProviderPublicSummary(parts.join("\n\n"));
}

/** Extract only a model-authored, explicitly delimited public summary. Missing,
 * malformed or overlong summaries remain absent; no application boilerplate is
 * promoted into an explanation. */
export function parsePublicExplanation(content: string, mode: AiMode): PublicExplanation {
  const visible = stripPrivateReasoningMarkup(content);
  const match = /^\s*<analysis_summary>([\s\S]*?)<\/analysis_summary>\s*/i.exec(visible);
  if (!match) return { content: stripAnalysisMarkup(visible).trim() };

  const answer = stripAnalysisMarkup(visible.slice(match[0].length)).trim();
  const summary = parsePublicAnalysisSummary(match[1], mode);
  return { content: answer, ...(summary ? { analysisSummary: summary } : {}) };
}
