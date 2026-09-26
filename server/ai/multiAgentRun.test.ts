import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiHarnessCapability, AiHarnessInput, AiSource } from "../../shared/ai";
import type { AiMultiAgentSettings } from "../../shared/aiMultiAgent";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, replyProcessFromRunEvents, type AiReplyProcessAgentsStep } from "../../shared/aiReplyProcess";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import { readAiChatStream } from "../../src/lib/aiRunStream";
import { createChatStreamResponse } from "./chatStream";
import { MULTI_AGENT_SEARCH_INPUT_RESERVE, multiAgentTiming, setMultiAgentPendingGuidance } from "./multiAgentRun";
import { createNodeAi } from "./node";
import type { AiTransport, AiTransportInit } from "./provider";

/*
 * 多 Agent 协作 end to end on the real AiService (SQLite store, quota ledger,
 * harness trace, run journal and SSE responder). Only the provider transport
 * is an in-process fixture: no network and no paid call.
 */

const MODELS = ["q-fast", "s-standard", "d-deep", "p-pro", "p-mini"];
const KEY = "multi-agent-fixture-not-a-real-key";
type Role = "coordinator" | "subagent" | "synthesis" | "direct";
interface Call { role: Role; body: Record<string, unknown>; init: AiTransportInit; title?: string }
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
  if (instructions.includes("【多 Agent 协作 · 协调者】")) return "coordinator";
  if (instructions.includes("【多 Agent 协作 · 子 Agent】")) return "subagent";
  if (instructions.includes("【多 Agent 协作 · 结果综合】")) return "synthesis";
  return "direct";
}
function userText(body: Record<string, unknown>): string {
  const turns = (body.input ?? body.messages) as Array<{ role: string; content: unknown }>;
  return turns.filter(turn => turn.role === "user").map(turn => typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content)).join("\n");
}

/** Responses SSE: optional real web_search_call lifecycle, one text part, terminal usage. */
function responsesStream(text: string, options: { usage?: Usage; searches?: Search[]; hold?: Promise<void>; signal?: AbortSignal; onClose?: () => void } = {}): Response {
  const usage = options.usage ?? { input: 40, output: 10 };
  const searches = options.searches ?? [];
  const head: object[] = [], tail: object[] = [];
  searches.forEach((search, index) => {
    head.push({ type: "response.output_item.added", output_index: index, item: { type: "web_search_call", id: `ws_${index}`, status: "in_progress" } });
    head.push({ type: "response.web_search_call.searching", output_index: index });
    head.push({ type: "response.output_item.done", output_index: index, item: { type: "web_search_call", id: `ws_${index}`, status: "completed", action: { query: search.query, sources: search.sources } } });
  });
  head.push({ type: "response.output_text.delta", output_index: searches.length, content_index: 0, delta: text });
  tail.push({ type: "response.completed", response: { status: "completed", usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output },
    output: [...searches.map((search, index) => ({ type: "web_search_call", id: `ws_${index}`, status: "completed", action: { query: search.query, sources: search.sources } })),
      { type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } });
  let closed = false;
  const close = () => { if (!closed) { closed = true; options.onClose?.(); } };
  const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      options.signal?.addEventListener("abort", () => { close(); try { controller.error(new DOMException("aborted", "AbortError")); } catch { /* already closed */ } }, { once: true });
      for (const event of head) controller.enqueue(frame(event));
      if (options.hold) await options.hold;
      if (options.signal?.aborted) return;
      for (const event of tail) controller.enqueue(frame(event));
      controller.close(); close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

const planJson = (subtasks: Array<Record<string, unknown>>) => JSON.stringify({ subtasks });
const subtask = (index: number, extra: Record<string, unknown> = {}) => ({ role: index % 2 ? "研究员" : "分析员", title: `子任务${index}`, task: `请独立完成子任务${index}：比较方案的第 ${index} 个方面。`, search: false, ...extra });

function harnessInput(options: { multiAgent?: AiMultiAgentSettings; capabilities?: AiHarnessCapability[]; protocol?: "responses" | "chat_completions" } = {}): AiHarnessInput {
  const protocol = options.protocol ?? "responses";
  const capabilities = options.capabilities ?? ["chat", "web_search"];
  const route = (modelId: string) => ({ providerId: "primary", modelId, protocol, maxOutputTokens: 2048, reasoningEffort: "" as const, capabilities, enabled: true });
  return {
    providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol, apiKey: KEY, enabled: true }],
    tiers: { quick: route("q-fast"), standard: route("s-standard"), deep: route("d-deep"),
      pro: { ...route("p-pro"), ...(options.multiAgent ? { multiAgent: options.multiAgent } : {}) } },
    policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
  };
}

