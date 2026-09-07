import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiProviderInput } from "../../shared/ai";
import { createNodeAi } from "./node";
import { AiPersonaRepository } from "./persona";
import { type AiTransport } from "./provider";

const provider: AiProviderInput = { name: "Budget fixture", baseUrl: "https://budget.example.com", apiKey: "fixture-key-never-expose", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100 };
const chat = (extra: Partial<AiChatRequest> = {}): AiChatRequest => ({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "你好" }], ...extra });
const reply = () => Response.json({ status: "completed", output_text: "你好！", usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } });

describe("AI chat preflight and atomic quota budget", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-ai-preflight-"));
    transport.mockReset(); transport.mockImplementation(async () => reply());
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider(provider);
    runtime.service.setQuota("member", "admin", { limitTokens: 10_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("explains a 10k search shortfall without claiming the balance is exhausted or reserving/sending", async () => {
    const request = chat({ webSearch: true });
    const quotaBefore = runtime.store.quota("member"), usageBefore = runtime.store.usage("member");
    const checked = runtime.service.preflight("member", request);
    expect(checked).toMatchObject({ canSend: false, reason: "search_quota_insufficient", quota: { remainingTokens: 10_000, usedTokens: 0, reservedTokens: 0 }, budget: { searchInputReserve: 32768, convertedReserve: 100, minOutputTokens: 16, availableOutputTokens: 0 }, withoutWebSearch: { canSend: true, reason: null, budget: { searchInputReserve: 0, convertedReserve: 0, availableOutputTokens: 2048 } } });
    expect(checked.budget.minimumRequiredTokens).toBe(checked.budget.inputReserve + 32768 + 100 + 16);
    expect(JSON.stringify(checked)).not.toContain("你好");
    expect(JSON.stringify(checked)).not.toContain(provider.apiKey);
    expect(transport).not.toHaveBeenCalled();
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ status: 402, code: "AI_SEARCH_QUOTA_INSUFFICIENT", details: checked });
    expect(runtime.store.quota("member")).toEqual(quotaBefore);
    expect(runtime.store.usage("member")).toEqual(usageBefore);
    expect(runtime.store.request("member", request.requestId)).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
    // Only a separate, explicit request without search may use the normal chat budget.
    await runtime.service.chat("member", chat({ webSearch: false }));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][1].body!)).not.toHaveProperty("tools");
    expect(runtime.store.quota("member")).toMatchObject({ usedTokens: 13, remainingTokens: 9987 });
  });

  it("distinguishes never granted, exhausted, and positive-but-insufficient quota", async () => {
    expect(() => runtime.service.preflight("ungranted", chat())).toThrow(expect.objectContaining({ code: "AI_ACCESS_NOT_GRANTED" }));
    runtime.service.setQuota("member", "admin", { limitTokens: 0 });
    const exhausted = runtime.service.preflight("member", chat({ webSearch: true }));
    expect(exhausted).toMatchObject({ canSend: false, reason: "quota_exhausted", withoutWebSearch: { canSend: false, reason: "quota_exhausted" } });
    await expect(runtime.service.chat("member", chat())).rejects.toMatchObject({ code: "AI_QUOTA_EXHAUSTED", details: { quota: { remainingTokens: 0 } } });
    runtime.service.setQuota("member", "admin", { limitTokens: 100 });
    expect(runtime.service.preflight("member", chat())).toMatchObject({ canSend: false, reason: "quota_insufficient", quota: { remainingTokens: 100 } });
    await expect(runtime.service.chat("member", chat())).rejects.toMatchObject({ code: "AI_QUOTA_INSUFFICIENT", details: { quota: { remainingTokens: 100 } } });
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses the real minimum output allowance, not the administrator's maximum as a forced minimum", async () => {
    const request = chat();
    const minimum = runtime.service.preflight("member", request).budget.minimumRequiredTokens;
    runtime.service.setQuota("member", "admin", { limitTokens: minimum - 1 });
    expect(runtime.service.preflight("member", request)).toMatchObject({ canSend: false, budget: { availableOutputTokens: 15 } });
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_QUOTA_INSUFFICIENT" });
    runtime.service.setQuota("member", "admin", { limitTokens: minimum });
    expect(runtime.service.preflight("member", request)).toMatchObject({ canSend: true, budget: { availableOutputTokens: 16, maxOutputTokens: 2048 } });
    await runtime.service.chat("member", request);
    expect(JSON.parse(transport.mock.calls[0][1].body!).max_output_tokens).toBe(16);
    expect(runtime.store.quota("member").usedTokens).toBe(13);
  });

  it("rechecks quota reductions after a successful preflight without sending or writing a paid request", async () => {
    const request = chat();
    expect(runtime.service.preflight("member", request).canSend).toBe(true);
    runtime.service.setQuota("member", "admin", { limitTokens: 10 });
    await expect(runtime.service.chat("member", request)).rejects.toMatchObject({ code: "AI_QUOTA_INSUFFICIENT", details: { quota: { remainingTokens: 10 } } });
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.store.request("member", request.requestId)).toBeUndefined();
  });

  it("keeps concurrent preflights advisory and enforces one actual reservation", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await held; return reply(); });
    const first = chat(), second = chat();
    expect(runtime.service.preflight("member", first).canSend).toBe(true);
    expect(runtime.service.preflight("member", second).canSend).toBe(true);
    const pending = runtime.service.chat("member", first);
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const quota = runtime.store.quota("member");
      expect(runtime.service.preflight("member", chat({ webSearch: true }))).toMatchObject({ canSend: false, reason: "request_in_progress", withoutWebSearch: { canSend: false, reason: "request_in_progress" } });
      await expect(runtime.service.chat("member", second)).rejects.toMatchObject({ status: 409, code: "AI_REQUEST_IN_PROGRESS", details: { reason: "request_in_progress", quota } });
      expect(runtime.store.quota("member")).toEqual(quota);
      expect(runtime.store.request("member", second.requestId)).toBeUndefined();
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { release(); await pending; }
    expect(runtime.store.quota("member")).toMatchObject({ usedTokens: 13, reservedTokens: 0 });
  });

  it("keeps the search safety reservation, releases unused allowance and charges a completed search once", async () => {
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    const request = chat({ webSearch: true });
    const checked = runtime.service.preflight("member", request);
    expect(checked.canSend).toBe(true);
    transport.mockImplementationOnce(async (_url, init) => {
      expect(runtime.store.quota("member").reservedTokens).toBe(checked.budget.inputReserve + checked.budget.searchInputReserve + checked.budget.convertedReserve + checked.budget.availableOutputTokens);
      expect(JSON.parse(init.body!)).toMatchObject({ tools: [{ type: "web_search", search_context_size: "low" }], max_tool_calls: 1, tool_choice: "required" });
      return Response.json({ status: "completed", output_text: "已联网", output: [{ type: "web_search_call", status: "completed" }], usage: { input_tokens: 1000, output_tokens: 10, total_tokens: 1010 } });
    });
    const response = await runtime.service.chat("member", request);
    expect(response).toMatchObject({ usage: { totalTokens: 1110, convertedTokens: 100 }, quota: { usedTokens: 1110, reservedTokens: 0, remainingTokens: 48890 } });
    expect(await runtime.service.chat("member", request)).toEqual(response);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("budgets the authenticated persona, approved Skill, project and text attachments, without exposing them", () => {
    runtime.service.setQuota("other", "admin", { limitTokens: 10_000 });
    new AiPersonaRepository(runtime.store.sql).save("member", { expectedRevision: 0, profile: { name: "私有名字", tone: "concise", customStyle: "先给结论", preferences: "仅属于甲的偏好".repeat(200), onboardingComplete: true } });
    const request = chat({ skillIds: ["meeting-notes"], projectContext: "项目秘密".repeat(100), attachments: [{ name: "private.txt", text: "附件秘密".repeat(100) }] });
    const first = runtime.service.preflight("member", { ...request, userId: "other", inputReserve: 0 });
    const other = runtime.service.preflight("other", request);
    expect(first.budget.inputReserve).toBeGreaterThan(other.budget.inputReserve);
    expect(other.budget.inputReserve).toBeGreaterThan(runtime.service.preflight("other", chat()).budget.inputReserve);
    for (const secret of ["私有名字", "偏好", "项目秘密", "附件秘密", "private.txt"]) expect(JSON.stringify(first)).not.toContain(secret);
    expect(runtime.store.usage("other")).toHaveLength(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not mutate an existing expired reservation during a read-only preflight", async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await held; return reply(); });
    const request = chat(), pending = runtime.service.chat("member", request);
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const stored = runtime.store.request("member", request.requestId)!;
      stored.expiresAt = Date.now() - 1000; runtime.store.saveRequest(stored);
      const quota = runtime.store.quota("member"), usage = runtime.store.usage("member");
      expect(runtime.service.preflight("member", chat())).toMatchObject({ reason: "request_in_progress", canSend: false });
      expect(runtime.store.request("member", request.requestId)).toEqual(stored);
      expect(runtime.store.quota("member")).toEqual(quota);
      expect(runtime.store.usage("member")).toEqual(usage);
    } finally { release(); await pending; }
  });
});
