import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiProviderInput } from "../../shared/ai";
import { createNodeAi } from "./node";
import { readProviderResponse, type AiTransport } from "./provider";

const provider: AiProviderInput = { name: "Search fixture", baseUrl: "https://fixture.example", apiKey: "fixture-not-a-real-key", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100 };
const chat = (): AiChatRequest => ({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "查找官方资料" }], webSearch: true });
const search = (index: number) => ({ id: `search-${index}`, type: "web_search_call", status: "completed", action: { type: "search", sources: [{ title: "Official source", url: "https://example.com/docs" }] } });
const result = (calls: number) => ({ status: "completed", output_text: "根据官方资料的回答", output: Array.from({ length: calls }, (_, index) => search(index)), usage: { input_tokens: 8665, output_tokens: 57, total_tokens: 8722 } });
const event = (type: string, extra: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

describe("Explicit compatible Responses search and bounded settlement", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-search-compat-"));
    transport.mockReset(); transport.mockImplementation(async () => Response.json(result(1)));
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider(provider);
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });
  it.each([0, 1])("automatic search accepts %i actual calls and bills only observed use", async calls => {
    transport.mockResolvedValue(Response.json(result(calls)));
    const request = { ...chat(), webSearch: false, webSearchMode: "auto" as const };
    const response = await runtime.service.chat("member", request);
    expect(response.usage.convertedTokens ?? 0).toBe(calls * 100);
    expect(JSON.parse(transport.mock.calls[0][1].body!)).toMatchObject({ tool_choice: "auto" });
    await runtime.service.chat("member", request);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
  });

  it("defaults old configs to standard search and disabled vision while preserving explicit later settings", async () => {
    expect(runtime.service.provider()).toMatchObject({ webSearchProtocol: "standard", visionEnabled: false, visionInputReserveTokens: 4096 });
    await runtime.service.saveProvider({ ...provider, webSearchProtocol: "compatible", visionInputReserveTokens: 2048 });
    await runtime.service.saveProvider(provider);
    expect(runtime.service.provider()).toMatchObject({ webSearchProtocol: "compatible", visionEnabled: false, visionInputReserveTokens: 2048 });
    await runtime.service.saveProvider({ ...provider, webSearchProtocol: "standard", visionInputReserveTokens: 4096 });
    expect(runtime.service.provider()?.webSearchProtocol).toBe("standard");
  });
  it.each([0, 255, 131073, 4096.5, "4096", NaN])("rejects invalid per-image reservation %s", async visionInputReserveTokens => {
    await expect(runtime.service.saveProvider({ ...provider, visionInputReserveTokens })).rejects.toMatchObject({ code: "AI_VISION_CONFIG_INVALID" });
  });
  it("rejects unknown search profiles and never falls back or repeats a rejected request", async () => {
    await expect(runtime.service.saveProvider({ ...provider, webSearchProtocol: "auto" })).rejects.toMatchObject({ code: "AI_SEARCH_CONFIG_INVALID" });
    transport.mockResolvedValueOnce(Response.json({ error: { message: "Unsupported parameter: max_tool_calls" } }, { status: 400 }));
    const request = chat();
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ diagnostic: { param: "max_tool_calls", billing: "rejected" } });
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });
  it.each([1, 2, 3, 5])("reserves 5 conversions but settles only %i observed searches, retaining source requirements", async calls => {
    const standard = runtime.service.preflight("member", chat());
    await runtime.service.saveProvider({ ...provider, webSearchProtocol: "compatible" });
    const request = chat();
    const compatible = runtime.service.preflight("member", request);
    expect(compatible.budget.convertedReserve).toBe(500);
    expect(compatible.budget.minimumRequiredTokens - standard.budget.minimumRequiredTokens).toBe(400);
    transport.mockResolvedValueOnce(Response.json(result(calls)));
    const response = await runtime.service.chat("member", request);
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body).not.toHaveProperty("max_tool_calls");
    expect(body).toMatchObject({ tools: [{ type: "web_search", search_context_size: "low" }], tool_choice: "required", include: ["web_search_call.action.sources"] });
    expect(response.usage).toMatchObject({ inputTokens: 8665, outputTokens: 57, tokenUsageEstimated: false, searchCalls: calls, convertedTokens: calls * 100, totalTokens: 8722 + calls * 100 });
    expect(response.quota).toMatchObject({ usedTokens: 8722 + calls * 100, reservedTokens: 0 });
    expect(response.sources).toEqual([{ title: "Official source", url: "https://example.com/docs" }]);
    runtime.close(); runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    expect(runtime.store.usage("member")[0]).toMatchObject({ searchCalls: calls, convertedTokens: calls * 100 });
    expect((await runtime.service.chat("member", request)).usage).toEqual(response.usage);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("cancels on the sixth stream search, keeps uncertain settlement, and never resumes or retries it", async () => {
    await runtime.service.saveProvider({ ...provider, webSearchProtocol: "compatible" });
    let pulls = 0;
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode(event("response.output_item.added", { output_index: pulls, item: search(pulls) }))); pulls++; }, cancel: cancelled }, { highWaterMark: 0 });
    transport.mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const request = chat();
    const reserved = runtime.service.preflight("member", request).budget;
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_SEARCH_LIMIT_EXCEEDED" });
    expect(pulls).toBe(6); expect(cancelled).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: reserved.inputReserve + reserved.searchInputReserve + reserved.availableOutputTokens + reserved.convertedReserve, reservedTokens: 0 });
    expect(runtime.service.getRequestResult("member", request.requestId)).toMatchObject({ status: "uncertain" });
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_SEARCH_LIMIT_EXCEEDED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not undercharge as completed when a terminal response drops an observed search call", async () => {
    await runtime.service.saveProvider({ ...provider, webSearchProtocol: "compatible" });
    const body = event("response.output_item.added", { output_index: 0, item: search(0) })
      + event("response.output_item.added", { output_index: 1, item: search(1) })
      + event("response.completed", { response: result(1) });
    transport.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const request = chat();
    const reserved = runtime.service.preflight("member", request).budget;
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_SEARCH_USAGE_MISMATCH" });
    const record = runtime.service.getRequestResult("member", request.requestId);
    expect(record).toMatchObject({ status: "uncertain", error: { code: "AI_SEARCH_USAGE_MISMATCH" } });
    expect(record.result).toBeUndefined();
    expect(runtime.store.usage("member")[0]).toMatchObject({ status: "uncertain", estimated: true, totalTokens: reserved.inputReserve + reserved.searchInputReserve + reserved.availableOutputTokens + reserved.convertedReserve });
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_SEARCH_USAGE_MISMATCH" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});

