import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import { AiServiceMediaTaskOrchestrator } from "./mediaTaskOrchestrator";
import type { AiTransport } from "./provider";
import { AiWorkspaceRepository } from "./workspace";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
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
    const run = await orchestrator.submit("member", { ...input(), requestText: "帮我生成一张图片" });
    const question = await orchestrator.advance("member", run.runId);
    expect(question).toMatchObject({ status: "awaiting_input", freeQuestion: { prompt: "想画什么主题？" } });
    const answered = orchestrator.answer("member", run.runId, question.freeQuestion!.questionId, "一只蓝色的猫");
    expect(answered.status).toBe("queued");
    const planned = await orchestrator.advance("member", run.runId);
    expect(planned.status).toBe("awaiting_authorization");
    expect(transport).toHaveBeenCalledTimes(2);
    const first = JSON.parse(transport.mock.calls[0][1].body!);
    const second = JSON.parse(transport.mock.calls[1][1].body!);
    expect(first.messages.at(-1).content).toContain("帮我生成一张图片");
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

  it("uses scoped records: a foreign tenant/account cannot observe or authorize a task", async () => {
    const run = await orchestrator.submit("member", input());
    expect(() => orchestrator.get("other-member", run.runId)).toThrow();
    const foreign = new AiServiceMediaTaskOrchestrator(node.service.forTenant("other-tenant"));
    expect(() => foreign.get("member", run.runId)).toThrow();
    expect(transport).not.toHaveBeenCalled();
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

  it("uses no history when the requested conversation was not saved and rejects other-account lookups", async () => {
    const run = await orchestrator.submit("member", input());
    expect(orchestrator.runtime.snapshot("member", run.runId)?.contextMessages).toBeUndefined();
    expect(() => orchestrator.getByRequest("other-member", run.requestId)).toThrow();
    expect(() => new AiServiceMediaTaskOrchestrator(node.service.forTenant("other-tenant")).getByRequest("member", run.requestId)).toThrow();
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
