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
export type AiRunEvent = AiRunEventPayload & {
  requestId: string;
  runId: string;
  stepId: string;
  seq: number;
  timestamp: number;
  /** Optional additive envelope: old clients and journal entries retain the same event types. */
  schemaVersion?: 1;
  eventId?: string;
  attemptId?: string;
  conversationId?: string;
};

/** Media tasks have their own durable run and event cursor. These payloads
 * describe committed task-state transitions, not speculative model output. */
export type AiMediaTaskEventPayload =
  | { type: "artifact_ready"; data: { capability: "image" | "video"; artifactIds: string[] } }
  | { type: "question_opened"; data:
    | { kind: "free_text"; questionId: string; prompt: string; deadlineAt: number }
    | { kind: "choice"; questionId: string; options: Array<{ id: string; label: string; estimatedPoints: number }>; defaultOptionId: string; deadlineAt: number } };
export type AiMediaTaskEvent = AiMediaTaskEventPayload & {
  requestId: string;
  runId: string;
  stepId: string;
  seq: number;
  timestamp: number;
};
