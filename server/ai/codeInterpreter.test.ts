import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiProviderInput } from "../../shared/ai";
import { createNodeAi } from "./node";
import { readProviderResponse, type AiTransport } from "./provider";

const provider: AiProviderInput = { name: "Code exec fixture", baseUrl: "https://fixture.example", apiKey: "fixture-not-a-real-key", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true, codeInterpreterEnabled: true, codeInterpreterQuotaTokens: 200 };
const chat = (content = "帮我计算一下这组数据的平均值并画个图"): AiChatRequest => ({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content }] });
const exec = (index: number, extra: Record<string, unknown> = {}) => ({ id: `exec-${index}`, type: "code_interpreter_call", status: "completed", container_id: "container-fixture", code: "print(sum([1, 2, 3]) / 3)", outputs: [{ type: "logs", logs: "1.0" }], ...extra });
const result = (calls: number, extra: Record<string, unknown> = {}) => ({ status: "completed", output_text: "平均值是 1.0", output: Array.from({ length: calls }, (_, index) => exec(index)), usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 }, ...extra });
const event = (type: string, extra: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;

describe("Hosted code_interpreter gating, billing and settlement", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-code-exec-"));
    // 0 observed calls by default: a request that never should have attached
    // the tool must not accidentally trip the local call-count guard just
    // because the shared mock happens to report one anyway.
    transport.mockReset(); transport.mockImplementation(async () => Response.json(result(0)));
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider(provider);
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("never attaches the tool to an ordinary chat turn even when enabled and funded", async () => {
    await runtime.service.chat("member", chat("你好，很高兴认识你"));
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("max_tool_calls");
  });
  it("never attaches when the admin has not enabled code execution", async () => {
    await runtime.service.saveProvider({ ...provider, codeInterpreterEnabled: false, codeInterpreterQuotaTokens: 0 });
    await runtime.service.chat("member", chat());
    expect(JSON.parse(transport.mock.calls[0][1].body!)).not.toHaveProperty("tools");
  });
  it("attaches only on a computation-shaped turn, and a data attachment alone is sufficient evidence", async () => {
    await runtime.service.chat("member", chat());
    let body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body).toMatchObject({ tools: [{ type: "code_interpreter", container: { type: "auto" } }], tool_choice: "auto", max_tool_calls: 3, include: ["code_interpreter_call.outputs"] });
    transport.mockClear();
    await runtime.service.chat("member", { ...chat("这是什么"), attachments: [{ name: "sales.csv", mediaType: "text/csv", text: "a,b\n1,2" }] });
    body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body.tools).toEqual([{ type: "code_interpreter", container: { type: "auto" } }]);
  });
  it("never attaches alongside an explicitly forced search, but both attach together when search is auto-decided", async () => {
    await runtime.service.saveProvider({ ...provider, webSearchEnabled: true, webSearchQuotaTokens: 100 });
    const searchItem = { id: "search-0", type: "web_search_call", status: "completed", action: { type: "search", sources: [{ title: "Official", url: "https://example.com/docs" }] } };
    const searchOnly = { status: "completed", output_text: "答案", output: [searchItem], usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } };
    transport.mockResolvedValueOnce(Response.json(searchOnly));
    await runtime.service.chat("member", { ...chat(), webSearch: true });
    let body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }]);
    expect(body.tool_choice).toBe("required");
    transport.mockClear();
    transport.mockResolvedValueOnce(Response.json(searchOnly));
    await runtime.service.chat("member", { ...chat("今天的新闻是什么，顺便帮我算一下这组数据的平均值"), webSearchMode: "auto" });
    body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body.tools).toEqual([{ type: "web_search", search_context_size: "low" }, { type: "code_interpreter", container: { type: "auto" } }]);
    expect(body.tool_choice).toBe("auto");
    // Standard-protocol search relies on the provider's own max_tool_calls
    // enforcement for its single forced call (searchCallLimit reserves only 1
    // locally); code execution is never forced, so it always reserves the
    // full local bound (3) regardless of protocol.
    expect(body.max_tool_calls).toBe(1 + 3);
  });
  it("never attaches outside an ordinary text turn (a restricted agent-continuation decision)", async () => {
    // Whatever this call ultimately resolves or rejects with is not the point
    // here; only that the outgoing provider body never carries the tool.
    await runtime.service.chat("member", { ...chat(), skillIds: ["agent-continuation-v1"] }).catch(() => undefined);
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body).not.toHaveProperty("tools");
  });

  it("bills only the observed call count and settles without a second charge on repeat delivery", async () => {
    transport.mockResolvedValueOnce(Response.json(result(1)));
    const request = chat();
    const response = await runtime.service.chat("member", request);
    expect(response.usage).toMatchObject({ execCalls: 1, convertedTokens: 200, billingKind: "tokens_with_code_exec", totalTokens: 940 + 200 });
    expect(response.quota).toMatchObject({ usedTokens: 940 + 200, reservedTokens: 0 });
    runtime.close(); runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    expect(runtime.store.usage("member")[0]).toMatchObject({ execCalls: 1, convertedTokens: 200, billingKind: "tokens_with_code_exec" });
    expect((await runtime.service.chat("member", request)).usage).toEqual(response.usage);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("counts generated images without fetching or storing their bytes", async () => {
    transport.mockResolvedValueOnce(Response.json(result(1, { output: [exec(0, { outputs: [{ type: "logs", logs: "done" }, { type: "image", url: "https://fixture.example/container/file/img" }] })] })));
    const response = await runtime.service.chat("member", chat());
    expect(response.usage).toMatchObject({ execCalls: 1 });
    expect(JSON.stringify(response)).not.toContain("fixture.example/container/file/img");
  });
  it("reserves the code-exec budget on top of the ordinary, for the same request text", async () => {
    const withExec = runtime.service.preflight("member", chat());
    expect(withExec.budget.codeExecInputReserve).toBe(8192);
    expect(withExec.budget.convertedReserve).toBe(600);
    await runtime.service.saveProvider({ ...provider, codeInterpreterEnabled: false, codeInterpreterQuotaTokens: 0 });
    const withoutExec = runtime.service.preflight("member", chat());
    expect(withoutExec.budget.codeExecInputReserve).toBe(0);
    expect(withoutExec.budget.convertedReserve).toBe(0);
    expect(withExec.budget.minimumRequiredTokens - withoutExec.budget.minimumRequiredTokens).toBe(8192 + 600);
  });
  it("silently drops code execution instead of failing the turn when the extra reserve alone would exceed quota", async () => {
    const funded = runtime.service.preflight("member", chat());
    // Same request text throughout: only the exec-specific reserve/conversion
    // is subtracted, so no other component of the budget shifts underneath us.
    const withoutExecMinimum = funded.budget.minimumRequiredTokens - funded.budget.codeExecInputReserve - funded.budget.convertedReserve;
    runtime.service.setQuota("member", "admin", { limitTokens: withoutExecMinimum + 10 });
    const preflight = runtime.service.preflight("member", chat());
    expect(preflight.canSend).toBe(true);
    expect(preflight.reason).toBeNull();
    expect(preflight.budget.codeExecInputReserve).toBe(0);
    await runtime.service.chat("member", chat());
    expect(JSON.parse(transport.mock.calls[0][1].body!)).not.toHaveProperty("tools");
  });

  it("retries once without the tool on an unsupported-tool rejection, marks the step unsupported, and never double-charges", async () => {
    transport.mockResolvedValueOnce(Response.json({ error: { message: "Unsupported parameter: tools" } }, { status: 400 }));
    transport.mockResolvedValueOnce(Response.json({ status: "completed", output_text: "1.0 是平均值", output: [], usage: { input_tokens: 900, output_tokens: 40, total_tokens: 940 } }));
    const events: unknown[] = [];
    const response = await runtime.service.chat("member", { ...chat(), liveProgress: true }, { stream: true, onEvent: e => events.push(e) });
    expect(response.usage).toMatchObject({ totalTokens: 940 });
    expect(response.usage.execCalls).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(transport.mock.calls[1][1].body!);
    expect(secondBody).not.toHaveProperty("tools");
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_progress", data: { tool: "code_interpreter", callId: "exec-unsupported", status: "failed", unsupported: true } }));
    expect(runtime.service.quota("member")).toMatchObject({ reservedTokens: 0 });
  });
  it("propagates any other rejection unchanged and never retries a request the tool did not cause", async () => {
    transport.mockResolvedValueOnce(Response.json({ error: { message: "Invalid API key" } }, { status: 401 }));
    await expect(runtime.service.chat("member", chat())).rejects.toMatchObject({ code: "AI_PROVIDER_AUTH" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects as uncertain when a call the provider opened never reaches completed in the terminal response", async () => {
    // Present (so the stream guard's own added-vs-terminal reconciliation
    // sees no discrepancy and lets it through) but never marked completed:
    // this is the service-level completeness check, not the guard's.
    transport.mockResolvedValueOnce(Response.json(result(1, { output: [{ ...exec(0), status: "in_progress" }] })));
    const request = chat();
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_CODE_EXEC_NOT_COMPLETED" });
    expect(runtime.service.getRequestResult("member", request.requestId)).toMatchObject({ status: "uncertain" });
    // The call stayed within the local guard's bound and reported real,
    // in-reserve token usage, so this bills the observed amount plus its
    // conversion rather than the full pessimistic reservation.
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: 940 + 200, reservedTokens: 0 });
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_CODE_EXEC_NOT_COMPLETED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("cancels on the fourth stream call, keeps uncertain settlement, and never resumes or retries it", async () => {
    let pulls = 0;
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode(event("response.output_item.added", { output_index: pulls, item: exec(pulls) }))); pulls++; }, cancel: cancelled }, { highWaterMark: 0 });
    transport.mockResolvedValueOnce(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
    const request = chat();
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_CODE_INTERPRETER_LIMIT_EXCEEDED" });
    expect(pulls).toBe(4); expect(cancelled).toHaveBeenCalledTimes(1);
    expect(runtime.service.getRequestResult("member", request.requestId)).toMatchObject({ status: "uncertain" });
  });
});

