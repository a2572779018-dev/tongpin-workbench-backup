import type { AiChatResponse, AiUsage } from "./ai";
import type { AiSubagentUpdate } from "./aiMultiAgent";

export type AiRunEventPayload =
  | { type: "run_started"; data: { startedAt: number } }
  | { type: "answer_delta" | "public_summary_delta"; data: { delta: string } }
  /** Reasoning text a chat-completions provider chose to publish in
   * `delta.reasoning_content`. Display-only: never part of the final response,
   * the persisted message, or any later model context. Emitted only to clients
   * that opted in with `liveProgress: true`. */
  | { type: "reasoning_delta"; data: { delta: string; source: "provider_reasoning_content" } }
  /** Real provider tool-call state (currently Responses `web_search_call`).
   * `callId` is an application-local ordinal, never a provider item id.
   * Emitted only to clients that opted in with `liveProgress: true`. */
  | { type: "tool_progress"; data: AiToolProgress }
  /** 多 Agent 协作 lifecycle (shared/aiMultiAgent.ts). Emitted only to clients
   * that opted in with `subagentEvents: true`; older clients reject unknown types. */
  | { type: "subagent_update"; data: AiSubagentUpdate }
  /** Emitted only after a provider-reported token usage has been durably settled.
   * totalTokens may include administrator-configured search conversion units;
   * inputTokens/outputTokens remain the provider-reported text counts. */
  | { type: "usage_updated"; data: { usage: AiUsage; status: "completed" | "failed" | "uncertain"; providerReported: true } }
  | { type: "run_finished"; data: { response: AiChatResponse } }
  | { type: "run_failed"; data: { error: { code: string; message: string } } };
export interface AiToolProgress {
  tool: "web_search";
  callId: string;
  status: "in_progress" | "searching" | "completed" | "failed";
  /** Provider-reported search query, bounded and control-character free. */
  query?: string;
  /** Number of sources the provider attached to this call, when reported. */
  sourceCount?: number;
}
export const AI_TOOL_PROGRESS_STATUSES: readonly AiToolProgress["status"][] = ["in_progress", "searching", "completed", "failed"];
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
