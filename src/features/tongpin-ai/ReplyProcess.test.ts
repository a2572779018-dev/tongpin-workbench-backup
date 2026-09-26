import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiHarnessTrace } from "../../../shared/ai";
import {
  AI_REPLY_PROCESS_LIMITS,
  applyReplyProcessEvent,
  EMPTY_REPLY_PROCESS_LIVE,
  readReplyProcess,
  replyProcessFromRunEvents,
  settleReplyProcess,
  withReplyProcessTool,
  type AiReplyProcess,
  type AiReplyProcessEvent,
  type AiReplyProcessLive,
} from "../../../shared/aiReplyProcess";
import { ChatMessageRow } from "./ChatMessageRow";
import { ChatWorkspace } from "./ChatWorkspace";
import { ReplyProcessDetailsContext } from "./ReplyProcess";
import {
  formatProcessDuration,
  hasReplyProcess,
  isReplyProcessExpanded,
  nextReplyProcessDetails,
  replyProcessActivity,
  replyProcessSummary,
  replyProcessToolPart,
  replyProcessView,
  type ReplyProcessDetails,
} from "./replyProcessModel";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";

const search = (callId: string, status: "in_progress" | "searching" | "completed" | "failed", extra: { query?: string; sourceCount?: number } = {}) =>
  ({ type: "tool_progress", data: { tool: "web_search", callId, status, ...extra } }) as const;
const at = (timestamp: number, payload: AiReplyProcessEvent): AiReplyProcessEvent => ({ ...payload, timestamp });

/** Mirrors a real Responses run: summary, two searches, answer, finish. */
function liveRun(): AiReplyProcessLive {
  const events: AiReplyProcessEvent[] = [
    at(1_000, { type: "run_started", data: { startedAt: 1_000 } }),
    at(1_100, { type: "public_summary_delta", data: { delta: "先确认城市，" } }),
    at(1_200, search("search-1", "in_progress")),
    at(1_900, search("search-1", "searching")),
    at(2_400, search("search-1", "completed")),
    at(2_450, search("search-1", "completed", { query: "上海\n今日天气", sourceCount: 5 })),
    at(2_500, { type: "public_summary_delta", data: { delta: "再核对空气质量。" } }),
    at(3_000, search("search-2", "in_progress", { query: "上海 空气质量" })),
    at(5_100, search("search-2", "completed", { query: "上海 空气质量", sourceCount: 6 })),
    at(5_200, { type: "answer_delta", data: { delta: "今天晴。" } }),
    at(10_200, { type: "run_finished", data: { response: { requestId: "r", content: "今天晴。", model: "m", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false }, quota: { limitTokens: 1, usedTokens: 0, reservedTokens: 0, remainingTokens: 1, inputTokens: 0, outputTokens: 0 } } } }),
  ];
  return events.reduce(applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE);
}

const settledProcess = (): AiReplyProcess => settleReplyProcess(liveRun(), { outcome: "completed", durationMs: 9_200 })!;
const assistant = (extra: Partial<TongpinAIMessage> = {}): TongpinAIMessage => ({ id: "reply", role: "assistant", content: "今天晴。", time: "12:00", status: "ready", ...extra });
const trace = (status: AiHarnessTrace["status"] = "succeeded"): AiHarnessTrace => ({
  runId: "run-a", tier: "standard", strategy: "plan_execute", status, reasoningSummary: "生成演示文稿", nextAction: status === "running" ? "poll" : "none",
  toolBudget: { used: 1, max: 2, remaining: 1 },
  steps: [
    { id: "strategy", kind: "strategy", capability: "presentation", title: "执行策略", summary: "内部", status: "succeeded", createdAt: "2026-09-26T10:00:00.000Z", updatedAt: "2026-09-26T10:00:00.000Z", strategy: "plan_execute", maxToolSteps: 2 },
    { id: "tool-1", kind: "tool", capability: "presentation", title: "整理大纲", summary: "已整理 6 页", status: "succeeded", createdAt: "2026-09-26T10:00:00.000Z", updatedAt: "2026-09-26T10:00:02.000Z" },
    { id: "result-1", kind: "result", capability: "presentation", title: "生成 PPT", summary: "生成中", status: status === "running" ? "running" : "succeeded", createdAt: "2026-09-26T10:00:02.000Z", updatedAt: "2026-09-26T10:00:04.000Z" },
  ],
});
const imageArtifact = (status: string): TongpinAIArtifact => ({ id: "artifact-image", conversationId: "c", title: "生成的图片", kind: "图片", updatedLabel: "刚刚", summary: "", sections: [],
  data: { mediaTaskRequestId: "request-image-1234", mediaTaskStatus: status } });
