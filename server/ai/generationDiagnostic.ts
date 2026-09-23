import type { AiGenerationDiagnostic, AiUsage } from "../../shared/ai";
import { object } from "./provider";

export function generationDiagnostic(raw: unknown, headers: Headers, protocol: AiGenerationDiagnostic["protocol"], outputLimit: number, startedAt: number, usage: AiUsage | null): AiGenerationDiagnostic {
  const root = object(raw), choices = Array.isArray(root.choices) ? object(root.choices[0]) : {};
  const finish = choices.finish_reason;
  const detail = object(root.incomplete_details).reason;
  const tokens = object(object(root.usage)[protocol === "responses" ? "output_tokens_details" : "completion_tokens_details"]).reasoning_tokens;
  const candidateId = headers.get("x-request-id");
  // Reject arbitrary provider strings even when they look like an identifier.
  const requestId = candidateId && /^(?:req_[a-f0-9]{16,64}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(candidateId) ? candidateId : undefined;
  return {
    protocol, outputLimit, durationMs: Math.max(0, Date.now() - startedAt),
    status: root.error ? "failed" : root.status === "incomplete" || finish === "length" ? "incomplete" : root.status === "completed" || finish === "stop" ? "completed" : root.status === "failed" || finish === "content_filter" ? "failed" : "unknown",
    ...(["stop", "length", "content_filter", "tool_calls"].includes(String(finish)) ? { finishReason: finish as AiGenerationDiagnostic["finishReason"] } : {}),
    ...(detail === undefined ? {} : { incompleteReason: ["max_output_tokens", "content_filter", "stream_interrupted"].includes(String(detail)) ? detail as AiGenerationDiagnostic["incompleteReason"] : "unknown" }),
    ...(Number.isSafeInteger(tokens) && Number(tokens) >= 0 && Number(tokens) <= 1_000_000_000 ? { reasoningTokens: Number(tokens) } : {}),
    ...(usage ? { actualUsage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens } } : {}),
    ...(requestId ? { providerRequestId: requestId } : {}),
  };
}
