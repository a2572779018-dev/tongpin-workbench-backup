import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import { AiVideoService } from "./videoService";
import { createSecretBox } from "./security";
import type { AiTransport } from "./provider";
import type { AiVideoPlanParameters } from "../../shared/ai";
import type { VideoModelId, VideoResolution } from "../../shared/aiVideoModels";

describe("durable H3 jobs and isolated quotas", () => {
  let dir: string, runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  const task = (status = "queued", progress = 0) => Response.json({ id: "task_fixture_12345678", status, progress });
  const saveVideoPlan = (userId: string, prompt: string, videoParameters: AiVideoPlanParameters) => {
    const requestId = crypto.randomUUID();
    runtime.store.saveRequest({
      requestId, userId, hash: "saved-plan", status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "planner", mode: "quick",
      result: { requestId, content: "已整理，请确认后生成", model: "planner", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "video", summary: "方案", prompt, videoParameters } },
    });
    return requestId;
  };
  type VideoInput = {
    requestId: string;
    prompt: string;
    planRequestId: string;
    model?: VideoModelId;
    seconds: number;
    resolution: VideoResolution;
    aspectRatio: "16:9" | "9:16";
    referenceIds?: string[];
    conversationId?: string;
  };
  const planParameters = (request: Omit<VideoInput, "planRequestId">): AiVideoPlanParameters => ({
    model: request.model ?? runtime.service.video.settings().defaultModel ?? "minimax_h3",
    seconds: request.seconds,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    referenceCount: request.referenceIds?.length ?? 0,
    referenceFingerprints: request.referenceIds?.map(id => {
      const row = runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_video_references WHERE id=?", id)[0];
      const stored = row ? JSON.parse(row.data) as { fingerprint?: unknown } : undefined;
      return typeof stored?.fingerprint === "string" ? stored.fingerprint : id;
    }) ?? [],
  });
  const input = (userId = "a", prompt = "一只猫", overrides: Partial<Omit<VideoInput, "planRequestId" | "prompt">> = {}): VideoInput => {
    const request: Omit<VideoInput, "planRequestId"> = { requestId: crypto.randomUUID(), prompt, seconds: 15, resolution: "768p", aspectRatio: "16:9", ...overrides };
    return { ...request, planRequestId: saveVideoPlan(userId, prompt, planParameters(request)) };
  };
  const config = { enabled: true, quotaPoints: 1000, apiKey: "sk-video-test-fixture-secret" };
  const authorize = (...models: VideoModelId[]) => {
    const row = runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
    const saved = JSON.parse(row.data);
    runtime.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify({
      ...saved,
      verifiedConfigVersion: saved.configVersion,
      verifiedKeyVersion: saved.keyVersion,
      verifiedModels: models,
    }));
  };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "tongpin-video-test-")); transport.mockReset(); transport.mockResolvedValue(task());
    runtime = await createNodeAi(path.join(dir, "test.json"), transport);
    await runtime.service.video.configure(config);
    authorize("minimax_h3", "minimax_h3_no_audios_1080", "sd-2-c6", "sd-2.0-fast");
    runtime.service.setQuota("a", "admin", { limitTokens: 10000 }); runtime.service.setQuota("b", "admin", { limitTokens: 10000 });
  });
  afterEach(async () => { vi.useRealTimers(); runtime.close(); await rm(dir, { recursive: true }); });
  it("defaults disabled, supports deployment secret and never serializes the key", async () => {
    expect(JSON.stringify(runtime.service.video.settings())).not.toContain(config.apiKey);
    expect((await readFile(path.join(dir, "test.json.ai.sqlite"))).includes(Buffer.from(config.apiKey))).toBe(false);
    runtime.store.sql.exec("DELETE FROM ai_settings WHERE id='video'");
    const video = new AiVideoService(runtime.store, () => createSecretBox("fixture-with-at-least-thirty-two-characters"), transport, () => "deployment-secret");
    expect(video.settings()).toEqual({ enabled: false, quotaPoints: 0, apiKeyConfigured: true, defaultModel: "minimax_h3", availableModels: [], modelsVerified: false });
    await expect(video.submit("a", input())).rejects.toMatchObject({ code: "AI_VIDEO_DISABLED" }); expect(transport).not.toHaveBeenCalled();
  });
  it("round-trips a validated default model, uses it for omitted model IDs and repairs a corrupt legacy value", async () => {
    expect(await runtime.service.video.configure({ ...config, defaultModel: "sd-2-c6" })).toMatchObject({ defaultModel: "sd-2-c6" });
    authorize("sd-2-c6");
    const request = input("a", "一只猫", { resolution: "720p" });
    await runtime.service.video.submit("a", request);
    expect(JSON.parse(transport.mock.calls[0][1].body!)).toMatchObject({ model: "sd-2-c6", seconds: "15", resolution: "720p" });
    const before = runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0].data;
    await expect(runtime.service.video.configure({ ...config, defaultModel: "not-a-video-model" })).rejects.toMatchObject({ code: "AI_VIDEO_MODEL_INVALID" });
    expect(runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0].data).toBe(before);
    const legacy = { ...JSON.parse(before), defaultModel: "removed-legacy-model" };
    runtime.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify(legacy));
    expect(runtime.service.video.settings().defaultModel).toBe("minimax_h3");
    expect(await runtime.service.video.configure({ enabled: true, quotaPoints: 1000 })).toMatchObject({ defaultModel: "minimax_h3" });
  });
  it("executes an explicit verified model through the tier-bound 75API provider and key", async () => {
    const route = {
      providerId: "video-provider", modelId: "minimax_h3", protocol: "chat_completions" as const,
      maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities: ["chat", "video"] as const,
      enabled: true, videoProviderId: "video-provider", videoModelId: "sd-2-c6",
    };
    await runtime.service.saveHarness({
      providers: [{ id: "video-provider", name: "75API", baseUrl: "https://www.75api.com/v1", protocol: "chat_completions", apiKey: "harness-video-key", enabled: true }],
      tiers: { quick: route, standard: route, deep: route, pro: route },
      policy: { strategy: "plan_execute", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
    });
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "minimax_h3" }, { id: "sd-2-c6" }] }));
    await runtime.service.discoverHarnessProvider("video-provider");
    expect(runtime.service.video.list("a").settings).toMatchObject({ availableModels: ["minimax_h3", "sd-2-c6"], defaultModel: "sd-2-c6" });
    transport.mockResolvedValueOnce(task());
    const request = input("a", "一段品牌视频", { model: "minimax_h3", seconds: 15, resolution: "768p" });
    await runtime.service.video.submit("a", request);
    const [url, init] = transport.mock.calls.at(-1)!;
    expect(url).toBe("https://www.75api.com/v1/videos");
    expect(init.headers.Authorization).toBe("Bearer harness-video-key");
    expect(JSON.parse(init.body!)).toMatchObject({ model: "minimax_h3", seconds: "15", resolution: "768p" });
  });
  it("requires a positive administrator conversion and valid credentials", async () => {
    await expect(runtime.service.video.configure({ enabled: true, quotaPoints: 0 })).rejects.toMatchObject({ code: "AI_VIDEO_SETTINGS_INVALID" });
    await expect(runtime.service.video.configure({ ...config, apiKey: "bad\nkey" })).rejects.toMatchObject({ code: "AI_KEY_INVALID" });
  });
  it("freezes an opaque media configuration version and validates reference ownership before planning", async () => {
    const video = runtime.service.video;
    const before = await video.configurationVersion("quick");
    expect(before).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify({ before })).not.toContain(config.apiKey);
    const first = await video.uploadReference("a", { dataUrl: "data:image/jpeg;base64,/9j/AAAA", conversationId: "conversation_a" });
    expect(await video.referenceFingerprintsForTask("a", [first.id], "conversation_a")).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    await expect(video.referenceFingerprintsForTask("b", [first.id], "conversation_a")).rejects.toMatchObject({ code: "AI_VIDEO_SOURCE_CONVERSATION" });
    await expect(video.referenceFingerprintsForTask("a", [first.id], "conversation_b")).rejects.toMatchObject({ code: "AI_VIDEO_SOURCE_CONVERSATION" });
    const legacy = await video.uploadReference("a", { dataUrl: "data:image/jpeg;base64,/9j/AAAA" });
    await expect(video.referenceFingerprintsForTask("a", [legacy.id], "conversation_a")).rejects.toMatchObject({ code: "AI_VIDEO_SOURCE_CONVERSATION" });
    await video.configure({ ...config, defaultModel: "sd-2-c6" });
    expect(await video.configurationVersion("quick")).not.toBe(before);
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps reference images encrypted, account-bound and expiring; retries do not generate twice", async () => {
    const video = runtime.service.video;
    const dataUrl = "data:image/jpeg;base64,/9j/" + "AAAA".repeat(20000);
    const reference = await video.uploadReference("a", { dataUrl });
    expect(reference.id).toMatch(/^[a-f0-9]{64}$/);
    const stored = runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_video_references WHERE id=?", reference.id)[0].data;
    expect(stored).not.toContain(dataUrl.slice(0, 100));
    const image = await video.referenceContent(reference.id);
    expect(image.status).toBe(200); expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0)));
    const req = input("a", "一只猫", { referenceIds: [reference.id] });
    const bRequest = { ...req, planRequestId: saveVideoPlan("b", req.prompt, planParameters(req)) };
    await expect(video.submit("b", bRequest)).rejects.toMatchObject({ code: "AI_VIDEO_IMAGE_INVALID" });
    await video.submit("a", req); await video.submit("a", req);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][1].body!).images).toEqual([`https://notify.samhubs.com/api/video-reference/${reference.id}`]);
    const changedReferences = { ...req, referenceIds: [] };
    await expect(video.submit("a", { ...changedReferences, planRequestId: saveVideoPlan("a", req.prompt, planParameters(changedReferences)) })).rejects.toMatchObject({ code: "AI_VIDEO_REQUEST_CONFLICT" });
    expect(video.list("a").jobs.find(job => job.id === req.requestId)?.referenceIds).toEqual([reference.id]);
    expect(JSON.stringify(video.list("b"))).not.toContain(reference.id);
    runtime.store.sql.exec("UPDATE ai_video_references SET expires_at=0 WHERE id=?", reference.id);
    expect((await video.referenceContent(reference.id)).status).toBe(404);
    await expect(video.submit("a", input("a", "一只猫", { referenceIds: [reference.id] }))).rejects.toMatchObject({ code: "AI_VIDEO_IMAGE_INVALID" });
    await expect(video.uploadReference("zero", { dataUrl })).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
  });
  it("reserves once across concurrent duplicate submissions, with private key snapshots", async () => {
    const req = input(); const result = await Promise.all([runtime.service.video.submit("a", req), runtime.service.video.submit("a", req)]);
    expect(transport).toHaveBeenCalledTimes(1); expect(result.every(j => j.id === req.requestId)).toBe(true);
    expect(runtime.service.quota("a")).toMatchObject({ reservedTokens: 1000, usedTokens: 0, remainingTokens: 9000 });
    expect(JSON.stringify(runtime.service.video.list("a"))).not.toMatch(/encryptedKey|sk-video|providerId/);
    await expect(runtime.service.video.submit("a", { ...req, prompt: "other", planRequestId: saveVideoPlan("a", "other", planParameters(req)) })).rejects.toMatchObject({ code: "AI_VIDEO_REQUEST_CONFLICT" });
  });
  it("durably writes the request and reservation before the one paid provider POST", async () => {
    const req = input();
    transport.mockImplementationOnce(async () => {
      expect(runtime.service.video.list("a").jobs).toEqual([expect.objectContaining({ id: req.requestId, status: "submitting", reserved: true })]);
      expect(runtime.service.quota("a")).toMatchObject({ usedTokens: 0, reservedTokens: 1000, remainingTokens: 9000 });
      return task();
    });

    await expect(runtime.service.video.submit("a", req)).resolves.toMatchObject({ id: req.requestId, status: "queued", reserved: true });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("allows one video generation per plan while preserving duplicate-request replay", async () => {
    const req = input();
    const first = await runtime.service.video.submit("a", req);
    expect((await runtime.service.video.submit("a", req)).id).toBe(first.id);
    await expect(runtime.service.video.submit("a", { ...req, requestId: crypto.randomUUID() })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_CONSUMED" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects an expired video plan before provider access or quota reservation", async () => {
    const req = input();
    const stored = runtime.store.request("a", req.planRequestId)!;
    runtime.store.saveRequest({ ...stored, toolPlanExpiresAt: 0 });
    const quota = runtime.service.quota("a");

    await expect(runtime.service.video.submit("a", req)).rejects.toMatchObject({ code: "AI_TOOL_PLAN_EXPIRED" });
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.service.quota("a")).toEqual(quota);
  });
  it("isolates users, blocks zero quotas, single-flights a conversation and caps each account at three tasks", async () => {
    transport.mockImplementation(async () => task());
    const req = input("a", "一只猫", { conversationId: "conversation-a" }); await runtime.service.video.submit("a", req);
    expect(runtime.service.video.list("b").jobs).toEqual([]);
    await expect(runtime.service.video.refresh("b", req.requestId)).rejects.toMatchObject({ status: 404 });
    await expect(runtime.service.video.content("b", req.requestId)).rejects.toMatchObject({ status: 404 });
    await expect(runtime.service.video.submit("zero", input("zero"))).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
    await expect(runtime.service.video.submit("a", input("a", "另一只猫", { conversationId: "conversation-a" }))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    await runtime.service.video.submit("a", input("a", "第二条", { conversationId: "conversation-b" }));
    await runtime.service.video.submit("a", input("a", "第三条", { conversationId: "conversation-c" }));
    await expect(runtime.service.video.submit("a", input("a", "第四条", { conversationId: "conversation-d" }))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    await runtime.service.video.submit("b", input("b"));
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it("shares video concurrency slots and conversation locks with chat, image and presentation requests", async () => {
    const savePending = (conversationId: string) => {
      const requestId = crypto.randomUUID();
      runtime.store.saveRequest({
        requestId, userId: "a", hash: requestId, status: "pending", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
        inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "business-tier", mode: "standard", conversationId,
      });
    };
    savePending("shared-conversation");
    await expect(runtime.service.video.submit("a", input("a", "同一对话", { conversationId: "shared-conversation" }))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    savePending("second-conversation");
    await expect(runtime.service.video.submit("a", input("a", "第三条任务", { conversationId: "video-conversation" }))).resolves.toMatchObject({ status: "queued" });
    await expect(runtime.service.video.submit("a", input("a", "第四条任务", { conversationId: "fourth-conversation" }))).rejects.toMatchObject({ code: "AI_REQUEST_IN_PROGRESS" });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects racing mismatched duplicate input without another paid submission", async () => {
    const req = input();
    const results = await Promise.allSettled([runtime.service.video.submit("a", req), runtime.service.video.submit("a", { ...req, prompt: "不同内容", planRequestId: saveVideoPlan("a", "不同内容", planParameters(req)) })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "AI_VIDEO_REQUEST_CONFLICT" } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("a").reservedTokens).toBe(1000);
  });
  it("fails closed before the video provider when a plan belongs to another account, kind or prompt", async () => {
    const savePlan = (userId: string, kind: "image" | "video", prompt: string, videoParameters?: AiVideoPlanParameters) => {
      const requestId = crypto.randomUUID();
      runtime.store.saveRequest({
        requestId, userId, hash: "saved-plan", status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
        inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "planner", mode: "quick",
        result: { requestId, content: "已整理，请确认后生成", model: "planner", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: kind === "video" ? { kind, summary: "方案", prompt, videoParameters: videoParameters! } : { kind, summary: "方案", prompt } },
      });
      return requestId;
    };
    const prompt = "品牌 Logo 缓慢推近";
    const validInput = input("a", prompt);
    const videoPlan = savePlan("a", "video", prompt, planParameters(validInput));
    const imagePlan = savePlan("a", "image", prompt);
    const calls = transport.mock.calls.length;
    const quota = runtime.service.quota("a");

    await expect(runtime.service.video.submit("a", { ...input(), prompt, planRequestId: undefined })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_REQUIRED" });
    await expect(runtime.service.video.submit("b", { ...input(), prompt, planRequestId: videoPlan })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });
    await expect(runtime.service.video.submit("a", { ...input(), prompt: "篡改后的提示词", planRequestId: videoPlan })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });
    await expect(runtime.service.video.submit("a", { ...input(), prompt, planRequestId: imagePlan })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });
    await expect(runtime.service.video.submit("a", { ...input(), prompt, planRequestId: "short" })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_INVALID" });
    expect(transport).toHaveBeenCalledTimes(calls);
    expect(runtime.service.video.list("a").jobs).toEqual([]);
    expect(runtime.service.quota("a")).toEqual(quota);

    const submitted = await runtime.service.video.submit("a", { ...validInput, planRequestId: videoPlan });
    expect(submitted).toMatchObject({ prompt, planRequestId: videoPlan, status: "queued" });
    expect(transport).toHaveBeenCalledTimes(calls + 1);
  });
  it("rejects every video plan parameter change before provider access or quota reservation", async () => {
    const request = input();
    const reference = await runtime.service.video.uploadReference("a", { dataUrl: "data:image/jpeg;base64,/9j/AAAA" });
    const changes: Array<Partial<VideoInput>> = [
      { model: "sd-2-c6" },
      { seconds: 14 },
      { resolution: "480p" },
      { aspectRatio: "9:16" },
      { referenceIds: [reference.id] },
    ];
    const quota = runtime.service.quota("a");
    for (const change of changes) {
      await expect(runtime.service.video.submit("a", { ...request, ...change })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });
    }
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.service.video.list("a").jobs).toEqual([]);
    expect(runtime.service.quota("a")).toEqual(quota);
  });
  it("binds a video plan to the exact reference contents and order, not only their count", async () => {
    const first = await runtime.service.video.uploadReference("a", { dataUrl: "data:image/jpeg;base64,/9j/AAAA" });
    const second = await runtime.service.video.uploadReference("a", { dataUrl: "data:image/jpeg;base64,/9j/BBBB" });
    const planned = input("a", "参考图不可替换", { referenceIds: [first.id, second.id] });
    const quota = runtime.service.quota("a");

    await expect(runtime.service.video.submit("a", { ...planned, referenceIds: [second.id, first.id] })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });
    await expect(runtime.service.video.submit("a", { ...planned, referenceIds: [first.id, first.id] })).rejects.toMatchObject({ code: "AI_TOOL_PLAN_MISMATCH" });

    expect(transport).not.toHaveBeenCalled();
    expect(runtime.service.video.list("a").jobs).toEqual([]);
    expect(runtime.service.quota("a")).toEqual(quota);
  });
  it("rejects an unverified non-default model before reading references, reserving quota or calling the provider", async () => {
    await runtime.service.video.configure({ ...config, defaultModel: "minimax_h3" });
    const request = input("a", "品牌短片", { model: "sd-2-c6", resolution: "720p", referenceIds: ["0".repeat(64)] });
    const quota = runtime.service.quota("a");

    await expect(runtime.service.video.submit("a", request)).rejects.toMatchObject({ code: "AI_VIDEO_MODEL_NOT_AUTHORIZED" });
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.service.video.list("a").jobs).toEqual([]);
    expect(runtime.service.quota("a")).toEqual(quota);
  });
  it("allows only the provider-listed, locally enabled models after verification", async () => {
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "sd-2-c6" }, { id: "sd-2.5-c1" }, { id: "unknown-provider-model" }] }));
    const check = await runtime.service.video.test();
    expect(check.availableModels).toEqual(["sd-2-c6", "sd-2.5-c1"]);
    const memberSettings = runtime.service.video.list("a").settings;
    expect(memberSettings).toMatchObject({ availableModels: ["sd-2-c6", "sd-2.5-c1"], defaultModel: "sd-2-c6", modelsVerified: true, profile: { resolutions: ["720p"], maxImages: 9, requiresImage: false } });

    transport.mockResolvedValueOnce(task());
    await runtime.service.video.submit("a", input("a", "品牌短片", { model: "sd-2-c6", resolution: "720p" }));
    expect(JSON.parse(transport.mock.calls[1][1].body!)).toMatchObject({ model: "sd-2-c6" });
  });
  it("fails closed when a successful model check finds no locally enabled model", async () => {
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "unknown-provider-model" }] }));
    expect((await runtime.service.video.test()).availableModels).toEqual([]);
    expect(runtime.service.video.list("a").settings).toEqual(expect.objectContaining({ availableModels: [], modelsVerified: false }));
    expect(runtime.service.video.list("a").settings.defaultModel).toBeUndefined();

    const quota = runtime.service.quota("a");
    await expect(runtime.service.video.submit("a", input())).rejects.toMatchObject({ code: "AI_VIDEO_MODEL_NOT_AUTHORIZED" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("a")).toEqual(quota);
  });
  it("binds verified models to the saved config and key versions, then clears them on either change", async () => {
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "minimax_h3" }, { id: "sd-2-c6" }] }));
    await runtime.service.video.test();
    const verified = JSON.parse(runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0].data);
    expect(verified).toMatchObject({ verifiedConfigVersion: verified.configVersion, verifiedKeyVersion: verified.keyVersion, verifiedModels: ["minimax_h3", "sd-2-c6"] });

    await runtime.service.video.configure({ enabled: true, quotaPoints: 1200, defaultModel: "sd-2-c6" });
    const changedConfig = JSON.parse(runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0].data);
    expect(changedConfig.configVersion).not.toBe(verified.configVersion);
    expect(changedConfig.keyVersion).toBe(verified.keyVersion);
    expect(changedConfig).not.toHaveProperty("verifiedModels");
    expect(runtime.service.video.settings()).toMatchObject({ availableModels: [], modelsVerified: false });

    await runtime.service.video.configure({ enabled: true, quotaPoints: 1200, defaultModel: "sd-2-c6", apiKey: "rotated-video-key" });
    const changedKey = JSON.parse(runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0].data);
    expect(changedKey.keyVersion).not.toBe(changedConfig.keyVersion);
    expect(changedKey).not.toHaveProperty("verifiedModels");
  });
  it("does not apply a stale model check after the administrator changes configuration", async () => {
    let finish!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const checking = runtime.service.video.test();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await runtime.service.video.configure({ enabled: true, quotaPoints: 1300, defaultModel: "sd-2-c6" });
    finish(Response.json({ data: [{ id: "minimax_h3" }, { id: "sd-2-c6" }] }));

    await expect(checking).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    expect(runtime.service.video.settings()).toMatchObject({ defaultModel: "sd-2-c6", availableModels: [], modelsVerified: false });
  });
  it("makes stale jobs visible to admin without resubmitting or releasing money", async () => {
    const req = input(); await runtime.service.video.submit("a", req);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    const pending = runtime.service.video.adminPending();
    expect(pending).toEqual([expect.objectContaining({ id: req.requestId, status: "uncertain", reserved: true, userId: "a" })]);
    expect(pending[0]).not.toHaveProperty("prompt");
    expect(pending[0]).not.toHaveProperty("conversationId");
    expect(pending[0]).not.toHaveProperty("referenceIds");
    expect(pending[0]).not.toHaveProperty("images");
    expect(pending[0]).not.toHaveProperty("encryptedKey");
    expect(runtime.service.quota("a").reservedTokens).toBe(1000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("settles completion only once and retains original credential after rotation", async () => {
    const req = input(); await runtime.service.video.submit("a", req);
    await runtime.service.video.configure({ ...config, apiKey: "new-video-key", quotaPoints: 9000 });
    transport.mockResolvedValue(task("completed", 100));
    await runtime.service.video.refresh("a", req.requestId); await runtime.service.video.refresh("a", req.requestId);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${config.apiKey}`);
    expect(runtime.service.quota("a")).toMatchObject({ reservedTokens: 0, usedTokens: 1000, remainingTokens: 9000 });
    expect(runtime.store.usage("a").filter(e => e.kind === "video")).toHaveLength(1);
  });
  it("refunds explicit rejected 403 but preserves uncertain submission and never retries", async () => {
    transport.mockResolvedValue(new Response("denied", { status: 403 }));
    const req = input(); expect(await runtime.service.video.submit("a", req)).toMatchObject({ status: "failed", reserved: false });
    expect(runtime.service.quota("a").remainingTokens).toBe(10000);
    await expect(runtime.service.video.submit("a", req)).resolves.toMatchObject({ status: "failed", reserved: false });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.usage("a").filter(entry => entry.requestId === req.requestId)).toHaveLength(1);
    transport.mockRejectedValue(new Error("private details and unknown submission"));
    const uncertain = input(); expect(await runtime.service.video.submit("a", uncertain)).toMatchObject({ status: "uncertain", reserved: true });
    await runtime.service.video.submit("a", uncertain); expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(runtime.service.video.list("a"))).not.toContain("private details");
    expect(runtime.service.video.reconcile("a", uncertain.requestId, "admin", { action: "release" }).reserved).toBe(false);
    await expect(runtime.service.video.submit("a", uncertain)).resolves.toMatchObject({ status: "failed" });
    expect(runtime.service.quota("a").remainingTokens).toBe(10000);
    expect(() => runtime.service.video.reconcile("a", uncertain.requestId, "admin", { action: "charge" })).toThrow();

    const chargedUnknown = input();
    expect(await runtime.service.video.submit("a", chargedUnknown)).toMatchObject({ status: "uncertain", reserved: true });
    expect(runtime.service.video.reconcile("a", chargedUnknown.requestId, "admin", { action: "charge" })).toMatchObject({ status: "failed", reserved: false });
    expect(runtime.service.quota("a")).toMatchObject({ usedTokens: 1000, reservedTokens: 0, remainingTokens: 9000 });
    expect(runtime.store.usage("a").find(entry => entry.requestId === chargedUnknown.requestId)).toMatchObject({ status: "failed", totalTokens: 1000, reason: expect.stringContaining("任务结果仍未验证") });
    expect(runtime.store.sql.all<{ success: number; error_code: string }>("SELECT success,error_code FROM ai_observability_events WHERE tenant_id=? ORDER BY rowid DESC LIMIT 1", runtime.store.tenantId)[0]).toEqual({ success: 0, error_code: "AI_VIDEO_RECONCILED_CHARGE_UNVERIFIED" });
  });
  it("keeps pending jobs on restart without chat recovery stealing their reservation", async () => {
    const req = input(); await runtime.service.video.submit("a", req); runtime.close();
    runtime = await createNodeAi(path.join(dir, "test.json"), transport);
    expect(runtime.service.video.list("a").jobs[0]).toMatchObject({ id: req.requestId, status: "queued" });
    expect(runtime.service.quota("a").reservedTokens).toBe(1000);
    transport.mockResolvedValue(task("completed", 100)); await runtime.service.video.refresh("a", req.requestId);
    expect(runtime.service.quota("a").usedTokens).toBe(1000);
  });
  it("validates content type, downloads only canonical provider path and bounds size", async () => {
    const req = input(); transport.mockResolvedValue(task("completed", 100)); await runtime.service.video.submit("a", req);
    transport.mockResolvedValue(new Response("invalid", { headers: { "Content-Type": "text/html" } }));
    await expect(runtime.service.video.content("a", req.requestId)).rejects.toMatchObject({ code: "AI_VIDEO_CONTENT_INVALID" });
    transport.mockResolvedValue(new Response(new Uint8Array([0,0,0,24]), { headers: { "Content-Type": "video/mp4" } }));
    const response = await runtime.service.video.content("a", req.requestId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(transport.mock.lastCall?.[0]).toBe("https://www.75api.com/v1/videos/task_fixture_12345678/content");
    expect(transport.mock.lastCall?.[1].maxResponseBytes).toBe(64 * 1024 * 1024);
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });
  it("checks a warm video's current owner and provider availability without downloading its body", async () => {
    const req = input(); transport.mockResolvedValue(task("completed", 100)); await runtime.service.video.submit("a", req);
    const used = runtime.service.quota("a").usedTokens;
    const callsBeforeDenied = transport.mock.calls.length;
    await expect(runtime.service.video.checkContent("b", req.requestId)).rejects.toMatchObject({ status: 404 });
    expect(transport).toHaveBeenCalledTimes(callsBeforeDenied);
    const cancelled = vi.fn();
    transport.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }), { headers: { "Content-Type": "video/mp4" } }));
    await expect(runtime.service.video.checkContent("a", req.requestId)).resolves.toEqual({ available: true });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(transport.mock.lastCall?.[0]).toBe("https://www.75api.com/v1/videos/task_fixture_12345678/content");
    expect(transport.mock.lastCall?.[1].method).toBe("GET");
    expect(transport.mock.lastCall?.[1].headers.Range).toBe("bytes=0-0");
    expect(runtime.service.quota("a").usedTokens).toBe(used);
    transport.mockResolvedValue(new Response("gone", { status: 404, headers: { "Content-Type": "text/plain" } }));
    await expect(runtime.service.video.checkContent("a", req.requestId)).rejects.toMatchObject({ code: "AI_PROVIDER_REJECTED" });
  });
  it("GET model test does not submit or reserve quota", async () => {
    transport.mockResolvedValue(Response.json({ data: [{ id: "minimax_h3" }, { id: "sd-2.5-c1" }, { id: "unrelated" }] }));
    const check = await runtime.service.video.test();
    expect(check).toMatchObject({ ok: true, models: [
      { id: "minimax_h3", listed: true },
      { id: "minimax_h3_no_audios_1080", listed: false },
      { id: "sd-2-c6", listed: false },
      { id: "sd-2.0-fast", listed: false },
      { id: "sd-2.5-c1", listed: true },
    ], availableModels: ["minimax_h3", "sd-2.5-c1"] });
    expect(check.message).toContain("成员端只显示这些模型");
    expect(runtime.service.video.settings()).toMatchObject({ availableModels: ["minimax_h3", "sd-2.5-c1"], modelsVerified: true });
    expect(transport.mock.calls[0][0]).toBe("https://www.75api.com/v1/models"); expect(transport.mock.calls[0][1].method).toBe("GET");
    expect(runtime.service.quota("a").remainingTokens).toBe(10000);
  });
});
