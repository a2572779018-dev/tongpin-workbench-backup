import { describe, expect, it } from "vitest";
import type { AiHarnessPublicStep, AiHarnessTrace } from "../../../shared/ai";
import { memberVisibleHarnessSteps } from "./tracePresentation";

const TIME = "2026-09-21T08:00:00.000Z";
function step(id: string, kind: AiHarnessPublicStep["kind"], status: AiHarnessPublicStep["status"] = "succeeded"): AiHarnessPublicStep {
  return { id, kind, status, capability: "chat", title: id, summary: `${id} summary`, createdAt: TIME, updatedAt: TIME };
}

describe("member-visible harness progress", () => {
  it("hides routing boilerplate while retaining genuine workflow and tool progress", () => {
    const trace: AiHarnessTrace = {
      runId: "run-1",
      tier: "deep",
      strategy: "plan_execute",
      status: "running",
      reasoningSummary: "internal application summary",
      nextAction: "poll",
      toolBudget: { used: 1, max: 3, remaining: 2 },
      steps: [
        step("strategy", "strategy"),
        step("route", "route"),
        step("plan", "plan"),
        step("model", "model"),
        step("workflow", "workflow"),
        step("tool", "tool", "running"),
        step("approval", "approval", "waiting_approval"),
        step("result", "result", "planned"),
      ],
    };

    expect(memberVisibleHarnessSteps(trace).map((step) => step.kind)).toEqual([
      "workflow",
      "tool",
      "approval",
      "result",
    ]);
  });

  it("does not manufacture a visible trace when the run only has platform rows", () => {
    const trace: AiHarnessTrace = {
      runId: "run-2",
      tier: "quick",
      strategy: "direct",
      status: "succeeded",
      reasoningSummary: "internal",
      nextAction: "none",
      toolBudget: { used: 0, max: 0, remaining: 0 },
      steps: [step("model", "model")],
    };
    expect(memberVisibleHarnessSteps(trace)).toEqual([]);
  });
});
