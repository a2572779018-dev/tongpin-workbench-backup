import { describe, expect, it } from "vitest";
import { buildChatRequest, canRecoverChatRequest, completedReply, recoverInterruptedMessages, replaceChatMessage } from "./chatRequests";
import type { TongpinAIConversation } from "./types";

const history: TongpinAIConversation[] = [{ id: "a", title: "A", timeLabel: "刚刚", messages: [
  { id: "u", role: "user", content: "你好", time: "12:00" },
  { id: "r", role: "assistant", content: "旧错误不能送进上下文", status: "error", time: "12:00" },
  { id: "t", role: "assistant", content: "", status: "thinking", time: "12:00" },
] }, { id: "b", title: "B", timeLabel: "刚刚", messages: [] }];

describe("real AI chat request state", () => {
  it("allows result recovery without offering a dead retry for terminal provider errors", () => {
    for (const code of ["NETWORK_UNAVAILABLE", "AI_REQUEST_IN_PROGRESS", "AI_QUOTA_EXHAUSTED", "AI_NOT_CONFIGURED", "AI_SEARCH_QUOTA_INSUFFICIENT", "AI_QUOTA_INSUFFICIENT"]) {
      expect(canRecoverChatRequest(code, false)).toBe(true);
    }
    for (const code of ["AI_PROVIDER_AUTH", "AI_RESPONSE_INCOMPLETE", "AI_REQUEST_UNCERTAIN", "AI_INPUT_INVALID", "AI_CONNECTION_FAILED"]) {
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
    expect(recovered[0].messages[2].content).toContain("扣额记录");
    expect(recovered[0].messages[0]).toEqual(history[0].messages[0]);
  });
  it("uses provider response and reported usage verbatim", () => {
    const usage = { inputTokens: 30, outputTokens: 12, totalTokens: 42, estimated: false };
    expect(completedReply({ requestId: "one-id", content: "已收到", model: "test-model", usage,
      quota: { limitTokens: 1000, usedTokens: 42, remainingTokens: 958, reservedTokens: 0, inputTokens: 30, outputTokens: 12 },
    })).toEqual({ content: "已收到", status: "ready", model: "test-model", usage });
  });
});
