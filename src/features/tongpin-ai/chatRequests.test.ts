import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { AI_CHAT_CONTEXT_LIMITS, AI_CONTEXT_WINDOW_PREFIX, aiChatTextContextBytes, fitAiChatMessages } from "../../../shared/aiContext";
import { buildChatRequest, canRecoverChatRequest, completedReply, interruptedChatRequests, recoverInterruptedMessages, replaceChatMessage, stoppedPlanningReply } from "./chatRequests";
import { messageTaskStatus } from "./conversationTaskStatus";
import { ReplyWaiting } from "./ReplyWaiting";
import { waitForReply } from "./waitForReply";
import type { TongpinAIConversation, TongpinAIMessage } from "./types";
import type { AiHarnessTrace } from "../../../shared/ai";

const history: TongpinAIConversation[] = [{ id: "a", title: "A", timeLabel: "刚刚", messages: [
  { id: "u", role: "user", content: "你好", time: "12:00" },
  { id: "r", role: "assistant", content: "旧错误不能送进上下文", status: "error", time: "12:00" },
  { id: "t", role: "assistant", content: "", status: "thinking", time: "12:00" },
] }, { id: "b", title: "B", timeLabel: "刚刚", messages: [] }];

describe("real AI chat request state", () => {
  afterEach(() => vi.useRealTimers());
  it("allows result recovery without offering a dead retry for terminal provider errors", () => {
    for (const code of ["NETWORK_UNAVAILABLE", "AI_REQUEST_IN_PROGRESS", "AI_STREAM_INTERRUPTED", "AI_REQUEST_UNCERTAIN", "AI_WAIT_TIMEOUT", "AI_QUOTA_EXHAUSTED", "AI_NOT_CONFIGURED", "AI_SEARCH_QUOTA_INSUFFICIENT", "AI_QUOTA_INSUFFICIENT"]) {
      expect(canRecoverChatRequest(code, false)).toBe(true);
    }
    for (const code of ["AI_PROVIDER_AUTH", "AI_RESPONSE_INCOMPLETE", "AI_INPUT_INVALID", "AI_CONNECTION_FAILED"]) {
      expect(canRecoverChatRequest(code, false)).toBe(false);
    }
    expect(canRecoverChatRequest(undefined, true)).toBe(true);
  });
  it("sends only user/assistant content and never client quota or error placeholders", () => {
    const request = buildChatRequest("one-id", "quick", history[0].messages);
    expect(request).toEqual({ requestId: "one-id", mode: "quick", messages: [{ role: "user", content: "你好" }] });
  });
  it("keeps successful assistant context for a follow-up", () => {
    const request = buildChatRequest("follow-up", "deep", [...history[0].messages,
      { id: "ok", role: "assistant", content: "真正的上游回答", time: "12:01", status: "ready" },
      { id: "u2", role: "user", content: "继续", time: "12:02" },
    ]);
    expect(request.messages.map(message => message.content)).toEqual(["你好", "真正的上游回答", "继续"]);
  });
  it("keeps the current turn and newest useful history inside the request window without changing saved history", () => {
    const messages: TongpinAIMessage[] = [
      ...Array.from({ length: 90 }, (_, index) => ({
        id: `history-${index}`,
        role: index % 2 ? "assistant" as const : "user" as const,
        content: `历史-${index}-${"资料".repeat(300)}`,
        time: "12:00",
      })),
      { id: "current", role: "user", content: "继续讨论刚才的产物", time: "12:01" },
    ];
    const saved = structuredClone(messages);
    const request = buildChatRequest("bounded-context-id", "deep", messages);
    expect(request.messages.length).toBeLessThanOrEqual(AI_CHAT_CONTEXT_LIMITS.requestMessages);
    expect(aiChatTextContextBytes(request.messages)).toBeLessThanOrEqual(AI_CHAT_CONTEXT_LIMITS.requestTextBytes);
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "继续讨论刚才的产物" });
    expect(request.messages.some(message => message.content.includes("历史-89-"))).toBe(true);
    expect(request.messages.some(message => message.content.includes("历史-0-"))).toBe(false);
    expect(request.messages[0].content.startsWith(AI_CONTEXT_WINDOW_PREFIX)).toBe(true);
    expect(fitAiChatMessages(request.messages)).toEqual(request.messages);
    expect(messages).toEqual(saved);
  });
  it("compresses a long old reply by preserving its head and tail rather than blocking the follow-up", () => {
    const longReply = `头部结论-${"中间资料".repeat(20_000)}-尾部结论`;
    const result = fitAiChatMessages([
      { role: "assistant", content: longReply },
      { role: "user", content: "根据上面结论继续" },
    ]);
    expect(result.at(-1)?.content).toBe("根据上面结论继续");
    expect(result.some(message => message.content.includes("头部结论"))).toBe(true);
    expect(result.some(message => message.content.includes("尾部结论"))).toBe(true);
    expect(result.some(message => message.content.includes("较长历史消息已有界压缩"))).toBe(true);
    expect(result[0].content).toContain("不得推测未提供的历史、视频画面或声音");
  });
  it("routes late replies to their original conversation without reviving deleted chats", () => {
    const next = replaceChatMessage(history, "a", "t", { content: "回答", status: "ready" });
    expect(next[0].messages[2].content).toBe("回答");
    expect(next[1]).toBe(history[1]);
    expect(history[0].messages[2].status).toBe("thinking");
    expect(replaceChatMessage([history[1]], "a", "t", { content: "回答" })).toEqual([history[1]]);
  });
  it("settles a stopped tool planning reply, and reads a saved planning request back after a reload", () => {
    const planning: TongpinAIConversation[] = [{ id: "ppt", title: "PPT", timeLabel: "刚刚", messages: [
      { id: "user-ppt", role: "user", content: "做一份周报 PPT", time: "12:00" },
      { id: "reply-ppt", role: "assistant", content: "", status: "thinking", taskPhase: "queued", time: "12:00" },
    ] }];
    const stopped = replaceChatMessage(planning, "ppt", "reply-ppt", stoppedPlanningReply("presentation", false));
    expect(stopped[0].messages[1]).toEqual({ id: "reply-ppt", role: "assistant", content: "已取消发送，本次未调用模型。", status: "stopped", time: "12:00" });
    // Not queued/running any more, and never turned into "未保存有效任务编号" after a reload.
    expect(messageTaskStatus(stopped[0].messages[1])).toBeUndefined();
    expect(recoverInterruptedMessages(stopped)).toEqual(stopped);
    expect(stoppedPlanningReply("presentation", true).content).toBe("已停止，本次未生成 PPT。整理方案的请求可能已计费。");
    const requestId = "plan-7f1c2c1e-5d0e-4a44-9d4e-0c8f5f0d9b21";
    const saved = replaceChatMessage(planning, "ppt", "reply-ppt", { taskPhase: "planning" })
      .map(item => ({ ...item, messages: item.messages.map(message => message.id === "reply-ppt" ? { ...message, requestId } : message) }));
    expect(interruptedChatRequests(saved)).toEqual([{ conversationId: "ppt", messageId: "reply-ppt", requestId }]);
    expect(recoverInterruptedMessages(saved)[0].messages[1]).toMatchObject({ status: "thinking", requestId });
  });
  it("does not invent a recoverable request ID for interrupted legacy work", () => {
    const recovered = recoverInterruptedMessages(history);
    expect(recovered[0].messages[2].status).toBe("error");
    expect(recovered[0].messages[2].content).toContain("未保存有效任务编号");
    expect(recovered[0].messages[2].taskPhase).toBe("unknown");
    expect(recoverInterruptedMessages([{ ...history[0], messages: [{ ...history[0].messages[2], content: "已收到的部分回答" }] }])[0].messages[0].content).toBe("已收到的部分回答");
    expect(recovered[0].messages[0]).toEqual(history[0].messages[0]);
  });
  it("remounts an in-flight reply as waiting and reads only its original ID", async () => {
    const requestId = "b51d1d56-3a68-4dba-93b2-0ba5597c72fd";
    const startedAt = Date.parse("2026-09-23T08:00:00.000Z");
    const original: TongpinAIConversation[] = [{ id: "conversation-b", title: "B", timeLabel: "刚刚", messages: [
      { id: "user-b", role: "user", content: "你好", time: "16:00" },
      { id: "reply-b", role: "assistant", requestId, content: "", status: "thinking", taskPhase: "running", startedAt, time: "16:00" },
    ] }];
    // The server-saved workspace is JSON, not a mounted React component.
    const restored = recoverInterruptedMessages(JSON.parse(JSON.stringify(original)));
    expect(restored[0].messages[1]).toMatchObject({ status: "thinking", taskPhase: "running", startedAt, requestId });
    expect(interruptedChatRequests(restored)).toEqual([{ conversationId: "conversation-b", messageId: "reply-b", requestId }]);
    const settled = { requestId, content: "# 真实回复", model: "快速", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false },
      quota: { limitTokens: 100, usedTokens: 3, remainingTokens: 97, reservedTokens: 0, inputTokens: 1, outputTokens: 2 } };
    const readOriginal = vi.fn(async (id: string, _signal: AbortSignal) => ({ requestId: id, status: "completed" as const, result: settled }));
    const response = await waitForReply((signal) => readOriginal(requestId, signal), new AbortController().signal);
    expect(readOriginal).toHaveBeenCalledTimes(1);
    expect(readOriginal.mock.calls[0][0]).toBe(requestId);
    if ("images" in response) throw new Error("Expected a text reply");
    expect(completedReply(response)).toMatchObject({ content: "# 真实回复", status: "ready", taskPhase: "completed" });
    vi.useFakeTimers(); vi.setSystemTime(startedAt + 9_500);
    expect(renderToStaticMarkup(createElement(ReplyWaiting, { startedAt }))).toContain("已用时 9 秒");
  });
  it("recovers an old interruption notice but never auto-retries a stopped or media task", () => {
    const requestId = "a150935b-69d3-4600-9f0b-f013ea077e66";
    const old = { ...history[0], messages: [
      { id: "old", role: "assistant" as const, requestId, time: "12:00", status: "error" as const, taskPhase: "unknown" as const,
        content: "上次等待已中断，可以查询原任务结果；不会重复提交收费请求。" },
      { id: "stopped", role: "assistant" as const, requestId: "92deecad-7f51-4795-9f33-5cc9caabdef2", time: "12:00", status: "stopped" as const, content: "已停止" },
      { id: "media", role: "assistant" as const, requestId: "4c4cd796-4810-4567-8cf8-af7ae08a6f86", artifactId: "asset-1", time: "12:00", status: "thinking" as const, content: "" },
    ] };
    const restored = recoverInterruptedMessages([old]);
    expect(interruptedChatRequests(restored)).toEqual([{ conversationId: "a", messageId: "old", requestId }]);
    expect(restored[0].messages[0]).toMatchObject({ content: "", status: "thinking", taskPhase: "running" });
    expect(restored[0].messages[1].status).toBe("stopped");
    expect(restored[0].messages[2].status).toBe("error");
  });
  it("wires page navigation recovery to the GET-only branch and not a new generation POST", () => {
    const source = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    expect(source).toContain("void performChat(pending.conversationId, pending.messageId, pending.requestId)");
    expect(source).toContain('if (typeof request === "string") response = await recover();');
    expect(source).toContain('`/api/ai/requests/${encodeURIComponent(requestId)}`');
    expect(source).toContain('if (typeof request === "string") {\n          // The dispatch result is durable');
  });
  it("uses provider response and reported usage verbatim", () => {
    const usage = { inputTokens: 30, outputTokens: 12, totalTokens: 42, estimated: false };
    expect(completedReply({ requestId: "one-id", content: "已收到", model: "test-model", usage,
      quota: { limitTokens: 1000, usedTokens: 42, remainingTokens: 958, reservedTokens: 0, inputTokens: 30, outputTokens: 12 },
    })).toEqual({ content: "已收到", status: "ready", taskPhase: "completed", model: "test-model", usage });
  });
  it("keeps a model-authored public analysis summary separate from the formal reply", () => {
    const usage = { inputTokens: 30, outputTokens: 12, totalTokens: 42, estimated: false };
    expect(completedReply({ requestId: "summary-id", content: "正式回答", analysisSummary: "依据现有资料，先处理高风险项。", model: "test-model", usage,
      quota: { limitTokens: 1000, usedTokens: 42, remainingTokens: 958, reservedTokens: 0, inputTokens: 30, outputTokens: 12 },
    })).toEqual({ content: "正式回答", analysisSummary: "依据现有资料，先处理高风险项。", status: "ready", taskPhase: "completed", model: "test-model", usage });
  });
  it("clears obsolete partial metadata only after a terminal response and remains JSON-safe", () => {
    const partial = { ...history[0], messages: [{ ...history[0].messages[2], completion: { state: "partial" as const, reason: "output_limit" as const, canContinue: true }, retryDisposition: "recover" as const }] };
    const next = replaceChatMessage([partial], "a", "t", { content: "完整结果", taskPhase: "completed", startedAt: undefined });
    expect(next[0].messages[0]).not.toHaveProperty("completion");
    expect(next[0].messages[0]).not.toHaveProperty("retryDisposition");
    expect(next[0].messages[0]).toEqual(JSON.parse(JSON.stringify(next[0].messages[0])));
  });
  it("preserves the parent planning trace when a PPT execution response carries a different terminal run", () => {
    const parent: AiHarnessTrace = { runId: "parent-plan", tier: "deep", strategy: "plan_execute", status: "planned",
      reasoningSummary: "已校验 PPT 方案", nextAction: "resume", toolBudget: { used: 1, max: 3, remaining: 2 }, steps: [] };
    const execution: AiHarnessTrace = { ...parent, runId: "execution", status: "succeeded", nextAction: "none" };
    const response = { requestId: "execution", content: "PPT 已生成", model: "test", trace: execution,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
      quota: { limitTokens: 10, usedTokens: 2, remainingTokens: 8, reservedTokens: 0, inputTokens: 1, outputTokens: 1 } };
    expect(completedReply(response).trace).toEqual(execution);
    const merged = { trace: parent, ...completedReply(response, { preserveExistingTrace: true }) };
    expect(merged.trace).toEqual(parent);
  });
});
