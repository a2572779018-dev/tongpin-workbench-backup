import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessCapability, AiHarnessInput, AiMode } from "../../shared/ai";
import { createNodeAi } from "./node";
import { parseHarnessContinuationDecision } from "./harness";
import type { AiTransport } from "./provider";

const MODELS = ["q-fast", "s-standard", "d-deep", "p-pro", "image-model", "minimax_h3", "sd-2-c6"];
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function harnessInput(apiKey = "harness-secret-never-return-me", strategy: AiHarnessInput["policy"]["strategy"] = "plan_execute", maxToolSteps = 3): AiHarnessInput {
  const route = (modelId: string, reasoningEffort: "" | "low" | "medium" | "high") => ({
    providerId: "primary",
    modelId,
    protocol: "chat_completions" as const,
    maxOutputTokens: 1024,
    reasoningEffort,
    capabilities: ["chat", "vision", "image", "video", "presentation", "computer"] as AiHarnessCapability[],
    imageProviderId: "primary",
    imageModelId: "image-model",
    videoProviderId: "primary",
    videoModelId: "minimax_h3",
    enabled: true,
  });
  return {
    providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey, enabled: true }],
    tiers: {
      quick: route("q-fast", ""),
      standard: route("s-standard", "low"),
      deep: route("d-deep", "medium"),
      pro: route("p-pro", "high"),
    },
    policy: { strategy, maxToolSteps, requireApproval: true, autoWebSearch: false },
  };
}

const complete = (content = "完成") => Response.json({
  choices: [{ message: { content } }],
  usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
});