const rowProps = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined };
const row = (message: TongpinAIMessage, details?: ReplyProcessDetails, artifact?: TongpinAIArtifact) => {
  const element = createElement(ChatMessageRow, { ...rowProps, message, artifact });
  return renderToStaticMarkup(details ? createElement(ReplyProcessDetailsContext.Provider, { value: details }, element) : element);
};

describe("reply process events", () => {
  it("keeps the order in which real parts first appeared, with server-timed search durations", () => {
    const live = liveRun();
    expect(live.steps.map(step => step.kind === "search" ? step.callId : step.kind)).toEqual(["thinking", "search-1", "search-2"]);
    expect(live.runStartedAt).toBe(1_000);
    expect(live.finishedAt).toBe(10_200);
    expect(settledProcess()).toEqual({ version: 1, outcome: "completed", durationMs: 9_200, steps: [
      { kind: "thinking" },
      { kind: "search", status: "completed", query: "上海 今日天气", sourceCount: 5, durationMs: 1_200 },
      { kind: "search", status: "completed", query: "上海 空气质量", sourceCount: 6, durationMs: 2_100 },
    ] });
  });

  it("never shows or stores raw provider reasoning", () => {
    const start = applyReplyProcessEvent(EMPTY_REPLY_PROCESS_LIVE, at(1, { type: "run_started", data: { startedAt: 1 } }));
    const raw = applyReplyProcessEvent(start, at(2, { type: "reasoning_delta", data: { delta: "raw private chain", source: "provider_reasoning_content" } }));
    expect(raw).toBe(start);
    expect(applyReplyProcessEvent(start, at(3, { type: "answer_delta", data: { delta: "答" } }))).toBe(start);
    const html = row(assistant({ status: "thinking", content: "", startedAt: Date.now(), liveProcess: raw,
      liveThinking: { reasoning: "raw private chain", searches: [{ tool: "web_search", callId: "search-1", status: "searching", query: "上海" }] } }));
    expect(html).not.toContain("raw private chain");
    expect(JSON.stringify(settleReplyProcess(withReplyProcessTool(raw, { kind: "tool", tool: "computer", status: "handed_off" }), { outcome: "completed" }))).not.toContain("raw");
  });

  it("does not regress a settled search and marks an unsettled one incomplete when the reply stops", () => {
    let live = applyReplyProcessEvent(EMPTY_REPLY_PROCESS_LIVE, at(10, search("search-1", "completed", { query: "q", sourceCount: 2 })));
    const settled = live;
    live = applyReplyProcessEvent(live, at(20, search("search-1", "searching")));
    expect(live).toBe(settled);
    live = applyReplyProcessEvent(live, at(30, search("search-2", "searching", { query: "第二次" })));
    expect(settleReplyProcess(live, { outcome: "stopped", durationMs: 4_000 })).toEqual({ version: 1, outcome: "stopped", durationMs: 4_000, steps: [
      { kind: "search", status: "completed", query: "q", sourceCount: 2 },
      { kind: "search", status: "incomplete", query: "第二次" },
    ] });
    expect(settleReplyProcess(EMPTY_REPLY_PROCESS_LIVE, { outcome: "completed", durationMs: 1 })).toBeUndefined();
  });

  it("stays within the persisted caps", () => {
    let live = EMPTY_REPLY_PROCESS_LIVE;
    for (let index = 1; index <= 12; index += 1) live = applyReplyProcessEvent(live, at(index, search(`search-${index}`, "completed", { query: "长".repeat(500), sourceCount: 99_999 })));
    const process = settleReplyProcess(live, { outcome: "completed", durationMs: AI_REPLY_PROCESS_LIMITS.durationMs + 1 })!;
    expect(process.steps).toHaveLength(AI_REPLY_PROCESS_LIMITS.steps);
    expect(process.durationMs).toBeUndefined();
    const first = process.steps[0];
    expect(first.kind === "search" && [...(first.query ?? "")].length).toBe(AI_REPLY_PROCESS_LIMITS.queryCodePoints);
    expect(first.kind === "search" && first.sourceCount).toBe(AI_REPLY_PROCESS_LIMITS.sourceCount);
  });

  it("rebuilds only a journal that reached run_finished, and reads stored values defensively", () => {
    const events: AiReplyProcessEvent[] = [at(1, { type: "run_started", data: { startedAt: 1 } }), at(2, search("search-1", "completed", { sourceCount: 1 }))];
    expect(replyProcessFromRunEvents(events, "completed")).toBeUndefined();
    expect(readReplyProcess({ version: 1, outcome: "completed", steps: [{ kind: "thinking", text: "x" }, { kind: "search", status: "bogus" }, { kind: "search", status: "failed", query: "a\u0000b" }] }))
      .toEqual({ version: 1, outcome: "completed", steps: [{ kind: "thinking" }, { kind: "search", status: "failed" }] });
    expect(readReplyProcess({ version: 2, outcome: "completed", steps: [{ kind: "thinking" }] })).toBeUndefined();
  });
});

