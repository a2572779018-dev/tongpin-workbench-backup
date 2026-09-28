import type { AiDispatchDecision, AiMode } from "../../shared/ai";
import { AiError } from "./security";
import { parsePublicAnalysisSummary } from "./publicExplanation";

const TOOL_KINDS = new Set<AiDispatchDecision["kind"]>(["image", "video", "presentation", "computer"]);
// Model prose legitimately carries format characters: emoji ZWJ sequences
// (👨‍💻), ZWNJ, variation selectors, soft hyphens, a BOM. Only reject what
// changes how the text reads: C0/C1 controls (prose keeps \t \n \r), bidi
// embeddings/overrides/isolates and lone surrogates. trim() drops a BOM.
const UNSAFE_PROSE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\p{Cs}]/u;
const UNSAFE_LINE = /[\p{Cc}\u202a-\u202e\u2066-\u2069\p{Cs}]/u;

function clean(value: unknown, label: string, max: number, multiline = false): string {
  const unsafe = multiline ? UNSAFE_PROSE : UNSAFE_LINE;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || unsafe.test(value)) {
    throw new AiError(502, "AI_DISPATCH_INVALID", `AI 返回的${label}不完整`);
  }
  return value.trim();
}

/** Parse only the public, schema-bound dispatcher result. Provider hidden
 * reasoning fields are discarded earlier by parseProviderResult(). */
export function parseAiDispatchDecision(content: string, mode: AiMode, options: { allowPlainText?: boolean } = {}): AiDispatchDecision {
  const trimmed = content.trim();
  const tagged = trimmed.startsWith("<tool_request>");
  // Legacy gateways can still return the old envelope. A partial envelope is
  // never treated as an executable tool or rendered as an ordinary answer.
  const legacy = /^\s*(?:```(?:json)?\s*)?\{\s*"(?:kind|content|prompt|analysisSummary|clarification)"\s*:/.test(content);
  if (options.allowPlainText && !tagged && !legacy) return { kind: "text", content: clean(content, "文字答复", 128_000, true) };
  if (tagged && !trimmed.endsWith("</tool_request>")) throw new AiError(502, "AI_DISPATCH_INVALID", "AI 没有返回完整的工具请求");
  if (tagged) content = trimmed.slice("<tool_request>".length, -"</tool_request>".length);
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