describe("Pro 多 Agent 协作", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  let calls: Call[];
  let handlers: Partial<Record<Role, (call: Call) => Response | Promise<Response>>>;
  let active: number, peak: number;
  const timing = { ...multiAgentTiming };

  const transport: AiTransport = async (url, init) => {
    if (url.endsWith("/models")) return Response.json({ data: MODELS.map(id => ({ id })) });
    const body = JSON.parse(init.body!) as Record<string, unknown>;
    const role = roleOf(body);
    const title = /子任务：(.+)/.exec(userText(body))?.[1];
    const call: Call = { role, body, init, ...(title ? { title } : {}) };
    calls.push(call);
    const handler = handlers[role];
    if (handler) return handler(call);
    if (role === "subagent") return responsesStream(`摘要：${title} 的结论。\n\n- 支撑要点`, { usage: { input: 30, output: 12 } });
    if (role === "synthesis") return responsesStream("综合后的最终回答 [1]", { usage: { input: 90, output: 20 } });
    return responsesStream("这是直接回答，不需要多 Agent 协作。", { usage: { input: 50, output: 15 } });
  };

  async function configure(multiAgent: AiMultiAgentSettings | undefined = { maxConcurrency: 2, subAgentMaxOutputTokens: 512 }, options: { capabilities?: AiHarnessCapability[]; search?: boolean } = {}) {
    if (options.search !== false) await runtime.service.saveProvider({ name: "Search", baseUrl: "https://gateway.example.com/v1", apiKey: KEY, protocol: "responses", quickModel: "q-fast", deepModel: "p-pro", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100 });
    await runtime.service.saveHarness(harnessInput({ ...(multiAgent ? { multiAgent } : {}), ...(options.capabilities ? { capabilities: options.capabilities } : {}) }));
    await runtime.service.discoverHarnessProvider("primary");
    calls.length = 0;
  }
  const request = (content = "请从成本、性能、生态三个方面比较方案 A 和方案 B", overrides: Partial<AiChatRequest> = {}): AiChatRequest => ({
    requestId: crypto.randomUUID(), conversationId: "conversation-pro", mode: "pro", outputFormat: "dispatch", webSearchMode: "auto",
    messages: [{ role: "user", content }], ...overrides,
  });
  const run = async (body: AiChatRequest, subagentEvents = true) => {
    const events: AiRunEvent[] = [];
    const response = await runtime.service.chat("member", { ...body, subagentEvents }, { stream: true, onEvent: event => events.push(event) });
    return { response, events };
  };
  const updates = (events: AiRunEvent[]) => events.flatMap(event => event.type === "subagent_update" ? [event.data] : []);
  const ledger = (requestId: string) => runtime.store.usage("member").filter(entry => entry.requestId === requestId);

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-multi-agent-"));
    calls = []; handlers = {}; active = 0; peak = 0;
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    runtime.service.setQuota("member", "admin", { limitTokens: 1_000_000 });
  });
  afterEach(async () => {
    Object.assign(multiAgentTiming, timing);
    setMultiAgentPendingGuidance(undefined);
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("validates the per-tier settings and exposes the multi_agent strategy only on that tier", async () => {
    for (const bad of [{ maxConcurrency: 1, subAgentMaxOutputTokens: 512 }, { maxConcurrency: 6, subAgentMaxOutputTokens: 512 },
      { maxConcurrency: 3, subAgentMaxOutputTokens: 4096 }, { maxConcurrency: 3, subAgentMaxOutputTokens: 100 }, { maxConcurrency: 3, subAgentMaxOutputTokens: 512, extra: true }]) {
      await expect(runtime.service.saveHarness(harnessInput({ multiAgent: bad as AiMultiAgentSettings }))).rejects.toMatchObject({ code: "AI_HARNESS_INVALID" });
    }
    const invalidGlobal = harnessInput();
    invalidGlobal.policy.strategy = "multi_agent";
    await expect(runtime.service.saveHarness(invalidGlobal)).rejects.toMatchObject({ code: "AI_HARNESS_INVALID" });
    await configure({ maxConcurrency: 3, subAgentMaxOutputTokens: 1024, subAgentModelId: "p-mini" });
    expect(runtime.service.harnessSettings()?.tiers.pro.multiAgent).toEqual({ maxConcurrency: 3, subAgentMaxOutputTokens: 1024, subAgentModelId: "p-mini" });
    expect(runtime.service.harnessSettings()?.tiers.quick.multiAgent).toBeUndefined();
    const route = runtime.service.harness.resolve("pro", runtime.store.provider(), "chat");
    // The global rule still governs tool steps; only real multi-agent runs are recorded as multi_agent.
    expect(route).toMatchObject({ policy: { strategy: "react", maxToolSteps: 3 }, multiAgent: { maxConcurrency: 3, subAgentModelId: "p-mini" } });
    expect(runtime.service.harness.resolve("quick", runtime.store.provider(), "chat").policy.strategy).toBe("react");
  });

  it("decomposes, runs sub-agents concurrently within the limit, and synthesizes one billed answer", async () => {
    await configure();
    const gates = new Map<string, () => void>();
    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2), subtask(3)]), { usage: { input: 60, output: 30 } });
    handlers.subagent = call => {
      active += 1; peak = Math.max(peak, active);
      const hold = new Promise<void>(resolve => gates.set(call.title!, resolve));
      return responsesStream(`摘要：${call.title} 已完成。\n\n- 依据`, { usage: { input: 30, output: 12 }, hold, signal: call.init.signal, onClose: () => { active -= 1; },
        searches: [] });
    };
    handlers.synthesis = () => responsesStream("最终对比：A 更便宜，B 更快。", { usage: { input: 150, output: 25 } });
    const body = request();
    const pending = run(body);
    await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(2));
    await new Promise(resolve => setTimeout(resolve, 20));
    // The third subtask waits for a free slot: never more than maxConcurrency=2 in flight.
    expect(calls.filter(call => call.role === "subagent")).toHaveLength(2);
    gates.get("子任务1")!();
    await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(3));
    for (const release of gates.values()) release();
    await vi.waitFor(() => expect([...gates.keys()]).toHaveLength(3));
    for (const release of gates.values()) release();
    const { response, events } = await pending;

    expect(peak).toBe(2);
    expect(calls.map(call => call.role)).toEqual(["coordinator", "subagent", "subagent", "subagent", "synthesis"]);
    expect(response).toMatchObject({ content: "最终对比：A 更便宜，B 更快。", model: "Pro", dispatch: { kind: "text", content: "最终对比：A 更便宜，B 更快。" } });
    // Each sub-agent is isolated: its only input is its own task, with the hard output cap.
    for (const call of calls.filter(item => item.role === "subagent")) {
      expect(call.body).toMatchObject({ model: "p-pro", max_output_tokens: 512, stream: true });
      expect(userText(call.body)).toContain(call.title);
      expect(userText(call.body)).not.toContain("方案 A 和方案 B");
      expect(call.body).not.toHaveProperty("tools");
    }
    const synthesisInput = userText(calls.at(-1)!.body);
    expect(synthesisInput).toContain("方案 A 和方案 B");
    expect(synthesisInput).toContain("子任务1 已完成");
    expect(synthesisInput).toContain('"status":"done"');
    // One request, one ledger entry: actual provider usage of all five calls.
    const used = (60 + 30) + 3 * (30 + 12) + (150 + 25);
    expect(response.usage).toMatchObject({ inputTokens: 60 + 90 + 150, outputTokens: 30 + 36 + 25, totalTokens: used, estimated: false });
    expect(ledger(body.requestId)).toEqual([expect.objectContaining({ status: "completed", kind: "chat", totalTokens: used })]);
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: used, reservedTokens: 0 });
    expect(response.trace).toMatchObject({ strategy: "multi_agent", status: "succeeded", toolBudget: { max: 1 } });

    // Event stream: planning → dispatching (plan) → working (start…) → synthesizing → done.
    const phases = updates(events).map(update => update.phase);
    expect(phases[0]).toBe("planning");
    expect(phases[1]).toBe("plan");
    expect(phases.filter(phase => phase === "start")).toHaveLength(3);
    expect(phases.filter(phase => phase === "stop")).toHaveLength(3);
    expect(phases.indexOf("synthesis")).toBeGreaterThan(phases.lastIndexOf("stop"));
    expect(phases.at(-1)).toBe("finish");
    const plan = updates(events).find(update => update.phase === "plan");
    expect(plan).toMatchObject({ maxConcurrency: 2, subtasks: [{ id: "agent-1", role: "研究员", title: "子任务1", search: false }, { id: "agent-2", role: "分析员" }, { id: "agent-3" }] });
    const types = events.map(event => event.type);
    expect(types[0]).toBe("run_started");
    expect(types.slice(-2)).toEqual(["usage_updated", "run_finished"]);
    // 结果综合 is the main content: answer text only after the synthesis phase starts.
    const synthesisAt = events.findIndex(event => event.type === "subagent_update" && event.data.phase === "synthesis");
    expect(types.indexOf("answer_delta")).toBeGreaterThan(synthesisAt);
    expect(events.map(event => event.seq)).toEqual(events.map((_, index) => index + 1));

    // The journal folds into the persisted process the AI 员工办公室 view reads.
    const process = replyProcessFromRunEvents(runtime.service.getRunEvents("member", body.requestId), "completed");
    const agents = process?.steps.find(step => step.kind === "agents") as AiReplyProcessAgentsStep;
    expect(agents).toMatchObject({ kind: "agents", phase: "done", maxConcurrency: 2, synthesis: "done" });
    expect(agents.agents.map(agent => [agent.id, agent.role, agent.status, agent.summary])).toEqual([
      ["agent-1", "研究员", "done", "子任务1 已完成。"], ["agent-2", "分析员", "done", "子任务2 已完成。"], ["agent-3", "研究员", "done", "子任务3 已完成。"]]);
    expect(agents.agents[0].task).toContain("子任务1");
    expect(agents.agents.every(agent => agent.startedAt !== undefined && agent.finishedAt! >= agent.startedAt! && agent.durationMs !== undefined)).toBe(true);
  });

  it("answers a simple request directly: one call, no sub-agents, planning step dropped", async () => {
    await configure();
    const body = request("你好");
    const { response, events } = await run(body);
    expect(calls.map(call => call.role)).toEqual(["coordinator"]);
    expect(response.content).toBe("这是直接回答，不需要多 Agent 协作。");
    expect(updates(events).map(update => update.phase)).toEqual(["planning", "direct"]);
    expect(events.flatMap(event => event.type === "answer_delta" ? [event.data.delta] : []).join("")).toBe(response.content);
    expect(replyProcessFromRunEvents(events, "completed")).toBeUndefined();
    expect(ledger(body.requestId)).toEqual([expect.objectContaining({ status: "completed", totalTokens: 65 })]);
    expect(response.trace?.strategy).toBe("multi_agent");
  });

  it("keeps tool requests and the tier allowlist working under the coordinator", async () => {
    await configure(undefined, { capabilities: ["chat", "web_search"] });
    handlers.coordinator = () => responsesStream('<tool_request>{"kind":"image","prompt":"一只橘猫"}</tool_request>');
    const { response } = await run(request("帮我画一只橘猫"));
    expect(calls).toHaveLength(1);
    expect(response.dispatch).toMatchObject({ kind: "text" });
    expect(response.content).toContain("没有开放图片生成");
  });

  it("degrades a broken plan to one direct answer instead of failing", async () => {
    await configure();
    handlers.coordinator = () => responsesStream('{"subtasks": "not-an-array"}');
    const body = request();
    const { response, events } = await run(body);
    expect(calls.map(call => call.role)).toEqual(["coordinator", "direct"]);
    expect(response.content).toBe("这是直接回答，不需要多 Agent 协作。");
    expect(updates(events).map(update => update.phase)).toEqual(["planning", "direct"]);
    expect(ledger(body.requestId)[0]).toMatchObject({ status: "completed", totalTokens: (40 + 10) + (50 + 15) });
  });

  it("repairs a fenced, prose-wrapped plan and caps it at five sub-agents", async () => {
    await configure({ maxConcurrency: 5, subAgentMaxOutputTokens: 512 });
    const items = Array.from({ length: 8 }, (_, index) => subtask(index + 1));
    handlers.coordinator = () => responsesStream(`好的，我来分工：\n\`\`\`json\n${planJson(items).replace(/}]}$/, "},]}")}\n\`\`\``);
    const { response } = await run(request());
    expect(calls.filter(call => call.role === "subagent")).toHaveLength(5);
    expect(response.content).toContain("综合后的最终回答");
  });

  it("isolates a failed and a timed-out sub-agent; synthesis notes the missing parts", async () => {
    await configure({ maxConcurrency: 3, subAgentMaxOutputTokens: 512 });
    multiAgentTiming.subagentTimeoutMs = 150;
    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2), subtask(3)]));
    handlers.subagent = call => {
      if (call.title === "子任务2") return Response.json({ error: { code: "server_error", message: `${KEY} private` } }, { status: 500 });
      if (call.title === "子任务3") return responsesStream("摘要：只写了一半", { hold: new Promise(() => {}), signal: call.init.signal });
      return responsesStream("摘要：第一部分完成。", { usage: { input: 30, output: 12 } });
    };
    const body = request();
    const { response, events } = await run(body);
    expect(response.content).toBe("综合后的最终回答 [1]");
    const errors = updates(events).filter(update => update.phase === "error");
    expect(errors).toEqual([
      expect.objectContaining({ id: "agent-2", reason: "failed" }),
      expect.objectContaining({ id: "agent-3", reason: "timeout", message: "超时未完成（1 秒）" }),
    ]);
    expect(JSON.stringify(events)).not.toContain(KEY);
    const reference = userText(calls.at(-1)!.body);
    expect(reference).toContain('"status":"failed"');
    expect(reference).toContain('"status":"timeout"');
    expect(reference).toContain("只写了一半");
    // Unknown usage of the failed/aborted calls is billed at their reservation, never above the total.
    const entry = ledger(body.requestId)[0];
    expect(entry).toMatchObject({ status: "completed", estimated: true });
    expect(entry.totalTokens).toBeGreaterThan(50 + 10 + 30 + 12 + 90 + 20);
    const quota = runtime.service.quota("member");
    expect(quota.reservedTokens).toBe(0);
    expect(quota.usedTokens).toBe(entry.totalTokens);
    const process = replyProcessFromRunEvents(events, "completed")!;
    const agents = process.steps.find(step => step.kind === "agents") as AiReplyProcessAgentsStep;
    expect(agents.agents.map(agent => agent.status)).toEqual(["done", "failed", "failed"]);
    expect(agents.agents[2].error).toBe("超时未完成（1 秒）");
  });

  it("stops every in-flight and queued sub-agent on member cancel, without synthesis", async () => {
    await configure({ maxConcurrency: 2, subAgentMaxOutputTokens: 512 });
    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2), subtask(3)]));
    handlers.subagent = call => { active += 1; return responsesStream("摘要：进行中", { hold: new Promise(() => {}), signal: call.init.signal, onClose: () => { active -= 1; } }); };
    const body = request();
    const events: AiRunEvent[] = [];
    const pending = runtime.service.chat("member", { ...body, subagentEvents: true }, { stream: true, onEvent: event => events.push(event) });
    await vi.waitFor(() => expect(active).toBe(2));
    // Another member cannot stop this run, even with the same request id.
    runtime.service.setQuota("other-member", "admin", { limitTokens: 1000 });
    expect(runtime.service.cancelMultiAgentRun("other-member", body.requestId)).toEqual({ cancelled: false });
    expect(() => runtime.service.cancelMultiAgentRun("no-access", body.requestId)).toThrow(expect.objectContaining({ code: "AI_ACCESS_NOT_GRANTED" }));
    expect(runtime.service.cancelMultiAgentRun("member", body.requestId)).toEqual({ cancelled: true });
    await expect(pending).rejects.toMatchObject({ code: "AI_RUN_CANCELLED" });
    expect(active).toBe(0);
    expect(calls.filter(call => call.role === "subagent")).toHaveLength(2);
    expect(calls.filter(call => call.role === "subagent").every(call => call.init.signal.aborted)).toBe(true);
    expect(calls.some(call => call.role === "synthesis")).toBe(false);
    const phases = updates(events).map(update => update.phase === "error" ? `${update.phase}:${update.id}:${update.reason}` : update.phase);
    expect(phases).toEqual(expect.arrayContaining(["error:agent-1:cancelled", "error:agent-2:cancelled", "error:agent-3:cancelled", "finish"]));
    expect(events.at(-1)).toMatchObject({ type: "run_failed", data: { error: { code: "AI_RUN_CANCELLED" } } });
    expect(ledger(body.requestId)[0]).toMatchObject({ status: "uncertain" });
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
    expect(runtime.service.cancelMultiAgentRun("member", body.requestId)).toEqual({ cancelled: false });
  });

  it("reserves the worst case up front, caps every call, and never settles above the reservation", async () => {
    await configure({ maxConcurrency: 2, subAgentMaxOutputTokens: 512 });
    const body = request();
    const preflight = runtime.service.preflight("member", body);
    expect(preflight.canSend).toBe(true);
    // Worst case with search: 3 search sub-agents at the conservative search allowance.
    expect(preflight.budget.searchInputReserve).toBe(3 * MULTI_AGENT_SEARCH_INPUT_RESERVE);
    expect(preflight.budget.convertedReserve).toBe(3 * 100);
    expect(preflight.budget.availableOutputTokens).toBe(2048 + 2048 + 5 * 512);
    // The search allowance matches the ordinary single-agent reservation.
    await runtime.service.saveHarness(harnessInput());
    await runtime.service.discoverHarnessProvider("primary");
    expect(runtime.service.preflight("member", { ...request("今天深圳天气怎么样"), mode: "pro" }).budget.searchInputReserve).toBe(MULTI_AGENT_SEARCH_INPUT_RESERVE);
    await configure({ maxConcurrency: 2, subAgentMaxOutputTokens: 512 });

    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2)]));
    let pendingReserve = 0;
    handlers.subagent = call => {
      pendingReserve = runtime.service.quota("member").reservedTokens;
      // A provider that reports more than the cap is billed at the call's reservation instead.
      return responsesStream("摘要：超额报告", { usage: call.title === "子任务1" ? { input: 30, output: 5000 } : { input: 30, output: 12 } });
    };
    const { response } = await run(body);
    expect(pendingReserve).toBe(preflight.budget.minimumRequiredTokens);
    for (const call of calls) expect(call.body.max_output_tokens).toBe(call.role === "subagent" ? 512 : 2048);
    expect(response.usage.estimated).toBe(true);
    expect(response.usage.totalTokens).toBeLessThanOrEqual(preflight.budget.minimumRequiredTokens);
    // coordinator 10 + over-reporting sub-agent billed at its 512 cap + 12 + synthesis 20.
    expect(response.usage.outputTokens).toBe(10 + 512 + 12 + 20);
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
  });

  it("falls back to the ordinary single-agent path when the worst case does not fit", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    const body = request();
    const preflight = runtime.service.preflight("member", body);
    expect(preflight.budget.minimumRequiredTokens).toBeLessThan(20_000);
    const { response, events } = await run(body);
    expect(calls.map(call => call.role)).toEqual(["direct"]);
    expect(updates(events)).toEqual([]);
    expect(response.trace).toMatchObject({ strategy: "react", toolBudget: { max: 3 } });
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
  });

  it("runs without sub-agent search when only the plain worst case fits", async () => {
    await configure();
    const plain = runtime.service.preflight("member", request());
    runtime.service.setQuota("member", "admin", { limitTokens: plain.budget.minimumRequiredTokens - plain.budget.searchInputReserve - plain.budget.convertedReserve + 10 });
    handlers.coordinator = call => {
      expect(instructionsOf(call.body)).toContain("联网搜索当前不可用");
      return responsesStream(planJson([subtask(1, { search: true }), subtask(2)]));
    };
    await run(request());
    expect(calls.filter(call => call.role === "subagent").every(call => !("tools" in call.body))).toBe(true);
  });

  it("lets search sub-agents browse, streams a distinct searching state and merges numbered sources", async () => {
    await configure();
    handlers.coordinator = () => responsesStream(planJson([subtask(1, { search: true }), subtask(2, { search: true })]));
    handlers.subagent = call => responsesStream(`摘要：${call.title} 查到了。`, { usage: { input: 30, output: 12 }, searches: [{
      query: `${call.title} 最新数据`, sources: [{ title: `${call.title} 来源`, url: `https://news.example.com/${encodeURIComponent(call.title!)}` }, { title: "共同来源", url: "https://shared.example.com/doc" }],
    }] });
    const body = request();
    const { response, events } = await run(body);
    for (const call of calls.filter(item => item.role === "subagent")) {
      expect(call.body).toMatchObject({ tools: [{ type: "web_search" }], tool_choice: "auto", max_tool_calls: 1 });
    }
    expect(response.sources).toHaveLength(3);
    expect(response.usage).toMatchObject({ searchCalls: 2, convertedTokens: 200, billingKind: "tokens_with_search" });
    const searches = updates(events).filter(update => update.phase === "search");
    expect(searches.map(update => update.phase === "search" && update.status)).toEqual(expect.arrayContaining(["in_progress", "searching", "completed"]));
    // Fold: the sub-agent is "searching" while the provider search runs, then back to working.
    const seen = new Set<string>();
    let live = EMPTY_REPLY_PROCESS_LIVE;
    for (const event of events) {
      live = applyReplyProcessEvent(live, event);
      const step = live.steps.find(item => item.kind === "agents");
      if (step?.kind === "agents") for (const agent of step.agents) seen.add(`${agent.id}:${agent.status}:${agent.activity}`);
    }
    expect(seen).toContain("agent-1:searching:正在联网搜索");
    expect(seen).toContain("agent-1:done:子任务1 查到了。");
    const agents = replyProcessFromRunEvents(events, "completed")!.steps.find(step => step.kind === "agents") as AiReplyProcessAgentsStep;
    expect(agents.agents.map(agent => agent.sources)).toEqual([[1, 2], [3, 2]]);
    expect(agents.agents.every(agent => agent.searchCount === 1 && agent.sourceCount === 2)).toBe(true);
  });

  it("sends no subagent_update events to clients that did not opt in", async () => {
    await configure();
    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2)]));
    const { response, events } = await run(request(), false);
    expect(response.content).toBe("综合后的最终回答 [1]");
    expect(events.some(event => event.type === "subagent_update")).toBe(false);
    expect(events.at(-1)?.type).toBe("run_finished");
  });

  it("injects pending user guidance at every checkpoint", async () => {
    await configure();
    const checkpoints: string[] = [];
    setMultiAgentPendingGuidance(context => { checkpoints.push(context.checkpoint); return [`补充-${context.checkpoint}`]; });
    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2)]));
    await run(request());
    expect(checkpoints).toEqual(["before_coordinator", "before_subagents", "before_synthesis"]);
    expect(userText(calls[0].body)).toContain("补充-before_coordinator");
    expect(calls.filter(call => call.role === "subagent").every(call => userText(call.body).includes("补充-before_subagents"))).toBe(true);
    expect(userText(calls.at(-1)!.body)).toContain("补充-before_synthesis");
  });

  it("streams through the real SSE responder into the real browser decoder", async () => {
    await configure();
    handlers.coordinator = () => responsesStream(planJson([subtask(1), subtask(2)]));
    const target = request();
    const events: AiRunEvent[] = [];
    const api = async <T,>(requestPath: string): Promise<T> => {
      if (requestPath === "/api/ai/chat/stream") return createChatStreamResponse(runtime.service, "member", { ...target, liveProgress: true, subagentEvents: true }) as T;
      const after = Number(new URLSearchParams(requestPath.split("?")[1] ?? "").get("after") ?? 0);
      return { events: runtime.service.getRunEvents("member", target.requestId, after) } as T;
    };
    const result = await readAiChatStream(api, target, { accountId: "member", signal: new AbortController().signal, onEvent: event => events.push(event) });
    expect(result.content).toBe("综合后的最终回答 [1]");
    expect(events.filter(event => event.type === "subagent_update").length).toBeGreaterThanOrEqual(6);
  });
});
