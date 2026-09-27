import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiSubagentUpdate } from "../../../../shared/aiMultiAgent";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, replyProcessFromRunEvents, settleReplyProcess, type AiReplyProcessEvent, type AiReplyProcessLive } from "../../../../shared/aiReplyProcess";
import { ChatMessageRow } from "../ChatMessageRow";
import { ReplyProcessDetailsContext } from "../ReplyProcess";
import type { TongpinAIMessage } from "../types";
import { AGENT_OFFICE_COORDINATOR_NAME, agentOfficeSnapshotFromMessage } from "./fromMultiAgent";

const REQUEST_ID = "request-office-000000000001";
const update = (timestamp: number, data: AiSubagentUpdate): AiReplyProcessEvent => ({ type: "subagent_update", data, timestamp });
const at = (timestamp: number, payload: AiReplyProcessEvent): AiReplyProcessEvent => ({ ...payload, timestamp });
const PLAN: AiSubagentUpdate = { phase: "plan", maxConcurrency: 2, subtasks: [
  { id: "agent-1", role: "研究员", title: "查天气", task: "查找深圳今天的天气。\n只列事实，注明来源。", search: true },
  { id: "agent-2", role: "分析员", title: "比较方案", task: "比较两种出行方案的成本。", search: false },
  { id: "agent-3", role: "核对员", title: "核对结论", task: "核对前两项的结论是否一致。", search: false },
] };
/** A real journal order: 任务分解 → sub-agents (one searches, one times out) → 结果综合. */
const EVENTS: AiReplyProcessEvent[] = [
  at(1_000, { type: "run_started", data: { startedAt: 1_000 } }),
  update(1_010, { phase: "planning" }),
  update(2_000, PLAN),
  update(2_010, { phase: "start", id: "agent-1" }),
  update(2_020, { phase: "start", id: "agent-2" }),
  update(2_100, { phase: "search", id: "agent-1", callId: "search-1", status: "in_progress" }),
  update(2_500, { phase: "search", id: "agent-1", callId: "search-1", status: "completed", query: "深圳 天气", sourceCount: 3 }),
  update(2_600, { phase: "progress", id: "agent-1", chars: 14, preview: "深圳今天晴，气温 25 度。" }),
  update(4_000, { phase: "stop", id: "agent-1", durationMs: 1_990, summary: "深圳今天晴，适合出行。", searchCount: 1, sourceCount: 3, sources: [1, 2] }),
  update(4_100, { phase: "start", id: "agent-3" }),
  update(5_000, { phase: "error", id: "agent-2", reason: "timeout", message: "超时未完成（90 秒）", durationMs: 2_980 }),
  update(6_000, { phase: "stop", id: "agent-3", durationMs: 1_900, summary: "结论一致。" }),
  update(6_100, { phase: "synthesis" }),
  update(8_000, { phase: "finish", outcome: "done" }),
  at(8_001, { type: "run_finished", data: { response: { requestId: REQUEST_ID, content: "综合回答", model: "m",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
    quota: { limitTokens: 1, usedTokens: 0, reservedTokens: 0, remainingTokens: 1, inputTokens: 0, outputTokens: 0 } } } }),
];
const upTo = (timestamp: number): AiReplyProcessLive => EVENTS.filter(event => (event.timestamp ?? 0) <= timestamp).reduce(applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE);
const streaming = (timestamp: number, overrides: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({
  id: "assistant-office", role: "assistant", content: "", time: "12:00", status: "thinking", requestId: REQUEST_ID, startedAt: 1_000, liveProcess: upTo(timestamp), ...overrides,
});
const settledMessage = (overrides: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({
  id: "assistant-office", role: "assistant", content: "综合回答", time: "12:00", status: "ready", requestId: REQUEST_ID, process: replyProcessFromRunEvents(EVENTS, "completed"), ...overrides,
});

describe("agentOfficeSnapshotFromMessage", () => {
  it("starts with the coordinator alone while it decomposes the task", () => {
    expect(agentOfficeSnapshotFromMessage(streaming(1_010))).toEqual({
      runId: REQUEST_ID, phase: "planning", workers: [], updatedAt: 1_010,
      coordinator: { name: AGENT_OFFICE_COORDINATOR_NAME, status: "thinking", activity: "正在分解任务" },
    });
  });

  it("maps every worker field from the live 多 Agent 协作 step (handoff doc section 7)", () => {
    const dispatching = agentOfficeSnapshotFromMessage(streaming(2_000))!;
    expect(dispatching).toMatchObject({ phase: "dispatching", coordinator: { status: "working", activity: "已拆成 3 个子任务，正在分派" }, updatedAt: 2_000 });
    expect(dispatching.workers.map(worker => [worker.id, worker.role, worker.status, worker.activity])).toEqual([
      ["agent-1", "研究员", "queued", "排队等待"], ["agent-2", "分析员", "queued", "排队等待"], ["agent-3", "核对员", "queued", "排队等待"]]);
    expect(dispatching.workers[0].task).toBe("查找深圳今天的天气。\n只列事实，注明来源。");
    // Each desk says which aspect of the request that worker owns.
    expect(dispatching.workers.map(worker => worker.title)).toEqual(["查天气", "比较方案", "核对结论"]);

    const working = agentOfficeSnapshotFromMessage(streaming(4_000, { status: "typing" }))!;
    expect(working).toMatchObject({ runId: REQUEST_ID, phase: "working", coordinator: { status: "thinking", activity: "等待子 Agent 完成（1/3）" }, updatedAt: 4_000 });
    expect(working.workers[0]).toEqual({ id: "agent-1", role: "研究员", title: "查天气", task: "查找深圳今天的天气。\n只列事实，注明来源。", status: "done",
      activity: "深圳今天晴，适合出行。", startedAt: 2_010, finishedAt: 4_000, resultSummary: "深圳今天晴，适合出行。", sourceCount: 3 });
    expect(working.workers[1]).toMatchObject({ id: "agent-2", status: "thinking", startedAt: 2_020 });
    expect(working.workers[1].finishedAt).toBeUndefined();
    expect(working.workers[2]).toMatchObject({ id: "agent-3", status: "queued" });

    expect(agentOfficeSnapshotFromMessage(streaming(6_100))).toMatchObject({ phase: "synthesizing", coordinator: { status: "working", activity: "正在综合 3 个子任务的结果" } });
  });

  it("reads the saved record once the reply settles", () => {
    const done = agentOfficeSnapshotFromMessage(settledMessage())!;
    expect(done).toMatchObject({ runId: REQUEST_ID, phase: "done", coordinator: { name: AGENT_OFFICE_COORDINATOR_NAME, status: "done", activity: "已完成结果综合" }, updatedAt: 8_000 });
    expect(done.workers.map(worker => [worker.id, worker.status, worker.activity, worker.resultSummary, worker.startedAt, worker.finishedAt, worker.sourceCount])).toEqual([
      ["agent-1", "done", "深圳今天晴，适合出行。", "深圳今天晴，适合出行。", 2_010, 4_000, 3],
      ["agent-2", "failed", "超时未完成（90 秒）", undefined, 2_020, 5_000, undefined],
      ["agent-3", "done", "结论一致。", "结论一致。", 4_100, 6_000, undefined]]);
    // A stopped run keeps its unfinished workers as stopped, like the cards next to it.
    const stopped = agentOfficeSnapshotFromMessage(settledMessage({ status: "stopped", process: settleReplyProcess(upTo(3_000), { outcome: "stopped" }) }))!;
    expect(stopped).toMatchObject({ phase: "cancelled", coordinator: { status: "cancelled" } });
    expect(stopped.workers.map(worker => worker.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  it("is null for anything that is not a 多 Agent 协作 reply", () => {
    const direct = [update(1, { phase: "planning" }), update(2, { phase: "direct" })].reduce(applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE);
    expect(agentOfficeSnapshotFromMessage(streaming(0, { liveProcess: direct }))).toBeNull();
    expect(agentOfficeSnapshotFromMessage({ ...settledMessage(), role: "user" })).toBeNull();
    expect(agentOfficeSnapshotFromMessage(settledMessage({ process: undefined }))).toBeNull();
  });

  it("picks the record exactly as the reply process does", () => {
    const saved = replyProcessFromRunEvents(EVENTS, "completed");
    // While it streams, a live journal with steps wins over an older saved record…
    expect(agentOfficeSnapshotFromMessage(streaming(2_000, { process: saved }))?.phase).toBe("dispatching");
    // …and before its first step the saved record shows, like the cards next to it.
    expect(agentOfficeSnapshotFromMessage(streaming(0, { liveProcess: EMPTY_REPLY_PROCESS_LIVE, process: saved }))?.phase).toBe("done");
  });

  it("keeps a stable run id for a V2 stream placeholder that has no request id yet", () => {
    expect(agentOfficeSnapshotFromMessage(streaming(2_000, { id: "stream-conversation-1", requestId: undefined }))?.runId).toBe("stream-conversation-1");
  });
});

describe("AI 员工办公室 next to the 多 Agent 协作 cards", () => {
  const rowProps = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined };
  const row = (message: TongpinAIMessage, expanded = false) => {
    const element = createElement(ChatMessageRow, { ...rowProps, message });
    return renderToStaticMarkup(expanded ? createElement(ReplyProcessDetailsContext.Provider, { value: { expanded: true, revision: 1 } }, element) : element);
  };
  const officeHeader = (html: string) => /<section class="tp-ai-office-panel[^"]*" aria-label="AI 员工办公室"><button type="button" class="tp-ai-office-panel__header" aria-expanded="(true|false)"/.exec(html)?.[1];

  it("is open while the run works, after the sub-agent cards", () => {
    const html = row(streaming(2_600));
    expect(officeHeader(html)).toBe("true");
    expect(html.indexOf("tp-ai-agents__list")).toBeLessThan(html.indexOf("AI 员工办公室"));
    expect(html).toContain("处理中 · 3 位员工");
  });

  it("is collapsed once the run is done, and absent from a plain reply", () => {
    // The settled process folds to one line by default; opened, the office starts collapsed.
    expect(officeHeader(row(settledMessage()))).toBeUndefined();
    const html = row(settledMessage(), true);
    expect(officeHeader(html)).toBe("false");
    expect(html).toContain("已完成 · 3 位员工");
    expect(row({ id: "assistant-plain", role: "assistant", content: "普通回答", time: "12:00", status: "ready", requestId: REQUEST_ID }, true)).not.toContain("AI 员工办公室");
  });
});