describe("Code interpreter stream guard framing", () => {
  it("checks terminal-only JSON and SSE payloads against the same budget", async () => {
    await expect(readProviderResponse(Response.json(result(4)), { maxCodeInterpreterCalls: 3 })).rejects.toMatchObject({ code: "AI_CODE_INTERPRETER_LIMIT_EXCEEDED" });
    await expect(readProviderResponse(new Response(event("response.completed", { response: result(4) })), { maxCodeInterpreterCalls: 3 })).rejects.toMatchObject({ code: "AI_CODE_INTERPRETER_LIMIT_EXCEEDED" });
  });
  it("streams code deltas and logs into deduplicated tool_progress, terminating on completion", async () => {
    const progress: unknown[] = [];
    const body = event("response.output_item.added", { output_index: 0, item: { ...exec(0), status: "in_progress", code: "", outputs: [] } })
      + event("response.code_interpreter_call_code.delta", { output_index: 0, delta: "print(1" })
      + event("response.code_interpreter_call_code.delta", { output_index: 0, delta: "+1)" })
      + event("response.code_interpreter_call.interpreting", { output_index: 0 })
      + event("response.output_item.done", { output_index: 0, item: exec(0) })
      + event("response.completed", { response: result(1) });
    await readProviderResponse(new Response(body, { headers: { "content-type": "text/event-stream" } }), { maxCodeInterpreterCalls: 3, onToolProgress: p => progress.push(p) });
    expect(progress).toContainEqual({ tool: "code_interpreter", callId: "exec-1", status: "in_progress" });
    expect(progress).toContainEqual(expect.objectContaining({ tool: "code_interpreter", callId: "exec-1", status: "interpreting", code: "print(1+1)" }));
    expect(progress.at(-1)).toMatchObject({ tool: "code_interpreter", callId: "exec-1", status: "completed", code: "print(sum([1, 2, 3]) / 3)", logs: "1.0" });
  });
});
