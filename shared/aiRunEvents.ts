import type { AiChatResponse, AiUsage } from "./ai";

export type AiRunEventPayload =
  | { type: "run_started"; data: { startedAt: number } }
  | { type: "answer_delta" | "public_summary_delta"; data: { delta: string } }
  /** Emitted only after a provider-reported token usage has been durably settled.
   * totalTokens may include administrator-configured search conversion units;
   * inputTokens/outputTokens remain the provider-reported text counts. */
  | { type: "usage_updated"; data: { usage: AiUsage; status: "completed" | "failed" | "uncertain"; providerReported: true } }
  | { type: "run_finished"; data: { response: AiChatResponse } }
  | { type: "run_failed"; data: { error: { code: string; message: string } } };
export type AiRunEvent = AiRunEventPayload & { requestId: string; runId: string; stepId: string; seq: number; timestamp: number };
