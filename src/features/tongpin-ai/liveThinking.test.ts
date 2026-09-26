import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiRunEvent } from "../../../shared/aiRunEvents";
import { ChatMessageRow } from "./ChatMessageRow";
import { LiveThinkingPanel } from "./LiveThinkingPanel";
import { applyLiveThinkingEvent, EMPTY_LIVE_THINKING, hasLiveThinking, searchProgressLabel } from "./liveThinking";
import type { TongpinAIMessage } from "./types";

const base = { requestId: "r", runId: "r", stepId: "r", timestamp: 1 };
const ev = (seq: number, payload: Pick<AiRunEvent, "type" | "data">) => ({ ...base, seq, ...payload }) as AiRunEvent;

describe("live thinking state", () => {
  it("builds state only from real reasoning and tool events", () => {
    let state = EMPTY_LIVE_THINKING;
    state = applyLiveThinkingEvent(state, ev(1, { type: "answer_delta", data: { delta: "answer" } }));
    expect(state).toBe(EMPTY_LIVE_THINKING);
    expect(hasLiveThinking(state)).toBe(false);
    state = applyLiveThinkingEvent(state, ev(2, { type: "tool_progress", data: { tool: "web_search", callId: "search-1", status: "in_progress" } }));
    state = applyLiveThinkingEvent(state, ev(3, { type: "tool_progress", data: { tool: "web_search", callId: "search-1", status: "completed", query: "上海天气", sourceCount: 3 } }));
    state = applyLiveThinkingEvent(state, ev(4, { type: "reasoning_delta", data: { delta: "先确认", source: "provider_reasoning_content" } }));
    state = applyLiveThinkingEvent(state, ev(5, { type: "reasoning_delta", data: { delta: "城市", source: "provider_reasoning_content" } }));
    expect(state).toEqual({ reasoning: "先确认城市", searches: [{ tool: "web_search", callId: "search-1", status: "completed", query: "上海天气", sourceCount: 3 }] });
    expect(EMPTY_LIVE_THINKING).toEqual({ reasoning: "", searches: [] });
    expect(hasLiveThinking(state)).toBe(true);
  });

  it("labels only provider-reported search states", () => {
    expect(searchProgressLabel({ tool: "web_search", callId: "search-1", status: "in_progress" })).toBe("已发起");
    expect(searchProgressLabel({ tool: "web_search", callId: "search-1", status: "searching" })).toBe("搜索中");
    expect(searchProgressLabel({ tool: "web_search", callId: "search-1", status: "completed", sourceCount: 0 })).toBe("已完成 · 0 个来源");
    expect(searchProgressLabel({ tool: "web_search", callId: "search-1", status: "completed" })).toBe("已完成");
    expect(searchProgressLabel({ tool: "web_search", callId: "search-1", status: "failed" })).toBe("未完成");
  });

  it("renders query, source count and a collapsed, escaped 思考摘要", () => {
    const html = renderToStaticMarkup(createElement(LiveThinkingPanel, { thinking: {
      reasoning: "<img src=x onerror=alert(1)>先确认城市",
      searches: [{ tool: "web_search", callId: "search-1", status: "completed", query: "上海天气", sourceCount: 2 }],
    } }));
    expect(html).toContain("上海天气");
    expect(html).toContain("已完成 · 2 个来源");
    expect(html).toContain("<summary>思考摘要</summary>");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("<img");
  });
});

describe("in-flight reply row", () => {
  const props = { assistantName: "同频", copied: false, retryable: false, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined };
  const row = (message: TongpinAIMessage) => renderToStaticMarkup(createElement(ChatMessageRow, { ...props, message }));

  it("shows only the neutral wait placeholder before any event", () => {
    const html = row({ id: "m", role: "assistant", content: "", time: "", status: "thinking", startedAt: Date.now() });
    expect(html).toContain("等待模型响应");
    expect(html).not.toMatch(/正在思考|正在整理|正在分析/);
  });

  it("replaces the placeholder with real search progress once events arrive", () => {
    const html = row({ id: "m", role: "assistant", content: "", time: "", status: "thinking", startedAt: Date.now(),
      liveThinking: { reasoning: "", searches: [{ tool: "web_search", callId: "search-1", status: "searching", query: "上海天气" }] } });
    expect(html).toContain("上海天气");
    expect(html).toContain("搜索中");
    expect(html).not.toContain("等待模型响应");
  });

  it("keeps completed search progress visible while the answer streams", () => {
    const html = row({ id: "m", role: "assistant", content: "今天晴。", time: "", status: "typing",
      liveThinking: { reasoning: "", searches: [{ tool: "web_search", callId: "search-1", status: "completed", query: "上海天气", sourceCount: 1 }] } });
    expect(html).toContain("已完成 · 1 个来源");
    expect(html).toContain("tp-ai-markdown");
  });
});
