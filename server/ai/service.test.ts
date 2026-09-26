import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiProviderInput } from "../../shared/ai";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import { AiError, createSecretBox, isPublicIp, safeBaseUrl } from "./security";
import { BAI_AGENT_MODELS, TONGPIN_QUICK_AGENT } from "../../shared/aiAuto";

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
  it("resolves Auto before budget and transport, stores actual model and retains token usage", async () => {
    await runtime.service.saveProvider({ ...provider, baseUrl: "https://api.b.ai/v1", protocol: "responses", quickModel: "tongpin-auto", deepModel: "old" });
    expect(runtime.service.provider()?.quickModel).toBe("tongpin-agent");
    transport.mockResolvedValueOnce(Response.json({ data: BAI_AGENT_MODELS.map(id => ({ id })) }));
    await expect(runtime.service.testProvider({ target: "chat" })).resolves.toMatchObject({ modelsVerified: true, availableModels: BAI_AGENT_MODELS });
    runtime.service.setQuota("auto-member", "admin", { limitTokens: 100000 });
    const req = chat();
    expect(runtime.service.preflight("auto-member", req).canSend).toBe(true);
    const result = await runtime.service.chat("auto-member", req);
    expect(result.model).toBe("快速"); expect(result.usage.totalTokens).toBe(13);
    expect(transport.mock.calls[1][0]).toBe("https://api.b.ai/v1/chat/completions");
    expect(JSON.parse(transport.mock.calls[1][1].body!).model).toBe("hy3");
    await runtime.service.chat("auto-member", req); expect(transport).toHaveBeenCalledTimes(2);
    expect(runtime.service.provider()?.deepModel).toBe("gpt-6-astra");
  });
  it("normalizes endpoint paths, encrypts write-only keys and applies supported file permissions", async () => {
    expect(runtime.service.provider()).toMatchObject({ baseUrl: "https://api.example.com/v1", apiKeyConfigured: true });
    expect(JSON.stringify(runtime.service.provider())).not.toContain(provider.apiKey);
    expect(JSON.stringify(runtime.store.provider())).not.toContain(provider.apiKey);
    const disk = await readFile(path.join(directory, "test.json.ai.sqlite"));
    expect(disk.includes(Buffer.from(provider.apiKey!))).toBe(false);
    // Windows chmod/stat do not implement POSIX owner/group/other isolation.
    // Verify owner read/write there; Unix continues to require exact 0600.
    const permissionMask = process.platform === "win32" ? 0o600 : 0o777;
    for (const filename of ["test.json.ai-key", "test.json.ai.sqlite"]) {
      const info = await stat(path.join(directory, filename));
      expect(info.isFile()).toBe(true);
      expect(info.mode & permissionMask).toBe(0o600);
    }
    const localEncryptionKey = await readFile(path.join(directory, "test.json.ai-key"), "utf8");
    expect(/^[a-f0-9]{64}$/.test(localEncryptionKey)).toBe(true);
    expect(localEncryptionKey.includes(provider.apiKey!)).toBe(false);
    expect(safeBaseUrl("https://api.example.com/v1/chat/completions")).toBe("https://api.example.com/v1");
  });
  it("keeps existing key only for same normalized base and rejects changing host/path without a new key", async () => {
    await runtime.service.saveProvider({ ...provider, apiKey: "", quickModel: "other" });
    await expect(runtime.service.saveProvider({ ...provider, apiKey: "", baseUrl: "https://other.example.com" })).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
    await expect(runtime.service.saveProvider({ ...provider, apiKey: "", baseUrl: "https://api.example.com/evil" })).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
  });
  it("defaults to no quota and does not call the provider", async () => {
    expect(runtime.service.status("member-a")).toMatchObject({ accessGranted: false, quota: { remainingTokens: 0 } });
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ status: 403, code: "AI_ACCESS_NOT_GRANTED" });
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.store.usage("member-a")).toEqual([]);
  });
  it("returns and persists an image clarification instead of failing or authorizing generation", async () => {
    await runtime.service.saveProvider({ ...provider, imageModel: "image-model", imageQuotaTokens: 1000 });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 30000 });
    transport.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: '{"kind":"clarification","question":"你希望生成什么主题的图片？"}' } }], usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 } }));
    const request = { ...chat(), outputFormat: "image_plan", messages: [{ role: "user", content: "帮我生成一张图片" }] };
    const response = await runtime.service.chat("member-a", request);
    expect(response.toolClarification).toBe("你希望生成什么主题的图片？");
    expect(response.content).toBe(response.toolClarification);
    expect(response.toolPlan).toBeUndefined();
    expect(runtime.store.request("member-a", request.requestId)?.status).toBe("completed");
    expect(runtime.store.request("member-a", request.requestId)?.toolPlanExpiresAt).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toContain("chat/completions");
    await expect(runtime.service.generateImage("member-a", { requestId: crypto.randomUUID(), prompt: response.content, planRequestId: request.requestId })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("accepts an image plan with an overlong display summary without executing or double-charging", async () => {
    await runtime.service.saveProvider({ ...provider, imageModel: "image-model", imageQuotaTokens: 1000 });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 30000 });
    const prompt = "制作一张蓝色科技海报";
    transport.mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: JSON.stringify({ kind: "image", summary: "展示说明".repeat(1001), prompt }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
    }));
    const planned = { ...chat(), outputFormat: "image_plan" as const, messages: [{ role: "user" as const, content: prompt }] };
    const response = await runtime.service.chat("member-a", planned);
    expect(response.toolPlan).toMatchObject({ kind: "image", prompt, summary: "展示说明".repeat(60) });
    expect(runtime.store.request("member-a", planned.requestId)?.status).toBe("completed");
    expect(runtime.service.quota("member-a").usedTokens).toBe(35);
    await expect(runtime.service.chat("member-a", planned)).resolves.toMatchObject({ toolPlan: { kind: "image", prompt } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("member-a").usedTokens).toBe(35);
  });
  it("persists a model-authored public analysis summary separately and never invents one", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 10000 });
    transport.mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: "<analysis_summary>依据已提供的交付约束，方案 B 风险更低。</analysis_summary>\n\n建议选择方案 B。" } }],
      usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
    }));
    const summarizedRequest = chat();
    const summarized = await runtime.service.chat("member-a", summarizedRequest);
    expect(summarized).toMatchObject({
      content: "建议选择方案 B。",
      analysisSummary: "依据已提供的交付约束，方案 B 风险更低。",
    });
    expect(runtime.service.getRequestResult("member-a", summarizedRequest.requestId).result).toMatchObject({
      content: "建议选择方案 B。",
      analysisSummary: "依据已提供的交付约束，方案 B 风险更低。",
    });
    const outbound = JSON.parse(transport.mock.calls[0][1].body!);
    expect(outbound.messages[0].content).toContain("analysis_summary");
    expect(JSON.stringify(outbound.messages.slice(1))).not.toContain("analysis_summary");

    transport.mockResolvedValueOnce(complete());
    const plain = await runtime.service.chat("member-a", chat());
    expect(plain.content).toBe("你好！");
    expect(plain.analysisSummary).toBeUndefined();
  });
  it("uses the existing chat quota and idempotency path for a server-side text dispatch", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 30_000 });
    const markdown = "可以。\n\n| 项目 | 状态 |\n| --- | --- |\n| 同频 | 正常 |";
    const analysisSummary = "根据当前状态与风险进行比较。";
    transport.mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: JSON.stringify({ kind: "text", content: markdown, analysisSummary }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 },
    }));
    const request = { ...chat(), outputFormat: "dispatch" as const, messages: [{ role: "user" as const, content: "帮我分析当前情况" }] };
    const first = await runtime.service.chat("member-a", request);
    expect(first).toMatchObject({ content: markdown, analysisSummary, dispatch: { kind: "text", content: markdown, analysisSummary }, usage: { totalTokens: 32 } });
    expect(runtime.store.request("member-a", request.requestId)?.result?.dispatch).toEqual({ kind: "text", content: markdown, analysisSummary });
    expect(JSON.parse(transport.mock.calls[0][1].body!).messages[0].content).toContain("不要把整篇回答包装成 JSON");
    await expect(runtime.service.chat("member-a", request)).resolves.toMatchObject({ dispatch: { kind: "text" } });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("returns a tool dispatch as a proposal without creating or executing a tool step", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 30_000 });
    transport.mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: JSON.stringify({ kind: "image", prompt: "制作一张蓝色科技海报" }) } }],
      usage: { prompt_tokens: 18, completion_tokens: 8, total_tokens: 26 },
    }));
    const request = { ...chat(), outputFormat: "dispatch" as const, messages: [{ role: "user" as const, content: "帮我生成一张蓝色科技海报" }] };
    const response = await runtime.service.chat("member-a", request);
    expect(response).toMatchObject({ content: "", dispatch: { kind: "image", prompt: "制作一张蓝色科技海报" } });
    expect(response.toolPlan).toBeUndefined();
    expect(response.trace?.steps.some(step => step.kind === "tool" || step.kind === "approval")).toBe(false);
    expect(runtime.store.usage("member-a").filter(entry => entry.requestId === request.requestId)).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("checks availability only after account permission, configuration and quota checks", async () => {
    expect((await runtime.service.availability("member-a")).check.code).toBe("AI_ACCESS_NOT_GRANTED");
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 0 });
    expect((await runtime.service.availability("member-a")).check.code).toBe("AI_QUOTA_EXHAUSTED");
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    await runtime.service.saveProvider({ ...provider, enabled: false });
    expect((await runtime.service.availability("member-a")).check.code).toBe("AI_NOT_CONFIGURED");
    expect(transport).not.toHaveBeenCalled();
  });
  it("shares a non-generating probe but never shares account quota or secrets", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    runtime.service.setQuota("member-b", "admin", { limitTokens: 5000 });
    const usageBefore = runtime.store.usage();
    transport.mockImplementation(async () => Response.json({ data: [{ id: "quick-model" }] }));
    const [a, b] = await Promise.all([runtime.service.availability("member-a"), runtime.service.availability("member-b")]);
    expect(a.check.state).toBe("reachable"); expect(a.status.quota.remainingTokens).toBe(1000);
    expect(b.check.state).toBe("reachable"); expect(b.status.quota.remainingTokens).toBe(5000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toBe("https://api.example.com/v1/models");
    expect(transport.mock.calls[0][1].method).toBe("GET");
    expect(transport.mock.calls[0][1].body).toBeUndefined();
    expect(runtime.store.usage()).toEqual(usageBefore);
    expect(JSON.stringify([a, b])).not.toContain(provider.apiKey);
  });
  it("invalidates the connection cache after key rotation", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    transport.mockImplementation(async () => Response.json({ data: [] }));
    await runtime.service.availability("member-a");
    await runtime.service.saveProvider({ ...provider, apiKey: "new-fixture-key" });
    await runtime.service.availability("member-a");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1].headers.Authorization).toBe("Bearer new-fixture-key");
  });
  it("does not reuse a cached successful probe after a real generation failure", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    transport.mockImplementation(async () => Response.json({ data: [] }));
    expect((await runtime.service.availability("member-a")).check.state).toBe("reachable");
    transport.mockImplementation(async () => new Response("denied", { status: 403 }));
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ code: "AI_PROVIDER_ACCESS_DENIED" });
    expect((await runtime.service.availability("member-a")).check.state).toBe("unavailable");
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(["GET", "POST", "GET"]);
  });
  it("does not report an obsolete provider or revoked quota as usable after an in-flight probe", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    let finish!: (value: Response) => void;
    transport.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = runtime.service.availability("member-a");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    runtime.service.setQuota("member-a", "admin", { limitTokens: 0 });
    finish(Response.json({ data: [] }));
    expect((await pending).check.state).toBe("unavailable");
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    await runtime.service.saveProvider({ ...provider, apiKey: "changed-fixture-key" });
    const changed = runtime.service.availability("member-a");
    const assertion = expect(changed).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    await new Promise(resolve => setTimeout(resolve, 10));
    await runtime.service.saveProvider({ ...provider, enabled: false });
    finish(Response.json({ data: [] }));
    await assertion;
  });
  it("probes an independent image key without blocking the chat connection", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 1000 });
    await runtime.service.saveProvider({ ...provider, imageModel: "picture", imageBaseUrl: "https://images.example.com", imageApiKey: "image-fixture-key", imageQuotaTokens: 100 });
    transport.mockImplementation(async url => url.includes("images.example") ? new Response("denied", { status: 403 }) : Response.json({ data: [] }));
    expect((await runtime.service.availability("member-a", "image")).check.state).toBe("unavailable");
    expect((await runtime.service.availability("member-a", "chat")).check.state).toBe("reachable");
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer image-fixture-key");
    await expect(runtime.service.availability("member-a", "https://evil.example")).rejects.toMatchObject({ code: "AI_INPUT_INVALID" });
  });
  it("uses the administrator's rotated key for every member's NEW request, without per-member provider keys", async () => {
    for (const member of ["member-mac", "member-win"]) runtime.service.setQuota(member, "admin", { limitTokens: 10000 });
    await runtime.service.chat("member-mac", chat());
    const changedKey = "fixture-rotated-key-do-not-return";
    await runtime.service.saveProvider({ ...provider, apiKey: changedKey });
    await runtime.service.chat("member-win", chat());
    await runtime.service.chat("member-mac", { ...chat(), mode: "deep" });
    expect(transport.mock.calls.map(([, init]) => init.headers.Authorization)).toEqual([
      `Bearer ${provider.apiKey}`, `Bearer ${changedKey}`, `Bearer ${changedKey}`,
    ]);
    expect(JSON.stringify(runtime.service.provider()) + JSON.stringify(runtime.store.usage())).not.toContain(changedKey);
    expect(runtime.service.quota("member-win").usedTokens).toBe(13);
    expect(runtime.service.quota("member-mac").usedTokens).toBe(26);
  });
  it("does not treat zero-only adjustments as access, but retains positive-grant history beyond the latest 200 entries", async () => {
    runtime.service.setQuota("zero-member", "admin", { limitTokens: 0 });
    expect(runtime.service.status("zero-member").accessGranted).toBe(false);
    await expect(runtime.service.generateImage("zero-member", { requestId: crypto.randomUUID(), prompt: "不应发送" })).rejects.toMatchObject({ status: 403, code: "AI_ACCESS_NOT_GRANTED" });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    for (let index = 0; index < 201; index++) runtime.service.setQuota("member-a", "admin", { limitTokens: 0 });
    expect(runtime.store.usage("member-a").every(entry => entry.limitTokens === 0)).toBe(true);
    expect(runtime.service.status("member-a")).toMatchObject({ accessGranted: true, quota: { remainingTokens: 0 } });
    await expect(runtime.service.chat("member-a", chat())).rejects.toMatchObject({ status: 402, code: "AI_QUOTA_EXHAUSTED" });
    expect(runtime.service.status("member-b").accessGranted).toBe(false);
    expect(transport).not.toHaveBeenCalled();
    runtime.close(); runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    expect(runtime.service.status("member-a").accessGranted).toBe(true);
    expect(runtime.service.status("zero-member").accessGranted).toBe(false);
  });
  it("charges real usage once, isolates members and replays completed response without more generation", async () => {
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const body = chat();
    const result = await runtime.service.chat("member-a", body);
    expect(result).toMatchObject({ content: "你好！", usage: { totalTokens: 13, estimated: false }, quota: { usedTokens: 13, reservedTokens: 0, remainingTokens: 4987 } });
    expect(runtime.service.quota("member-b").limitTokens).toBe(0);
    await runtime.service.chat("member-a", body);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].headers.Accept).toBe("application/json");
    await expect(runtime.service.chat("member-a", { ...body, messages: [{ role: "user", content: "另一个问题" }] })).rejects.toMatchObject({ code: "AI_REQUEST_CONFLICT" });
    expect(runtime.store.usage("member-a").filter(e => e.kind === "chat")).toHaveLength(1);
  });
  it("reserves before outbound I/O, enforces one active request and prevents quota shrinking under reservation", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await waiting; return complete(); });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const conversationId = "conversation-a";
    const first = runtime.service.chat("member-a", { ...chat(), conversationId });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    expect(runtime.service.quota("member-a").reservedTokens).toBeGreaterThan(1024);
    expect(() => runtime.service.setQuota("member-a", "admin", { limitTokens: 0 })).toThrow();
    await expect(runtime.service.chat("member-a", { ...chat(), conversationId })).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    expect(transport).toHaveBeenCalledTimes(1);
    release(); await first;
    expect(runtime.service.quota("member-a").reservedTokens).toBe(0);
  });
  it("supports Responses protocol with explicit output cap and deep reasoning", async () => {
    await runtime.service.saveProvider({ ...provider, protocol: "responses" });
    // Enough headroom above the instruction reserve that the provider cap, not
    // the remaining quota, bounds the output.
    runtime.service.setQuota("member-a", "admin", { limitTokens: 8000 });
    transport.mockResolvedValueOnce(Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: "真正回复" }] }], usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 } }));
    const result = await runtime.service.chat("member-a", { ...chat(), mode: "deep" });
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/responses");
    expect(init.headers.Accept).toBe("text/event-stream, application/json");
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
    await expect(runtime.service.chat("member-a", chat())).resolves.toMatchObject({ completion: { state: "partial", reason: "stream_interrupted", canContinue: false } });
    expect(runtime.store.usage("member-a")[0]).toMatchObject({ status: "uncertain", estimated: true });
  });
  it.each(["responses", "chat_completions"] as const)("rejects an unpersistable %s reply without truncating, losing request state or generating twice", async protocol => {
    await runtime.service.saveProvider({ ...provider, protocol });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 5000 });
    const content = "长".repeat(128001);
    const value = protocol === "responses"
      ? { status: "completed", output_text: content, usage: { input_tokens: 12, output_tokens: 4, total_tokens: 16 } }
      : { choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } };
    transport.mockResolvedValueOnce(Response.json(value));
    const request = chat();
    await expect(runtime.service.chat("member-a", request)).rejects.toMatchObject({ code: "AI_RESPONSE_TOO_LONG" });
    const record = runtime.service.getRequestResult("member-a", request.requestId);
    expect(record).toMatchObject({ status: "uncertain", error: { code: "AI_RESPONSE_TOO_LONG" } });
    expect(record.result).toBeUndefined();
    expect(JSON.stringify(record)).not.toContain(content);
    expect(runtime.store.usage("member-a")[0]).toMatchObject({ status: "uncertain", estimated: true });
    expect(runtime.service.quota("member-a").reservedTokens).toBe(0);
    await expect(runtime.service.chat("member-a", request)).rejects.toMatchObject({ code: "AI_RESPONSE_TOO_LONG" });
    expect(transport).toHaveBeenCalledTimes(1);
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
  it.each(["response.failed", "error"])("does not report SSE %s as successful chat", async type => {
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
  it("persists only allowlisted B.AI models discovered with the saved key and keeps verification across restart", async () => {
    await runtime.service.saveProvider({ ...provider, baseUrl: "https://api.b.ai/v1", protocol: "responses", quickModel: TONGPIN_QUICK_AGENT, deepModel: "ignored" });
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: false, availableModels: [] });
    transport.mockResolvedValueOnce(Response.json({ data: [
      { id: "unknown-provider-model" }, { id: "hy3" }, { id: "qwen3.8-flash" }, { id: "mimo-v2.5" }, { id: "gpt-6-astra" },
    ] }));
    const result = await runtime.service.testProvider({ target: "chat" });
    expect(result).toMatchObject({ ok: true, modelsVerified: true, availableModels: BAI_AGENT_MODELS });
    expect(result.models).toContain("unknown-provider-model");
    const raw = runtime.store.provider()!;
    expect(raw.verifiedModels).toEqual(BAI_AGENT_MODELS);
    expect(raw.verifiedModelConfigVersion).toBe(raw.modelConfigVersion);
    expect(raw.verifiedModelKeyVersion).toBe(raw.modelKeyVersion);
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: true, availableModels: BAI_AGENT_MODELS });
    expect(JSON.stringify(runtime.service.provider())).not.toMatch(/modelConfigVersion|modelKeyVersion|verifiedModels/);
    expect(runtime.store.usage()).toEqual([]);

    runtime.close();
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    runtime.service.setQuota("verified-member", "admin", { limitTokens: 10_000 });
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: true, availableModels: BAI_AGENT_MODELS });
    expect(runtime.service.preflight("verified-member", chat()).canSend).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("never applies draft-key discovery to the saved Agent verification", async () => {
    await runtime.service.saveProvider({ ...provider, baseUrl: "https://api.b.ai/v1", protocol: "responses", quickModel: TONGPIN_QUICK_AGENT, deepModel: "ignored" });
    const stored = runtime.store.provider();
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "hy3" }, { id: "gpt-6-astra" }, { id: "not-allowlisted" }] }));
    const result = await runtime.service.testProvider({ baseUrl: "https://api.b.ai/v1", apiKey: "draft-only-key", target: "chat" });
    expect(result).toMatchObject({ modelsVerified: false, availableModels: ["hy3", "gpt-6-astra"] });
    expect(runtime.store.provider()).toEqual(stored);
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: false, availableModels: [] });
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer draft-only-key");
  });
  it("clears Agent verification after a configuration or key save and fails locally until rechecked", async () => {
    const agent = { ...provider, baseUrl: "https://api.b.ai/v1", protocol: "responses" as const, quickModel: TONGPIN_QUICK_AGENT, deepModel: "ignored" };
    await runtime.service.saveProvider(agent);
    transport.mockResolvedValueOnce(Response.json({ data: BAI_AGENT_MODELS.map(id => ({ id })) }));
    await runtime.service.testProvider({ target: "chat" });
    runtime.service.setQuota("verified-member", "admin", { limitTokens: 10_000 });
    const first = runtime.store.provider()!;

    await runtime.service.saveProvider({ ...agent, apiKey: "", maxOutputTokens: 2048 });
    const changed = runtime.store.provider()!;
    expect(changed.modelConfigVersion).not.toBe(first.modelConfigVersion);
    expect(changed.modelKeyVersion).toBe(first.modelKeyVersion);
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: false, availableModels: [] });
    expect(() => runtime.service.preflight("verified-member", chat())).toThrow(expect.objectContaining({ code: "AI_AGENT_MODELS_UNVERIFIED" }));

    transport.mockResolvedValueOnce(Response.json({ data: BAI_AGENT_MODELS.map(id => ({ id })) }));
    await runtime.service.testProvider({ target: "chat" });
    const reverified = runtime.store.provider()!;
    await runtime.service.saveProvider({ ...agent, apiKey: "rotated-bai-key", maxOutputTokens: 2048 });
    const rotated = runtime.store.provider()!;
    expect(rotated.modelKeyVersion).not.toBe(reverified.modelKeyVersion);
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: false, availableModels: [] });
    expect(() => runtime.service.preflight("verified-member", chat())).toThrow(expect.objectContaining({ code: "AI_AGENT_MODELS_UNVERIFIED" }));
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("does not let a stale model-list response authorize a newer Agent configuration", async () => {
    const agent = { ...provider, baseUrl: "https://api.b.ai/v1", protocol: "responses" as const, quickModel: TONGPIN_QUICK_AGENT, deepModel: "ignored" };
    await runtime.service.saveProvider(agent);
    let finish!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const checking = runtime.service.testProvider({ target: "chat" });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await runtime.service.saveProvider({ ...agent, apiKey: "", maxOutputTokens: 2048 });
    finish(Response.json({ data: BAI_AGENT_MODELS.map(id => ({ id })) }));
    await expect(checking).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    expect(runtime.service.provider()).toMatchObject({ modelsVerified: false, availableModels: [] });
  });
  it("fails before quota reservation or provider generation when a verified Agent lacks Astra or all quick models", async () => {
    const agent = { ...provider, baseUrl: "https://api.b.ai/v1", protocol: "responses" as const, quickModel: TONGPIN_QUICK_AGENT, deepModel: "ignored", webSearchEnabled: true, webSearchQuotaTokens: 100 };
    await runtime.service.saveProvider(agent);
    runtime.service.setQuota("verified-member", "admin", { limitTokens: 10_000 });
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "hy3" }] }));
    await runtime.service.testProvider({ target: "chat" });
    expect(() => runtime.service.preflight("verified-member", { ...chat(), mode: "deep" })).toThrow(expect.objectContaining({ code: "AI_AGENT_ASTRA_UNAVAILABLE" }));
    expect(() => runtime.service.preflight("verified-member", { ...chat(), webSearchMode: "auto", messages: [{ role: "user", content: "\u4eca\u5929\u6709\u4ec0\u4e48\u65b0\u95fb" }] })).toThrow(expect.objectContaining({ code: "AI_AGENT_ASTRA_UNAVAILABLE" }));
    expect(runtime.store.pending("verified-member")).toEqual([]);
    expect(runtime.service.quota("verified-member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });

    await runtime.service.saveProvider({ ...agent, apiKey: "" });
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "gpt-6-astra" }, { id: "unknown-provider-model" }] }));
    await runtime.service.testProvider({ target: "chat" });
    expect(() => runtime.service.preflight("verified-member", chat())).toThrow(expect.objectContaining({ code: "AI_AGENT_QUICK_MODELS_UNAVAILABLE" }));
    expect(runtime.store.pending("verified-member")).toEqual([]);
    expect(runtime.service.quota("verified-member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
    expect(transport).toHaveBeenCalledTimes(2);
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
