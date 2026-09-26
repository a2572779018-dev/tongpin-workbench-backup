import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiSubagentUpdate } from "../../../shared/aiMultiAgent";
import {
  applyReplyProcessEvent,
  EMPTY_REPLY_PROCESS_LIVE,
  readReplyProcess,
  replyProcessFromRunEvents,
  settleReplyProcess,
  type AiReplyProcess,
  type AiReplyProcessAgentsStep,
  type AiReplyProcessEvent,
  type AiReplyProcessLive,
  type AiReplyProcessLiveAgents,
} from "../../../shared/aiReplyProcess";
import { defaultMultiAgentSettings, multiAgentSettingsError } from "./AdminAiMultiAgentSettings";
import { ChatMessageRow } from "./ChatMessageRow";
import { requestMultiAgentStop } from "./multiAgentClient";
import { ReplyProcessDetailsContext } from "./ReplyProcess";
import { agentsPart, replyProcessActivity, replyProcessSummary, replyProcessView } from "./replyProcessModel";
import type { TongpinAIMessage } from "./types";

const update = (timestamp: number, data: AiSubagentUpdate): AiReplyProcessEvent => ({ type: "subagent_update", data, timestamp });
const at = (timestamp: number, payload: AiReplyProcessEvent): AiReplyProcessEvent => ({ ...payload, timestamp });
const PLAN: AiSubagentUpdate = { phase: "plan", maxConcurrency: 2, subtasks: [
  { id: "agent-1", role: "研究员", title: "查天气", task: "查找深圳今天的天气。\n只列事实，注明来源。", search: true },
  { id: "agent-2", role: "分析员", title: "比较方案", task: "比较两种出行方案的成本。", search: false },
  { id: "agent-3", role: "核对员", title: "核对结论", task: "核对前两项的结论是否一致。", search: false },
] };
const finished = at(8_001, { type: "run_finished", data: { response: { requestId: "r", content: "综合回答", model: "m",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
  quota: { limitTokens: 1, usedTokens: 0, reservedTokens: 0, remainingTokens: 1, inputTokens: 0, outputTokens: 0 } } } });

/** A real run's journal order: 任务分解 → sub-agents (one searches, one times out) → 结果综合. */
const EVENTS: AiReplyProcessEvent[] = [
  at(1_000, { type: "run_started", data: { startedAt: 1_000 } }),
  update(1_010, { phase: "planning" }),
  update(2_000, PLAN),
  update(2_010, { phase: "start", id: "agent-1" }),
  update(2_020, { phase: "start", id: "agent-2" }),
  update(2_100, { phase: "search", id: "agent-1", callId: "search-1", status: "in_progress" }),
  update(2_500, { phase: "search", id: "agent-1", callId: "search-1", status: "completed", query: "深圳 天气", sourceCount: 3 }),
  update(2_600, { phase: "progress", id: "agent-1", chars: 14, preview: "深圳今天晴，气温 25 度。" }),
  update(3_000, { phase: "progress", id: "agent-2", chars: 9, preview: "方案 A 更省钱。" }),
  update(4_000, { phase: "stop", id: "agent-1", durationMs: 1_990, summary: "深圳今天晴，适合出行。", searchCount: 1, sourceCount: 3, sources: [1, 2] }),
  update(4_100, { phase: "start", id: "agent-3" }),
  update(5_000, { phase: "error", id: "agent-2", reason: "timeout", message: "超时未完成（90 秒）", durationMs: 2_980 }),
  update(6_000, { phase: "stop", id: "agent-3", durationMs: 1_900, summary: "结论一致。" }),
  update(6_100, { phase: "synthesis" }),
  at(7_000, { type: "answer_delta", data: { delta: "综合回答" } }),
  update(8_000, { phase: "finish", outcome: "done" }),
  finished,
];

