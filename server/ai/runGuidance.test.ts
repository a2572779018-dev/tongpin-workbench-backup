import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiHarnessCapability, AiHarnessInput, AiHarnessRunStatus } from "../../shared/ai";
import { chatInputReserve, chatMessages, parseChatCapabilities } from "./capabilities";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import {
  AI_RUN_GUIDANCE_FRAMING, AI_SUPPLEMENT_FRAMING, cancelRunGuidance, listRunGuidance, parseRunGuidanceInput,
  registerRunGuidanceTarget, runGuidanceMessage, runGuidanceRoute, submitRunGuidance, supplementFramedMessages,
  takePendingGuidance, withPendingGuidance,
} from "./runGuidance";
import { AiStore, emptyQuota, type AiSql, type StoredRequest } from "./storage";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

const RUN = "run-request-0000000000000001";
const OTHER_RUN = "run-request-0000000000000002";
const guidance = (text: string, id: string = crypto.randomUUID()) => ({ id, text });

function grant(store: AiStore, userId: string) {
  store.saveQuota(userId, { ...emptyQuota(), limitTokens: 10_000, remainingTokens: 10_000 });
}

function createRun(store: AiStore, userId: string, requestId: string, status: AiHarnessRunStatus) {
  store.createHarnessRun({
    id: crypto.randomUUID(), requestId, userId, conversationId: "conversation-a", tier: "quick", providerId: "primary",
    capability: "presentation", goalKind: "presentation", goalSummary: "完成当前演示文稿任务。", status,
    reasoningSummary: "进行中", startedAt: 1, updatedAt: 1,
  }, []);
}

function pendingRequest(store: AiStore, userId: string, requestId: string, overrides: Partial<StoredRequest> = {}) {
  store.saveRequest({ requestId, userId, hash: "hash", status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
    inputReserve: 1, outputReserve: 1, kind: "chat", model: "model", mode: "quick", conversationId: "conversation-a", ...overrides });
}

