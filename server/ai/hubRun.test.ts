import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiHarnessCapability, AiHarnessInput, AiSource } from "../../shared/ai";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, replyProcessFromRunEvents } from "../../shared/aiReplyProcess";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import { readAiWorkflowUpdate, type AiWorkflowUpdate } from "../../shared/aiWorkflows";
import { readAiChatStream } from "../../src/lib/aiRunStream";
import { replyProcessView } from "../../src/features/tongpin-ai/replyProcessModel";
import { activeMultiAgentRequestId } from "../../src/features/tongpin-ai/composerSteer";
import { createChatStreamResponse } from "./chatStream";
import { hubTiming, hubWorkflowFor } from "./hubRun";
import { setMultiAgentPendingGuidance } from "./multiAgentRun";
import { createNodeAi } from "./node";
import type { AiTransport, AiTransportInit } from "./provider";

/*
 * Hub 工作流, step by step, end to end on the real AiService (SQLite store,
 * quota ledger, harness trace, run journal and SSE responder). Only the
 * provider transport is an in-process fixture: no network and no paid call.
 */

const MODELS = ["q-fast", "s-standard", "d-deep", "p-pro"];
const KEY = "hub-fixture-not-a-real-key";
type Role = "step1" | "step2" | "final" | "direct";
interface Call { role: Role; body: Record<string, unknown>; init: AiTransportInit }
interface Usage { input: number; output: number }
interface Search { query: string; sources: AiSource[] }

const encoder = new TextEncoder();
function instructionsOf(body: Record<string, unknown>): string {
  if (typeof body.instructions === "string") return body.instructions;
  const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
  return String(messages?.[0]?.content ?? "");
}
function roleOf(body: Record<string, unknown>): Role {
  const instructions = instructionsOf(body);
  if (instructions.includes("【Hub 工作流 · 第 1/3 步】")) return "step1";
  if (instructions.includes("【Hub 工作流 · 第 2/3 步】")) return "step2";
  if (instructions.includes("【Hub 工作流 · 最后一步】")) return "final";
  return "direct";
}
function userText(body: Record<string, unknown>): string {
  const turns = (body.input ?? body.messages) as Array<{ role: string; content: unknown }>;
  return turns.filter(turn => turn.role === "user").map(turn => typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content)).join("\n");
}

/** Responses SSE: optional real web_search_call lifecycle, one text part, terminal usage. */
function responsesStream(text: string, options: { usage?: Usage; searches?: Search[]; hold?: Promise<void>; signal?: AbortSignal } = {}): Response {
  const usage = options.usage ?? { input: 40, output: 10 };
  const searches = options.searches ?? [];
  const head: object[] = [], tail: object[] = [];
  searches.forEach((search, index) => {
    head.push({ type: "response.output_item.added", output_index: index, item: { type: "web_search_call", id: `ws_${index}`, status: "in_progress" } });
    head.push({ type: "response.web_search_call.searching", output_index: index });
    head.push({ type: "response.output_item.done", output_index: index, item: { type: "web_search_call", id: `ws_${index}`, status: "completed", action: { query: search.query, sources: search.sources } } });
  });
  if (text) head.push({ type: "response.output_text.delta", output_index: searches.length, content_index: 0, delta: text });
  tail.push({ type: "response.completed", response: { status: "completed", usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output },
    output: [...searches.map((search, index) => ({ type: "web_search_call", id: `ws_${index}`, status: "completed", action: { query: search.query, sources: search.sources } })),
      { type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } });
  const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      options.signal?.addEventListener("abort", () => { try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ } }, { once: true });
      for (const event of head) controller.enqueue(frame(event));
      if (options.hold) await options.hold;
      if (options.signal?.aborted) return;
      for (const event of tail) controller.enqueue(frame(event));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function harnessInput(options: { capabilities?: AiHarnessCapability[]; strategy?: "react" | "direct" } = {}): AiHarnessInput {
  const capabilities = options.capabilities ?? ["chat", "web_search"];
  const route = (modelId: string) => ({ providerId: "primary", modelId, protocol: "responses" as const, maxOutputTokens: 2048, reasoningEffort: "" as const, capabilities, enabled: true });
  return {
    providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "responses", apiKey: KEY, enabled: true }],
    tiers: { quick: route("q-fast"), standard: route("s-standard"), deep: route("d-deep"), pro: route("p-pro") },
    policy: { strategy: options.strategy ?? "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
  };
}