function fold(events: AiReplyProcessEvent[]): AiReplyProcessLive {
  return events.reduce(applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE);
}
const agentsOf = (live: AiReplyProcessLive) => live.steps.find(step => step.kind === "agents") as AiReplyProcessLiveAgents;
const upTo = (timestamp: number) => fold(EVENTS.filter(event => (event.timestamp ?? 0) <= timestamp));
const assistant = (extra: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({ id: "reply", role: "assistant", content: "综合回答", time: "12:00", status: "ready", ...extra });
const rowProps = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined };
const row = (message: TongpinAIMessage, expanded = false) => {
  const element = createElement(ChatMessageRow, { ...rowProps, message });
  return renderToStaticMarkup(expanded ? createElement(ReplyProcessDetailsContext.Provider, { value: { expanded: true, revision: 1 } }, element) : element);
};
const settled = (): AiReplyProcess => replyProcessFromRunEvents(EVENTS, "completed")!;

describe("多 Agent 协作 live process", () => {
  it("walks planning → dispatching → working → synthesizing → done with per-agent statuses", () => {
    const phases: string[] = [];
    const statuses = new Map<string, string[]>();
    let live = EMPTY_REPLY_PROCESS_LIVE;
    for (const event of EVENTS) {
      live = applyReplyProcessEvent(live, event);
      const step = agentsOf(live);
      if (!step) continue;
      if (phases.at(-1) !== step.phase) phases.push(step.phase);
      for (const agent of step.agents) {
        const seen = statuses.get(agent.id) ?? [];
        if (seen.at(-1) !== agent.status) statuses.set(agent.id, [...seen, agent.status]);
      }
    }
    expect(phases).toEqual(["planning", "dispatching", "working", "synthesizing", "done"]);
    expect(Object.fromEntries(statuses)).toEqual({
      "agent-1": ["queued", "thinking", "searching", "thinking", "working", "done"],
      "agent-2": ["queued", "thinking", "working", "failed"],
      "agent-3": ["queued", "thinking", "done"],
    });
  });

  it("keeps the fields the AI 员工办公室 view reads: id, role, task, activity, times, summary, sources", () => {
    const planned = agentsOf(upTo(2_000));
    expect(planned.coordinatorActivity).toBe("已拆成 3 个子任务，正在分派");
    expect(planned.agents.map(agent => [agent.id, agent.role, agent.status, agent.activity])).toEqual([
      ["agent-1", "研究员", "queued", "排队等待"], ["agent-2", "分析员", "queued", "排队等待"], ["agent-3", "核对员", "queued", "排队等待"]]);
    expect(planned.agents[0].task).toBe("查找深圳今天的天气。\n只列事实，注明来源。");
    const searching = agentsOf(upTo(2_100));
    expect(searching.phase).toBe("working");
    expect(searching.coordinatorActivity).toBe("等待子 Agent 完成（0/3）");
    expect(searching.agents[0]).toMatchObject({ status: "searching", activity: "正在联网搜索", startedAt: 2_010 });
    expect(agentsOf(upTo(2_600)).agents[0]).toMatchObject({ status: "working", searchQuery: "深圳 天气", activity: "撰写中：深圳今天晴，气温 25 度。" });
    const done = agentsOf(fold(EVENTS));
    expect(done.agents[0]).toMatchObject({ status: "done", startedAt: 2_010, finishedAt: 4_000, durationMs: 1_990, summary: "深圳今天晴，适合出行。",
      activity: "深圳今天晴，适合出行。", searchCount: 1, sourceCount: 3, sources: [1, 2] });
    expect(done.agents[1]).toMatchObject({ status: "failed", failure: "timeout", error: "超时未完成（90 秒）", finishedAt: 5_000 });
    expect(done).toMatchObject({ phase: "done", synthesis: "done", startedAt: 1_010, finishedAt: 8_000, updatedAt: 8_000, coordinatorActivity: "已完成结果综合" });
  });

  it("ignores late or regressing events once a sub-agent or the run is final", () => {
    const done = fold(EVENTS);
    expect(applyReplyProcessEvent(done, update(9_000, { phase: "start", id: "agent-1" }))).toBe(done);
    const midRun = upTo(4_000);
    expect(applyReplyProcessEvent(midRun, update(4_050, { phase: "progress", id: "agent-1", chars: 99 }))).toBe(midRun);
    expect(applyReplyProcessEvent(midRun, update(4_050, { phase: "start", id: "agent-5" }))).toBe(midRun);
    expect(applyReplyProcessEvent(midRun, { type: "subagent_update", data: { phase: "stop", id: "agent-2", durationMs: -1 } as never })).toBe(midRun);
  });

  it("drops the step when the coordinator answers directly", () => {
    const direct = fold([update(1, { phase: "planning" }), update(2, { phase: "direct" })]);
    expect(direct.steps).toEqual([]);
    expect(settleReplyProcess(fold([update(1, { phase: "planning" })]), { outcome: "completed" })).toBeUndefined();
  });

  it("shows unfinished sub-agents as stopped once the reply is no longer streaming", () => {
    const step = agentsOf(upTo(3_000));
    const part = agentsPart(step, false);
    expect(part).toMatchObject({ phase: "cancelled", state: "failed", coordinatorActivity: "已停止" });
    expect(part.agents.map(agent => [agent.status, agent.live])).toEqual([["cancelled", false], ["cancelled", false], ["cancelled", false]]);
    expect(part.agents[0].error).toBe("已停止");
    const running = agentsPart(step, true);
    expect(running.agents.map(agent => [agent.status, agent.live])).toEqual([["working", true], ["working", true], ["queued", true]]);
    expect(running).toMatchObject({ phase: "working", startedAt: 1_010, updatedAt: 3_000 });
    expect(running.agents[0]).toMatchObject({ startedAt: 2_010 });
    // The persisted record normalizes to the same view (the AI 员工办公室 adapter reads either).
    const persisted = agentsPart(settled().steps.find(step => step.kind === "agents") as AiReplyProcessAgentsStep, false);
    expect(persisted).toMatchObject({ phase: "done", coordinatorActivity: "已完成结果综合", startedAt: 1_010, updatedAt: 8_000, finishedAt: 8_000 });
    expect(persisted.agents.map(agent => [agent.id, agent.role, agent.status, agent.activity, agent.startedAt, agent.finishedAt, agent.summary, agent.sourceCount, agent.live])).toEqual([
      ["agent-1", "研究员", "done", "深圳今天晴，适合出行。", 2_010, 4_000, "深圳今天晴，适合出行。", 3, false],
      ["agent-2", "分析员", "failed", "超时未完成（90 秒）", 2_020, 5_000, undefined, undefined, false],
      ["agent-3", "核对员", "done", "结论一致。", 4_100, 6_000, "结论一致。", undefined, false]]);
  });
});