describe("reply process parts (adapted grouping)", () => {
  it("orders plan, public thinking summary, searches, then the tool linked to its card", () => {
    const view = replyProcessView({ message: assistant({ analysisSummary: "先比较，再核对。", process: settledProcess(), trace: trace(), artifactId: "artifact-image" }),
      artifact: imageArtifact("completed") })!;
    expect(view.parts.map(part => part.kind)).toEqual(["plan", "thinking", "search", "search", "tool"]);
    expect(view.parts[0]).toMatchObject({ kind: "plan", label: "工具进度", completed: 2, steps: [{ id: "tool-1" }, { id: "result-1" }] });
    expect(view.parts[4]).toMatchObject({ kind: "tool", label: "生成图片", statusText: "图片已生成", hasCard: true, state: "done" });
    expect(view.phase).toBe("settled");
    // A tool run outlives the chat call, so its duration is not reported as the task's.
    expect(view.durationMs).toBeUndefined();
  });

  it("shows nothing for a plain answer and falls back to saved summary fields for older replies", () => {
    expect(hasReplyProcess(assistant())).toBe(false);
    expect(hasReplyProcess({ ...assistant(), role: "user" })).toBe(false);
    const legacy = replyProcessView({ message: assistant({ analysisSummary: "依据摘要", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false, searchCalls: 2 },
      sources: [{ title: "A", url: "https://a.example/" }, { title: "A again", url: "https://www.a.example/?utm_source=x" }, { title: "B", url: "https://b.example/" }] }) })!;
    expect(legacy.parts.map(part => part.kind)).toEqual(["thinking", "search-total"]);
    expect(replyProcessSummary(legacy)).toBe("搜索 2 次 · 2 个来源");
  });

  it("maps media task states to compact tool rows without inventing progress", () => {
    expect(replyProcessToolPart(imageArtifact("awaiting_authorization"))).toMatchObject({ state: "waiting", statusText: "方案已就绪，等待确认生成额度" });
    expect(replyProcessToolPart(imageArtifact("running"))).toMatchObject({ state: "running", statusText: "正在生成图片" });
    expect(replyProcessToolPart(imageArtifact("failed"))).toMatchObject({ state: "failed" });
    expect(replyProcessToolPart({ ...imageArtifact("queued"), data: { mediaTaskRequestId: "request-image-1234", mediaTaskSubmitError: "未提交" } })).toMatchObject({ state: "failed", statusText: "任务未提交" });
    expect(replyProcessToolPart({ id: "p", conversationId: "c", title: "季度复盘", kind: "PPT", updatedLabel: "", summary: "", sections: [] })).toMatchObject({ tool: "presentation", state: "done" });
    const waiting = replyProcessView({ message: assistant({ artifactId: "artifact-image" }), artifact: imageArtifact("awaiting_authorization") })!;
    expect(waiting.phase).toBe("waiting");
    expect(replyProcessActivity(waiting, { content: "" })).toBe("方案已就绪，等待确认生成额度");
  });

  it("summarizes a settled reply on one line", () => {
    expect(replyProcessSummary(replyProcessView({ message: assistant({ analysisSummary: "摘要", process: settledProcess() }) })!)).toBe("搜索 2 次 · 11 个来源 · 用时 9 秒");
    expect(replyProcessSummary(replyProcessView({ message: assistant({ analysisSummary: "摘要", process: { version: 1, outcome: "completed", durationMs: 5_400, steps: [{ kind: "thinking" }] } }) })!)).toBe("已思考 · 用时 5 秒");
    expect(replyProcessSummary(replyProcessView({ message: assistant({ status: "error", process: { version: 1, outcome: "stopped", durationMs: 4_100, steps: [{ kind: "search", status: "incomplete", query: "q" }] } }) })!)).toBe("已停止 · 搜索 1 次 · 用时 4 秒");
    expect(replyProcessSummary(replyProcessView({ message: assistant({ trace: trace() }) })!)).toBe("工具进度 2/2 步");
    expect(formatProcessDuration(1_234)).toBe("1.2 秒");
    expect(formatProcessDuration(65_000)).toBe("1 分 5 秒");
  });

  it("describes only what is happening now while the reply streams", () => {
    const live = liveRun();
    const searching = applyReplyProcessEvent(EMPTY_REPLY_PROCESS_LIVE, at(1, search("search-1", "searching", { query: "上海" })));
    const streaming = (extra: Partial<TongpinAIMessage>) => replyProcessView({ message: assistant({ status: "thinking", content: "", ...extra }) })!;
    expect(replyProcessActivity(streaming({ liveProcess: searching }), { content: "" })).toBe("正在联网搜索");
    const thinkingOnly = applyReplyProcessEvent(EMPTY_REPLY_PROCESS_LIVE, at(1, { type: "public_summary_delta", data: { delta: "先确认" } }));
    const thinkingView = streaming({ liveProcess: thinkingOnly, analysisSummary: "先确认" });
    expect(replyProcessActivity(thinkingView, { content: "" })).toBe("正在思考");
    expect(thinkingView.parts[0]).toMatchObject({ kind: "thinking", state: "running" });
    const answering = streaming({ liveProcess: live, analysisSummary: "先确认", content: "今天" });
    expect(replyProcessActivity(answering, { content: "今天" })).toBe("正在生成回答");
    expect(answering.parts.map(part => part.state)).toEqual(["done", "done", "done"]);
  });
});