describe("Hub 工作流 · 真实分步执行", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  let calls: Call[];
  let handlers: Partial<Record<Role, (call: Call) => Response | Promise<Response>>>;
  const timing = { ...hubTiming };

  const transport: AiTransport = async (url, init) => {
    if (url.endsWith("/models")) return Response.json({ data: MODELS.map(id => ({ id })) });
    const body = JSON.parse(init.body!) as Record<string, unknown>;
    const role = roleOf(body);
    const call: Call = { role, body, init };
    calls.push(call);
    const handler = handlers[role];
    if (handler) return handler(call);
    if (role === "step1") return responsesStream("摘要：核心问题是 A 与 B 的成本差异。\n\n- 时间范围：2026 年", { usage: { input: 50, output: 20 } });
    if (role === "step2") return responsesStream("摘要：A 更便宜，B 更稳定。\n\n- 事实：A 单价 3 元\n- 待确认：B 的折扣", { usage: { input: 70, output: 25 } });
    if (role === "final") return responsesStream("结论：选 A。依据：A 单价更低，B 的折扣待确认。", { usage: { input: 120, output: 30 } });
    return responsesStream("一次性回答（模板路径）。", { usage: { input: 60, output: 15 } });
  };

  async function configure(options: { search?: boolean; strategy?: "react" | "direct" } = {}) {
    if (options.search !== false) await runtime.service.saveProvider({ name: "Search", baseUrl: "https://gateway.example.com/v1", apiKey: KEY, protocol: "responses", quickModel: "q-fast", deepModel: "p-pro", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100 });
    await runtime.service.saveHarness(harnessInput({ ...(options.strategy ? { strategy: options.strategy } : {}) }));
    await runtime.service.discoverHarnessProvider("primary");
    calls.length = 0;
  }
  const request = (overrides: Partial<AiChatRequest> = {}): AiChatRequest => ({
    requestId: crypto.randomUUID(), conversationId: "conversation-hub", mode: "standard", outputFormat: "dispatch",
    workflowId: "hub-research-brief", skillIds: ["deep-research", "data-reader", "content-editor"],
    messages: [{ role: "user", content: "@hub-research-brief 帮我比较供应商 A 和 B 的报价" }], ...overrides,
  });
  const run = async (body: AiChatRequest, workflowEvents = true) => {
    const events: AiRunEvent[] = [];
    const response = await runtime.service.chat("member", { ...body, workflowEvents, liveProgress: true }, { stream: true, onEvent: event => events.push(event) });
    return { response, events };
  };
  const updates = (events: AiRunEvent[]) => events.flatMap(event => event.type === "workflow_update" ? [event.data] : []);
  const statuses = (update: AiWorkflowUpdate) => update.steps.map(step => step.status).join(",");
  const ledger = (requestId: string) => runtime.store.usage("member").filter(entry => entry.requestId === requestId);
  const workflowSteps = (trace: { steps: Array<{ kind: string; status: string; summary: string; workflowStepId?: string }> } | undefined) =>
    trace?.steps.filter(step => step.kind === "workflow").map(step => ({ id: step.workflowStepId, status: step.status, summary: step.summary }));

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-hub-"));
    calls = []; handlers = {};
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    runtime.service.setQuota("member", "admin", { limitTokens: 1_000_000 });
  });
  afterEach(async () => {
    Object.assign(hubTiming, timing);
    setMultiAgentPendingGuidance(undefined);
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("runs each step as its own call, hands every result to the next, and streams only the last", async () => {
    await configure();
    const body = request();
    const { response, events } = await run(body);

    expect(calls.map(call => call.role)).toEqual(["step1", "step2", "final"]);
    // Step 1 sees the member's request and no earlier result; it is capped and tool-free.
    expect(userText(calls[0].body)).toContain("供应商 A 和 B");
    expect(userText(calls[0].body)).not.toContain("前面步骤的结果");
    for (const call of calls.slice(0, 2)) {
      expect(call.body).toMatchObject({ model: "s-standard", max_output_tokens: 2048, stream: true });
      expect(call.body).not.toHaveProperty("tools");
      expect(instructionsOf(call.body)).toContain("这是中间步骤");
      expect(instructionsOf(call.body)).not.toContain("按顺序完成以下应用步骤");
    }
    expect(instructionsOf(calls[0].body)).toContain("「界定问题」：明确目标、范围");
    expect(instructionsOf(calls[1].body)).toContain("「整理证据」：分开已提供事实");
    // Step 2 gets step 1's result as reference data; the last step gets both.
    expect(userText(calls[1].body)).toContain("核心问题是 A 与 B 的成本差异");
    expect(userText(calls[1].body)).toContain('"status":"done"');
    const finalInput = userText(calls[2].body);
    expect(finalInput).toContain("核心问题是 A 与 B 的成本差异");
    expect(finalInput).toContain("A 单价 3 元");
    expect(finalInput).toContain("供应商 A 和 B");
    expect(instructionsOf(calls[2].body)).toContain("「形成简报」：优先给出结论");
    expect(instructionsOf(calls[2].body)).not.toContain("按顺序完成以下应用步骤");

    expect(response).toMatchObject({ content: "结论：选 A。依据：A 单价更低，B 的折扣待确认。", dispatch: { kind: "text" } });
    // Only the last step's text is the member-visible answer.
    expect(events.flatMap(event => event.type === "answer_delta" ? [event.data.delta] : []).join("")).toBe(response.content);
    // One request, one ledger entry: actual provider usage of all three calls.
    const used = (50 + 20) + (70 + 25) + (120 + 30);
    expect(response.usage).toMatchObject({ inputTokens: 240, outputTokens: 75, totalTokens: used, estimated: false });
    expect(ledger(body.requestId)).toEqual([expect.objectContaining({ status: "completed", kind: "chat", totalTokens: used })]);
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: used, reservedTokens: 0 });

    // The trace records every step as the application verified it.
    expect(response.trace).toMatchObject({ strategy: "plan_execute", status: "succeeded" });
    expect(workflowSteps(response.trace)).toEqual([
      { id: "scope", status: "succeeded", summary: expect.stringMatching(/^已完成，结果已交给下一步（用时 \d+ 秒）。$/) },
      { id: "evidence", status: "succeeded", summary: expect.stringMatching(/^已完成，结果已交给下一步/) },
      { id: "deliver", status: "succeeded", summary: "已完成并形成最终回答。" },
    ]);
    // The trace never stores member text or model output.
    expect(JSON.stringify(response.trace)).not.toMatch(/供应商|成本差异|单价/);

    // Live progress: one step at a time, in order, ending with every step done.
    const steps = updates(events).map(statuses);
    expect(steps[0]).toBe("running,planned,planned");
    expect(steps).toContain("done,running,planned");
    expect(steps).toContain("done,done,running");
    expect(steps.at(-1)).toBe("done,done,done");
    expect(updates(events).every(update => readAiWorkflowUpdate(update))).toBe(true);
    const done = updates(events).at(-1)!;
    expect(done.steps[0]).toMatchObject({ activity: "核心问题是 A 与 B 的成本差异。", durationMs: expect.any(Number) });
    // Answer text appears only once the last step runs.
    const lastStarts = events.findIndex(event => event.type === "workflow_update" && statuses(event.data) === "done,done,running");
    expect(events.findIndex(event => event.type === "answer_delta")).toBeGreaterThan(lastStarts);
    const types = events.map(event => event.type);
    expect(types[0]).toBe("run_started");
    expect(types.slice(-2)).toEqual(["usage_updated", "run_finished"]);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));
    // Display-only: nothing about the Hub steps enters the persisted reply process.
    expect(replyProcessFromRunEvents(events, "completed")).toBeUndefined();
  });

  it("shows the live steps in the reply process and takes supplements until the last step starts", async () => {
    await configure();
    const body = request();
    const { events } = await run(body);
    let live = EMPTY_REPLY_PROCESS_LIVE;
    const seen: string[] = [];
    const targets: Array<string | undefined> = [];
    for (const event of events) {
      live = applyReplyProcessEvent(live, event);
      const message = { id: "m1", role: "assistant" as const, content: "", time: "", status: "thinking" as const, requestId: body.requestId, liveProcess: live };
      const view = replyProcessView({ message });
      const plan = view?.parts.find(part => part.kind === "plan");
      if (plan?.kind === "plan" && plan.activity) seen.push(plan.activity);
      targets.push(activeMultiAgentRequestId(message));
    }
    expect(seen).toContain("正在执行第 1/3 步：界定问题");
    expect(seen).toContain("正在执行第 2/3 步：整理证据");
    expect(seen).toContain("正在执行第 3/3 步：形成简报");
    // Guidance is accepted while a later step can still take it, never during the last step.
    expect(targets).toContain(body.requestId);
    expect(targets.at(-1)).toBeUndefined();
    const lastRunning = events.findIndex(event => event.type === "workflow_update" && event.data.steps[2].status === "running");
    expect(targets.slice(lastRunning)).not.toContain(body.requestId);
  });

  it("sends no workflow_update events to clients that did not opt in, and still answers step by step", async () => {
    await configure();
    const { response, events } = await run(request(), false);
    expect(calls.map(call => call.role)).toEqual(["step1", "step2", "final"]);
    expect(response.content).toContain("结论：选 A");
    expect(events.some(event => event.type === "workflow_update")).toBe(false);
    expect(events.at(-1)?.type).toBe("run_finished");
  });

  it("lets only the evidence step search when the member asks for web search, and cites its sources", async () => {
    await configure();
    handlers.step2 = () => responsesStream("摘要：查到两家最新报价。", { usage: { input: 80, output: 20 }, searches: [{
      query: "供应商 A B 报价 2026", sources: [{ title: "A 官网报价", url: "https://a.example.com/price" }, { title: "B 公告", url: "https://b.example.com/news" }],
    }] });
    handlers.final = call => {
      expect(instructionsOf(call.body)).toContain("前面的步骤已经联网检索过");
      expect(userText(call.body)).toContain('"sources":[{"n":1,"title":"A 官网报价","site":"a.example.com"}');
      return responsesStream("A 更便宜 [1]，B 有折扣 [2]。", { usage: { input: 130, output: 20 } });
    };
    const body = request({ webSearch: true });
    const { response, events } = await run(body);
    expect(calls.map(call => call.role)).toEqual(["step1", "step2", "final"]);
    expect(calls[0].body).not.toHaveProperty("tools");
    expect(calls[1].body).toMatchObject({ tools: [{ type: "web_search" }], tool_choice: "required", max_tool_calls: 1 });
    expect(calls[2].body).not.toHaveProperty("tools");
    expect(response.sources).toEqual([{ title: "A 官网报价", url: "https://a.example.com/price" }, { title: "B 公告", url: "https://b.example.com/news" }]);
    expect(response.usage).toMatchObject({ searchCalls: 1, convertedTokens: 100, billingKind: "tokens_with_search" });
    expect(workflowSteps(response.trace)?.[1].summary).toMatch(/联网搜索 1 次/);
    // The search itself shows live like an ordinary reply's and is kept in the reply process.
    expect(updates(events).some(update => update.steps[1].activity === "联网搜索：供应商 A B 报价 2026")).toBe(true);
    expect(replyProcessFromRunEvents(events, "completed")?.steps).toEqual([expect.objectContaining({ kind: "search", status: "completed", query: "供应商 A B 报价 2026", sourceCount: 2 })]);
  });

  it("keeps the one-call template for turns it cannot split", async () => {
    await configure();
    // A web-search turn whose Hub has no step that may search.
    handlers.direct = () => responsesStream("一次性回答（模板路径）。", { usage: { input: 60, output: 15 }, searches: [{ query: "周会", sources: [] }] });
    const meeting = request({ workflowId: "hub-meeting-followup", skillIds: ["meeting-notes", "content-editor", "slide-maker"], webSearch: true, messages: [{ role: "user", content: "整理今天的周会" }] });
    const { response } = await run(meeting);
    expect(calls.map(call => call.role)).toEqual(["direct"]);
    expect(instructionsOf(calls[0].body)).toContain("按顺序完成以下应用步骤");
    expect(response.content).toBe("一次性回答（模板路径）。");
    const route = runtime.service.harness.resolve("standard", runtime.store.provider(), "chat");
    expect(hubWorkflowFor(route, request({ outputFormat: "image_plan" }))).toBeUndefined();
    expect(hubWorkflowFor(route, request({ voiceCall: true }))).toBeUndefined();
    expect(hubWorkflowFor(route, request({ codeInterpreter: true }))).toBeUndefined();
    expect(hubWorkflowFor(route, request({ retryMode: "continue", retryOf: crypto.randomUUID() }))).toBeUndefined();
    expect(hubWorkflowFor(route, request({ workflowId: undefined }))).toBeUndefined();
    expect(hubWorkflowFor({ ...route, legacy: true }, request())).toBeUndefined();
    expect(hubWorkflowFor(route, request())?.id).toBe("hub-research-brief");
  });

  it("falls back to the one-call template when the worst case does not fit", async () => {
    await configure();
    const body = request();
    const preflight = runtime.service.preflight("member", body);
    // Three calls reserve more than one ordinary answer.
    expect(preflight.budget.availableOutputTokens).toBe(2048 * 3);
    runtime.service.setQuota("member", "admin", { limitTokens: preflight.budget.minimumRequiredTokens - 1 });
    const fallback = runtime.service.preflight("member", body);
    expect(fallback.canSend).toBe(true);
    expect(fallback.budget.minimumRequiredTokens).toBeLessThan(preflight.budget.minimumRequiredTokens);
    const { response, events } = await run(body);
    expect(calls.map(call => call.role)).toEqual(["direct"]);
    expect(updates(events)).toEqual([]);
    expect(response.trace).toMatchObject({ strategy: "react" });
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
  });

  it("reserves every call's worst case up front and never settles above it", async () => {
    await configure();
    const body = request();
    const preflight = runtime.service.preflight("member", body);
    let reservedDuringRun = 0;
    handlers.step1 = () => {
      reservedDuringRun = runtime.service.quota("member").reservedTokens;
      // A provider that reports more than the step's cap is billed at the step's reservation instead.
      return responsesStream("摘要：超额报告", { usage: { input: 30, output: 5000 } });
    };
    const { response } = await run(body);
    expect(reservedDuringRun).toBe(preflight.budget.minimumRequiredTokens);
    expect(response.usage.estimated).toBe(true);
    expect(response.usage.outputTokens).toBe(2048 + 25 + 30);
    expect(response.usage.totalTokens).toBeLessThanOrEqual(preflight.budget.minimumRequiredTokens);
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
  });

  it("stops at once when a step's call fails, with no further paid call", async () => {
    await configure();
    // A refusal before generation (429) is free; the run stops instead of calling the last step.
    handlers.step2 = () => Response.json({ error: { code: "rate_limit_exceeded", message: `${KEY} private` } }, { status: 429 });
    const body = request();
    const events: AiRunEvent[] = [];
    await expect(runtime.service.chat("member", { ...body, workflowEvents: true }, { stream: true, onEvent: event => events.push(event) })).rejects.toMatchObject({ code: expect.any(String) });
    expect(calls.map(call => call.role)).toEqual(["step1", "step2"]);
    const stored = runtime.store.request("member", body.requestId)!;
    expect(stored.status).toBe("failed");
    expect(ledger(body.requestId)).toEqual([expect.objectContaining({ status: "failed", totalTokens: 70 })]);
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: 70, reservedTokens: 0 });
    expect(updates(events).at(-1)!.steps.map(step => step.status)).toEqual(["done", "failed", "skipped"]);
    expect(events.at(-1)).toMatchObject({ type: "run_failed" });
    expect(JSON.stringify(events)).not.toContain(KEY);
    const trace = runtime.service.harness.trace("member", body.requestId);
    expect(workflowSteps(trace)).toEqual([
      expect.objectContaining({ id: "scope", status: "succeeded" }),
      { id: "evidence", status: "failed", summary: "该步骤未能完成。" },
      { id: "deliver", status: "cancelled", summary: "未执行。" },
    ]);
  });

  it("goes on when a step returns nothing usable, and tells the last step what is missing", async () => {
    await configure();
    handlers.step1 = () => responsesStream("", { usage: { input: 50, output: 0 } });
    const body = request();
    const { response, events } = await run(body);
    expect(calls.map(call => call.role)).toEqual(["step1", "step2", "final"]);
    expect(userText(calls[2].body)).toContain('{"n":1,"title":"界定问题","status":"failed","note":"该步骤未完成，没有可用结果"}');
    expect(response.content).toContain("结论：选 A");
    expect(workflowSteps(response.trace)?.map(step => step.status)).toEqual(["failed", "succeeded", "succeeded"]);
    expect(updates(events).at(-1)!.steps.map(step => step.status)).toEqual(["failed", "done", "done"]);
  });

  it("returns the earlier steps' paid work, marked unfinished, when the last step fails", async () => {
    await configure();
    handlers.final = () => Response.json({ error: { code: "server_error", message: "boom" } }, { status: 500 });
    const body = request();
    const { response, events } = await run(body);
    expect(response.content).toContain("「研究简报 Hub」的最后一步「形成简报」未能完成");
    expect(response.content).toContain("核心问题是 A 与 B 的成本差异");
    expect(response.completion).toEqual({ state: "partial", reason: "stream_interrupted", canContinue: false });
    expect(ledger(body.requestId)[0]).toMatchObject({ status: "uncertain" });
    expect(workflowSteps(response.trace)?.[2]).toEqual({ id: "deliver", status: "failed", summary: "最后一步未能完成，已返回前面步骤的结果。" });
    expect(updates(events).at(-1)!.steps.map(step => step.status)).toEqual(["done", "done", "failed"]);
  });

  it("stops the step in flight when the member presses Stop", async () => {
    await configure();
    let started = false;
    handlers.step2 = call => { started = true; return responsesStream("摘要：进行中", { hold: new Promise(() => {}), signal: call.init.signal }); };
    const body = request();
    const events: AiRunEvent[] = [];
    const pending = runtime.service.chat("member", { ...body, workflowEvents: true }, { stream: true, onEvent: event => events.push(event) });
    await vi.waitFor(() => expect(started).toBe(true));
    // Another member cannot stop this run, even with the same request id.
    runtime.service.setQuota("other-member", "admin", { limitTokens: 1000 });
    expect(runtime.service.cancelMultiAgentRun("other-member", body.requestId)).toEqual({ cancelled: false });
    expect(runtime.service.cancelMultiAgentRun("member", body.requestId)).toEqual({ cancelled: true });
    await expect(pending).rejects.toMatchObject({ code: "AI_RUN_CANCELLED" });
    expect(calls.map(call => call.role)).toEqual(["step1", "step2"]);
    expect(calls[1].init.signal!.aborted).toBe(true);
    expect(updates(events).at(-1)!.steps.map(step => step.status)).toEqual(["done", "skipped", "skipped"]);
    expect(events.at(-1)).toMatchObject({ type: "run_failed", data: { error: { code: "AI_RUN_CANCELLED" } } });
    expect(ledger(body.requestId)[0]).toMatchObject({ status: "uncertain" });
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
    expect(workflowSteps(runtime.service.harness.trace("member", body.requestId))?.map(step => step.status)).toEqual(["succeeded", "cancelled", "cancelled"]);
    expect(runtime.service.cancelMultiAgentRun("member", body.requestId)).toEqual({ cancelled: false });
  });

  it("adds supplements typed during the run to every later step", async () => {
    await configure();
    const checkpoints: string[] = [];
    setMultiAgentPendingGuidance(context => {
      checkpoints.push(context.checkpoint);
      return checkpoints.length === 2 ? ["只看 2026 年的报价"] : [];
    });
    await run(request());
    expect(checkpoints).toEqual(["before_workflow_step", "before_workflow_step", "before_workflow_final"]);
    expect(userText(calls[0].body)).not.toContain("只看 2026 年的报价");
    expect(userText(calls[1].body)).toContain('"guidance":["只看 2026 年的报价"]');
    expect(userText(calls[2].body)).toContain('"guidance":["只看 2026 年的报价"]');
  });

  it("streams through the real SSE responder into the real browser decoder", async () => {
    await configure();
    const target = request();
    const events: AiRunEvent[] = [];
    const api = async <T,>(requestPath: string, init?: RequestInit): Promise<T> => {
      if (requestPath === "/api/ai/chat/stream") return createChatStreamResponse(runtime.service, "member", JSON.parse(String(init!.body))) as T;
      const after = Number(new URLSearchParams(requestPath.split("?")[1] ?? "").get("after") ?? 0);
      return { events: runtime.service.getRunEvents("member", target.requestId, after) } as T;
    };
    const result = await readAiChatStream(api, target, { accountId: "member", signal: new AbortController().signal, onEvent: event => events.push(event) });
    expect(result.content).toContain("结论：选 A");
    // The browser client opts in, and accepts every Hub progress event.
    expect(events.filter(event => event.type === "workflow_update").length).toBeGreaterThanOrEqual(4);
  });
});
