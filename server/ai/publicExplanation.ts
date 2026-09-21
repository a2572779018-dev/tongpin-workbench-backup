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

export function supportsPublicExplanation(request: AiChatRequest): boolean {
  return (request.outputFormat === undefined || request.outputFormat === "text")
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
