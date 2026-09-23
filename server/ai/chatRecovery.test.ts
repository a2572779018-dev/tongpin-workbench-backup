import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import { readProviderResponse, type AiTransport } from "./provider";
import { parseAiDispatchDecision } from "./dispatch";
import { createChatStreamResponse } from "./chatStream";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import { readAiChatStream } from "../../src/lib/aiRunStream";
import { createVisibleStream } from "./visibleStream";

describe("recoverable chat output", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  const chat = () => ({ requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "quick", messages: [{ role: "user", content: "写一个完整方案" }] });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-chat-recovery-"));
    transport.mockReset();
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider({ name: "fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-not-real", protocol: "chat_completions", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true });
    runtime.service.setQuota("member", "admin", { limitTokens: 100000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("keeps a long plain answer outside a dispatcher JSON envelope", () => {
    const content = "# 方案\n\n" + "保留完整正文。".repeat(500);
    expect(parseAiDispatchDecision(content, "quick", { allowPlainText: true })).toEqual({ kind: "text", content });
  });
  it("stores partial output with actual usage and never resubmits a recovered request", async () => {
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "第一部分已经完成，后续" }, finish_reason: "length" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const request = chat();
    const events: AiRunEvent[] = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: value => events.push(value) });
    expect(result).toMatchObject({ content: "第一部分已经完成，后续", completion: { state: "partial", reason: "output_limit", canContinue: true }, usage: { totalTokens: 50, estimated: false } });
    expect(result.richContent).toEqual({ version: 1, blocks: [{ id: "markdown:0", kind: "markdown", start: 0, end: result.content.length }] });
    expect(events.map(value => value.type)).toEqual(["run_started", "usage_updated", "run_finished"]);
    expect(events[1]).toMatchObject({ data: { status: "uncertain", providerReported: true, usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50, estimated: false } } });
    expect(events[1].data).toEqual({ status: "uncertain", providerReported: true, usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50, estimated: false } });
    expect(runtime.store.usage("member").find(value => value.requestId === request.requestId)?.totalTokens).toBe(50);
    expect(runtime.service.getRequestResult("member", request.requestId).result).toMatchObject({ content: result.content, completion: result.completion });
    await runtime.service.chat("member", request);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.quota("member").usedTokens).toBe(50);
  });
  it("never executes or salvages incomplete tool parameters", async () => {
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"kind":"image","prompt":"unfinished' }, finish_reason: "length" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const request = { ...chat(), outputFormat: "image_plan" };
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_RESPONSE_INCOMPLETE" });
    expect(runtime.service.getRequestResult("member", request.requestId).result?.toolPlan).toBeUndefined();
  });
  it("delivers a delta before the provider ends its stream", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const deltas: string[] = [];
    const done = readProviderResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), { onTextDelta: delta => deltas.push(delta) });
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"真实首段"}\n\n'));
    await vi.waitFor(() => expect(deltas).toEqual(["真实首段"]));
    controller.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"output_text":"真实首段","status":"completed"}}\n\n'));
    controller.close();
    await expect(done).resolves.toMatchObject({ output_text: "真实首段", status: "completed" });
  });
  it("continues a partial with a new linked attempt from the immutable original snapshot", async () => {
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "第一部分" }, finish_reason: "length" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const original = chat();
    const first = await runtime.service.chat("member", original);
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "第二部分" }, finish_reason: "stop" }], usage: { prompt_tokens: 30, completion_tokens: 30, total_tokens: 60 } }));
    const retry = { ...chat(), retryOf: original.requestId, retryMode: "continue", messages: [{ role: "user", content: "forged replacement" }] };
    const second = await runtime.service.chat("member", retry);
    expect(second.attempt).toEqual({ runId: first.attempt!.runId, attemptId: retry.requestId, parentAttemptId: original.requestId });
    const sent = JSON.parse(transport.mock.calls[1][1].body!);
    expect(sent.messages).toContainEqual({ role: "assistant", content: "第一部分" });
    expect(JSON.stringify(sent)).not.toContain("forged replacement");
    await runtime.service.chat("member", retry);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(runtime.store.quota("member").usedTokens).toBe(110);
  });
  it("rejects retry across accounts/conversations and unknown billing", async () => {
    transport.mockResolvedValueOnce(new Response('data: {"type":"response.output_text.delta","delta":"可读部分"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    await runtime.service.saveProvider({ ...runtime.service.provider()!, protocol: "responses" });
    const original = chat();
    await runtime.service.chat("member", original);
    await expect(runtime.service.chat("member", { ...chat(), retryOf: original.requestId, retryMode: "regenerate" })).rejects.toMatchObject({ code: "AI_RETRY_UNSAFE" });
    await expect(runtime.service.chat("member", { ...chat(), conversationId: "conversation-b", retryOf: original.requestId, retryMode: "continue" })).rejects.toMatchObject({ code: "AI_RETRY_NOT_FOUND" });
    runtime.service.setQuota("other", "admin", { limitTokens: 100000 });
    await expect(runtime.service.chat("other", { ...chat(), retryOf: original.requestId, retryMode: "continue" })).rejects.toMatchObject({ code: "AI_RETRY_NOT_FOUND" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("streams through server and browser decoder before EOF, persists ordered replay without billing again", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } }));
    const request = chat(), events: AiRunEvent[] = [];
    const client = readAiChatStream(async <T,>() => createChatStreamResponse(runtime.service, "member", request) as T, request as never, { accountId: "member", signal: new AbortController().signal, onEvent: value => events.push(value) });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const event = { choices: [{ delta: { content: "流式首段" }, finish_reason: null }] };
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    await vi.waitFor(() => expect(events.some(value => value.type === "answer_delta" && value.data.delta === "流式首段")).toBe(true));
    expect(events.some(value => value.type === "run_finished")).toBe(false);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":30,"total_tokens":50}}\n\ndata: [DONE]\n\n'));
    controller.close();
    expect((await client).content).toBe("流式首段");
    expect(events.at(-1)).toMatchObject({ type: "run_finished", data: { response: { richContent: { version: 1 } } } });
    expect(events.every(value => value.schemaVersion === 1 && value.eventId === `${request.requestId}:${value.seq}`)).toBe(true);
    const replay = runtime.service.getRunEvents("member", request.requestId);
    expect(replay.map(value => value.seq)).toEqual([1, 2, 3, 4]);
    expect(replay.map(value => value.type)).toEqual(["run_started", "answer_delta", "usage_updated", "run_finished"]);
    expect(replay[2]).toMatchObject({ data: { status: "completed", providerReported: true, usage: { inputTokens: 20, outputTokens: 30, totalTokens: 50, estimated: false } } });
    expect(replay[2]).toMatchObject({ requestId: request.requestId, runId: expect.any(String), stepId: request.requestId, seq: 3, timestamp: expect.any(Number) });
    expect(runtime.service.getRunEvents("member", request.requestId, 2)).toHaveLength(2);
    runtime.service.setQuota("other", "admin", { limitTokens: 100000 });
    expect(() => runtime.service.getRunEvents("other", request.requestId)).toThrow(expect.objectContaining({ code: "AI_REQUEST_NOT_FOUND" }));
    expect(runtime.service.forTenant("other-tenant").store.runEvents("member", request.requestId)).toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.quota("member").usedTokens).toBe(50);
  });
  it("persists versioned markdown block offsets and stable event ids on the real chat stream", async () => {
    const content = "结论。\n\n| 项目 | 状态 |\n| --- | --- |\n| 视频 | 完成 |";
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const request = chat();
    const seen: AiRunEvent[] = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: value => seen.push(value) });
    expect(result.richContent).toEqual({ version: 1, blocks: [
      { id: "markdown:0", kind: "markdown", start: 0, end: 3 },
      { id: "markdown:5", kind: "markdown", start: 5, end: content.length },
    ] });
    expect(runtime.service.getRequestResult("member", request.requestId).result?.richContent).toEqual(result.richContent);
    expect(seen.at(-1)).toMatchObject({ type: "run_finished", data: { response: { richContent: result.richContent } } });
    expect(seen).toEqual(runtime.service.getRunEvents("member", request.requestId));
    for (const event of seen) expect(event).toMatchObject({
      schemaVersion: 1, eventId: `${request.requestId}:${event.seq}`, attemptId: request.requestId,
      conversationId: request.conversationId,
    });
    expect(runtime.store.quota("member").usedTokens).toBe(50);
    await runtime.service.chat("member", request);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.quota("member").usedTokens).toBe(50);
  });
  it("does not report conservative reservation as provider usage", async () => {
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "正文" }, finish_reason: "stop" }] }));
    const request = chat(), events: AiRunEvent[] = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: value => events.push(value) });
    expect(result.usage.estimated).toBe(true);
    expect(events.map(value => value.type)).toEqual(["run_started", "run_finished"]);
    expect(runtime.service.getRunEvents("member", request.requestId).some(value => value.type === "usage_updated")).toBe(false);
  });
  it("reports provider usage already settled before a malformed answer fails", async () => {
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const request = chat(), events: AiRunEvent[] = [];
    await expect(runtime.service.chat("member", request, { stream: true, onEvent: value => events.push(value) })).rejects.toMatchObject({ code: "AI_EMPTY_RESPONSE" });
    expect(events.map(value => value.type)).toEqual(["run_started", "usage_updated", "run_failed"]);
    expect(events[1]).toMatchObject({ data: { status: "uncertain", providerReported: true, usage: { totalTokens: 50, estimated: false } } });
    expect(runtime.store.quota("member").usedTokens).toBe(50);
  });
  it("reports settled provider usage on a rejected tool plan without exposing its body", async () => {
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "not a valid tool plan" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }));
    const request = { ...chat(), outputFormat: "image_plan" }, events: AiRunEvent[] = [];
    await expect(runtime.service.chat("member", request, { stream: true, onEvent: value => events.push(value) })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_INVALID" });
    expect(events.map(value => value.type)).toEqual(["run_started", "usage_updated", "run_failed"]);
    expect(events[1]).toMatchObject({ data: { status: "failed", providerReported: true, usage: { totalTokens: 50 } } });
    expect(JSON.stringify(events[1])).not.toContain("not a valid tool plan");
  });
  it("keeps an accepted generation running after its SSE subscriber disconnects", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { "content-type": "text/event-stream" } }));
    const request = chat(), accepted: Promise<void>[] = [];
    const response = createChatStreamResponse(runtime.service, "member", request, task => accepted.push(task));
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("run_started");
    await reader.cancel();
    expect(accepted).toHaveLength(1);
    controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"断开后完成"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":30,"total_tokens":50}}\n\ndata: [DONE]\n\n'));
    controller.close();
    await Promise.all(accepted);
    expect(runtime.service.getRequestResult("member", request.requestId).result?.content).toBe("断开后完成");
    expect(runtime.store.quota("member").usedTokens).toBe(50);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not leak split private reasoning or structured tool parameters into visible deltas", () => {
    const answers: string[] = [], summaries: string[] = [];
    const stream = createVisibleStream("quick", value => answers.push(value), value => summaries.push(value));
    for (const char of '<think>private chain</think><analysis_summary>公开依据</analysis_summary>可见正文') stream.feed(char);
    expect(answers.join("")).toBe("可见正文"); expect(summaries).toEqual(["公开依据"]);
    const tools: string[] = [];
    const tool = createVisibleStream("quick", value => tools.push(value), () => undefined);
    for (const char of '<tool_request>{"kind":"image","prompt":"未授权"}</tool_request>') tool.feed(char);
    expect(tools).toEqual([]);
  });
});