describe("run guidance store", () => {
  let database: DatabaseSync;
  let root: AiStore;
  let alpha: AiStore;
  let beta: AiStore;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    root = new AiStore(adapter(database));
    root.initialize();
    alpha = root.forTenant("tenant-alpha");
    beta = root.forTenant("tenant-beta");
    for (const store of [alpha, beta]) for (const user of ["member-a", "member-b"]) grant(store, user);
  });
  afterEach(() => database.close());

  it("accepts only { id, text } with a bounded, trimmed text", () => {
    expect(parseRunGuidanceInput({ id: "guidance-000000000001", text: "  改成三页\r\n加总结  " })).toEqual({ id: "guidance-000000000001", text: "改成三页\n加总结" });
    expect(parseRunGuidanceInput({ id: "guidance-000000000001", text: "字".repeat(2000) }).text).toHaveLength(2000);
    for (const body of [
      null, [], "text", {}, { id: "guidance-000000000001" },
      { id: "guidance-000000000001", text: "ok", userId: "member-b" },
      { id: "guidance-000000000001", text: "ok", tenantId: "tenant-beta" },
      { id: "short", text: "ok" }, { id: "guidance/../../000001", text: "ok" },
      { id: "guidance-000000000001", text: "   " }, { id: "guidance-000000000001", text: 42 },
      { id: "guidance-000000000001", text: "字".repeat(2001) },
      { id: "guidance-000000000001", text: "bad\u0000byte" },
    ]) expect(() => parseRunGuidanceInput(body), JSON.stringify(body)).toThrow(expect.objectContaining({ status: 400, code: "AI_GUIDANCE_INVALID" }));
  });

  it("stores guidance only for an active run of the same member and tenant", () => {
    createRun(alpha, "member-a", RUN, "running");
    expect(() => submitRunGuidance(alpha, "member-a", OTHER_RUN, guidance("补充"))).toThrow(expect.objectContaining({ status: 404, code: "AI_RUN_NOT_FOUND" }));
    // Another member of the same tenant, and the same member id in another tenant, cannot see the run.
    expect(() => submitRunGuidance(alpha, "member-b", RUN, guidance("补充"))).toThrow(expect.objectContaining({ status: 404, code: "AI_RUN_NOT_FOUND" }));
    expect(() => submitRunGuidance(beta, "member-a", RUN, guidance("补充"))).toThrow(expect.objectContaining({ status: 404, code: "AI_RUN_NOT_FOUND" }));
    expect(() => submitRunGuidance(alpha, "member-a", "bad id", guidance("补充"))).toThrow(expect.objectContaining({ status: 400 }));

    const accepted = submitRunGuidance(alpha, "member-a", RUN, guidance("请把第二页改成对比表", "guidance-a-0000000001"), 1_000);
    expect(accepted).toEqual({ created: true, guidance: { id: "guidance-a-0000000001", status: "pending", createdAt: 1_000 } });
    expect(JSON.stringify(accepted)).not.toContain("对比表");
    expect(listRunGuidance(alpha, "member-a", RUN).guidance.map(item => item.id)).toEqual(["guidance-a-0000000001"]);
    expect(() => listRunGuidance(alpha, "member-b", RUN)).not.toThrow();
    expect(listRunGuidance(alpha, "member-b", RUN).guidance).toEqual([]);
    expect(listRunGuidance(beta, "member-a", RUN).guidance).toEqual([]);
    expect(() => cancelRunGuidance(alpha, "member-b", RUN, "guidance-a-0000000001")).toThrow(expect.objectContaining({ status: 404, code: "AI_GUIDANCE_NOT_FOUND" }));
    expect(() => cancelRunGuidance(beta, "member-a", RUN, "guidance-a-0000000001")).toThrow(expect.objectContaining({ status: 404 }));
    expect(takePendingGuidance(alpha, "member-b", RUN)).toEqual([]);
    expect(takePendingGuidance(beta, "member-a", RUN)).toEqual([]);
    expect(takePendingGuidance(alpha, "member-a", RUN)).toEqual([{ id: "guidance-a-0000000001", text: "请把第二页改成对比表" }]);
  });

  it("treats planned and waiting runs and pending requests as active, and finished ones as closed", () => {
    for (const [index, status] of (["planned", "waiting_approval"] as const).entries()) {
      const requestId = `active-harness-run-00000${index}`;
      createRun(alpha, "member-a", requestId, status);
      expect(submitRunGuidance(alpha, "member-a", requestId, guidance("补充")).created).toBe(true);
    }
    for (const [index, status] of (["succeeded", "failed", "cancelled", "uncertain"] as const).entries()) {
      const requestId = `closed-harness-run-00000${index}`;
      createRun(alpha, "member-a", requestId, status);
      expect(() => submitRunGuidance(alpha, "member-a", requestId, guidance("补充"))).toThrow(expect.objectContaining({ status: 409, code: "AI_RUN_NOT_ACTIVE" }));
    }
    pendingRequest(alpha, "member-a", "pending-request-0000001");
    expect(submitRunGuidance(alpha, "member-a", "pending-request-0000001", guidance("补充")).created).toBe(true);
    pendingRequest(alpha, "member-a", "expired-request-0000001", { expiresAt: Date.now() - 1 });
    expect(() => submitRunGuidance(alpha, "member-a", "expired-request-0000001", guidance("补充"))).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
    pendingRequest(alpha, "member-a", "done-request-000000001", { status: "completed" });
    expect(() => submitRunGuidance(alpha, "member-a", "done-request-000000001", guidance("补充"))).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
  });

  it("is idempotent by client id, rejects a reused id with other text, and bounds items per run", () => {
    createRun(alpha, "member-a", RUN, "running");
    const first = submitRunGuidance(alpha, "member-a", RUN, guidance("第一条", "guidance-first-000001"));
    expect(submitRunGuidance(alpha, "member-a", RUN, guidance("第一条", "guidance-first-000001"), Date.now() + 5_000)).toEqual({ ...first, created: false });
    expect(() => submitRunGuidance(alpha, "member-a", RUN, guidance("另一条", "guidance-first-000001"))).toThrow(expect.objectContaining({ status: 409, code: "AI_GUIDANCE_CONFLICT" }));
    for (let index = 2; index <= 5; index += 1) submitRunGuidance(alpha, "member-a", RUN, guidance(`第${index}条`, `guidance-item-00000${index}`));
    expect(() => submitRunGuidance(alpha, "member-a", RUN, guidance("第六条"))).toThrow(expect.objectContaining({ status: 409, code: "AI_GUIDANCE_LIMIT" }));
    // A withdrawn item frees its slot; a replay of an accepted id still succeeds after the run ends.
    cancelRunGuidance(alpha, "member-a", RUN, "guidance-item-000005");
    expect(submitRunGuidance(alpha, "member-a", RUN, guidance("第六条", "guidance-item-000006")).created).toBe(true);
    alpha.updateHarnessRun("member-a", RUN, "succeeded", "完成");
    expect(submitRunGuidance(alpha, "member-a", RUN, guidance("第一条", "guidance-first-000001")).created).toBe(false);
    expect(() => submitRunGuidance(alpha, "member-a", RUN, guidance("迟到的补充"))).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
  });

  it("delivers pending guidance exactly once, oldest first, and never after withdrawal", () => {
    createRun(alpha, "member-a", RUN, "running");
    submitRunGuidance(alpha, "member-a", RUN, guidance("先用中文", "guidance-order-000001"), 1);
    submitRunGuidance(alpha, "member-a", RUN, guidance("撤回的内容", "guidance-order-000002"), 2);
    submitRunGuidance(alpha, "member-a", RUN, guidance("再加总结页", "guidance-order-000003"), 3);
    expect(cancelRunGuidance(alpha, "member-a", RUN, "guidance-order-000002").guidance.status).toBe("cancelled");
    expect(cancelRunGuidance(alpha, "member-a", RUN, "guidance-order-000002").guidance.status).toBe("cancelled");
    expect(takePendingGuidance(alpha, "member-a", RUN, { deliveredTo: "decision-request-000001", now: 50 })).toEqual([
      { id: "guidance-order-000001", text: "先用中文" },
      { id: "guidance-order-000003", text: "再加总结页" },
    ]);
    expect(takePendingGuidance(alpha, "member-a", RUN)).toEqual([]);
    expect(listRunGuidance(alpha, "member-a", RUN).guidance).toEqual([
      { id: "guidance-order-000001", status: "delivered", createdAt: 1, deliveredAt: 50 },
      { id: "guidance-order-000002", status: "cancelled", createdAt: 2 },
      { id: "guidance-order-000003", status: "delivered", createdAt: 3, deliveredAt: 50 },
    ]);
    expect(() => cancelRunGuidance(alpha, "member-a", RUN, "guidance-order-000001")).toThrow(expect.objectContaining({ status: 409, code: "AI_GUIDANCE_DELIVERED" }));
    // Used or withdrawn text is not retained in the guidance table.
    expect(database.prepare("SELECT text FROM ai_run_guidance WHERE text != ''").all()).toEqual([]);
  });

  it("forgets week-old guidance rows of the member when new guidance arrives", () => {
    createRun(alpha, "member-a", RUN, "running");
    createRun(alpha, "member-a", OTHER_RUN, "running");
    createRun(alpha, "member-b", RUN, "running");
    const start = Date.now();
    const weekAgo = start - 8 * 24 * 60 * 60 * 1000;
    submitRunGuidance(alpha, "member-a", RUN, guidance("旧补充", "guidance-old-00000001"), weekAgo);
    submitRunGuidance(alpha, "member-b", RUN, guidance("他人的旧补充", "guidance-old-00000002"), weekAgo);
    submitRunGuidance(alpha, "member-a", OTHER_RUN, guidance("新补充", "guidance-new-00000001"), start);
    expect(listRunGuidance(alpha, "member-a", RUN).guidance).toEqual([]);
    expect(listRunGuidance(alpha, "member-a", OTHER_RUN).guidance.map(item => item.id)).toEqual(["guidance-new-00000001"]);
    // Only the submitting member's own rows are pruned.
    expect(listRunGuidance(alpha, "member-b", RUN).guidance.map(item => item.id)).toEqual(["guidance-old-00000002"]);
  });

  it("can be taken inside a step loop's own claim transaction", () => {
    createRun(alpha, "member-a", RUN, "running");
    submitRunGuidance(alpha, "member-a", RUN, guidance("在事务里读取", "guidance-tx-000000001"));
    const taken = alpha.sql.transaction(() => withPendingGuidance(alpha, "member-a", RUN, [{ role: "user", content: "下一步" }], { deliveredTo: "decision-request-000002" }));
    expect(taken).toEqual([{ role: "user", content: "下一步" }, { role: "user", content: `${AI_RUN_GUIDANCE_FRAMING}\n在事务里读取` }]);
    expect(listRunGuidance(alpha, "member-a", RUN).guidance).toMatchObject([{ id: "guidance-tx-000000001", status: "delivered" }]);
    expect(alpha.sql.transaction(() => takePendingGuidance(alpha, "member-a", RUN))).toEqual([]);
  });

  it("builds one extra user message for step loops", () => {
    createRun(alpha, "member-a", RUN, "running");
    const base: AiChatRequest["messages"] = [{ role: "user", content: "下一步决策" }];
    expect(withPendingGuidance(alpha, "member-a", RUN, base)).toBe(base);
    submitRunGuidance(alpha, "member-a", RUN, guidance("只要三页"));
    expect(withPendingGuidance(alpha, "member-a", RUN, base)).toEqual([...base, { role: "user", content: `${AI_RUN_GUIDANCE_FRAMING}\n只要三页` }]);
    expect(runGuidanceMessage([{ text: "甲" }, { text: "乙" }], "框架：")).toEqual({ role: "user", content: "框架：\n1. 甲\n2. 乙" });
    expect(runGuidanceMessage([])).toBeUndefined();
  });

  it("requires AI access and dispatches the shared route contract", () => {
    createRun(alpha, "member-a", RUN, "running");
    alpha.saveQuota("member-c", emptyQuota());
    expect(() => runGuidanceRoute(alpha, "member-c", "POST", RUN, undefined, guidance("补充"))).toThrow(expect.objectContaining({ status: 403, code: "AI_ACCESS_NOT_GRANTED" }));
    const posted = runGuidanceRoute(alpha, "member-a", "POST", RUN, undefined, guidance("补充", "guidance-route-000001")) as { guidance: { id: string } };
    expect(posted.guidance.id).toBe("guidance-route-000001");
    expect(runGuidanceRoute(alpha, "member-a", "GET", RUN)).toMatchObject({ guidance: [{ id: "guidance-route-000001", status: "pending" }] });
    expect(runGuidanceRoute(alpha, "member-a", "DELETE", RUN, "guidance-route-000001")).toMatchObject({ guidance: { status: "cancelled" } });
    expect(() => runGuidanceRoute(alpha, "member-a", "PUT", RUN)).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => runGuidanceRoute(alpha, "member-a", "DELETE", RUN)).toThrow(expect.objectContaining({ status: 404 }));
  });

  it("lets another step loop register its own run record", () => {
    const unregister = registerRunGuidanceTarget((_store, userId, requestId) => userId === "member-a" && requestId === "multi-agent-run-000001" ? "active" : undefined);
    try {
      expect(submitRunGuidance(alpha, "member-a", "multi-agent-run-000001", guidance("换个方向")).created).toBe(true);
      expect(() => submitRunGuidance(alpha, "member-b", "multi-agent-run-000001", guidance("换个方向"))).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_FOUND" }));
    } finally { unregister(); }
    expect(() => submitRunGuidance(alpha, "member-a", "multi-agent-run-000001", guidance("再来"))).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_FOUND" }));
  });
});

