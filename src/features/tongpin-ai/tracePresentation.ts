import type { AiHarnessPublicStep, AiHarnessTrace } from "../../../shared/ai";

const MEMBER_VISIBLE_TRACE_KINDS = new Set<AiHarnessPublicStep["kind"]>([
  "workflow",
  "tool",
  "approval",
  "result",
]);

/** Strategy, tier routing, planning and model-response rows are platform
 * boilerplate rather than user evidence. Keep only genuine workflow/tool state. */
export function memberVisibleHarnessSteps(trace: AiHarnessTrace): AiHarnessPublicStep[] {
  return trace.steps.filter((step) => MEMBER_VISIBLE_TRACE_KINDS.has(step.kind));
}