describe("多 Agent 协作 persisted process", () => {
  it("settles to a bounded record that the reader accepts unchanged", () => {
    const process = settled();
    const agents = process.steps.find(step => step.kind === "agents") as AiReplyProcessAgentsStep;
    expect(agents).toEqual({ kind: "agents", phase: "done", maxConcurrency: 2, synthesis: "done", startedAt: 1_010, finishedAt: 8_000, agents: [
      { id: "agent-1", role: "研究员", title: "查天气", task: "查找深圳今天的天气。\n只列事实，注明来源。", status: "done", summary: "深圳今天晴，适合出行。",
        startedAt: 2_010, finishedAt: 4_000, durationMs: 1_990, searchCount: 1, sourceCount: 3, sources: [1, 2] },
      { id: "agent-2", role: "分析员", title: "比较方案", task: "比较两种出行方案的成本。", status: "failed", error: "超时未完成（90 秒）", startedAt: 2_020, finishedAt: 5_000, durationMs: 2_980 },
      { id: "agent-3", role: "核对员", title: "核对结论", task: "核对前两项的结论是否一致。", status: "done", summary: "结论一致。", startedAt: 4_100, finishedAt: 6_000, durationMs: 1_900 },
    ] });
    expect(process.durationMs).toBe(7_001);
    expect(readReplyProcess(JSON.parse(JSON.stringify(process)))).toEqual(process);
  });

  it("bounds a long subtask to the persisted excerpt", () => {
    const long = "很长的子任务说明。".repeat(60);
    const live = fold([update(1, { phase: "planning" }), update(2, { phase: "plan", maxConcurrency: 3, subtasks: [{ id: "agent-1", role: "撰稿员", title: "写初稿", task: long, search: false }] })]);
    const agents = settleReplyProcess(live, { outcome: "stopped" })!.steps[0] as AiReplyProcessAgentsStep;
    expect([...agents.agents[0].task]).toHaveLength(200);
    expect(agents).toMatchObject({ phase: "cancelled", agents: [{ status: "cancelled", error: "已停止" }] });
  });

  it.each([
    ["an unknown sub-agent id", (step: AiReplyProcessAgentsStep) => ({ ...step, agents: [{ ...step.agents[0], id: "agent-9" }] })],
    ["a duplicated sub-agent id", (step: AiReplyProcessAgentsStep) => ({ ...step, agents: [step.agents[0], step.agents[0]] })],
    ["an extra field", (step: AiReplyProcessAgentsStep) => ({ ...step, agents: [{ ...step.agents[0], prompt: "hidden" }] })],
    ["a live status", (step: AiReplyProcessAgentsStep) => ({ ...step, agents: [{ ...step.agents[0], status: "working" }] })],
    ["too much concurrency", (step: AiReplyProcessAgentsStep) => ({ ...step, maxConcurrency: 9 })],
    ["a control character in the role", (step: AiReplyProcessAgentsStep) => ({ ...step, agents: [{ ...step.agents[0], role: "研究\u0007员" }] })],
    ["an out-of-range source number", (step: AiReplyProcessAgentsStep) => ({ ...step, agents: [{ ...step.agents[0], sources: [0] }] })],
    ["a finish before the start", (step: AiReplyProcessAgentsStep) => ({ ...step, startedAt: 9_000 })],
  ])("drops a stored agents step with %s", (_name, mutate) => {
    const process = settled();
    const agents = process.steps.find(step => step.kind === "agents") as AiReplyProcessAgentsStep;
    expect(readReplyProcess({ ...process, steps: [mutate(agents)] })).toBeUndefined();
  });

  it("keeps only the first agents step", () => {
    const process = settled();
    const agents = process.steps.find(step => step.kind === "agents")!;
    expect(readReplyProcess({ ...process, steps: [agents, agents] })?.steps).toEqual([agents]);
  });
});