describe("AI Harness", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  let backgroundPrincipalActive: boolean;
  const transport = vi.fn<AiTransport>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-harness-"));
    backgroundPrincipalActive = true;
    transport.mockReset();
    transport.mockImplementation(async target => target.endsWith("/models")
      ? Response.json({ data: MODELS.map(id => ({ id })) })
      : complete());
    runtime = await createNodeAi(path.join(directory, "test.json"), transport, (tenantId, userId) =>
      backgroundPrincipalActive && tenantId === "tenant-background" && userId === "member",
    );
  });

  afterEach(async () => {
    runtime.close();
    await rm(directory, { recursive: true });
  });

  async function configure() {
    const saved = await runtime.service.saveHarness(harnessInput());
    expect(JSON.stringify(saved)).not.toContain("harness-secret-never-return-me");
    expect(saved.providers[0]).toMatchObject({ apiKeyConfigured: true, modelsVerified: false, availableModels: [] });
    const discovery = await runtime.service.discoverHarnessProvider("primary");
    expect(discovery.models).toEqual(MODELS.slice().sort());
    return discovery;
  }

  it("encrypts provider keys, binds /models discovery to the saved key/config, and never exposes provider model IDs to members", async () => {
    await configure();
    const disk = await readFile(path.join(directory, "test.json.ai.sqlite"));
    expect(disk.includes(Buffer.from("harness-secret-never-return-me"))).toBe(false);
    expect(transport.mock.calls[0][0]).toBe("https://gateway.example.com/v1/models");
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer harness-secret-never-return-me");

    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    const status = runtime.service.status("member");
    expect(status).toMatchObject({ configured: true, quickModel: "quick", deepModel: "deep", availableTiers: ["quick", "standard", "deep", "pro"] });
    expect(JSON.stringify(status)).not.toMatch(/q-fast|s-standard|d-deep|p-pro|Primary/);

    const response = await runtime.service.chat("member", {
      requestId: crypto.randomUUID(), conversationId: "conversation-quick", mode: "quick", messages: [{ role: "user", content: "你好" }],
    });
    expect(response.model).toBe("快速");
    expect(JSON.parse(transport.mock.calls[1][1].body!).model).toBe("q-fast");
    expect(runtime.store.usage("member").find(entry => entry.kind === "chat")?.model).toBe("q-fast");
    expect(runtime.service.memberUsage("member").find(entry => entry.kind === "chat")?.model).toBe("快速");
  });

  it.each([
    ["quick", "q-fast", "快速"],
    ["standard", "s-standard", "标准"],
    ["deep", "d-deep", "深度"],
    ["pro", "p-pro", "Pro"],
  ] as const)("translates %s only on the server", async (tier: AiMode, providerModel, label) => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
    const response = await runtime.service.chat("member", {
      requestId: crypto.randomUUID(), conversationId: `conversation-${tier}`, mode: tier, messages: [{ role: "user", content: "处理任务" }],
    });
    expect(response.model).toBe(label);
    expect(JSON.parse(transport.mock.calls[1][1].body!).model).toBe(providerModel);
    expect(JSON.stringify(response)).not.toContain(providerModel);
  });

  it("keeps image/video bindings admin-only and fails closed on an unsupported paid video protocol", async () => {
    await configure();
    const image = runtime.service.harness.resolveMedia("standard", runtime.store.provider(), "image");
    expect(image).toMatchObject({ tier: "standard", providerId: "primary", modelId: "image-model", baseUrl: "https://gateway.example.com/v1" });
    expect(() => runtime.service.harness.resolveMedia("standard", runtime.store.provider(), "video"))
      .toThrow(expect.objectContaining({ code: "AI_VIDEO_PROTOCOL_UNSUPPORTED" }));
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    expect(JSON.stringify(runtime.service.status("member"))).not.toMatch(/image-model|minimax_h3|gateway\.example/);
  });

  it("returns the server-authorized video model consistently across initial, replay and recovery responses", async () => {
    const input = harnessInput();
    input.providers[0].baseUrl = "https://www.75api.com/v1";
    await runtime.service.saveHarness(input);
    await runtime.service.discoverHarnessProvider("primary");
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "video", summary: "生成品牌短片", prompt: "蓝色科技品牌短片" })));
    const request = {
      requestId: crypto.randomUUID(), conversationId: "media-route-video", mode: "standard" as const, outputFormat: "video_plan" as const,
      messages: [{ role: "user" as const, content: "生成一段品牌短片" }],
      videoParameters: { seconds: 15, resolution: "768p", aspectRatio: "16:9" as const, referenceCount: 0, referenceFingerprints: [] },
    };

    const first = await runtime.service.chat("member", request);
    expect(first.toolPlan?.videoParameters?.model).toBe("minimax_h3");
    expect(runtime.store.request("member", request.requestId)?.result?.toolPlan?.videoParameters?.model).toBe("minimax_h3");

    const replay = await runtime.service.chat("member", request);
    const recovered = runtime.service.getRequestResult("member", request.requestId);
    expect(replay.toolPlan?.videoParameters?.model).toBe("minimax_h3");
    expect(recovered.result?.toolPlan?.videoParameters?.model).toBe("minimax_h3");
  });

  it("accepts an explicit local video model only when the selected tier provider verified it", async () => {
    const input = harnessInput();
    input.providers[0].baseUrl = "https://www.75api.com/v1";
    await runtime.service.saveHarness(input);
    await runtime.service.discoverHarnessProvider("primary");
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "video", summary: "SD 2.0 短片", prompt: "蓝色科技短片" })));
    const selected = {
      requestId: crypto.randomUUID(), conversationId: "media-route-video-selected", mode: "standard" as const, outputFormat: "video_plan" as const,
      messages: [{ role: "user" as const, content: "生成 SD 2.0 短片" }],
      videoParameters: { model: "sd-2-c6" as const, seconds: 15, resolution: "720p" as const, aspectRatio: "16:9" as const, referenceCount: 0, referenceFingerprints: [] },
    };
    expect((await runtime.service.chat("member", selected)).toolPlan?.videoParameters?.model).toBe("sd-2-c6");

    const unverified = { ...selected, requestId: crypto.randomUUID(), videoParameters: { ...selected.videoParameters, model: "sd-2.5-c1" as const, seconds: 30 } };
    const calls = transport.mock.calls.length;
    await expect(runtime.service.chat("member", unverified)).rejects.toMatchObject({ code: "AI_VIDEO_MODEL_NOT_AUTHORIZED" });
    expect(transport).toHaveBeenCalledTimes(calls);
  });

  it("executes image generation through the approved business-tier media binding", async () => {
    await runtime.service.saveProvider({
      name: "Legacy quota settings", baseUrl: "https://legacy.example.com/v1", protocol: "chat_completions",
      apiKey: "legacy-key", quickModel: "legacy-quick", deepModel: "legacy-deep", maxOutputTokens: 1024,
      reasoningEffort: "", enabled: true, imageModel: "legacy-image", imageQuotaTokens: 1000,
    });
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "绘制海报", prompt: "蓝色科技海报" })));
    const plan = await runtime.service.chat("member", {
      requestId: crypto.randomUUID(), conversationId: "media-route-image", mode: "standard", outputFormat: "image_plan",
      messages: [{ role: "user", content: "生成一张蓝色科技海报" }],
    });
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const image = await runtime.service.generateImage("member", {
      requestId: crypto.randomUUID(), conversationId: "media-route-image", prompt: plan.toolPlan!.prompt, planRequestId: plan.requestId,
    });
    expect(image.model).toBe("图片生成");
    const [url, init] = transport.mock.calls.at(-1)!;
    expect(url).toBe("https://gateway.example.com/v1/images/generations");
    expect(init.headers.Authorization).toBe("Bearer harness-secret-never-return-me");
    expect(JSON.parse(init.body!)).toMatchObject({ model: "image-model", prompt: "蓝色科技海报" });
    expect(runtime.store.usage("member").find(entry => entry.kind === "image")).toMatchObject({ mode: "standard", model: "image-model" });
  });

  it("invalidates model verification after a config or key change", async () => {
    await configure();
    const changed = harnessInput("");
    changed.providers[0].name = "Renamed";
    const saved = await runtime.service.saveHarness(changed);
    expect(saved.providers[0]).toMatchObject({ modelsVerified: false, availableModels: [] });
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    expect(() => runtime.service.preflight("member", {
      requestId: crypto.randomUUID(), conversationId: "unverified", mode: "quick", messages: [{ role: "user", content: "你好" }],
    })).toThrow(expect.objectContaining({ code: "AI_HARNESS_MODEL_UNVERIFIED" }));
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("persists concise member-safe reasoning and approval lifecycle without prompts or private chain-of-thought", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "生成一张海报", prompt: "蓝色科技海报" })));
    const requestId = crypto.randomUUID();
    const response = await runtime.service.chat("member", {
      requestId, conversationId: "image-plan", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "请调用工具，内部敏感提示不要展示" }],
    });
    expect(response.trace).toMatchObject({ strategy: "plan_execute", status: "waiting_approval", nextAction: "approve_tool", toolBudget: { used: 1, max: 3, remaining: 2 }, reasoningSummary: expect.stringContaining("等待你的明确确认") });
    expect(response.trace?.steps.map(step => step.kind)).toEqual(expect.arrayContaining(["strategy", "plan", "model", "tool", "approval"]));
    expect(response.trace?.steps.map(step => step.status)).toContain("waiting_approval");
    const serialized = JSON.stringify(runtime.service.harnessTrace("member", requestId));
    expect(serialized).not.toContain("内部敏感提示不要展示");
    expect(serialized).not.toContain("蓝色科技海报");
    expect(serialized).not.toContain("完成已校验计划：生成一张海报");
    expect(() => runtime.service.harnessTrace("other-member", requestId)).toThrow(expect.objectContaining({ code: "AI_RUN_NOT_FOUND" }));
    expect(runtime.service.cancelHarnessRun("member", requestId)).toMatchObject({ status: "cancelled" });
  });

  it("gives direct, react, and plan-execute distinct persisted state graphs", async () => {
    for (const strategy of ["direct", "react", "plan_execute"] as const) {
      await runtime.service.saveHarness(harnessInput(strategy === "direct" ? "direct-key" : "", strategy, 3));
      await runtime.service.discoverHarnessProvider("primary");
      runtime.service.setQuota(`member-${strategy}`, "admin", { limitTokens: 20_000 });
      transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: `${strategy} 安全摘要`, prompt: `${strategy} private prompt` })));
      const requestId = crypto.randomUUID();
      const response = await runtime.service.chat(`member-${strategy}`, {
        requestId, conversationId: `strategy-${strategy}`, mode: "quick", outputFormat: "image_plan",
        messages: [{ role: "user", content: `${strategy} sensitive request` }],
      });
      expect(response.trace?.strategy).toBe(strategy);
      expect(response.trace?.toolBudget.max).toBe(strategy === "direct" ? 1 : 3);
      expect(response.trace?.steps.some(step => step.kind === "plan")).toBe(strategy === "plan_execute");
      expect(response.trace?.steps.find(step => step.kind === "model")?.title).toBe(strategy === "react" ? "判断下一步" : "模型响应");
      expect(JSON.stringify(response.trace)).not.toContain("private prompt");
      expect(JSON.stringify(response.trace)).not.toContain("sensitive request");
    }
  });

  it("snapshots an invoked Hub and never marks unexecuted nodes as completed", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", {
      requestId, conversationId: "workflow-template", mode: "quick", workflowId: "hub-research-brief",
      messages: [{ role: "user", content: "整理这份研究简报" }],
    });
    const trace = runtime.service.harnessTrace("member", requestId);
    const workflow = trace.steps.filter(step => step.kind === "workflow");
    expect(workflow.map(step => ({ title: step.title, workflowId: step.workflowId, version: step.workflowVersion, status: step.status }))).toEqual([
      { title: "1. 界定问题", workflowId: "hub-research-brief", version: 1, status: "succeeded" },
      { title: "2. 整理证据", workflowId: "hub-research-brief", version: 1, status: "planned" },
      { title: "3. 形成简报", workflowId: "hub-research-brief", version: 1, status: "planned" },
    ]);
    expect(workflow.slice(1).every(step => !step.summary.includes("已完成"))).toBe(true);
    expect(JSON.parse(transport.mock.calls.at(-1)![1].body!).messages[0].content).toContain("研究简报 Hub");
    runtime.close();
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    expect(runtime.service.harnessTrace("member", requestId).steps.filter(step => step.kind === "workflow")).toEqual(workflow);
  });

  it("advances one Hub node only when its corresponding phase really completes", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "生成简报封面", prompt: "private prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", {
      requestId, conversationId: "workflow-progress", mode: "quick", workflowId: "hub-research-brief", outputFormat: "image_plan",
      messages: [{ role: "user", content: "private original request" }],
    });
    const statuses = () => runtime.service.harnessTrace("member", requestId).steps.filter(step => step.kind === "workflow").map(step => step.status);
    expect(statuses()).toEqual(["succeeded", "running", "planned"]);

    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    expect(statuses()).toEqual(["succeeded", "succeeded", "running"]);

    transport.mockResolvedValueOnce(complete('{"action":"complete","summary":"简报已完成"}'));
    await runtime.service.resumeHarnessRun("member", requestId);
    expect(statuses()).toEqual(["succeeded", "succeeded", "succeeded"]);
  });

  it("persists bounded multi-step proposals and makes one-time approval/resolution idempotent", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "先生成视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", {
      requestId, conversationId: "bounded-plan", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "内部需求原文" }],
    });

    const firstExecution = crypto.randomUUID();
    const first = runtime.service.harness.beginApprovedTool("member", requestId, "image", firstExecution);
    expect(first).toMatchObject({ status: "running", nextAction: "poll" });
    expect(runtime.service.harness.beginApprovedTool("member", requestId, "image", firstExecution)).toEqual(first);
    expect(() => runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID())).toThrow(expect.objectContaining({ code: "AI_TOOL_APPROVAL_CONSUMED" }));
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");

    runtime.service.harness.proposeNextTool("member", requestId, "video", "再生成一段短视频");
    runtime.service.harness.beginApprovedTool("member", requestId, "video", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "video", "succeeded");
    runtime.service.harness.proposeNextTool("member", requestId, "presentation", "最后整理演示文稿");
    runtime.service.harness.beginApprovedTool("member", requestId, "presentation", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "presentation", "succeeded");

    const trace = runtime.service.harnessTrace("member", requestId);
    expect(trace).toMatchObject({ strategy: "plan_execute", status: "succeeded", nextAction: "none", toolBudget: { used: 3, max: 3, remaining: 0 } });
    expect(trace.steps.filter(step => step.kind === "tool")).toHaveLength(3);
    expect(trace.steps.filter(step => step.kind === "approval")).toHaveLength(3);
    expect(trace.steps.filter(step => step.kind === "result")).toHaveLength(3);
    expect(trace.steps.find(step => step.kind === "tool")?.executionRequestId).toBe(firstExecution);
    expect(() => runtime.service.harness.proposeNextTool("member", requestId, "computer", "不应进入第四步")).toThrow(expect.objectContaining({ code: "AI_TOOL_STEP_LIMIT" }));
    expect(JSON.stringify(trace)).not.toMatch(/private image prompt|内部需求原文/);
  });

  it("binds repeated proposals for the same capability to the newest approval", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "第一张", prompt: "first" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "same-tool-twice", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "生成两版图片" }] });
    const firstExecution = crypto.randomUUID();
    runtime.service.harness.beginApprovedTool("member", requestId, "image", firstExecution);
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    runtime.service.harness.proposeNextTool("member", requestId, "image", "第二张");
    const secondExecution = crypto.randomUUID();
    runtime.service.harness.beginApprovedTool("member", requestId, "image", secondExecution);
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    expect(runtime.service.harnessTrace("member", requestId).steps.filter(step => step.kind === "tool").map(step => ({ status: step.status, executionRequestId: step.executionRequestId }))).toEqual([
      { status: "succeeded", executionRequestId: firstExecution },
      { status: "succeeded", executionRequestId: secondExecution },
    ]);
  });

  it("uses a persisted, quota-accounted model decision to resume a production run exactly once", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "先生成视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", {
      requestId, conversationId: "autonomous-resume", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "private original request" }],
    });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    expect(runtime.service.harnessTrace("member", requestId)).toMatchObject({ status: "planned", nextAction: "resume" });
    expect(runtime.service.harness.decisionContext("member", requestId)).toMatchObject({
      goal: { kind: "image", summary: "完成已校验计划：先生成视觉草图" },
      results: [{ sequence: 1, capability: "image", summary: expect.stringContaining("完整性校验") }],
    });

    runtime.close();
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    expect(runtime.service.harnessTrace("member", requestId)).toMatchObject({ status: "planned", nextAction: "resume" });

    transport.mockResolvedValueOnce(complete('{"action":"complete","summary":"已完成受限任务"}'));
    const calls = transport.mock.calls.length;
    const resumed = await runtime.service.resumeHarnessRun("member", requestId);
    expect(resumed).toMatchObject({ status: "succeeded", nextAction: "none", reasoningSummary: "已完成受限任务" });
    expect(transport).toHaveBeenCalledTimes(calls + 1);
    const decisionBody = JSON.stringify(JSON.parse(transport.mock.calls.at(-1)![1].body!));
    expect(decisionBody).toContain("受限代理决策");
    expect(decisionBody).toContain('\\"action\\":\\"complete\\"');
    expect(decisionBody).toContain("完成已校验计划：先生成视觉草图");
    expect(decisionBody).toContain("图片生成结果已通过完整性校验并保存");
    expect(decisionBody).not.toMatch(/private original request|private image prompt|chain.of.thought|思维链/iu);
    expect(runtime.store.usage("member").filter(entry => entry.kind === "chat")).toHaveLength(2);

    expect(await runtime.service.resumeHarnessRun("member", requestId)).toEqual(resumed);
    expect(transport).toHaveBeenCalledTimes(calls + 1);
  });

  it("continues a planned tenant run from the server background cycle without executing the next tool", async () => {
    const tenantService = runtime.service.forTenant("tenant-background");
    await tenantService.saveHarness(harnessInput());
    await tenantService.discoverHarnessProvider("primary");
    tenantService.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "生成视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await tenantService.chat("member", {
      requestId, conversationId: "background-resume", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "生成一张视觉草图" }],
    });
    tenantService.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    tenantService.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    expect(tenantService.harnessTrace("member", requestId)).toMatchObject({ status: "planned", nextAction: "resume" });

    transport.mockResolvedValueOnce(complete('{"action":"tool","capability":"video","summary":"建议制作一段短视频"}'));
    const cycle = await runtime.service.runBackgroundAgentCycle(4);
    expect(cycle).toMatchObject({ scanned: 1, resumed: 1, completed: 0, waitingApproval: 1, failed: 0 });
    const trace = tenantService.harnessTrace("member", requestId);
    expect(trace).toMatchObject({ status: "waiting_approval", nextAction: "approve_tool" });
    expect(trace.steps.filter(step => step.kind === "tool").at(-1)).toMatchObject({ capability: "video", status: "waiting_approval", requiresApproval: true });
    expect(transport.mock.calls.some(([url]) => /\/videos(?:\/|$)/.test(url))).toBe(false);
    expect((await runtime.service.runBackgroundAgentCycle(4)).scanned).toBe(0);
  });

  it("does not background-resume a disabled or deleted principal", async () => {
    const tenantService = runtime.service.forTenant("tenant-background");
    await tenantService.saveHarness(harnessInput());
    await tenantService.discoverHarnessProvider("primary");
    tenantService.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "生成视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await tenantService.chat("member", {
      requestId, conversationId: "inactive-background", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "生成一张视觉草图" }],
    });
    tenantService.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    tenantService.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    backgroundPrincipalActive = false;

    const calls = transport.mock.calls.length;
    expect(await runtime.service.runBackgroundAgentCycle(4)).toMatchObject({ scanned: 1, resumed: 0, skippedInactive: 1, failed: 0 });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(tenantService.harnessTrace("member", requestId)).toMatchObject({ status: "planned", nextAction: "resume" });
    expect(runtime.store.backgroundHarnessCandidates(4)).toEqual([]);
  });

  it("skips and retires inactive oldest rows without starving an active run in the same bounded cycle", async () => {
    const tenantService = runtime.service.forTenant("tenant-background");
    await tenantService.saveHarness(harnessInput());
    await tenantService.discoverHarnessProvider("primary");
    tenantService.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "生成视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await tenantService.chat("member", {
      requestId, conversationId: "active-after-inactive", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "生成一张视觉草图" }],
    });
    tenantService.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    tenantService.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    for (let index = 0; index < 4; index += 1) {
      tenantService.store.createHarnessRun({
        id: `inactive-run-${index}`, requestId: `inactive-request-${index}`, userId: `inactive-${index}`,
        conversationId: `inactive-conversation-${index}`, tier: "quick", providerId: "primary", capability: "chat",
        goalKind: "chat", goalSummary: "历史未完成任务", backgroundCapable: true, status: "planned",
        reasoningSummary: "waiting", startedAt: index + 1, updatedAt: index + 1,
      }, []);
    }
    transport.mockResolvedValueOnce(complete('{"action":"complete","summary":"已完成受限任务"}'));

    expect(await runtime.service.runBackgroundAgentCycle(4)).toMatchObject({ scanned: 5, skippedInactive: 4, resumed: 1, completed: 1, failed: 0 });
    expect(tenantService.harnessTrace("member", requestId)).toMatchObject({ status: "succeeded", nextAction: "none" });
    expect(tenantService.store.backgroundHarnessCandidates(4)).toEqual([]);
  });

  it("does not opt historical runs into background continuation after schema migration", async () => {
    const tenantService = runtime.service.forTenant("tenant-background");
    await tenantService.saveHarness(harnessInput());
    await tenantService.discoverHarnessProvider("primary");
    tenantService.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "生成视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await tenantService.chat("member", {
      requestId, conversationId: "legacy-background", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "生成一张视觉草图" }],
    });
    tenantService.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    tenantService.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    runtime.store.sql.exec("UPDATE ai_harness_runs SET background_capable=0 WHERE tenant_id=? AND request_id=?", "tenant-background", requestId);

    const calls = transport.mock.calls.length;
    expect(await runtime.service.runBackgroundAgentCycle(4)).toMatchObject({ scanned: 0, resumed: 0 });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(tenantService.harnessTrace("member", requestId)).toMatchObject({ status: "planned", nextAction: "resume" });
  });

  it("single-flights concurrent continuation claims so only one child request is sent", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "已校验海报方案", prompt: "private prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "concurrent-resume", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "private original" }] });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await gate; return complete('{"action":"complete","summary":"已完成"}'); });
    const calls = transport.mock.calls.length;
    const first = runtime.service.resumeHarnessRun("member", requestId);
    await vi.waitFor(() => expect(runtime.service.harnessTrace("member", requestId).status).toBe("running"));
    const second = runtime.service.resumeHarnessRun("member", requestId);
    release();
    const [firstTrace, secondTrace] = await Promise.all([first, second]);
    expect(firstTrace.status).toBe("succeeded");
    expect(["running", "succeeded"]).toContain(secondTrace.status);
    expect(runtime.service.harnessTrace("member", requestId).status).toBe("succeeded");
    expect(transport).toHaveBeenCalledTimes(calls + 1);
  });

  it("lets the continuation model propose only an allowlisted, approval-gated next tool", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "视觉草图", prompt: "private image prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", {
      requestId, conversationId: "autonomous-next-tool", mode: "quick", outputFormat: "image_plan",
      messages: [{ role: "user", content: "先画图再判断是否要制作视频" }],
    });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    transport.mockResolvedValueOnce(complete('{"action":"tool","capability":"video","summary":"建议制作一段短视频"}'));
    const calls = transport.mock.calls.length;
    const resumed = await runtime.service.resumeHarnessRun("member", requestId);
    expect(resumed).toMatchObject({ status: "waiting_approval", nextAction: "approve_tool", toolBudget: { used: 2, max: 3, remaining: 1 } });
    expect(resumed.steps.filter(step => step.kind === "tool").at(-1)).toMatchObject({ capability: "video", status: "waiting_approval", requiresApproval: true, approvalStatus: "waiting" });
    expect(resumed.steps.filter(step => step.kind === "approval").at(-1)).toMatchObject({ capability: "video", status: "waiting_approval" });
    expect(JSON.stringify(resumed)).not.toMatch(/建议制作一段短视频|private image prompt|思考过程/);
    expect(await runtime.service.resumeHarnessRun("member", requestId)).toEqual(resumed);
    expect(transport).toHaveBeenCalledTimes(calls + 1);
  });

  it("never replays an in-flight continuation after restart and strictly rejects extra decision fields", async () => {
    expect(parseHarnessContinuationDecision('{"action":"tool","capability":"image","summary":"生成图片"}', ["image"])).toEqual({ action: "tool", capability: "image", summary: "生成图片" });
    expect(() => parseHarnessContinuationDecision('{"action":"tool","capability":"image","summary":"生成图片","reasoning":"private"}', ["image"])).toThrow(expect.objectContaining({ code: "AI_AGENT_DECISION_INVALID" }));
    expect(() => parseHarnessContinuationDecision('{"action":"tool","capability":"computer","summary":"操作"}', ["image"])).toThrow(expect.objectContaining({ code: "AI_AGENT_DECISION_INVALID" }));

    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 50_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "草图", prompt: "private" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "restart-continuation", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "生成草图" }] });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    const continuationRequestId = crypto.randomUUID();
    runtime.store.sql.transaction(() => {
      runtime.service.harness.beginContinuation("member", requestId, continuationRequestId);
      runtime.store.saveRequest({ requestId: continuationRequestId, userId: "member", hash: "persisted", status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000, inputReserve: 0, outputReserve: 0, kind: "chat", model: "q-fast", mode: "quick", conversationId: "restart-continuation" });
    });
    const calls = transport.mock.calls.length;
    runtime.close();
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);
    const resumed = await runtime.service.resumeHarnessRun("member", requestId);
    expect(resumed).toMatchObject({ status: "running", nextAction: "poll" });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(JSON.stringify(resumed)).not.toContain(continuationRequestId);
  });

  it("keeps direct strategy to one tool even when the saved numeric limit is higher", async () => {
    await runtime.service.saveHarness(harnessInput(undefined, "direct", 8));
    await runtime.service.discoverHarnessProvider("primary");
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "单步图片", prompt: "single" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "direct-limit", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "画图" }] });
    runtime.service.harness.beginApprovedTool("member", requestId, "image", crypto.randomUUID());
    runtime.service.harness.finishApprovedTool("member", requestId, "image", "succeeded");
    expect(runtime.service.harnessTrace("member", requestId).toolBudget).toEqual({ used: 1, max: 1, remaining: 0 });
    expect(() => runtime.service.harness.proposeNextTool("member", requestId, "presentation", "追加步骤")).toThrow(expect.objectContaining({ code: "AI_DIRECT_TOOL_LIMIT" }));
  });

  it("rehydrates approval state after restart without replaying external work", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 20_000 });
    transport.mockResolvedValueOnce(complete(JSON.stringify({ kind: "image", summary: "等待确认的海报", prompt: "persisted private prompt" })));
    const requestId = crypto.randomUUID();
    await runtime.service.chat("member", { requestId, conversationId: "restart-resume", mode: "quick", outputFormat: "image_plan", messages: [{ role: "user", content: "生成海报" }] });
    const callsBeforeRestart = transport.mock.calls.length;
    runtime.close();
    runtime = await createNodeAi(path.join(directory, "test.json"), transport);

    expect(await runtime.service.resumeHarnessRun("member", requestId)).toMatchObject({
      strategy: "plan_execute", status: "waiting_approval", nextAction: "approve_tool",
      toolBudget: { used: 1, max: 3, remaining: 2 },
    });
    expect(await runtime.service.resumeHarnessRun("member", requestId)).toEqual(runtime.service.harnessTrace("member", requestId));
    expect(transport).toHaveBeenCalledTimes(callsBeforeRestart);
    await expect(runtime.service.resumeHarnessRun("other-member", requestId)).rejects.toMatchObject({ code: "AI_RUN_NOT_FOUND" });
  });

  it("allows three different conversations, single-flights each conversation, and rejects a fourth atomically", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementation(async target => {
      if (target.endsWith("/models")) return Response.json({ data: MODELS.map(id => ({ id })) });
      await waiting;
      return complete();
    });
    const request = (conversationId: string) => ({ requestId: crypto.randomUUID(), conversationId, mode: "quick" as const, messages: [{ role: "user" as const, content: "你好" }] });
    const first = runtime.service.chat("member", request("conversation-a"));
    const second = runtime.service.chat("member", request("conversation-b"));
    const third = runtime.service.chat("member", request("conversation-c"));
    await vi.waitFor(() => expect(runtime.store.pending("member")).toHaveLength(3));
    await expect(runtime.service.chat("member", request("conversation-a"))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    await expect(runtime.service.chat("member", request("conversation-d"))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    expect(runtime.store.pending("member")).toHaveLength(3);
    release();
    await Promise.all([first, second, third]);
    expect(runtime.store.pending("member")).toHaveLength(0);
    expect(runtime.service.quota("member").reservedTokens).toBe(0);
  });

  it("shares the per-account and per-conversation concurrency boundary with active video jobs", async () => {
    await configure();
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
    runtime.store.sql.exec("INSERT INTO ai_video_jobs(user_id,id,data) VALUES(?,?,?)", "member", "active-video", JSON.stringify({
      id: "active-video", userId: "member", conversationId: "shared-conversation", status: "processing",
    }));
    const sameConversation = {
      requestId: crypto.randomUUID(), conversationId: "shared-conversation", mode: "quick" as const,
      messages: [{ role: "user" as const, content: "继续处理" }],
    };
    expect(runtime.service.preflight("member", sameConversation)).toMatchObject({ canSend: false, reason: "request_in_progress" });

    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementation(async () => { await waiting; return complete(); });
    const request = (conversationId: string) => ({ requestId: crypto.randomUUID(), conversationId, mode: "quick" as const, messages: [{ role: "user" as const, content: "你好" }] });
    const first = runtime.service.chat("member", request("conversation-a"));
    const second = runtime.service.chat("member", request("conversation-b"));
    await vi.waitFor(() => expect(runtime.store.pending("member")).toHaveLength(2));
    await expect(runtime.service.chat("member", request("conversation-c"))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    release();
    await Promise.all([first, second]);
  });

  it("aggregates metadata-only latency/success/error slices and raises bounded alerts", async () => {
    for (let index = 0; index < 4; index++) runtime.store.addObservability({
      userId: `tenant-member-${index}`,
      tier: "deep",
      providerId: "primary",
      capability: "chat",
      success: false,
      latencyMs: 65_000,
      errorCode: "UPSTREAM_REJECTED",
    });
    const dashboard = runtime.service.observability(60);
    expect(dashboard.totals).toMatchObject({ requests: 4, failures: 4, errorRate: 1 });
    expect(dashboard.slices[0]).toMatchObject({ operation: "execution", errors: [{ code: "UPSTREAM_REJECTED", count: 4 }] });
    expect(dashboard.alerts.map(alert => alert.code)).toEqual(expect.arrayContaining(["HIGH_ERROR_RATE", "HIGH_LATENCY", "PROVIDER_UNAVAILABLE"]));
    expect(JSON.stringify(dashboard)).not.toMatch(/tenant-member|harness-secret|内部敏感提示/);

    const activeOccurrences = Object.fromEntries(dashboard.alerts.map(alert => [alert.code, alert.occurrences]));
    runtime.store.addObservability({ userId: "tenant-member-success", tier: "deep", providerId: "primary", capability: "chat", success: true, latencyMs: 10 });
    expect(Object.fromEntries(runtime.service.observability(60).alerts.map(alert => [alert.code, alert.occurrences]))).toEqual({
      HIGH_ERROR_RATE: activeOccurrences.HIGH_ERROR_RATE,
      HIGH_LATENCY: activeOccurrences.HIGH_LATENCY,
    });
    runtime.store.addObservability({ userId: "tenant-member-failure", tier: "deep", providerId: "primary", capability: "chat", success: false, latencyMs: 10, errorCode: "UPSTREAM_REJECTED" });
    expect(Object.fromEntries(runtime.service.observability(60).alerts.map(alert => [alert.code, alert.occurrences]))).toMatchObject({
      HIGH_ERROR_RATE: activeOccurrences.HIGH_ERROR_RATE + 1,
      HIGH_LATENCY: activeOccurrences.HIGH_LATENCY,
    });
    runtime.store.addObservability({ userId: "tenant-member-slow", tier: "deep", providerId: "primary", capability: "chat", success: true, latencyMs: 60_000 });
    expect(Object.fromEntries(runtime.service.observability(60).alerts.map(alert => [alert.code, alert.occurrences]))).toMatchObject({
      HIGH_ERROR_RATE: activeOccurrences.HIGH_ERROR_RATE + 1,
      HIGH_LATENCY: activeOccurrences.HIGH_LATENCY + 1,
    });

    const first = runtime.service.observability(60).alerts.find(alert => alert.code === "HIGH_ERROR_RATE")!;
    const occurrences = first.occurrences;
    expect(runtime.service.observability(60).alerts.find(alert => alert.id === first.id)?.occurrences).toBe(occurrences);
    expect(runtime.service.acknowledgeObservabilityAlert(first.id, "admin")).toMatchObject({ id: first.id, acknowledgedAt: expect.any(String) });
    expect(runtime.service.observability(60).alerts.find(alert => alert.id === first.id)?.acknowledgedAt).toEqual(expect.any(String));

    runtime.store.sql.exec("UPDATE ai_observability_events SET created_at=? WHERE tenant_id=?", Date.now() - 30 * 60_000, runtime.store.tenantId);
    expect(runtime.service.observability(5)).toMatchObject({ slices: [], alerts: expect.arrayContaining([expect.objectContaining({ id: first.id })]) });
    runtime.store.sql.exec("UPDATE ai_observability_events SET created_at=0 WHERE tenant_id=?", runtime.store.tenantId);
    const resolved = runtime.service.observability(60);
    expect(resolved.alerts).toEqual([]);
    expect(resolved.alertHistory.every(alert => alert.resolvedAt)).toBe(true);

    for (let index = 0; index < 4; index++) runtime.store.addObservability({
      userId: `tenant-member-new-${index}`, tier: "deep", providerId: "primary", capability: "chat", operation: "execution", success: false, latencyMs: 65_000, errorCode: "UPSTREAM_REJECTED",
    });
    const retriggered = runtime.service.observability(60);
    expect(retriggered.alerts).toHaveLength(3);
    expect(retriggered.alerts.every(alert => alert.acknowledgedAt === null)).toBe(true);
    expect(retriggered.alertHistory.length).toBe(resolved.alertHistory.length + 3);
  });

  it("separates planning from execution and normalizes unsafe telemetry labels", () => {
    runtime.store.addObservability({ userId: "member", tier: "quick", providerId: "unsafe provider body", capability: "image", operation: "planning", success: false, latencyMs: 4, errorCode: "not stable" });
    runtime.store.addObservability({ userId: "member", tier: "quick", providerId: "image-provider", capability: "image", operation: "execution", success: true, latencyMs: 12 });
    const dashboard = runtime.service.observability(60);
    expect(dashboard.slices).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: "unknown-provider", capability: "image", operation: "planning", errors: [{ code: "AI_UNKNOWN_ERROR", count: 1 }] }),
      expect.objectContaining({ provider: "image-provider", capability: "image", operation: "execution", errors: [] }),
    ]));
    expect(JSON.stringify(dashboard)).not.toContain("unsafe provider body");
  });
});
