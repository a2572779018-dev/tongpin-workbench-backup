import type { AiHarnessTrace } from "../../../shared/ai";

const TERMINAL_TRACE = new Set<AiHarnessTrace["status"]>(["succeeded", "failed", "cancelled", "uncertain"]);

export interface HarnessTraceRefresh {
  suffix: "";
  method: "GET";
}

/** Visibility is intentionally not an input: a collapsed progress disclosure
 * may observe the server-owned run, but opening or mounting it must never
 * claim a continuation or invoke a model. Server-side scheduling owns that. */
export function harnessTraceRefresh(trace: AiHarnessTrace): HarnessTraceRefresh | null {
  if (TERMINAL_TRACE.has(trace.status)) return null;
  return { suffix: "", method: "GET" };
}

/** Tool execution recovery keeps using `requestId`; trace polling follows the
 * separately persisted parent plan so image/PPT execution IDs cannot be
 * mistaken for the Harness run being continued. */
export function harnessTraceRequestId(message: { requestId?: string; harnessPlanRequestId?: string }): string | undefined {
  return message.harnessPlanRequestId ?? message.requestId;
}

/** Avoids a write/render loop when a poll returns the same public snapshot. */
export function sameHarnessTrace(left: AiHarnessTrace | undefined, right: AiHarnessTrace): boolean {
  if (!left) return false;
  if (left.runId !== right.runId || left.status !== right.status || left.nextAction !== right.nextAction
    || left.reasoningSummary !== right.reasoningSummary || left.steps.length !== right.steps.length
    || left.toolBudget.used !== right.toolBudget.used || left.toolBudget.max !== right.toolBudget.max) return false;
  return left.steps.every((step, index) => {
    const candidate = right.steps[index];
    return Boolean(candidate) && step.id === candidate.id && step.status === candidate.status
      && step.updatedAt === candidate.updatedAt && step.summary === candidate.summary;
  });
}