describe("多 Agent 协作 in the chat row", () => {
  it("renders the coordinator, each employee card and the live ticker while streaming", () => {
    const html = row(assistant({ status: "thinking", content: "", startedAt: Date.now() - 2_000, liveProcess: upTo(2_600) }));
    expect(html).toContain("多 Agent 协作");
    expect(html).toContain("协调 Agent");
    expect(html).toContain("等待子 Agent 完成（0/3）");
    expect(html).toContain("任务分解 · 3 个子任务 · 最多同时 2 个");
    for (const text of ["研究员", "分析员", "核对员", "查天气", "比较方案", "核对结论", "撰写中", "排队中"]) expect(html).toContain(text);
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("深圳今天晴，气温 25 度。");
    expect(html.indexOf("agent-1")).toBeLessThan(html.indexOf("agent-2"));
  });

  it("collapses a settled reply to one line that counts sub-agent searches", () => {
    const message = assistant({ process: settled(), sources: [{ title: "深圳天气", url: "https://weather.example/sz" }, { title: "气象台", url: "https://met.example/" }] });
    const view = replyProcessView({ message })!;
    expect(view.searchCount).toBe(1);
    expect(replyProcessSummary(view)).toBe("多 Agent 协作 2/3 · 搜索 1 次 · 2 个来源 · 用时 7 秒");
    const collapsed = row(message);
    expect(collapsed).toContain("多 Agent 协作 2/3 · 搜索 1 次 · 2 个来源 · 用时 7 秒");
    expect(collapsed).not.toContain("tp-ai-agents");
    const expanded = row(message, true);
    expect(expanded).toContain("2/3 个子任务完成");
    expect(expanded).toContain("已完成 · 2 秒");
    expect(expanded).toContain("未完成 · 3 秒");
    expect(expanded).toContain("超时未完成（90 秒）");
    expect(expanded).toContain("已综合为下方回答");
    expect(expanded).not.toContain('dir="rtl"');
  });

  it("reports the coordinator's own activity while sub-agents run", () => {
    const view = replyProcessView({ message: assistant({ status: "thinking", content: "", liveProcess: upTo(6_100) }) })!;
    expect(replyProcessActivity(view, { content: "" })).toBe("正在综合 3 个子任务的结果");
  });
});