describe("process details expansion", () => {
  const collapsed = { expanded: false, revision: 0 };
  it("is expanded while streaming and collapsed once settled by default", () => {
    expect(isReplyProcessExpanded({ streaming: true, details: collapsed, mountedRevision: 0 })).toBe(true);
    expect(isReplyProcessExpanded({ streaming: false, details: collapsed, mountedRevision: 0 })).toBe(false);
  });

  it("follows 全部展开 / 全部收起 for every reply, including one still streaming", () => {
    const expandedAll = nextReplyProcessDetails(collapsed);
    expect(expandedAll).toEqual({ expanded: true, revision: 1 });
    expect(isReplyProcessExpanded({ streaming: false, details: expandedAll, mountedRevision: 0 })).toBe(true);
    const collapsedAll = nextReplyProcessDetails(expandedAll);
    expect(isReplyProcessExpanded({ streaming: true, details: collapsedAll, mountedRevision: 0 })).toBe(false);
    // A reply that starts after the viewer's choice still opens while it streams.
    expect(isReplyProcessExpanded({ streaming: true, details: collapsedAll, mountedRevision: collapsedAll.revision })).toBe(true);
  });

  it("keeps a per-reply choice until the next conversation-level toggle", () => {
    const choice = { expanded: true, revision: 0 };
    expect(isReplyProcessExpanded({ streaming: false, details: collapsed, choice, mountedRevision: 0 })).toBe(true);
    expect(isReplyProcessExpanded({ streaming: false, details: { expanded: false, revision: 2 }, choice, mountedRevision: 0 })).toBe(false);
    expect(isReplyProcessExpanded({ streaming: true, details: collapsed, choice: { expanded: false, revision: 0 }, mountedRevision: 0 })).toBe(false);
  });
});

