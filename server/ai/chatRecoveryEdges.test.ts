import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest } from "../../shared/ai";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import type { StoredRequest } from "./storage";
import { createVisibleStream } from "./visibleStream";

const provider = {
  name: "fixture",
  baseUrl: "https://api.example.com/v1",
  apiKey: "fixture-not-real",
  protocol: "chat_completions" as const,
  quickModel: "quick",
  deepModel: "deep",
  maxOutputTokens: 1024,
  reasoningEffort: "",
  enabled: true,
};

const response = (content: string, totalTokens: number) => Response.json({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: totalTokens - 1, total_tokens: totalTokens },
});

describe("chat recovery edge invariants", () => {
  let directory: string;
  let dataFile: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-chat-recovery-edges-"));
    dataFile = path.join(directory, "fixture.json");
    transport.mockReset();
    runtime = await createNodeAi(dataFile, transport);
  });

  afterEach(async () => {
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("isolates identical account, request and conversation ids across two tenants in SQLite", async () => {
    const tenantA = runtime.service.forTenant("tenant-a");
    const tenantB = runtime.service.forTenant("tenant-b");
    await tenantA.saveProvider(provider);
    await tenantB.saveProvider(provider);
    tenantA.setQuota("same-member", "admin-a", { limitTokens: 10_000 });
    tenantB.setQuota("same-member", "admin-b", { limitTokens: 10_000 });
    transport.mockResolvedValueOnce(response("tenant A answer", 11)).mockResolvedValueOnce(response("tenant B answer", 17));
    const requestId = crypto.randomUUID();
    const base = { requestId, conversationId: "shared-conversation", mode: "quick" as const };

    const first = await tenantA.chat("same-member", { ...base, messages: [{ role: "user", content: "tenant A prompt" }] }, { stream: true });
    const second = await tenantB.chat("same-member", { ...base, messages: [{ role: "user", content: "tenant B prompt" }] }, { stream: true });

    expect(first.content).toBe("tenant A answer");
    expect(second.content).toBe("tenant B answer");
    expect(tenantA.store.requestSnapshot("same-member", requestId)).toMatchObject({ messages: [{ content: "tenant A prompt" }] });
    expect(tenantB.store.requestSnapshot("same-member", requestId)).toMatchObject({ messages: [{ content: "tenant B prompt" }] });
    expect(tenantA.getRunEvents("same-member", requestId).at(-1)?.data).toMatchObject({ response: { content: "tenant A answer" } });
    expect(tenantB.getRunEvents("same-member", requestId).at(-1)?.data).toMatchObject({ response: { content: "tenant B answer" } });
    expect(tenantA.quota("same-member").usedTokens).toBe(11);
    expect(tenantB.quota("same-member").usedTokens).toBe(17);

    await tenantA.chat("same-member", { ...base, messages: [{ role: "user", content: "tenant A prompt" }] }, { stream: true });
    await tenantB.chat("same-member", { ...base, messages: [{ role: "user", content: "tenant B prompt" }] }, { stream: true });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(tenantA.quota("same-member").usedTokens).toBe(11);
    expect(tenantB.quota("same-member").usedTokens).toBe(17);
  });

  it("settles an expired pending row once after a real SQLite reopen and never resumes generation", async () => {
    runtime.service.setQuota("member", "admin", { limitTokens: 10_000 });
    const requestId = crypto.randomUUID();
    const pending: StoredRequest = {
      requestId,
      userId: "member",
      hash: "persisted-request-hash",
      status: "pending",
      createdAt: new Date(Date.now() - 300_000).toISOString(),
      expiresAt: Date.now() - 1,
      inputReserve: 5,
      outputReserve: 20,
      convertedReserve: 7,
      kind: "chat",
      model: "quick",
      mode: "quick",
      conversationId: "conversation-a",
    };
    const quota = runtime.store.quota("member");
    quota.reservedTokens = 32;
    runtime.store.sql.transaction(() => {
      runtime.store.saveQuota("member", quota);
      runtime.store.saveRequest(pending);
    });
    runtime.close();

    runtime = await createNodeAi(dataFile, transport);
    expect(runtime.service.quota("member")).toMatchObject({ reservedTokens: 0, usedTokens: 32, inputTokens: 5, outputTokens: 20 });
    expect(runtime.service.getRequestResult("member", requestId)).toMatchObject({ status: "uncertain", error: { code: "AI_REQUEST_UNCERTAIN" } });
    expect(runtime.store.usage("member").filter(entry => entry.requestId === requestId)).toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();

    runtime.service.quota("member");
    runtime.service.getRequestResult("member", requestId);
    expect(runtime.store.usage("member").filter(entry => entry.requestId === requestId)).toHaveLength(1);
    expect(runtime.store.quota("member").usedTokens).toBe(32);
  });

  it("does not expose a structured envelope after a whitespace-only first delta", () => {
    const visible: string[] = [];
    const stream = createVisibleStream("quick", delta => visible.push(delta), () => undefined);
    stream.feed("  \n");
    stream.feed('{"kind":"image","prompt":"must stay terminal-only"}');
    expect(visible).toEqual([]);
  });

  it("ignores provider reasoning fields while retaining only public content deltas", async () => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    runtime.service.setQuota("member", "admin", { limitTokens: 10_000 });
    const bytes = new TextEncoder().encode([
      'data: {"type":"response.reasoning_text.delta","delta":"hidden chain"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"visible answer"}\n\n',
      'data: {"type":"response.completed","response":{"output_text":"visible answer","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ].join(""));
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }));
    const request: AiChatRequest = { requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "quick", messages: [{ role: "user", content: "answer" }] };
    const events: unknown[] = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: event => events.push(event) });
    expect(result.content).toBe("visible answer");
    expect(JSON.stringify(events)).not.toContain("hidden chain");
    expect(JSON.stringify(runtime.service.getRunEvents("member", request.requestId))).not.toContain("hidden chain");
  });

  it("accepts a provider-designated public summary after a whitespace-only SSE delta", async () => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    runtime.service.setQuota("member", "admin", { limitTokens: 10_000 });
    const bytes = new TextEncoder().encode([
      'data: {"type":"response.reasoning_summary_text.delta","delta":"  \\n"}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"公开"}\n\n',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"依据"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"正式回答"}\n\n',
      'data: {"type":"response.completed","response":{"output_text":"正式回答","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ].join(""));
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }));
    const request: AiChatRequest = { requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "quick", messages: [{ role: "user", content: "answer" }] };
    const events: Array<{ type: string; data: unknown }> = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: event => events.push(event) });
    expect(events.filter(event => event.type === "public_summary_delta").map(event => (event.data as { delta: string }).delta).join("")).toBe("公开依据");
    expect(result).toMatchObject({ content: "正式回答", analysisSummary: "公开依据" });
    expect(runtime.service.getRequestResult("member", request.requestId).result?.analysisSummary).toBe("公开依据");
  });

  it("requests and persists a provider-designated public summary on the verified official Responses route", async () => {
    await runtime.service.saveProvider({ ...provider, baseUrl: "https://api.openai.com/v1", protocol: "responses", deepModel: "gpt-6-astra", reasoningEffort: "high" });
    runtime.service.setQuota("member", "admin", { limitTokens: 10_000 });
    const publicSummary = "公开依据。".repeat(50);
    const bytes = new TextEncoder().encode([
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: publicSummary.slice(0, 120) })}\n\n`,
      `data: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: publicSummary.slice(120) })}\n\n`,
      'data: {"type":"response.reasoning_text.delta","delta":"hidden private reasoning"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"正式回答"}\n\n',
      'data: {"type":"response.completed","response":{"output_text":"正式回答","status":"completed","usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ].join(""));
    transport.mockResolvedValueOnce(new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }), { headers: { "content-type": "text/event-stream" } }));
    const request: AiChatRequest = { requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "deep", messages: [{ role: "user", content: "比较两个方案" }] };
    const events: Array<{ type: string; data: unknown }> = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: event => events.push(event) });
    expect(JSON.parse(transport.mock.calls[0][1].body!)).toMatchObject({ reasoning: { effort: "high", summary: "auto" } });
    expect(events.filter(event => event.type === "public_summary_delta").map(event => (event.data as { delta: string }).delta).join("")).toBe(publicSummary);
    expect(result.analysisSummary).toBe(publicSummary);
    expect(JSON.stringify(events)).not.toContain("hidden private reasoning");
  });

  it("uses a terminal-only official public summary without falling back to private reasoning", async () => {
    await runtime.service.saveProvider({ ...provider, baseUrl: "https://api.openai.com/v1", protocol: "responses", deepModel: "gpt-6-astra", reasoningEffort: "high" });
    runtime.service.setQuota("member", "admin", { limitTokens: 10_000 });
    const terminal = {
      output_text: "正式回答", status: "completed", usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "公开依据" }], content: [{ type: "reasoning_text", text: "private chain" }] }],
    };
    transport.mockResolvedValueOnce(new Response(`data: ${JSON.stringify({ type: "response.completed", response: terminal })}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const request: AiChatRequest = { requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "deep", messages: [{ role: "user", content: "比较两个方案" }] };
    const events: Array<{ type: string; data: unknown }> = [];
    const result = await runtime.service.chat("member", request, { stream: true, onEvent: event => events.push(event) });
    expect(result).toMatchObject({ content: "正式回答", analysisSummary: "公开依据" });
    expect(events.some(event => event.type === "public_summary_delta" && (event.data as { delta: string }).delta === "公开依据")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private chain");
  });
});