describe("多 Agent 协作 admin settings", () => {
  it("starts from the defaults within the tier's own output cap", () => {
    expect(defaultMultiAgentSettings(8_192)).toEqual({ maxConcurrency: 3, subAgentMaxOutputTokens: 2_048 });
    expect(defaultMultiAgentSettings(1_024)).toEqual({ maxConcurrency: 3, subAgentMaxOutputTokens: 1_024 });
    expect(multiAgentSettingsError({ maxOutputTokens: 1_024, multiAgent: defaultMultiAgentSettings(1_024) })).toBe("");
    expect(multiAgentSettingsError({ maxOutputTokens: 1_024 })).toBe("");
  });

  it("explains an invalid tier setting before saving", () => {
    expect(multiAgentSettingsError({ maxOutputTokens: 4_096, multiAgent: { maxConcurrency: 6, subAgentMaxOutputTokens: 1_024 } })).toContain("2 到 5");
    expect(multiAgentSettingsError({ maxOutputTokens: 1_024, multiAgent: { maxConcurrency: 3, subAgentMaxOutputTokens: 2_048 } })).toContain("256 到 1024");
    expect(multiAgentSettingsError({ maxOutputTokens: 200, multiAgent: { maxConcurrency: 3, subAgentMaxOutputTokens: 256 } })).toContain("至少 256");
  });
});

describe("停止 for a 多 Agent 协作 reply", () => {
  it("asks the server to cancel the run and reports whether it did", async () => {
    const calls: unknown[][] = [];
    const api = async <T,>(...args: [string, RequestInit?, number?]): Promise<T> => { calls.push(args); return { cancelled: true } as T; };
    await expect(requestMultiAgentStop(api, "member-a", "request 1")).resolves.toBe(true);
    expect(calls).toEqual([["/api/ai/requests/request%201/cancel", { method: "POST", headers: { "X-Tongpin-Account": "member-a" } }, 10_000]]);
  });

  it("is harmless for an ordinary reply, a failed request, or a reply without a server request", async () => {
    await expect(requestMultiAgentStop(async <T,>() => ({ cancelled: false }) as T, "member-a", "request-1")).resolves.toBe(false);
    await expect(requestMultiAgentStop(async () => { throw new Error("offline"); }, "member-a", "request-1")).resolves.toBe(false);
    const api = vi.fn();
    await expect(requestMultiAgentStop(api, "member-a", undefined)).resolves.toBe(false);
    await expect(requestMultiAgentStop(api, "member-a", "draft-key")).resolves.toBe(false);
    expect(api).not.toHaveBeenCalled();
  });
});
