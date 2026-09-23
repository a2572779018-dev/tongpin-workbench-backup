import { describe, expect, it } from "vitest";
import { AI_CHAT_CONTEXT_LIMITS, AI_CONTEXT_WINDOW_PREFIX, aiChatTextContextBytes, fitAiChatMessages } from "../../../shared/aiContext";
import { buildChatRequest, canRecoverChatRequest, completedReply, recoverInterruptedMessages, replaceChatMessage } from "./chatRequests";
import type { TongpinAIConversation, TongpinAIMessage } from "./types";
import type { AiHarnessTrace } from "../../../shared/ai";

const history: TongpinAIConversation[] = [{ id: "a", title: "A", timeLabel: "刚刚", messages: [
  { id: "u", role: "user", content: "你好", time: "12:00" },
  { id: "r", role: "assistant", content: "旧错误不能送进上下文", status: "error", time: "12:00" },
  { id: "t", role: "assistant", content: "", status: "thinking", time: "12:00" },
] }, { id: "b", title: "B", timeLabel: "刚刚", messages: [] }];

describe("real AI chat request state", () => {
  it("allows result recovery without offering a dead retry for terminal provider errors", () => {
    for (const code of ["NETWORK_UNAVAILABLE", "AI_REQUEST_IN_PROGRESS", "AI_STREAM_INTERRUPTED", "AI_REQUEST_UNCERTAIN", "AI_QUOTA_EXHAUSTED", "AI_NOT_CONFIGURED", "AI_SEARCH_QUOTA_INSUFFICIENT", "AI_QUOTA_INSUFFICIENT"]) {
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
  it("marks interrupted work as interrupted, without fabricating a reply or refund", () => {
    const recovered = recoverInterruptedMessages(history);
    expect(recovered[0].messages[2].status).toBe("error");
    expect(recovered[0].messages[2].content).toContain("查询原任务结果");
    expect(recovered[0].messages[2].taskPhase).toBe("unknown");
    expect(recoverInterruptedMessages([{ ...history[0], messages: [{ ...history[0].messages[2], content: "已收到的部分回答" }] }])[0].messages[0].content).toBe("已收到的部分回答");
    expect(recovered[0].messages[0]).toEqual(history[0].messages[0]);
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
