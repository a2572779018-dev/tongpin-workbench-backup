import type { AiDispatchDecision, AiMode } from "../../shared/ai";
import { AiError } from "./security";
import { parsePublicAnalysisSummary } from "./publicExplanation";

const TOOL_KINDS = new Set<AiDispatchDecision["kind"]>(["image", "video", "presentation", "computer"]);

function clean(value: unknown, label: string, max: number, multiline = false): string {
  const unsafe = multiline
    ? /[\p{Cf}\p{Cs}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u
    : /[\p{Cc}\p{Cf}\p{Cs}]/u;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || unsafe.test(value)) {
    throw new AiError(502, "AI_DISPATCH_INVALID", `AI 返回的${label}不完整`);
  }
  return value.trim();
}

/** Parse only the public, schema-bound dispatcher result. Provider hidden
 * reasoning fields are discarded earlier by parseProviderResult(). */
export function parseAiDispatchDecision(content: string, mode: AiMode): AiDispatchDecision {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, ""));
  } catch {
    throw new AiError(502, "AI_DISPATCH_INVALID", "AI 没有返回完整的任务类型");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AiError(502, "AI_DISPATCH_INVALID", "AI 返回的任务类型不正确");
  const value = raw as Record<string, unknown>;
  const textKeys = value.analysisSummary === undefined ? ["content", "kind"] : ["analysisSummary", "content", "kind"];
  if (value.kind === "text" && Object.keys(value).sort().every((key, index, keys) => keys.length === textKeys.length && key === textKeys[index])) {
    const analysisSummary = parsePublicAnalysisSummary(value.analysisSummary, mode);
    return { kind: "text", content: clean(value.content, "文字答复", 120_000, true), ...(analysisSummary ? { analysisSummary } : {}) };
  }
  if (typeof value.kind === "string" && TOOL_KINDS.has(value.kind as AiDispatchDecision["kind"])) {
    const allowedKeys = value.clarification === undefined ? ["kind", "prompt"] : ["clarification", "kind", "prompt"];
    const keys = Object.keys(value).sort();
    if (keys.length === allowedKeys.length && keys.every((key, index) => key === allowedKeys.sort()[index])) {
      return {
        kind: value.kind as "image" | "video" | "presentation" | "computer",
        prompt: clean(value.prompt, "工具请求", 12_000, true),
        ...(value.clarification === undefined ? {} : { clarification: clean(value.clarification, "补充问题", 500) }),
      };
    }
  }
  throw new AiError(502, "AI_DISPATCH_INVALID", "AI 返回的任务类型超出了已开放能力");
}