describe("supplement follow-up framing", () => {
  const request = (overrides: Partial<AiChatRequest> = {}): AiChatRequest => ({
    requestId: "supplement-request-00001", mode: "quick",
    messages: [{ role: "user", content: "写一份周报" }, { role: "assistant", content: "好的……" }, { role: "user", content: "改成英文" }],
    ...overrides,
  });

  it("parses only a literal true marker", () => {
    expect(parseChatCapabilities({ supplement: true })).toEqual({ supplement: true });
    expect(parseChatCapabilities({})).toEqual({});
    for (const supplement of [false, "true", 1]) expect(() => parseChatCapabilities({ supplement })).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("frames only the latest user turn sent to the model, and never a continue retry", () => {
    expect(supplementFramedMessages(request())).toEqual(request().messages);
    const framed = chatMessages(request({ supplement: true, projectContext: "项目：季度复盘" }));
    expect(framed.slice(0, 2)).toEqual(request().messages.slice(0, 2));
    expect(framed[2].content.startsWith(`${AI_SUPPLEMENT_FRAMING}\n改成英文`)).toBe(true);
    expect(framed[2].content).toContain("以下 JSON 是本次任务参考资料");
    expect(chatInputReserve(request({ supplement: true }))).toBeGreaterThan(chatInputReserve(request()));
    expect(supplementFramedMessages(request({ supplement: true, retryMode: "continue" }))).toEqual(request().messages);
    expect(supplementFramedMessages(request({ supplement: true, retryMode: "regenerate" }))[2].content).toContain(AI_SUPPLEMENT_FRAMING);
  });
});

describe("harness multi-step continuation takes guidance before its next model call", () => {
  const MODELS = ["q-fast", "s-standard", "d-deep", "p-pro", "image-model", "minimax_h3"];
  const complete = (content: string) => Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
  const harnessInput = (): AiHarnessInput => {
    const route = (modelId: string) => ({
      providerId: "primary", modelId, protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const,
      capabilities: ["chat", "image", "presentation"] as AiHarnessCapability[], imageProviderId: "primary", imageModelId: "image-model", enabled: true,
    });
    return {
      providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey: "fixture-key-not-a-secret", enabled: true }],
      tiers: { quick: route("q-fast"), standard: route("s-standard"), deep: route("d-deep"), pro: route("p-pro") },
      policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: false },
    };
  };
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-guidance-"));
    transport.mockReset();
    transport.mockImplementation(async target => target.endsWith("/models") ? Response.json({ data: MODELS.map(id => ({ id })) }) : complete("完成"));
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    await runtime.service.saveHarness(harnessInput());
    await runtime.service.discoverHarnessProvider("primary");
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    runtime.service.setQuota("other-member", "admin", { limitTokens: 50_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("injects pending guidance as one extra user message exactly once", async () => {
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "先生成视觉草图", prompt: "image prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "steer-run", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "做一组海报" }] });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    expect(runtime.service.harnessTrace("member", requestId)).toMatchObject({ strategy: "react", status: "running" });
    const store = runtime.service.store;
    submitRunGuidance(store, "member", requestId, guidance("第二张改成竖版", "guidance-harness-00001"));
    expect(() => submitRunGuidance(store, "other-member", requestId, guidance("越权补充"))).toThrow(expect.objectContaining({ status: 404 }));
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    expect(runtime.service.harnessTrace("member", requestId)).toMatchObject({ status: "planned", nextAction: "resume" });

    transport.mockResolvedValueOnce(complete('{"action":"complete","summary":"已按补充完成"}'));
    const calls = transport.mock.calls.length;
    await runtime.service.resumeHarnessRun("member", requestId);
    expect(transport).toHaveBeenCalledTimes(calls + 1);
    const body = JSON.parse(String(transport.mock.calls.at(-1)![1].body)) as { messages: Array<{ role: string; content: string }> };
    const users = body.messages.filter(message => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0].content).toContain("allowedTools");
    expect(users[1].content).toBe(`${AI_RUN_GUIDANCE_FRAMING}\n第二张改成竖版`);
    expect(JSON.stringify(body)).not.toContain("越权补充");
    expect(listRunGuidance(store, "member", requestId).guidance).toMatchObject([{ id: "guidance-harness-00001", status: "delivered" }]);
    expect(runtime.service.harnessTrace("member", requestId)).toMatchObject({ status: "succeeded" });
    expect(() => submitRunGuidance(store, "member", requestId, guidance("结束后再补充"))).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
  });

  it("leaves the decision request unchanged when nothing is pending", async () => {
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "草图", prompt: "image prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "steer-run-empty", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "做海报" }] });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    transport.mockResolvedValueOnce(complete('{"action":"complete","summary":"完成"}'));
    await runtime.service.resumeHarnessRun("member", requestId);
    const body = JSON.parse(String(transport.mock.calls.at(-1)![1].body)) as { messages: Array<{ role: string; content: string }> };
    expect(body.messages.filter(message => message.role === "user")).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain(AI_RUN_GUIDANCE_FRAMING);
  });
});