describe("Search stream guard framing", () => {
  it("deduplicates added/done events by output index and accepts complete search after split UTF-8 frames", async () => {
    const text = event("response.output_item.added", { output_index: 0, item: search(0) }) + event("response.output_item.done", { output_index: 0, item: search(0) }) + event("response.completed", { response: result(1) });
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3)); controller.close(); } });
    expect(await readProviderResponse(new Response(stream, { headers: { "content-type": "text/event-stream" } }), { maxSearchCalls: 1 })).toMatchObject(result(1));
  });
  it("checks terminal-only JSON and SSE payloads against the same budget", async () => {
    await expect(readProviderResponse(Response.json(result(4)), { maxSearchCalls: 3 })).rejects.toMatchObject({ code: "AI_SEARCH_LIMIT_EXCEEDED" });
    await expect(readProviderResponse(new Response(event("response.completed", { response: result(4) })), { maxSearchCalls: 3 })).rejects.toMatchObject({ code: "AI_SEARCH_LIMIT_EXCEEDED" });
    await expect(readProviderResponse(Response.json(result(1)), { maxSearchCalls: 0 })).rejects.toMatchObject({ code: "AI_SEARCH_LIMIT_EXCEEDED" });
  });
  it.each([true, false])("reconciles missing final calls even when added events arrive after terminal: %s", async terminalFirst => {
    const added = event("response.output_item.added", { output_index: 0, item: search(0) }) + event("response.output_item.done", { output_index: 1, item: search(1) });
    const terminal = event("response.completed", { response: result(1) });
    await expect(readProviderResponse(new Response(terminalFirst ? terminal + added : added + terminal), { maxSearchCalls: 3 })).rejects.toMatchObject({ code: "AI_SEARCH_USAGE_MISMATCH" });
  });
  it("accepts terminal calls with missing added/done events without inventing incomplete usage", async () => {
    const added = event("response.output_item.added", { output_index: 0, item: search(0) });
    const terminal = event("response.completed", { response: result(2) });
    expect(await readProviderResponse(new Response(added + terminal), { maxSearchCalls: 3 })).toMatchObject(result(2));
  });
});
