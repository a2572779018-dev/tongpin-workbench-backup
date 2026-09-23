import { describe, expect, it } from "vitest";
import type { AiHarnessTrace } from "../../../shared/ai";
import { harnessTraceRefresh, harnessTraceRequestId, sameHarnessTrace } from "./runTracePolling";
import { replaceChatMessage } from "./chatRequests";
import { hydrateWorkspace, serializeWorkspace } from "./workspaceState";

function trace(overrides: Partial<AiHarnessTrace> = {}): AiHarnessTrace {
  return {
    runId: "run-1", tier: "quick", strategy: "plan_execute", status: "waiting_approval",
    reasoningSummary: "等待确认", nextAction: "approve_tool", toolBudget: { used: 1, max: 3, remaining: 2 },
    steps: [{ id: "step-1", kind: "tool", capability: "image", title: "工具提案", summary: "尚未执行", status: "waiting_approval", createdAt: "2026-09-21T00:00:00.000Z", updatedAt: "2026-09-21T00:00:00.000Z" }],
    ...overrides,
  };
}

describe("Harness trace read-only refresh", () => {
  it("keeps polling a collapsed non-terminal trace without claiming planned work", () => {
    // Disclosure visibility is intentionally absent from this decision API.
    expect(harnessTraceRefresh(trace())).toEqual({ suffix: "", method: "GET" });
    expect(harnessTraceRefresh(trace({ status: "planned", nextAction: "resume" }))).toEqual({ suffix: "", method: "GET" });
    expect(harnessTraceRefresh(trace({ status: "running", nextAction: "poll" }))).toEqual({ suffix: "", method: "GET" });
    expect(harnessTraceRefresh(trace({ status: "succeeded", nextAction: "none" }))).toBeNull();
  });

  it("polls the parent plan while keeping the execution request available for result recovery", () => {
    const message = { requestId: "execution-request", harnessPlanRequestId: "parent-plan-request" };
    expect(harnessTraceRequestId(message)).toBe("parent-plan-request");
    expect(message.requestId).toBe("execution-request");
    expect(harnessTraceRequestId({ requestId: "ordinary-request" })).toBe("ordinary-request");
  });

  it("writes a changed polled trace into the message snapshot and round-trips it", () => {
    const initial = trace();
    const latest = trace({ status: "planned", nextAction: "resume", reasoningSummary: "等待续跑", steps: [{ ...initial.steps[0], status: "succeeded", summary: "已完成", updatedAt: "2026-09-21T00:00:01.000Z" }] });
    const conversations = [{ id: "conversation-1", title: "任务", timeLabel: "刚刚", messages: [{ id: "message-1", role: "assistant" as const, content: "已创建计划", time: "10:00", requestId: "request-1", trace: initial }] }];
    const updated = replaceChatMessage(conversations, "conversation-1", "message-1", { trace: latest });
    const saved = serializeWorkspace({ view: "chat", mode: "quick", conversations: updated, projects: [], artifacts: [], drafts: {}, activeConversationId: "conversation-1", activeProjectId: null, enabledSkillIds: new Set() });
    const restored = hydrateWorkspace(saved);
    expect(restored.conversations[0].messages[0].trace).toEqual(latest);
    expect(sameHarnessTrace(initial, latest)).toBe(false);
    expect(sameHarnessTrace(restored.conversations[0].messages[0].trace, latest)).toBe(true);
  });
});
