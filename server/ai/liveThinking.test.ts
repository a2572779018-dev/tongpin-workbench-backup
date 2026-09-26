import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiProviderInput } from "../../shared/ai";
import type { AiRunEvent, AiToolProgress } from "../../shared/aiRunEvents";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import { consumeProviderResponse } from "./providerStream";
import { AI_LIVE_REASONING_LIMIT } from "./service";

const sse = (...events: unknown[]) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    // One event per chunk exercises the incremental decoder.
    for (const value of events) controller.enqueue(encoder.encode(typeof value === "string" ? value : `data: ${JSON.stringify(value)}\n\n`));
    controller.close();
  },
}), { headers: { "content-type": "text/event-stream" } });
const responsesUsage = { input_tokens: 1, output_tokens: 2, total_tokens: 3 };
const completed = (extra: Record<string, unknown> = {}) => ({ type: "response.completed", response: { output_text: "正式回答", status: "completed", usage: responsesUsage, ...extra } });
const searchItem = (status: string, action?: Record<string, unknown>) => ({ id: "ws_provider_internal_id", type: "web_search_call", status, ...(action ? { action } : {}) });

describe("provider stream shapes for live thinking", () => {
  it("streams Responses reasoning_summary_text deltas, separates parts and uses .done only for parts without deltas", async () => {
    const summary: string[] = [];
    await consumeProviderResponse(sse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "先比较" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "两个方案" },
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", output_index: 0, summary_index: 0, text: "先比较两个方案" },
      // A gateway that only reports the finished part text.
      { type: "response.reasoning_summary_text.done", item_id: "rs_1", output_index: 0, summary_index: 1, text: "再核对风险" },
      { type: "response.output_text.delta", delta: "正式回答" },
      completed(),
    ), { onPublicSummaryDelta: delta => summary.push(delta) });
    expect(summary.join("")).toBe("先比较两个方案\n\n再核对风险");
  });

  it("never exposes Responses reasoning_text, even when it carries summary-like metadata", async () => {
    const summary: string[] = [], reasoning: string[] = [], text: string[] = [];
    await consumeProviderResponse(sse(
      { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "raw private chain" },
      { type: "response.reasoning_text.delta", item_id: "rs_1", summary_index: 0, delta: "raw chain claiming summary" },
      { type: "response.reasoning_text.done", item_id: "rs_1", content_index: 0, text: "raw private chain" },
      { type: "response.output_text.delta", delta: "正式回答" },
      completed({ output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "raw private chain" }] }] }),
    ), { onPublicSummaryDelta: d => summary.push(d), onProviderReasoningDelta: d => reasoning.push(d), onTextDelta: d => text.push(d) });
    expect(summary).toEqual([]);
    expect(reasoning).toEqual([]);
    expect(text.join("")).toBe("正式回答");
  });

  it("never forwards chat-completions raw reasoning_content", async () => {
    const reasoning: string[] = [], text: string[] = [];
    const result = await consumeProviderResponse(sse(
      { choices: [{ delta: { role: "assistant", reasoning_content: "用户问的是" } }] },
      { choices: [{ delta: { reasoning_content: "上海天气" } }] },
      { choices: [{ delta: { content: "今天" } }] },
      { choices: [{ delta: { content: "晴。" }, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      "data: [DONE]\n\n",
    ), { onProviderReasoningDelta: d => reasoning.push(d), onTextDelta: d => text.push(d) });
    expect(reasoning).toEqual([]);
    expect(text.join("")).toBe("今天晴。");
    expect(JSON.stringify(result)).not.toContain("上海天气");
  });

  it("reports real web_search_call progress with query and source count, deduplicated and never regressing", async () => {
    const progress: AiToolProgress[] = [];
    await consumeProviderResponse(sse(
      { type: "response.output_item.added", output_index: 0, item: searchItem("in_progress") },
      { type: "response.web_search_call.in_progress", output_index: 0, item_id: "ws_provider_internal_id" },
      { type: "response.web_search_call.searching", output_index: 0, item_id: "ws_provider_internal_id" },
      { type: "response.web_search_call.completed", output_index: 0, item_id: "ws_provider_internal_id" },
      { type: "response.output_item.done", output_index: 0, item: searchItem("completed", { type: "search", query: "上海\n今日天气", sources: [{ url: "https://a.example" }, { url: "https://b.example" }] }) },
      { type: "response.web_search_call.searching", output_index: 0, item_id: "ws_provider_internal_id" },
      { type: "response.output_text.delta", delta: "正式回答" },
      completed({ output: [searchItem("completed")] }),
    ), { maxSearchCalls: 1, onToolProgress: p => progress.push(p) });
    expect(progress).toEqual([
      { tool: "web_search", callId: "search-1", status: "in_progress" },
      { tool: "web_search", callId: "search-1", status: "searching" },
      { tool: "web_search", callId: "search-1", status: "completed" },
      { tool: "web_search", callId: "search-1", status: "completed", query: "上海 今日天气", sourceCount: 2 },
    ]);
    expect(JSON.stringify(progress)).not.toContain("ws_provider_internal_id");
  });

  it("marks a failed search call as failed", async () => {
    const progress: AiToolProgress[] = [];
    await consumeProviderResponse(sse(
      { type: "response.output_item.added", output_index: 1, item: searchItem("in_progress") },
      { type: "response.output_item.done", output_index: 1, item: searchItem("failed", { type: "search", query: "q" }) },
      completed({ output: [searchItem("failed")] }),
    ), { maxSearchCalls: 1, onToolProgress: p => progress.push(p) });
    expect(progress.at(-1)).toEqual({ tool: "web_search", callId: "search-1", status: "failed", query: "q" });
  });
});

describe("live thinking run events", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  const base: AiProviderInput = { name: "fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-not-real", protocol: "chat_completions", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true };
  const request = (extra: Partial<AiChatRequest> = {}): AiChatRequest => ({ requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "quick", messages: [{ role: "user", content: "上海天气" }], ...extra });
  const run = async (body: AiChatRequest & { liveProgress?: boolean }) => {
    const events: AiRunEvent[] = [];
    const response = await runtime.service.chat("member", body, { stream: true, onEvent: event => events.push(event) });
    return { response, events };
  };
  const chatReasoningStream = (reasoningDeltas: string[]) => sse(
    ...reasoningDeltas.map(delta => ({ choices: [{ delta: { reasoning_content: delta } }] })),
    { choices: [{ delta: { content: "今天晴。" }, finish_reason: "stop" }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  );

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-live-thinking-"));
    transport.mockReset();
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("does not stream raw reasoning_content even to opted-in clients", async () => {
    await runtime.service.saveProvider(base);
    transport.mockResolvedValueOnce(chatReasoningStream(["用户问的是", "上海天气"]));
    const body = { ...request(), liveProgress: true };
    const { response, events } = await run(body);
    expect(events.map(event => event.type)).not.toContain("reasoning_delta");
    expect(JSON.stringify(events)).not.toContain("上海天气");
    expect(response.content).toBe("今天晴。");
    expect(transport.mock.calls[0][1].body).not.toContain("liveProgress");
    expect(JSON.stringify(runtime.store.requestSnapshot("member", body.requestId))).not.toContain("liveProgress");
  });

  it("does not emit new event types to clients that did not opt in", async () => {
    await runtime.service.saveProvider(base);
    transport.mockResolvedValueOnce(chatReasoningStream(["用户问的是上海天气"]));
    const { events } = await run(request());
    expect(events.map(event => event.type)).not.toContain("reasoning_delta");
    expect(JSON.stringify(events)).not.toContain("上海天气");
  });

  it("streams web_search_call progress from a Responses provider", async () => {
    await runtime.service.saveProvider({ ...base, protocol: "responses", webSearchEnabled: true, webSearchQuotaTokens: 100 });
    const done = searchItem("completed", { type: "search", query: "上海 今日天气", sources: [{ title: "Weather", url: "https://weather.example" }] });
    transport.mockResolvedValueOnce(sse(
      { type: "response.output_item.added", output_index: 0, item: searchItem("in_progress") },
      { type: "response.web_search_call.searching", output_index: 0, item_id: "ws_provider_internal_id" },
      { type: "response.output_item.done", output_index: 0, item: done },
      { type: "response.reasoning_text.delta", delta: "hidden raw reasoning" },
      { type: "response.output_text.delta", delta: "正式回答" },
      completed({ output: [done], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }),
    ));
    const { response, events } = await run({ ...request({ webSearch: true }), liveProgress: true });
    const progress = events.flatMap(event => event.type === "tool_progress" ? [event.data] : []);
    expect(progress.map(item => item.status)).toEqual(["in_progress", "searching", "completed"]);
    expect(progress.at(-1)).toEqual({ tool: "web_search", callId: "search-1", status: "completed", query: "上海 今日天气", sourceCount: 1 });
    expect(events.findIndex(event => event.type === "tool_progress")).toBeLessThan(events.findIndex(event => event.type === "answer_delta"));
    expect(JSON.stringify(events)).not.toContain("hidden raw reasoning");
    expect(response.sources).toEqual([{ title: "Weather", url: "https://weather.example/" }]);
  });

  it("keeps streaming Responses public summaries and persists them as analysisSummary", async () => {
    await runtime.service.saveProvider({ ...base, protocol: "responses" });
    transport.mockResolvedValueOnce(sse(
      { type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 0, delta: "比较" },
      { type: "response.reasoning_summary_text.delta", item_id: "rs", summary_index: 1, delta: "核对" },
      { type: "response.output_text.delta", delta: "正式回答" },
      completed(),
    ));
    const { response, events } = await run({ ...request(), liveProgress: true });
    expect(events.flatMap(event => event.type === "public_summary_delta" ? [event.data.delta] : []).join("")).toBe("比较\n\n核对");
    expect(response.analysisSummary).toBe("比较\n\n核对");
  });
});