describe("reply process section in the chat row", () => {
  it("renders live parts expanded, in order, with the running search and elapsed time", () => {
    const live = applyReplyProcessEvent(liveRun(), at(11_000, search("search-3", "searching", { query: "明天天气" })));
    const html = row(assistant({ status: "thinking", content: "", startedAt: Date.now() - 3_000, analysisSummary: "<b>先比较</b>", liveProcess: live }));
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("正在联网搜索");
    expect(html).toContain("已用时 3 秒");
    const order = ["思考过程", "上海 今日天气", "上海 空气质量", "明天天气"].map(text => html.indexOf(text));
    expect(order.every((position, index) => position > 0 && (index === 0 || position > order[index - 1]))).toBe(true);
    expect(html).toContain("已完成 · 5 个来源 · 1.2 秒");
    expect(html).toContain("搜索中");
    expect(html).toContain("&lt;b&gt;先比较&lt;/b&gt;");
    expect(html).not.toContain("等待模型响应");
  });

  it("collapses a settled reply to one summary line and shows details when expanded", () => {
    const message = assistant({ analysisSummary: "先比较", process: settledProcess(), sources: [{ title: "A", url: "https://a.example/" }] });
    const collapsed = row(message);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain("搜索 2 次 · 11 个来源 · 用时 9 秒");
    expect(collapsed).not.toContain("tp-ai-process__parts");
    const expanded = row(message, { expanded: true, revision: 1 });
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain("tp-ai-process__parts");
    expect(expanded).toContain("完成 · 用时 9 秒");
    // Process first, then the answer, then the sources.
    expect(expanded.indexOf("tp-ai-process")).toBeLessThan(expanded.indexOf("tp-ai-markdown"));
    expect(expanded.indexOf("tp-ai-markdown")).toBeLessThan(expanded.indexOf("tp-ai-message-sources"));
  });

  it("links a tool row to its existing card instead of duplicating it", () => {
    const html = row(assistant({ artifactId: "artifact-ppt", content: "已生成。" }), { expanded: true, revision: 1 },
      { id: "artifact-ppt", conversationId: "c", title: "季度复盘", kind: "PPT", updatedLabel: "刚刚", summary: "", sections: [] });
    expect(html).toContain("工具调用 · 生成 PPT");
    expect(html).toContain(">查看结果</button>");
    expect(html.match(/打开成果：季度复盘/g)).toHaveLength(1);
  });

  it("keeps plain answers free of process chrome", () => {
    expect(row(assistant())).not.toContain("tp-ai-process");
    expect(row(assistant({ status: "thinking", content: "", startedAt: Date.now() }))).toContain("等待模型响应");
  });
});

describe("conversation header toggle", () => {
  const props = { artifactById: new Map(), composerFocusRequest: 0, draft: "", enabledSkills: [], mode: "quick" as const, notificationUnread: 0,
    quotaInsufficient: false, responding: false, onDraftChange: () => undefined, onModeChange: () => undefined, onOpenArtifact: () => undefined, onSubmit: () => undefined };
  const user: TongpinAIMessage = { id: "u", role: "user", content: "今天天气？", time: "12:00" };

  it("offers 过程详情：全部展开 only when a reply has process parts", () => {
    const withProcess = renderToStaticMarkup(createElement(ChatWorkspace, { ...props, viewerId: "member-a", messages: [user, assistant({ analysisSummary: "摘要", process: settledProcess() })] }));
    expect(withProcess).toContain('aria-label="过程详情：全部展开"');
    expect(withProcess).toContain("过程详情：</span>全部展开");
    const plain = renderToStaticMarkup(createElement(ChatWorkspace, { ...props, messages: [user, assistant()] }));
    expect(plain).not.toContain("过程详情");
  });

  it("advertises Esc on the stop button while a reply runs", () => {
    const running = renderToStaticMarkup(createElement(ChatWorkspace, { ...props, responding: true, onStop: () => undefined,
      messages: [user, assistant({ status: "thinking", content: "", startedAt: Date.now() })] }));
    expect(running).toContain('aria-keyshortcuts="Escape"');
    expect(running).toContain("按 Esc 停止当前回复");
    const idle = renderToStaticMarkup(createElement(ChatWorkspace, { ...props, messages: [user, assistant()] }));
    expect(idle).not.toContain("aria-keyshortcuts");
    expect(idle).toContain("Enter 发送 · Shift + Enter 换行");
  });
});

describe("page wiring", () => {
  it("builds live parts from every run event and persists the settled record on completion or stop", () => {
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("const nextProcess = applyReplyProcessEvent(liveProcess, event);");
    expect(page).not.toContain("applyLiveThinkingEvent");
    // Only a live journal that reached run_finished is kept; a GET recovery drops a stale record.
    expect(page).toContain("else if (liveProcess.finishedAt !== undefined) {");
    expect(page).toContain('if (typeof request === "string") { if (persistedReply?.process) updateReply(conversationId, messageId, { process: undefined }); }');
    expect(page).toContain('const stoppedProcess = settledProcess(interrupted ? "stopped" : "failed");');
    expect(page).toContain("viewerId={user.id}");
    const v2 = readFileSync(new URL("./TongpinAIWorkspaceV2.tsx", import.meta.url), "utf8");
    expect(v2).toContain("applyReplyProcessEvent(previous, event)");
    expect(v2).toContain("viewerId={user.id}");
  });
});
