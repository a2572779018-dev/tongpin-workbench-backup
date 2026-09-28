import { describe, expect, it } from "vitest";
import { AI_WORKFLOW_TEMPLATES, aiWorkflowStepSearches, readAiWorkflowUpdate, workflowActivityText } from "../../shared/aiWorkflows";

const valid = () => ({
  workflowId: "hub-research-brief",
  steps: [
    { id: "scope", title: "界定问题", status: "done", durationMs: 1200, activity: "核心问题是成本" },
    { id: "evidence", title: "整理证据", status: "running", activity: "联网搜索：报价" },
    { id: "deliver", title: "形成简报", status: "planned" },
  ],
});

describe("Hub workflow live updates", () => {
  it("accepts a well-formed step list and rejects anything else", () => {
    expect(readAiWorkflowUpdate(valid())).toEqual(valid());
    const bad: unknown[] = [
      { ...valid(), extra: 1 },
      { ...valid(), workflowId: "hub-unknown" },
      { ...valid(), steps: valid().steps.slice(0, 2) },
      { ...valid(), steps: [valid().steps[1], valid().steps[0], valid().steps[2]] },
      { ...valid(), steps: valid().steps.map(step => ({ ...step, status: "running" })) },
      { ...valid(), steps: [{ ...valid().steps[0], status: "unknown" }, ...valid().steps.slice(1)] },
      { ...valid(), steps: [{ ...valid().steps[0], activity: "x".repeat(81) }, ...valid().steps.slice(1)] },
      { ...valid(), steps: [{ ...valid().steps[0], activity: "换行\n不行" }, ...valid().steps.slice(1)] },
      { ...valid(), steps: [{ ...valid().steps[0], durationMs: -1 }, ...valid().steps.slice(1)] },
      { ...valid(), steps: [{ ...valid().steps[0], secret: "x" }, ...valid().steps.slice(1)] },
      null, [], "text",
    ];
    for (const value of bad) expect(readAiWorkflowUpdate(value)).toBeUndefined();
  });

  it("bounds an activity line and marks only the research evidence step as able to search", () => {
    expect(workflowActivityText("  撰写中：\n第一行\t第二行  ")).toBe("撰写中： 第一行 第二行");
    expect([...workflowActivityText("字".repeat(200))!]).toHaveLength(80);
    expect(workflowActivityText("   ")).toBeUndefined();
    const searching = AI_WORKFLOW_TEMPLATES.flatMap(workflow => workflow.steps.filter(aiWorkflowStepSearches).map(step => `${workflow.id}:${step.id}`));
    expect(searching).toEqual(["hub-research-brief:evidence"]);
  });
});
