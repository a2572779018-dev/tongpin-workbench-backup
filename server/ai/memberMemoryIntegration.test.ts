import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiHarnessCapability, AiHarnessInput } from "../../shared/ai";
import { MEMBER_MEMORY_REVIEW_INSTRUCTIONS } from "./memberMemoryPrompt";
import { memberMemoryRuntime } from "./memberMemoryService";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";

/*
 * Member memory (Hermes-style learning loop) meeting the two chat paths that
 * were built beside it: the Pro 多 Agent 协作 run, which returns before the
 * ordinary path, and the unified computer executor's task-spec call.
 */

const TASK = {
  kind: "computer_task",
  goal: "在微信中给联系人「姐姐」发送消息「中秋快乐」",
  apps: [{ name: "微信", bundleId: "com.tencent.xinWeChat" }],
  parameters: [{ id: "p1", role: "recipient", label: "联系人", value: "姐姐" }, { id: "p2", role: "message", label: "消息内容", value: "中秋快乐" }],
  successCheck: "与「姐姐」的聊天记录中出现刚发送的「中秋快乐」",
  irreversible: { kind: "send_message", summary: "发送消息给「姐姐」：中秋快乐", recipient: "姐姐", content: "中秋快乐" },
  actionKinds: ["activate_app", "click", "type", "key", "scroll"],
};
const encoder = new TextEncoder();

function responsesStream(text: string): Response {
  const events = [
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 }, output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } },
  ];
  return new Response(encoder.encode(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")), { headers: { "content-type": "text/event-stream" } });
}

describe("member memory with the multi-agent and computer paths", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const instructions: Array<{ role: string; text: string }> = [];
  let reviews = 0;

  const transport: AiTransport = async (url, init) => {
    if (url.endsWith("/models")) return Response.json({ data: ["q-fast", "d-deep", "p-pro"].map(id => ({ id })) });
    const body = JSON.parse(init.body!) as { instructions?: string; messages?: Array<{ role: string; content: string }> };
    if (url.startsWith("https://resp.example.com/")) {
      const text = String(body.instructions ?? "");
      const role = text.includes("【多 Agent 协作 · 协调者】") ? "coordinator" : text.includes("【多 Agent 协作 · 子 Agent】") ? "subagent" : text.includes("【多 Agent 协作 · 结果综合】") ? "synthesis" : "other";
      instructions.push({ role, text });
      if (role === "coordinator") return responsesStream(JSON.stringify({ subtasks: [1, 2].map(index => ({ role: "研究员", title: `方面${index}`, task: `请只分析方案的第 ${index} 个方面。`, search: false })) }));
      if (role === "subagent") return responsesStream("摘要：已完成。\n\n- 依据");
      return responsesStream("综合回答：方案 A 更适合。");
    }
    const system = String(body.messages?.[0]?.content ?? "");
    if (system === MEMBER_MEMORY_REVIEW_INSTRUCTIONS) {
      reviews += 1;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ operations: [] }) } }], usage: { prompt_tokens: 800, completion_tokens: 40, total_tokens: 840 } });
    }
    const computer = system.includes("电脑操作任务整理器");
    instructions.push({ role: computer ? "computer_task" : "chat", text: system });
    return Response.json({ choices: [{ message: { content: computer ? JSON.stringify(TASK) : "好的。" } }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-memory-integration-"));
    instructions.length = 0; reviews = 0;
    memberMemoryRuntime.startImmediately = true;
    runtime = await createNodeAi(path.join(directory, "db.json"), transport, () => true);
    const route = (providerId: "resp" | "cc", modelId: string, capabilities: AiHarnessCapability[] = ["chat"]) => ({
      providerId, modelId, protocol: providerId === "resp" ? "responses" as const : "chat_completions" as const, maxOutputTokens: 2048, reasoningEffort: "" as const, capabilities, enabled: true });
    const harness: AiHarnessInput = {
      providers: [
        { id: "resp", name: "Responses", baseUrl: "https://resp.example.com/v1", protocol: "responses", apiKey: "memory-integration-resp-not-real", enabled: true },
        { id: "cc", name: "Chat", baseUrl: "https://cc.example.com/v1", protocol: "chat_completions", apiKey: "memory-integration-cc-not-real", enabled: true },
      ],
      tiers: { quick: route("cc", "q-fast"), standard: route("cc", "q-fast"), deep: route("cc", "d-deep", ["chat", "computer"]),
        pro: { ...route("resp", "p-pro"), multiAgent: { maxConcurrency: 2, subAgentMaxOutputTokens: 512 } } },
      policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: false },
    };
    await runtime.service.saveHarness(harness);
    await runtime.service.discoverHarnessProvider("resp");
    await runtime.service.discoverHarnessProvider("cc");
    runtime.service.setQuota("member", "admin", { limitTokens: 1_000_000 });
    const memory = runtime.service.memberMemory;
    memory.saveAdminSettings({ enabled: true, reviewTier: "quick", pricePoints: 50 });
    memory.updateEntry("member", { expectedRevision: memory.state("member").revision, operation: { action: "add", target: "user", content: "成员偏好先给结论再展开" } });
    instructions.length = 0;
  });
  afterEach(async () => {
    await memberMemoryRuntime.idle();
    runtime.close();
    await rm(directory, { recursive: true });
  });

  it("reads memory into a Pro multi-agent run and reviews its reply like an ordinary one", async () => {
    const response = await runtime.service.chat("member", { requestId: crypto.randomUUID(), conversationId: "conv-pro", mode: "pro", outputFormat: "text",
      messages: [{ role: "user", content: "记住：以后比较方案都先给结论。请比较方案 A 和方案 B" }] });
    expect(response.content).toBe("综合回答：方案 A 更适合。");
    expect(instructions.map(item => item.role)).toEqual(["coordinator", "subagent", "subagent", "synthesis"]);
    for (const role of ["coordinator", "synthesis"]) expect(instructions.find(item => item.role === role)!.text).toContain("成员偏好先给结论再展开");
    await memberMemoryRuntime.idle();
    expect(reviews).toBe(1);
    expect(runtime.service.memberMemory.reviewStatuses("member", [response.requestId])[0].status).toBe("unchanged");
  });

  it("keeps member memory out of the computer task spec, as it does for the legacy computer plan", async () => {
    await runtime.service.computer.saveSettings({ enabled: true, apiKey: "memory-integration-jev-not-real", inputPointsPer1k: 500, outputPointsPer1k: 1000, maxSteps: 4, maxMinutes: 6, minConfidence: 0.5 });
    const created = await runtime.service.computer.createTask("member", { requestId: crypto.randomUUID(), mode: "deep", conversationId: "conv-computer", instruction: "给姐姐发一个中秋快乐" });
    expect(created.kind).toBe("run");
    await runtime.service.chat("member", { requestId: crypto.randomUUID(), conversationId: "conv-chat", mode: "deep", messages: [{ role: "user", content: "写一段周报开头" }] });
    expect(instructions.find(item => item.role === "computer_task")!.text).not.toContain("<member_memory");
    expect(instructions.find(item => item.role === "chat")!.text).toContain("成员偏好先给结论再展开");
    await memberMemoryRuntime.idle();
  });
});
