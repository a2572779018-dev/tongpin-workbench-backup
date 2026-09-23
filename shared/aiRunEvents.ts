import type { AiChatResponse } from "./ai";

export type AiRunEventPayload =
  | { type: "run_started"; data: { startedAt: number } }
  | { type: "answer_delta" | "public_summary_delta"; data: { delta: string } }
  | { type: "run_finished"; data: { response: AiChatResponse } }
  | { type: "run_failed"; data: { error: { code: string; message: string } } };
export type AiRunEvent = AiRunEventPayload & { requestId: string; runId: string; stepId: string; seq: number; timestamp: number };
