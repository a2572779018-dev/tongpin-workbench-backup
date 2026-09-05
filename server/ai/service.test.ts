import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProviderInput } from "../../shared/ai";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import { AiError, createSecretBox, isPublicIp, safeBaseUrl } from "./security";

describe("AI transactional service", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  const provider: AiProviderInput = { name: "Test provider", baseUrl: "https://api.example.com/", apiKey: "test-secret-never-return-me", protocol: "chat_completions", quickModel: "quick-model", deepModel: "deep-model", maxOutputTokens: 1024, reasoningEffort: "high", enabled: true };
  const chat = (requestId = crypto.randomUUID()) => ({ requestId, mode: "quick", messages: [{ role: "user", content: "你好" }] });
  const complete = () => Response.json({ choices: [{ message: { content: "你好！" } }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-ai-unit-"));
    transport.mockReset(); transport.mockImplementation(async () => complete());
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    await runtime.service.saveProvider(provider);
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });
  it("normalizes endpoint paths and encrypts write-only keys at rest with private local files", async () => {
    expect(runtime.service.provider()).toMatchObject({ baseUrl: "https://api.example.com/v1", apiKeyConfigured: true });
    expect(JSON.stringify(runtime.service.provider())).not.toContain(provider.apiKey);
    expect(JSON.stringify(runtime.store.provider())).not.toContain(provider.apiKey);
    const disk = await readFile(path.join(directory, "test.json.ai.sqlite"));
    expect(disk.includes(Buffer.from(provider.apiKey!))).toBe(false);
    expect((await stat(path.join(directory, "test.json.ai-key"))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(directory, "test.json.ai.sqlite"))).mode & 0o777).toBe(0o600);
    expect(safeBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
  });
  it("keeps existing key only for same normalized base and rejects changing host/path without a new key", async () => {
    await runtime.service.saveProvider({ ...provider, apiKey: "", quickModel: "other" });
    await expect(runtime.service.saveProvider({ ...provider, apiKey: "", baseUrl: "https://other.example.com" })).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
    await expect(runtime.service.saveProvider({ ...provider, apiKey: "", baseUrl: "https://api.example.com/evil" })).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
  });
  it("defaults to no quota and does not call the provider", async () => {
    expect(runtime.service.status("member-a").quota.remainingTokens).toBe(0);
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ code: "AI_QUOTA_EXHAUSTED" });
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.store.usage("member-a")).toEqual([]);
  });
  it("charges real usage once, isolates members and replays completed response without more generation", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const body = chat();
    const result = await runtime.service.chat("member-a", body);
    expect(result).toMatchObject({ content: "你好！", usage: { totalTokens: 13, estimated: false }, quota: { usedTokens: 13, reservedTokens: 0, remainingTokens: 4987 } });
    expect(runtime.service.quota("member-b").limitTokens).toBe(0);
    await runtime.service.chat("member-a", body);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(runtime.service.chat("member-a", { ...body, messages: [{ role: "user", content: "另一个问题" }] })).rejects.toMatchObject({ code: "AI_REQUEST_CONFLICT" });
    expect(runtime.store.usage("member-a").filter(e => e.kind === "chat")).toHaveLength(1);
  });
  it("reserves before outbound I/O, enforces one active request and prevents quota shrinking under reservation", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await waiting; return complete(); });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const first = runtime.service.chat("member-a", chat());
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(runtime.service.quota("member-a").reservedTokens).toBeGreaterThan(1024);
    expect(() => runtime.service.setQuota("member-a", "admin", { limitTokens: 0 })).toThrow();
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    expect(transport).toHaveBeenCalledTimes(1);
    release(); await first;
    expect(runtime.service.quota("member-a").reservedTokens).toBe(0);
  });
  it("supports Responses protocol with explicit output cap and deep reasoning", async () => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    transport.mockResolvedValueOnce(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "真正回复" }] }], usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 } }));
    const result = await runtime.service.chat("member-a", { ...chat(), mode: "deep" });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/responses");
    expect(JSON.parse(init.body!)).toMatchObject({ model: "deep-model", store: false, stream: true, max_output_tokens: 1024, reasoning: { effort: "high" } });
    expect(result).toMatchObject({ content: "真正回复", usage: { totalTokens: 20, estimated: false } });
  });
  it("accepts terminal Responses SSE from Codex relays without exposing partial streams as success", async () => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const terminal = { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "完整回复" }] }], usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } } };
    transport.mockResolvedValueOnce(new Response(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"完整"}\n\nevent: response.completed\ndata: ${JSON.stringify(terminal)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const result = await runtime.service.chat("member-a", chat());
    expect(result).toMatchObject({ content: "完整回复", usage: { totalTokens: 16, estimated: false } });
    transport.mockResolvedValueOnce(new Response('data: {"type":"response.output_text.delta","delta":"半句"}\n\n', { headers: { "content-type": "text/event-stream" } }));
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(runtime.store.usage("member-a")[0]).toMatchObject({ status: "uncertain", estimated: true });
  });
  it("decodes Chinese UTF-8 across SSE chunk boundaries and counts final output tokens once including reasoning", async () => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const terminal = { type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "中文最终回复" }] }], usage: { input_tokens: 18, output_tokens: 32, total_tokens: 50, output_tokens_details: { reasoning_tokens: 20 } } } };
    const bytes = new TextEncoder().encode(`data: {"type":"response.output_text.delta","delta":"中文"}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`);
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 2) controller.enqueue(bytes.slice(i, i + 2)); controller.close(); } });
    transport.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const result = await runtime.service.chat("member-a", chat());
    expect(result.content).toBe("中文最终回复");
    expect(result.usage).toMatchObject({ inputTokens: 18, outputTokens: 32, totalTokens: 50, estimated: false });
  });
  it.each(["response.failed", "error", "response.incomplete"])("does not report SSE %s as successful chat", async type => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const event = { type, response: { output_text: "不完整文字", usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } } };
    transport.mockResolvedValueOnce(new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const request = chat();
    await expect(runtime.service.chat("member-a", request)).rejects.toBeInstanceOf(AiError);
    expect(runtime.store.request("member-a", request.requestId)?.status).toBe("uncertain");
    expect(runtime.store.request("member-a", request.requestId)?.result).toBeUndefined();
  });
  it("tests connectivity using GET models only and returns no provider content or secrets", async () => {
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] }));
    expect(await runtime.service.testProvider()).toMatchObject({ ok: true, models: ["model-a", "model-b"] });
    expect(transport.mock.calls[0][1].method).toBe("GET");
    expect(runtime.store.usage()).toEqual([]);
  });
  it("discovers models before saving config and never reuses a key on a changed draft origin", async () => {
    const stored = runtime.store.provider();
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "draft-model" }] }));
    const result = await runtime.service.testProvider({ baseUrl: "https://draft.example.com", apiKey: "draft-key" });
    expect(result.models).toEqual(["draft-model"]);
    expect(transport.mock.calls[0][0]).toBe("https://draft.example.com/v1/models");
    expect(runtime.store.provider()).toEqual(stored);
    await expect(runtime.service.testProvider({ baseUrl: "https://draft.example.com" })).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("releases reservations when safe transport proves nothing was sent", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    transport.mockRejectedValueOnce(new AiError(502, "AI_DNS_FAILED", "地址验证失败", true));
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ code: "AI_DNS_FAILED" });
    expect(runtime.service.quota("member-a")).toMatchObject({ usedTokens: 0, reservedTokens: 0, remainingTokens: 5000 });
  });
  it("maps upstream auth errors to non-401, releases rejected usage and never retries same request", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    transport.mockResolvedValueOnce(Response.json({ error: { message: provider.apiKey } }, { status: 401 }));
    const body = chat();
    await expect(runtime.service.chat("member-a", body)).rejects.toMatchObject({ status: 502, code: "AI_PROVIDER_AUTH" });
    await expect(runtime.service.chat("member-a", body)).rejects.toMatchObject({ code: "AI_PROVIDER_AUTH" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("member-a")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
    expect(JSON.stringify(runtime.store.usage())).not.toContain(provider.apiKey);
  });
  it.each([undefined, { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 1 }])("conservatively charges missing or malformed usage (%j)", async usage => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: "无用量回复" } }], usage }));
    const result = await runtime.service.chat("member-a", chat());
    expect(result.usage.estimated).toBe(true);
    expect(result.usage.totalTokens).toBeGreaterThan(1024);
    expect(result.quota.reservedTokens).toBe(0);
    expect(runtime.store.usage("member-a")[0]).toMatchObject({ status: "uncertain", estimated: true });
  });
  it("records network uncertainty conservatively and recovers abandoned reservations after restart", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    transport.mockRejectedValueOnce(new Error(`network error ${provider.apiKey}`));
    const body = chat();
    await expect(runtime.service.chat("member-a", body)).rejects.toMatchObject({ code: "AI_CONNECTION_FAILED" });
    await expect(runtime.service.chat("member-a", body)).rejects.toMatchObject({ code: "AI_CONNECTION_FAILED" });
    expect(transport).toHaveBeenCalledTimes(1);
    const used = runtime.service.quota("member-a").usedTokens;
    expect(used).toBeGreaterThan(1024);
    expect(runtime.store.usage("member-a")[0]).toMatchObject({ status: "uncertain", estimated: true });
    runtime.close(); runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    expect(runtime.service.quota("member-a").usedTokens).toBe(used);
    runtime.store.saveRequest({ requestId: "abandoned-request", userId: "member-b", hash: "x", status: "pending", createdAt: new Date().toISOString(), expiresAt: 1, inputReserve: 100, outputReserve: 200, mode: "quick", model: "x" });
    runtime.store.saveQuota("member-b", { limitTokens: 300, usedTokens: 0, reservedTokens: 300, remainingTokens: 0, inputTokens: 0, outputTokens: 0 });
    expect(runtime.service.quota("member-b")).toMatchObject({ usedTokens: 300, reservedTokens: 0, remainingTokens: 0 });
    expect(runtime.store.usage("member-b")[0]).toMatchObject({ status: "uncertain", totalTokens: 300 });
  });
});

describe("AI SSRF and key protection", () => {
  it.each(["http://api.example.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://169.254.169.254", "https://10.0.0.1", "https://api.internal", "https://example.com:8443", "https://user:pass@example.com", "https://example.com?a=1", "https://example.com#x"])("rejects unsafe base %s", url => { expect(() => safeBaseUrl(url)).toThrow(AiError); });
  it.each(["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "172.16.0.1", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fe80::1", "2001:db8::1"])("rejects private/reserved DNS answer %s", ip => { expect(isPublicIp(ip)).toBe(false); });
  it("accepts public DNS answers and authenticated encryption rejects tampering/wrong secrets", async () => {
    expect(isPublicIp("1.1.1.1")).toBe(true); expect(isPublicIp("2606:4700::1111")).toBe(true);
    const a = await createSecretBox("a".repeat(64)), b = await createSecretBox("b".repeat(64));
    const ciphertext = await a.encrypt("secret");
    expect(await a.decrypt(ciphertext)).toBe("secret");
    await expect(b.decrypt(ciphertext)).rejects.toMatchObject({ code: "AI_KEY_UNREADABLE" });
  });
});
