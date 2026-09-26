import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiHarnessCapability, AiHarnessInput } from "../../shared/ai";
import type { ComputerDecisionRequest } from "../../shared/computerAgent";
import { createNodeAi } from "./node";
import type { AiTransport, AiTransportInit } from "./provider";
import { cancelRunGuidance, listRunGuidance, submitRunGuidance, takePendingGuidance } from "./runGuidance";
import { computerGuidanceFits, multiAgentGuidanceFits } from "./runGuidanceWiring";

/*
 * Integration of mid-run guidance (steer) with the Pro 多 Agent 协作 run and
 * the unified computer executor, through the real createNodeAi wiring. Only
 * the provider / Jev transport is an in-process fixture.
 */

const KEY = "guidance-wiring-fixture-not-a-real-key";
const JEV_KEY = "guidance-wiring-jev-fixture-not-real";
const encoder = new TextEncoder();

function userText(body: Record<string, unknown>): string {
  const turns = (body.input ?? body.messages) as Array<{ role: string; content: unknown }>;
  return turns.filter(turn => turn.role === "user").map(turn => typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content)).join("\n");
}

function responsesStream(text: string, hold?: Promise<void>): Response {
  const frame = (event: object) => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(frame({ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }));
      if (hold) await hold;
      controller.enqueue(frame({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 },
        output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } }));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("mid-run guidance wiring", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  let transport: AiTransport;
  const bind: AiTransport = (url, init) => transport(url, init);

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-guidance-wiring-"));
    runtime = await createNodeAi(path.join(directory, "fixture.json"), bind);
    runtime.service.setQuota("member", "admin", { limitTokens: 1_000_000 });
    runtime.service.setQuota("other", "admin", { limitTokens: 1_000_000 });
  });
  afterEach(async () => {
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("takes only the oldest items a step can carry whole and leaves the rest pending", () => {
    const requestId = crypto.randomUUID();
    runtime.store.saveRequest({ requestId, userId: "member", hash: "fixture", status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
      inputReserve: 1, outputReserve: 1, kind: "chat", model: "fixture", mode: "quick" });
    ["一", "二二", "三三三"].forEach((text, index) => submitRunGuidance(runtime.store, "member", requestId, { id: `guidance-fits-0000${index}`, text }));
    expect(takePendingGuidance(runtime.store, "member", requestId, { fits: texts => texts.join("").length <= 3 }).map(item => item.text)).toEqual(["一", "二二"]);
    expect(listRunGuidance(runtime.store, "member", requestId).guidance.map(item => item.status)).toEqual(["delivered", "delivered", "pending"]);
    // An item that does not fit is never cut short or skipped over: it waits.
    expect(takePendingGuidance(runtime.store, "member", requestId, { fits: () => false })).toEqual([]);
    expect(takePendingGuidance(runtime.store, "member", requestId).map(item => item.text)).toEqual(["三三三"]);
  });

  it("bounds each loop to what it can inject", () => {
    expect(multiAgentGuidanceFits(["a", "b", "c"])).toBe(true);
    expect(multiAgentGuidanceFits(["a", "b", "c", "d"])).toBe(false);
    expect(multiAgentGuidanceFits(["字".repeat(600)])).toBe(true);
    expect(multiAgentGuidanceFits(["字".repeat(300), "字".repeat(301)])).toBe(false);
    expect(computerGuidanceFits(["字".repeat(300), "b", "c"])).toBe(true);
    expect(computerGuidanceFits(["字".repeat(301)])).toBe(false);
    expect(computerGuidanceFits(["a", "b", "c", "d"])).toBe(false);
  });

  describe("Pro 多 Agent 协作", () => {
    const gates: Array<() => void> = [];
    const calls: Array<{ role: string; user: string }> = [];

    beforeEach(async () => {
      gates.length = 0; calls.length = 0;
      transport = async (url, init: AiTransportInit) => {
        if (url.endsWith("/models")) return Response.json({ data: ["q-fast", "p-pro"].map(id => ({ id })) });
        const body = JSON.parse(init.body!) as Record<string, unknown>;
        const instructions = String(body.instructions ?? "");
        const role = instructions.includes("【多 Agent 协作 · 协调者】") ? "coordinator" : instructions.includes("【多 Agent 协作 · 子 Agent】") ? "subagent"
          : instructions.includes("【多 Agent 协作 · 结果综合】") ? "synthesis" : "other";
        calls.push({ role, user: userText(body) });
        if (role === "coordinator") return responsesStream(JSON.stringify({ subtasks: [1, 2].map(index => ({ role: "研究员", title: `方面${index}`, task: `请只分析方案的第 ${index} 个方面。`, search: false })) }));
        if (role === "subagent") return responsesStream("摘要：已完成。\n\n- 依据", new Promise<void>(resolve => gates.push(resolve)));
        return responsesStream("综合回答");
      };
      const route = (modelId: string) => ({ providerId: "primary", modelId, protocol: "responses" as const, maxOutputTokens: 2048, reasoningEffort: "" as const, capabilities: ["chat" as const], enabled: true });
      const harness: AiHarnessInput = {
        providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "responses", apiKey: KEY, enabled: true }],
        tiers: { quick: route("q-fast"), standard: route("q-fast"), deep: route("p-pro"), pro: { ...route("p-pro"), multiAgent: { maxConcurrency: 2, subAgentMaxOutputTokens: 512 } } },
        policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: false },
      };
      await runtime.service.saveHarness(harness);
      await runtime.service.discoverHarnessProvider("primary");
      calls.length = 0;
    });

    it("accepts guidance while the run works and hands the items that fit to the synthesis step", async () => {
      const request: AiChatRequest = { requestId: crypto.randomUUID(), conversationId: "conversation-pro", mode: "pro", outputFormat: "text", messages: [{ role: "user", content: "比较方案 A 和方案 B" }] };
      const preflight = runtime.service.preflight("member", request);
      const pending = runtime.service.chat("member", { ...request, subagentEvents: true }, { stream: true, onEvent: () => undefined });
      await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(2));
      // The run's harness record is "running", so the route treats the request as an active target.
      const items = ["改用表格对比", "重点看成本", "长".repeat(595), "最后一条"];
      items.forEach((text, index) => expect(submitRunGuidance(runtime.store, "member", request.requestId, { id: `guidance-multi-000${index}`, text })).toMatchObject({ created: true }));
      expect(() => submitRunGuidance(runtime.store, "other", request.requestId, { id: "guidance-multi-other", text: "越权" })).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_FOUND" }));
      for (const release of gates) release();
      const response = await pending;
      expect(response.content).toBe("综合回答");
      const synthesis = calls.find(call => call.role === "synthesis")!;
      expect(synthesis.user).toContain('"guidance":["改用表格对比","重点看成本"]');
      expect(synthesis.user).not.toContain("最后一条");
      // What the checkpoint could not carry whole stays pending for the steer client's follow-up turn.
      expect(listRunGuidance(runtime.store, "member", request.requestId).guidance.map(item => item.status)).toEqual(["delivered", "delivered", "pending", "pending"]);
      expect(cancelRunGuidance(runtime.store, "member", request.requestId, "guidance-multi-0002").guidance.status).toBe("cancelled");
      expect(() => submitRunGuidance(runtime.store, "member", request.requestId, { id: "guidance-multi-late", text: "晚了" })).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
      // The registered hook reserves the guidance allowance in preflight and send alike.
      expect(runtime.service.quota("member").reservedTokens).toBe(0);
      expect(response.usage.totalTokens).toBeLessThanOrEqual(preflight.budget!.minimumRequiredTokens);
    });
  });

  describe("unified computer executor", () => {
    const TASK = {
      kind: "computer_task",
      goal: "在微信中给联系人「姐姐」发送消息「中秋快乐」",
      apps: [{ name: "微信", bundleId: "com.tencent.xinWeChat" }],
      parameters: [{ id: "p1", role: "recipient", label: "联系人", value: "姐姐" }, { id: "p2", role: "message", label: "消息内容", value: "中秋快乐" }],
      successCheck: "与「姐姐」的聊天记录中出现刚发送的「中秋快乐」",
      irreversible: { kind: "send_message", summary: "发送消息给「姐姐」：中秋快乐", recipient: "姐姐", content: "中秋快乐" },
      actionKinds: ["activate_app", "click", "type", "key", "scroll"],
    };
    const jevBodies: Array<{ state: { user_guidance: string[] } }> = [];
    const decision = (step: number): ComputerDecisionRequest => ({
      step, observationId: `obs_wiring_000${step}`,
      observation: { trust: "untrusted_screen_content", app: "微信", windowTitle: "微信", axSparse: false, elementsTotal: 1, elements: [{ ref: "e1", role: "text_area", label: "搜索", editable: true, searchBox: true }], texts: ["姐姐"] },
      candidates: [
        { id: "open_search", description: "Press Command+F in the 微信 window to focus its search box.", risk: "none" },
        { id: "reobserve", description: "Do not act; take a fresh observation.", risk: "none" },
        { id: "abstain", description: "Stop without acting.", risk: "none" },
        { id: "done", description: "Stop because the goal is achieved.", risk: "none" },
      ],
      facts: { focus: "none", irreversibleDone: false }, history: [], guidance: ["用搜索找她"],
    });

    beforeEach(async () => {
      jevBodies.length = 0;
      transport = async (url, init) => {
        if (url === "https://gateway.example.com/v1/models") return Response.json({ data: ["q-fast", "d-deep"].map(id => ({ id })) });
        if (url === "https://gateway.example.com/v1/chat/completions") return Response.json({ choices: [{ message: { content: JSON.stringify(TASK) } }], usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } });
        if (url === "https://api.typesafe.ai/v1/systemone") {
          const body = JSON.parse(init.body!) as { state: { user_guidance: string[] }; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
          jevBodies.push(body);
          const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === "choice"
            ? { type: "choice", choice: "open_search", confidence: 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria!).map(option => [option, option === "open_search" ? 1 : 0])) }
            : { type: "noul", noul: 0.1 }]));
          return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 2000, output_tokens: 40 } });
        }
        throw new Error(`unexpected ${url}`);
      };
      const route = (modelId: string, capabilities: AiHarnessCapability[]) => ({ providerId: "primary", modelId, protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities, enabled: true });
      await runtime.service.saveHarness({
        providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey: KEY, enabled: true }],
        tiers: { quick: route("q-fast", ["chat"]), standard: route("q-fast", ["chat"]), deep: route("d-deep", ["chat", "computer"]), pro: route("d-deep", ["chat", "computer"]) },
        policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
      });
      await runtime.service.discoverHarnessProvider("primary");
      await runtime.service.computer.saveSettings({ enabled: true, apiKey: JEV_KEY, inputPointsPer1k: 500, outputPointsPer1k: 1000, maxSteps: 4, maxMinutes: 6, minConfidence: 0.5 });
    });

    it("accepts guidance for a live run and adds what fits to the next Jev decision", async () => {
      const created = await runtime.service.computer.createTask("member", { requestId: crypto.randomUUID(), mode: "deep", conversationId: "conversation-computer", instruction: "给姐姐发一个中秋快乐" });
      if (created.kind !== "run") throw new Error("expected run");
      const runId = created.run.runId;
      expect(submitRunGuidance(runtime.store, "member", runId, { id: "guidance-computer-0001", text: "联系人备注是“姐姐（家）”" })).toMatchObject({ created: true, guidance: { status: "pending" } });
      expect(submitRunGuidance(runtime.store, "member", runId, { id: "guidance-computer-0002", text: "长".repeat(301) })).toMatchObject({ created: true });
      expect(() => submitRunGuidance(runtime.store, "other", runId, { id: "guidance-computer-0003", text: "越权" })).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_FOUND" }));
      expect(() => submitRunGuidance(runtime.store, "member", `cr_${"0".repeat(32)}`, { id: "guidance-computer-0004", text: "不存在" })).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_FOUND" }));

      await runtime.service.computer.decide("member", runId, decision(1));
      expect(jevBodies[0].state.user_guidance).toEqual(["用搜索找她", "联系人备注是“姐姐（家）”"]);
      // The over-long item is never cut to 300 characters; it waits (and later becomes the follow-up turn).
      expect(listRunGuidance(runtime.store, "member", runId).guidance.map(item => item.status)).toEqual(["delivered", "pending"]);
      await runtime.service.computer.decide("member", runId, decision(2));
      expect(jevBodies[1].state.user_guidance).toEqual(["用搜索找她"]);

      // Past the run's time budget, and after it finishes, the run no longer takes guidance.
      const late = Date.now() + 8 * 60_000;
      expect(() => submitRunGuidance(runtime.store, "member", runId, { id: "guidance-computer-0005", text: "太晚了" }, late)).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
      runtime.service.computer.finish("member", runId, { outcome: "abstained", reason: "user_stopped", summary: "已停止。" });
      expect(() => submitRunGuidance(runtime.store, "member", runId, { id: "guidance-computer-0006", text: "结束了" })).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_ACTIVE" }));
    });
  });
});
