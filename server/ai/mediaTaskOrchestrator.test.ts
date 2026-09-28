import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessCapability } from "../../shared/ai";
import { createNodeAi } from "./node";
import { AiServiceMediaTaskOrchestrator } from "./mediaTaskOrchestrator";
import type { AiTransport } from "./provider";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";
import { tenantStorageKey } from "./tenant";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_ALT = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
const provider = {
  name: "Fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret-only",
  protocol: "chat_completions" as const, quickModel: "text-model", deepModel: "text-model",
  maxOutputTokens: 2048, reasoningEffort: "" as const, enabled: true,
  imageModel: "image-model", imageQuotaTokens: 1000,
};
const planResponse = (kind: "image" | "video", prompt: string) => Response.json({
  choices: [{ message: { content: JSON.stringify({ kind, summary: `准备${kind}`, prompt }) } }],
  usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
});
const input = (requestId: string = crypto.randomUUID()) => ({
  requestId, conversationId: "conversation-a", entrypoint: "natural" as const,
  tier: "quick" as const, intent: "image" as const, requestText: "画一张蓝色科技海报", sourceAssetIds: [],
});

describe("real AiService media orchestration", () => {
  let directory: string;
  let node: Awaited<ReturnType<typeof createNodeAi>>;
  let orchestrator: AiServiceMediaTaskOrchestrator;
  let workspace: AiWorkspaceRepository;
  const transport = vi.fn<AiTransport>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-media-orchestrator-"));
    transport.mockReset();
    node = await createNodeAi(path.join(directory, "fixture.json"), transport);
    workspace = new AiWorkspaceRepository(node.store.sql); workspace.initialize();
    await node.service.saveProvider(provider);
    node.service.setQuota("member", "admin", { limitTokens: 20_000 });
    orchestrator = new AiServiceMediaTaskOrchestrator(node.service);
  });
  afterEach(async () => { node.close(); await rm(directory, { recursive: true }); });

  it("plans through chat, waits for an explicit grant, and calls the paid image service exactly once", async () => {
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const submitted = await orchestrator.submit("member", input());
    expect(submitted.status).toBe("queued");
    expect((await orchestrator.submit("member", input(submitted.requestId))).runId).toBe(submitted.runId);
    expect(transport).not.toHaveBeenCalled();
    const planned = await orchestrator.advance("member", submitted.runId);
    expect(planned).toMatchObject({ status: "awaiting_authorization", tool: { capability: "image", estimatedPoints: 1000 } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(node.service.quota("member").usedTokens).toBe(40);
    await expect(orchestrator.authorizeAndExecute("member", submitted.runId, { confirmed: true, maxPointsPerTool: 999 })).rejects.toMatchObject({ code: "AI_MEDIA_TASK_BUDGET_INVALID" });
    expect(transport).toHaveBeenCalledTimes(1);
    const finished = await orchestrator.authorizeAndExecute("member", submitted.runId, { confirmed: true, maxPointsPerTool: 1000 });
    expect(finished.status).toBe("completed");
    expect(finished.tool?.artifactIds).toHaveLength(1);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][0]).toBe("https://api.example.com/v1/images/generations");
    expect(await orchestrator.authorizeAndExecute("member", submitted.runId, { confirmed: true, maxPointsPerTool: 1000 })).toMatchObject({ status: "completed" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(node.store.usage("member").filter(item => item.kind === "image")).toHaveLength(1);
    expect(node.service.quota("member")).toMatchObject({ usedTokens: 1040, reservedTokens: 0 });
  });

  it("freezes an explicit Send grant and automatically executes exactly one image call after planning", async () => {
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const submission = { ...input(), requestText: "帮我生成一张蓝色科技海报", confirmedMediaExecution: { confirmed: true as const, maxPointsPerTool: 1000 } };
    const run = await orchestrator.submit("member", submission);
    const frozen = orchestrator.runtime.snapshot("member", run.runId)!;
    expect(frozen.authorizationScope).toMatchObject({ capabilities: ["image"], sourceAssetIds: [], maxPointsPerTool: 1000 });
    expect(orchestrator.dueCandidates().some(item => item.runId === run.runId)).toBe(true);
    const finished = await orchestrator.advance("member", run.runId);
    expect(finished.status).toBe("completed");
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
    // Duplicate HTTP delivery with a changed confirmation cannot mint a new grant.
    expect((await orchestrator.submit("member", { ...submission, confirmedMediaExecution: undefined })).runId).toBe(run.runId);
    await orchestrator.advance("member", run.runId);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it.each(["请设计一张活动海报", "帮我出一张图", "Create a video thumbnail"])(
    "accepts a front-end-recognized natural image Send without a second authorization: %s", async requestText => {
      transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
      transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
      const run = await orchestrator.submit("member", {
        ...input(), requestText, confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 },
      });
      expect(orchestrator.runtime.snapshot("member", run.runId)?.authorizationScope).toMatchObject({ capabilities: ["image"] });
      expect((await orchestrator.advance("member", run.runId)).status).toBe("completed");
      expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
    },
  );

  it("asks for the subject of a bare @image request without a model or paid call", async () => {
    const run = await orchestrator.submit("member", {
      ...input(), entrypoint: "mention_image", requestText: "@image 生成一张图片",
      confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 },
    });
    const waiting = await orchestrator.advance("member", run.runId);
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.freeQuestion?.prompt).toContain("想生成什么内容");
    expect(transport).not.toHaveBeenCalled();
  });

  it("asks for missing image content in-chat before any model or paid tool call", async () => {
    const run = await orchestrator.submit("member", {
      ...input(), requestText: "帮我生成一张图片", confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 },
    });
    const waiting = await orchestrator.advance("member", run.runId);
    expect(waiting.status).toBe("awaiting_input");
    expect(waiting.freeQuestion?.prompt).toContain("想生成什么内容");
    expect(transport).not.toHaveBeenCalled();
    orchestrator.answer("member", run.runId, waiting.freeQuestion!.questionId, "一只蓝色的猫，扁平插画");
    transport.mockResolvedValueOnce(planResponse("image", "一只蓝色的猫，扁平插画"));
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const finished = await orchestrator.advance("member", run.runId);
    expect(finished.status).toBe("completed");
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
  });

  it.each(["不要生成图片", "为什么生成图片失败", "如何生成图片？", "帮我写生成图片的提示词"])(
    "does not treat a discussion or negation as an authorized image send: %s",
    async requestText => {
      transport.mockResolvedValueOnce(planResponse("image", "安全的蓝色科技海报"));
      const run = await orchestrator.submit("member", {
        ...input(), requestText, confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 },
      });
      expect(orchestrator.runtime.snapshot("member", run.runId)?.authorizationScope).toBeNull();
      expect((await orchestrator.advance("member", run.runId)).status).toBe("awaiting_authorization");
      expect(transport).toHaveBeenCalledTimes(1);
      expect(node.store.usage("member").filter(item => item.kind === "image")).toHaveLength(0);
    },
  );

  it.each(["生成视频，不要字幕或旁白", "这个是 logo，帮我生成一段视频", "用刚才同一个人物做视频", "Please create a product video"])(
    "recognizes an affirmative video request with context or negative creative constraints: %s",
    async requestText => {
      await node.service.video.configure({ enabled: true, quotaPoints: 3000, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
      const row = node.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
      const settings = JSON.parse(row.data);
      node.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({ ...settings,
        verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion, verifiedModels: ["minimax_h3"] }));
      const run = await orchestrator.submit("member", {
        requestId: crypto.randomUUID(), conversationId: "conversation-v", entrypoint: "natural", tier: "quick",
        intent: "video", requestText, sourceAssetIds: [],
        videoParameters: { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [] },
        confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 3000 },
      });
      expect(orchestrator.runtime.snapshot("member", run.runId)?.authorizationScope).toMatchObject({ capabilities: ["video"], maxPointsPerTool: 3000 });
    },
  );

  it.each(["用刚才同一个人物做视频的提示词怎么写", "用刚才同一个人物做视频可以吗", "用刚才同一个人物做视频，先别生成"])(
    "does not preauthorize a reference-first discussion or negated video action: %s",
    async requestText => {
      await node.service.video.configure({ enabled: true, quotaPoints: 3000, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
      const row = node.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
      const settings = JSON.parse(row.data);
      node.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({ ...settings,
        verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion, verifiedModels: ["minimax_h3"] }));
      const run = await orchestrator.submit("member", {
        requestId: crypto.randomUUID(), conversationId: "conversation-v", entrypoint: "natural", tier: "quick",
        intent: "video", requestText, sourceAssetIds: [],
        videoParameters: { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [] },
        confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 3000 },
      });
      expect(orchestrator.runtime.snapshot("member", run.runId)?.authorizationScope).toBeNull();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("stages a valid media plan whose caption spans lines instead of freezing the task as unknown", async () => {
    transport.mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: JSON.stringify({ kind: "image", summary: "蓝色海报\n\t👨‍💻 程序员", prompt: "蓝色科技海报\n程序员 👨‍💻" }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
    }));
    const run = await orchestrator.submit("member", input());
    const planned = await orchestrator.advance("member", run.runId);
    expect(planned).toMatchObject({ status: "awaiting_authorization", tool: { capability: "image", estimatedPoints: 1000 } });
    expect(planned.errorCode).toBeUndefined();
    expect(node.store.request("member", `plan-${run.stepId}`)).toMatchObject({ status: "completed", result: { toolPlan: { summary: "蓝色海报 👨💻 程序员" } } });
    expect(node.service.quota("member")).toMatchObject({ usedTokens: 40, reservedTokens: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("keeps the Send grant through clarification and a raised limit; pauses only when the balance no longer covers the task", async () => {
    await node.service.saveProvider({ ...provider, imageQuotaTokens: 15_000 });
    const generated = () => transport.mock.calls.filter(([url]) => url.endsWith("/images/generations")).length;
    const sendAndClarify = async (member: string) => {
      transport.mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: '{"kind":"clarification","question":"想画什么主题？"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
      const run = await orchestrator.submit(member, {
        ...input(), requestText: "帮我生成一张动物图片", confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 15_000 },
      });
      const question = await orchestrator.advance(member, run.runId);
      expect(question.status).toBe("awaiting_input");
      orchestrator.answer(member, run.runId, question.freeQuestion!.questionId, "一只蓝色的猫");
      return run;
    };
    // A raised limit leaves the member's consent standing: one paid call, no re-confirmation.
    const raised = await sendAndClarify("member");
    node.service.setQuota("member", "admin", { limitTokens: 30_000 });
    transport.mockResolvedValueOnce(planResponse("image", "一只蓝色的猫"));
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    expect(await orchestrator.advance("member", raised.runId)).toMatchObject({ status: "completed" });
    expect(generated()).toBe(1);

    // A limit lowered below the task's cost pauses before the paid call.
    node.service.setQuota("member-2", "admin", { limitTokens: 40_000 });
    const lowered = await sendAndClarify("member-2");
    node.service.setQuota("member-2", "admin", { limitTokens: 14_000 });
    transport.mockResolvedValueOnce(planResponse("image", "一只蓝色的猫"));
    const paused = await orchestrator.advance("member-2", lowered.runId);
    expect(paused).toMatchObject({ status: "awaiting_authorization", dueAt: null, errorCode: "AI_MEDIA_GRANT_BUDGET_CHANGED" });
    // The stale grant is gone, so the card asks for a fresh confirmation
    // instead of claiming the amount was already confirmed.
    expect(paused.authorization).toBeUndefined();
    expect(await orchestrator.advance("member-2", lowered.runId)).toMatchObject({ status: "awaiting_authorization", version: paused.version });
    expect(generated()).toBe(1);
    node.service.setQuota("member-2", "admin", { limitTokens: 40_000 });
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const completed = await orchestrator.authorizeAndExecute("member-2", lowered.runId, { confirmed: true, maxPointsPerTool: 15_000 });
    expect(completed.status).toBe("completed");
    expect(generated()).toBe(2);
  });

  it("keeps an approved image task across model re-reads and unrelated settings saves, but not a changed image route", async () => {
    transport.mockImplementation(async url => url.endsWith("/models")
      ? Response.json({ data: ["text-model", "deep-model", "deep-model-2", "image-model", "image-model-2"].map(id => ({ id })) })
      : Response.json({ data: [{ b64_json: PNG }] }));
    const route = (modelId: string, imageModelId = "image-model") => ({
      providerId: "text", modelId, protocol: "chat_completions" as const, maxOutputTokens: 2048, reasoningEffort: "" as const, enabled: true,
      capabilities: ["chat", "image"] as AiHarnessCapability[], imageProviderId: "images", imageModelId,
    });
    const settings = (options: { deepModel?: string; imageModelId?: string; imagesName?: string; keys?: boolean } = {}) => ({
      providers: [
        { id: "text", name: "Text", baseUrl: "https://api.example.com/v1", protocol: "chat_completions" as const, ...(options.keys ? { apiKey: "text-key" } : {}), enabled: true },
        { id: "images", name: options.imagesName ?? "Images", baseUrl: "https://images.example.com/v1", protocol: "chat_completions" as const, ...(options.keys ? { apiKey: "image-key" } : {}), enabled: true },
      ],
      tiers: { quick: route("text-model", options.imageModelId), standard: route("text-model"), deep: route(options.deepModel ?? "deep-model"), pro: route(options.deepModel ?? "deep-model") },
      policy: { strategy: "direct" as const, maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
    });
    await node.service.saveHarness(settings({ keys: true }));
    await node.service.discoverHarnessProvider("text");
    await node.service.discoverHarnessProvider("images");
    const planned = async () => {
      transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
      const run = await orchestrator.submit("member", { ...input(), conversationId: `conversation-${crypto.randomUUID()}` });
      expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "awaiting_authorization" });
      return run;
    };
    const generations = () => transport.mock.calls.filter(([url]) => url === "https://images.example.com/v1/images/generations").length;
    const run = await planned();
    // The administrator re-reads both model lists, changes another tier and renames the image connection.
    await node.service.discoverHarnessProvider("images");
    await node.service.discoverHarnessProvider("text");
    await node.service.saveHarness(settings({ deepModel: "deep-model-2", imagesName: "Images renamed" }));
    expect(await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 })).toMatchObject({ status: "completed" });
    expect(generations()).toBe(1);

    // This tier's image model changing is a different route: the approval no longer applies.
    const second = await planned();
    await node.service.saveHarness(settings({ deepModel: "deep-model-2", imagesName: "Images renamed", imageModelId: "image-model-2" }));
    await expect(orchestrator.authorizeAndExecute("member", second.runId, { confirmed: true, maxPointsPerTool: 1000 })).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    expect(generations()).toBe(1);
  });

  it("rejects a changed model or billing policy before beginning a paid step", async () => {
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    const run = await orchestrator.submit("member", input());
    await orchestrator.advance("member", run.runId);
    await node.service.saveProvider({ ...provider, imageModel: "another-model" });
    await expect(orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 })).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    expect(orchestrator.get("member", run.runId).status).toBe("awaiting_authorization");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("persists an inline clarification and replans with a new request ID after the answer", async () => {
    transport.mockResolvedValueOnce(Response.json({
      choices: [{ message: { content: '{"kind":"clarification","question":"想画什么主题？"}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
    }));
    transport.mockResolvedValueOnce(planResponse("image", "一张蓝色的猫海报"));
    const run = await orchestrator.submit("member", { ...input(), requestText: "帮我画一张宠物图片" });
    const question = await orchestrator.advance("member", run.runId);
    expect(question).toMatchObject({ status: "awaiting_input", freeQuestion: { prompt: "想画什么主题？" } });
    const answered = orchestrator.answer("member", run.runId, question.freeQuestion!.questionId, "一只蓝色的猫");
    expect(answered.status).toBe("queued");
    const planned = await orchestrator.advance("member", run.runId);
    expect(planned.status).toBe("awaiting_authorization");
    expect(transport).toHaveBeenCalledTimes(2);
    const first = JSON.parse(transport.mock.calls[0][1].body!);
    const second = JSON.parse(transport.mock.calls[1][1].body!);
    expect(first.messages.at(-1).content).toContain("帮我画一张宠物图片");
    expect(second.messages.at(-1).content).toContain("一只蓝色的猫");
    expect(node.store.request("member", `plan-${run.stepId}`)).toBeTruthy();
    expect(node.store.request("member", `plan-${answered.stepId}`)).toBeTruthy();
  });

  it("records a rejected planner call as failed without an automatic retry", async () => {
    transport.mockResolvedValueOnce(Response.json({ error: { message: "forbidden" } }, { status: 403 }));
    const run = await orchestrator.submit("member", input());
    expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "failed" });
    expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "failed" });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("recovers an already-completed planner journal after restart without reposting", async () => {
    const run = await orchestrator.submit("member", input());
    const claimed = orchestrator.runtime.claimPlanning("member", run.runId)!;
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    await node.service.chat("member", {
      requestId: `plan-${claimed.stepId}`, conversationId: "conversation-a", mode: "quick",
      messages: [{ role: "user", content: "画一张蓝色科技海报" }], outputFormat: "image_plan",
    });
    orchestrator = new AiServiceMediaTaskOrchestrator(node.service);
    const recovered = await orchestrator.advance("member", run.runId);
    expect(recovered).toMatchObject({ status: "awaiting_authorization", tool: { planRequestId: `plan-${claimed.stepId}` } });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("never replays a claimed planner request with no journal, and stops polling a pending plan at deadline", async () => {
    let clock = Date.now();
    orchestrator = new AiServiceMediaTaskOrchestrator(node.service, () => clock);
    const missing = await orchestrator.submit("member", { ...input(), deadlineAt: clock + 60_000 });
    orchestrator.runtime.claimPlanning("member", missing.runId);
    expect(await orchestrator.advance("member", missing.runId)).toMatchObject({ status: "unknown", dueAt: null, errorCode: "AI_MEDIA_TASK_PLAN_UNRECORDED" });
    const pending = await orchestrator.submit("member", { ...input(), deadlineAt: clock + 60_000 });
    const claimed = orchestrator.runtime.claimPlanning("member", pending.runId)!;
    node.store.saveRequest({
      requestId: `plan-${claimed.stepId}`, userId: "member", hash: "fixture", status: "pending",
      createdAt: new Date().toISOString(), expiresAt: Date.now() + 120_000,
      inputReserve: 0, outputReserve: 0, model: "text-model", mode: "quick", conversationId: "conversation-a", kind: "chat",
    });
    expect((await orchestrator.advance("member", pending.runId)).status).toBe("planning");
    clock = pending.deadlineAt;
    expect(await orchestrator.advance("member", pending.runId)).toMatchObject({ status: "unknown", dueAt: null, errorCode: "AI_MEDIA_TASK_PLAN_TIMEOUT" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("marks a pending paid image call unknown at deadline rather than hot-polling or resubmitting", async () => {
    let clock = Date.now();
    orchestrator = new AiServiceMediaTaskOrchestrator(node.service, () => clock);
    const run = await orchestrator.submit("member", { ...input(), deadlineAt: clock + 60_000,
      confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 } });
    const claimed = orchestrator.runtime.claimPlanning("member", run.runId)!;
    const staged = orchestrator.runtime.stageTool("member", run.runId, {
      capability: "image", operationKey: `plan-${claimed.stepId}`, estimatedPoints: 1000,
      sourceAssetIds: [], planRequestId: `plan-${claimed.stepId}`,
    });
    const grant = staged.authorization!;
    const snapshot = orchestrator.runtime.snapshot("member", run.runId)!;
    const started = orchestrator.runtime.beginTool("member", run.runId, {
      modelConfigVersion: snapshot.modelConfigVersion, budgetVersion: grant.budgetVersion,
      availablePoints: 20_000, sourceAssetsValid: true,
    });
    expect(started.kind).toBe("started");
    node.store.saveRequest({
      requestId: started.run.tool!.toolCallId!, userId: "member", hash: "fixture", status: "pending",
      createdAt: new Date().toISOString(), expiresAt: Date.now() + 120_000,
      inputReserve: 0, outputReserve: 0, model: "image-model", mode: "quick", conversationId: "conversation-a", kind: "image",
    });
    expect((await orchestrator.advance("member", run.runId)).status).toBe("running");
    clock = run.deadlineAt;
    expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "unknown", dueAt: null, errorCode: "AI_MEDIA_TASK_IMAGE_TIMEOUT" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses scoped records: a foreign tenant/account cannot observe or authorize a task", async () => {
    const run = await orchestrator.submit("member", input());
    expect(() => orchestrator.get("other-member", run.runId)).toThrow();
    const foreign = new AiServiceMediaTaskOrchestrator(node.service.forTenant("other-tenant"));
    expect(() => foreign.get("member", run.runId)).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("carries an explicit @Skill or @Hub from the frozen request into the media planner", async () => {
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    const skillRun = await orchestrator.submit("member", { ...input(), entrypoint: "mention_image" as const, requestText: "@image @campaign-planner 画一张蓝色科技海报" });
    await orchestrator.advance("member", skillRun.runId);
    const skillBody = JSON.stringify(JSON.parse(transport.mock.calls[0][1].body!).messages[0]);
    expect(skillBody).toContain("活动策划：");
    expect(skillBody).not.toContain("受限 Hub 工作流");

    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    const hubRun = await orchestrator.submit("member", { ...input(), conversationId: "conversation-b", entrypoint: "mention_image" as const, requestText: "@image @hub-content-delivery 画一张蓝色科技海报" });
    await orchestrator.advance("member", hubRun.runId);
    const hubBody = JSON.stringify(JSON.parse(transport.mock.calls[1][1].body!).messages[0]);
    expect(hubBody).toContain("内容交付 Hub");
    expect(hubBody).toContain("内容精修：");

    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    const plainRun = await orchestrator.submit("member", { ...input(), conversationId: "conversation-c" });
    await orchestrator.advance("member", plainRun.runId);
    const plainBody = JSON.stringify(JSON.parse(transport.mock.calls[2][1].body!).messages[0]);
    expect(plainBody).not.toContain("活动策划：");
    expect(plainBody).not.toContain("受限 Hub 工作流");
  });

  it("freezes bounded same-conversation history, strips links, and never re-reads edited history while planning", async () => {
    const state = (oldText: string) => ({
      view: "chat" as const, mode: "quick" as const, projects: [], artifacts: [], drafts: {}, enabledSkillIds: [],
      activeConversationId: "conversation-a", activeProjectId: null,
      conversations: [{ id: "conversation-a", title: "海报", timeLabel: "刚刚", messages: [
        { id: "previous-user", role: "user" as const, content: `${oldText} https://untrusted.example/secret`, time: "10:00", status: "ready" as const },
        { id: "previous-assistant", role: "assistant" as const, content: "你希望保留蓝色背景。", time: "10:01", status: "ready" as const },
        { id: "current-user", role: "user" as const, content: "画一张蓝色科技海报", time: "10:02", status: "ready" as const },
      ] }],
    });
    await workspace.save("member", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("最初的品牌风格") });
    const run = await orchestrator.submit("member", input());
    expect(orchestrator.getByRequest("member", run.requestId).runId).toBe(run.runId);
    const snapshot = orchestrator.runtime.snapshot("member", run.runId)!;
    expect(snapshot.contextMessages).toEqual([
      { sourceMessageId: "previous-user", role: "user", content: "最初的品牌风格 [链接已省略]" },
      { sourceMessageId: "previous-assistant", role: "assistant", content: "你希望保留蓝色背景。" },
    ]);
    expect(snapshot.contextRevision).toBe(1);
    await workspace.save("member", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: state("修改后的不同历史") });
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    await orchestrator.advance("member", run.runId);
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    const serialized = JSON.stringify(body);
    expect(serialized).toContain("最初的品牌风格");
    expect(serialized).not.toContain("修改后的不同历史");
    expect(serialized).not.toContain("untrusted.example");
    expect(body.messages.filter((item: { content: string }) => item.content.includes("画一张蓝色科技海报"))).toHaveLength(1);
    expect((await orchestrator.submit("member", input(run.requestId))).runId).toBe(run.runId);
  });

  it("reads context from the matching V2 conversation without reopening the V1 account snapshot", async () => {
    await workspace.save("member", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: {
      view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, enabledSkillIds: [],
      activeConversationId: "conversation-a", activeProjectId: null,
      conversations: [{ id: "conversation-a", title: "海报", timeLabel: "刚刚", messages: [
        { id: "earlier-v2", role: "user", content: "沿用蓝色品牌色", time: "10:00" },
        { id: "current-v2", role: "user", content: "画一张蓝色科技海报", time: "10:01" },
      ] }],
    } });
    const shadow = new AiWorkspaceV2ShadowRepository(node.store.sql, workspace);
    const v2 = new AiWorkspaceV2Store(node.store.sql, workspace); v2.initialize();
    await shadow.stageFromV1("member");
    await v2.prepareFromShadow("member");
    const storedUser = tenantStorageKey(node.store.tenantId, "member");
    node.store.sql.transaction(() => {
      node.store.sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=?", new Date().toISOString(), node.store.tenantId, storedUser);
      node.store.sql.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=?", node.store.tenantId, storedUser);
    });
    expect(() => workspace.read("member")).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" }));
    const run = await orchestrator.submit("member", input());
    expect(orchestrator.runtime.snapshot("member", run.runId)).toMatchObject({ contextMessages: [
      { sourceMessageId: "earlier-v2", role: "user", content: "沿用蓝色品牌色" },
    ], contextRevision: 1 });
    expect(transport).not.toHaveBeenCalled();
  });

  it("uses no history when the requested conversation was not saved and rejects other-account lookups", async () => {
    const run = await orchestrator.submit("member", input());
    expect(orchestrator.runtime.snapshot("member", run.runId)?.contextMessages).toBeUndefined();
    expect(() => orchestrator.getByRequest("other-member", run.requestId)).toThrow();
    expect(() => new AiServiceMediaTaskOrchestrator(node.service.forTenant("other-tenant")).getByRequest("member", run.requestId)).toThrow();
  });

  it("uses only a saved user image document in the exact conversation and freezes its bytes", async () => {
    const state = (base64: string) => ({
      view: "chat" as const, mode: "quick" as const, projects: [], artifacts: [], drafts: {}, enabledSkillIds: [],
      activeConversationId: "conversation-a", activeProjectId: null,
      conversations: [{ id: "conversation-a", title: "海报", timeLabel: "刚刚", messages: [{
        id: "user-image", role: "user" as const, content: "帮我生成一张图片", time: "10:00", status: "ready" as const,
        attachments: [{ id: "uploaded-image", name: "logo.png", mimeType: "image/png", content: "参考 logo",
          media: { kind: "image" as const, frames: [{ dataUrl: `data:image/png;base64,${base64}` }] } }],
      }] }],
    });
    await workspace.save("member", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state(PNG) });
    const submission = { ...input(), requestText: "帮我生成一张图片", sourceAssetIds: ["uploaded-image"] };
    await expect(orchestrator.submit("member", { ...submission, conversationId: "other-conversation" }))
      .rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_INVALID" });
    const run = await orchestrator.submit("member", submission);
    expect(orchestrator.runtime.snapshot("member", run.runId)?.sourceFingerprints).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    const claimed = orchestrator.runtime.claimPlanning("member", run.runId)!;
    orchestrator.runtime.stageTool("member", run.runId, {
      capability: "image", operationKey: `plan-${claimed.stepId}`, estimatedPoints: 1000,
      sourceAssetIds: ["uploaded-image"], planRequestId: `plan-${claimed.stepId}`,
    });
    await workspace.save("member", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: state(PNG_ALT) });
    await expect(orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 }))
      .rejects.toMatchObject({ code: "AI_MEDIA_TASK_SOURCE_UNAVAILABLE" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("marks an ambiguous image send unknown and never resubmits it on advance or confirmation", async () => {
    transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
    transport.mockRejectedValueOnce(new Error("lost response after write"));
    const run = await orchestrator.submit("member", input());
    await orchestrator.advance("member", run.runId);
    const result = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 });
    expect(result.status).toBe("unknown");
    expect(node.store.request("member", result.tool!.toolCallId!)?.status).toBe("uncertain");
    expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "unknown" });
    expect(await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 })).toMatchObject({ status: "unknown" });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(node.store.usage("member").filter(item => item.kind === "image")).toHaveLength(1);
  });

  describe("a paid entry that refuses before recording anything", () => {
    const busyRequest = (conversationId: string) => ({
      requestId: "busy-chat-request-000001", userId: "member", hash: "fixture", status: "pending" as const,
      createdAt: new Date().toISOString(), expiresAt: Date.now() + 120_000,
      inputReserve: 0, outputReserve: 0, model: "text-model", mode: "quick" as const, conversationId, kind: "chat" as const,
    });
    const videoPosts = () => transport.mock.calls.filter(([url, init]) => url === "https://www.75api.com/v1/videos" && init.method === "POST");
    const configureVideo = async () => {
      await node.service.video.configure({ enabled: true, quotaPoints: 3000, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
      const row = node.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
      const settings = JSON.parse(row.data);
      node.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({ ...settings,
        verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion, verifiedModels: ["minimax_h3"] }));
    };
    const videoInput = () => ({
      requestId: crypto.randomUUID(), conversationId: "conversation-v", entrypoint: "mention_video" as const, tier: "quick" as const,
      intent: "video" as const, requestText: "生成品牌视频", sourceAssetIds: [],
      videoParameters: { model: "minimax_h3" as const, seconds: 15, resolution: "768p" as const, aspectRatio: "16:9" as const, referenceIds: [] },
    });

    it("returns a busy image call to a fresh confirmation with the reason, uncharged, then generates once", async () => {
      transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
      const run = await orchestrator.submit("member", input());
      await orchestrator.advance("member", run.runId);
      const busy = busyRequest("conversation-a");
      node.store.saveRequest(busy);
      const released = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 });
      expect(released).toMatchObject({ status: "awaiting_authorization", dueAt: null, errorCode: "AI_REQUEST_IN_PROGRESS", tool: { capability: "image", estimatedPoints: 1000 } });
      expect(released.tool?.toolCallId).toBeUndefined();
      expect(released.authorization).toBeUndefined();
      expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(0);
      expect(node.store.usage("member").filter(item => item.kind === "image")).toHaveLength(0);
      expect(node.service.quota("member")).toMatchObject({ usedTokens: 40, reservedTokens: 0 });
      // A scheduler pass or read neither resends nor writes.
      expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "awaiting_authorization", version: released.version });
      node.store.saveRequest({ ...busy, status: "failed" });
      transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
      expect((await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 })).status).toBe("completed");
      expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
      expect(node.store.usage("member").filter(item => item.kind === "image")).toHaveLength(1);
    });

    it("returns a busy video call to a fresh confirmation instead of freezing it as unknown", async () => {
      await configureVideo();
      transport.mockResolvedValueOnce(planResponse("video", "品牌视频"));
      const run = await orchestrator.submit("member", videoInput());
      expect((await orchestrator.advance("member", run.runId)).status).toBe("awaiting_authorization");
      const busy = busyRequest("conversation-v");
      node.store.saveRequest(busy);
      const released = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 3000 });
      expect(released).toMatchObject({ status: "awaiting_authorization", dueAt: null, errorCode: "AI_REQUEST_IN_PROGRESS" });
      expect(released.tool?.toolCallId).toBeUndefined();
      expect(videoPosts()).toHaveLength(0);
      expect(node.service.video.list("member").jobs).toEqual([]);
      expect(node.service.quota("member").reservedTokens).toBe(0);
      node.store.saveRequest({ ...busy, status: "failed" });
      transport.mockResolvedValueOnce(Response.json({ id: "task_fixture_12345678", status: "queued", progress: 0 }));
      expect(await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 3000 }))
        .toMatchObject({ status: "running", tool: { serviceRequestId: expect.any(String) } });
      expect(videoPosts()).toHaveLength(1);
    });

    it("fails a video whose refusal is final without charge instead of leaving it unknown", async () => {
      await configureVideo();
      transport.mockResolvedValueOnce(planResponse("video", "品牌视频"));
      const run = await orchestrator.submit("member", videoInput());
      const planned = await orchestrator.advance("member", run.runId);
      const plan = node.store.request("member", planned.tool!.planRequestId!)!;
      node.store.saveRequest({ ...plan, toolPlanExpiresAt: Date.now() - 1 });
      const result = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 3000 });
      expect(result).toMatchObject({ status: "failed", errorCode: "AI_TOOL_PLAN_EXPIRED", dueAt: null });
      expect(videoPosts()).toHaveLength(0);
      expect(node.service.quota("member").reservedTokens).toBe(0);
    });

    it("fails rather than re-offers a refused call whose task deadline passed meanwhile", async () => {
      let clock = Date.now();
      orchestrator = new AiServiceMediaTaskOrchestrator(node.service, () => clock);
      transport.mockResolvedValueOnce(planResponse("image", "蓝色科技海报"));
      const run = await orchestrator.submit("member", { ...input(), deadlineAt: clock + 60_000 });
      await orchestrator.advance("member", run.runId);
      node.store.saveRequest(busyRequest("conversation-a"));
      const generate = node.service.generateImage.bind(node.service);
      vi.spyOn(node.service, "generateImage").mockImplementationOnce(async (userId, value) => { clock = run.deadlineAt; return generate(userId, value); });
      const result = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 1000 });
      expect(result).toMatchObject({ status: "failed", errorCode: "AI_REQUEST_IN_PROGRESS", dueAt: null });
      expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(0);
      expect(node.service.quota("member").reservedTokens).toBe(0);
    });

    it("never writes on repeated reads of an unknown video whose job was never recorded", async () => {
      await configureVideo();
      const run = await orchestrator.submit("member", { ...videoInput(), confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 3000 } });
      const claimed = orchestrator.runtime.claimPlanning("member", run.runId)!;
      const staged = orchestrator.runtime.stageTool("member", run.runId, {
        capability: "video", operationKey: `plan-${claimed.stepId}`, estimatedPoints: 3000,
        sourceAssetIds: [], planRequestId: `plan-${claimed.stepId}`,
      });
      const started = orchestrator.runtime.beginTool("member", run.runId, {
        modelConfigVersion: orchestrator.runtime.snapshot("member", run.runId)!.modelConfigVersion,
        budgetVersion: staged.authorization!.budgetVersion, availablePoints: 20_000, sourceAssetsValid: true,
      });
      // Frozen as unknown by an earlier version although nothing was recorded.
      orchestrator.runtime.failTool("member", run.runId, started.run.tool!.toolCallId!, "AI_REQUEST_IN_PROGRESS", "unknown");
      // GET by request advances an unknown video on every read.
      const first = await orchestrator.advance("member", run.runId);
      expect(first).toMatchObject({ status: "unknown", errorCode: "AI_MEDIA_TASK_UNRECORDED", dueAt: null });
      for (let read = 0; read < 3; read += 1) {
        expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "unknown", version: first.version, updatedAt: first.updatedAt });
      }
      expect(transport).not.toHaveBeenCalled();
    });
  });

  it("keeps a video queued and polls only its provider task; it never sends the paid POST twice", async () => {
    await node.service.video.configure({ enabled: true, quotaPoints: 3000, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
    const row = node.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
    const settings = JSON.parse(row.data);
    node.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({ ...settings, verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion, verifiedModels: ["minimax_h3"] }));
    transport.mockResolvedValueOnce(planResponse("video", "一段十五秒品牌视频"));
    transport.mockResolvedValueOnce(Response.json({ id: "task_fixture_12345678", status: "queued", progress: 0 }));
    transport.mockResolvedValueOnce(Response.json({ id: "task_fixture_12345678", status: "completed", progress: 100 }));
    transport.mockResolvedValueOnce(new Response(MP4, { headers: { "Content-Type": "video/mp4" } }));
    const run = await orchestrator.submit("member", {
      requestId: crypto.randomUUID(), conversationId: "conversation-v", entrypoint: "mention_video", tier: "quick",
      intent: "video", requestText: "制作一段十五秒品牌视频", sourceAssetIds: [],
      videoParameters: { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [] },
    });
    const planned = await orchestrator.advance("member", run.runId);
    expect(planned.status).toBe("awaiting_authorization");
    const queued = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 3000 });
    expect(queued).toMatchObject({ status: "running", tool: { serviceRequestId: expect.any(String) } });
    expect(transport.mock.calls.filter(([url, init]) => url === "https://www.75api.com/v1/videos" && init.method === "POST")).toHaveLength(1);
    // Simulate a scheduler wake; refresh itself enforces the provider polling interval.
    node.store.sql.exec("UPDATE ai_video_jobs SET data=json_set(data, '$.pollAt', 0) WHERE id=?", queued.tool!.toolCallId!);
    const completed = await orchestrator.advance("member", run.runId);
    expect(completed).toMatchObject({ status: "completed", tool: { artifactIds: [queued.tool!.toolCallId] } });
    expect(transport.mock.calls.some(([url, init]) => url.endsWith("/content") && init.method === "GET")).toBe(true);
    expect(transport.mock.calls.filter(([url, init]) => url === "https://www.75api.com/v1/videos" && init.method === "POST")).toHaveLength(1);
    expect(node.store.usage("member").filter(item => item.kind === "video")).toHaveLength(1);
  });

  it("stops background polling after the deadline of an accepted video job without another paid POST", async () => {
    let clock = Date.now();
    orchestrator = new AiServiceMediaTaskOrchestrator(node.service, () => clock);
    await node.service.video.configure({ enabled: true, quotaPoints: 3000, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
    const row = node.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
    const settings = JSON.parse(row.data);
    node.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({ ...settings,
      verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion, verifiedModels: ["minimax_h3"] }));
    transport.mockResolvedValueOnce(planResponse("video", "品牌视频"));
    transport.mockResolvedValueOnce(Response.json({ id: "task_fixture_12345678", status: "queued", progress: 0 }));
    const run = await orchestrator.submit("member", {
      requestId: crypto.randomUUID(), conversationId: "conversation-v", entrypoint: "mention_video", tier: "quick",
      intent: "video", requestText: "生成品牌视频", sourceAssetIds: [], deadlineAt: clock + 60_000,
      videoParameters: { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [] },
      confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 3000 },
    });
    expect((await orchestrator.advance("member", run.runId)).status).toBe("running");
    clock = run.deadlineAt;
    expect(await orchestrator.advance("member", run.runId)).toMatchObject({ status: "unknown", dueAt: null, errorCode: "AI_MEDIA_TASK_VIDEO_TIMEOUT" });
    expect(transport.mock.calls.filter(([url, init]) => url.endsWith("/videos") && init.method === "POST")).toHaveLength(1);
  });

  it("does not call an inaccessible or invalid video a ready artifact", async () => {
    await node.service.video.configure({ enabled: true, quotaPoints: 3000, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
    const row = node.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
    const settings = JSON.parse(row.data);
    node.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({ ...settings, verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion, verifiedModels: ["minimax_h3"] }));
    transport.mockResolvedValueOnce(planResponse("video", "品牌视频"));
    transport.mockResolvedValueOnce(Response.json({ id: "task_fixture_12345678", status: "completed", progress: 100 }));
    transport.mockResolvedValueOnce(new Response("not a video", { headers: { "Content-Type": "video/mp4" } }));
    const run = await orchestrator.submit("member", {
      requestId: crypto.randomUUID(), conversationId: "conversation-invalid", entrypoint: "menu", tier: "quick",
      intent: "video", requestText: "品牌视频", sourceAssetIds: [],
      videoParameters: { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [] },
    });
    await orchestrator.advance("member", run.runId);
    const result = await orchestrator.authorizeAndExecute("member", run.runId, { confirmed: true, maxPointsPerTool: 3000 });
    expect(result).toMatchObject({ status: "unknown", tool: { errorCode: "AI_VIDEO_CONTENT_UNVERIFIED" } });
    expect(result.tool?.artifactIds).toBeUndefined();
    expect(transport.mock.calls.filter(([url, init]) => url === "https://www.75api.com/v1/videos" && init.method === "POST")).toHaveLength(1);
  });
});
