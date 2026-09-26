import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type AppRuntime } from "../app";
import type { AppConfig } from "../config";
import type { AiTransport } from "./provider";
import { toolPlanContextFingerprint } from "./toolPlans";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const KEY = "tool-routes-fixture-key-not-real";
const PASSWORD = "ToolRoutesFixture20260905!";

describe.sequential("AI tool APIs through real isolated Node authentication", () => {
  let directory: string;
  let runtime: AppRuntime;
  let http: Server | undefined;
  let emptyToolPlanContextFingerprint: string;
  const sessions: Record<string, { token: string; id: string }> = {};
  const transport = vi.fn<AiTransport>();
  function headers(actor: string, accountId = sessions[actor].id) {
    return { Authorization: `Bearer ${sessions[actor].token}`, "X-Tongpin-Account": accountId };
  }
  function saveImagePlan(actor: string, prompt: string) {
    const requestId = crypto.randomUUID();
    runtime.aiStore.saveRequest({
      requestId, userId: sessions[actor].id, hash: `fixture-${requestId}`, status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "quick", mode: "quick",
      toolPlanContextFingerprint: emptyToolPlanContextFingerprint,
      result: {
        requestId, content: "已整理图片任务，请确认后生成。", model: "quick",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false },
        toolPlan: { kind: "image", summary: "测试图片方案", prompt },
      },
    });
    return requestId;
  }
  async function createImage() {
    const requestId = crypto.randomUUID();
    const prompt = "隔离测试的私有图片";
    const response = await request(http!).post("/api/ai/images").set(headers("a")).send({ requestId, prompt, planRequestId: saveImagePlan("a", prompt), userId: sessions.b.id }).expect(200);
    return { requestId, assetId: response.body.images[0].assetId as string, result: response.body };
  }
  beforeAll(async () => {
    emptyToolPlanContextFingerprint = await toolPlanContextFingerprint();
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-tools-route-test-"));
    const config: AppConfig = {
      host: "127.0.0.1", port: 0, dataFile: path.join(directory, "runtime.json"), jwtSecret: "tool-route-fixture-jwt-secret-not-for-production",
      clientOrigins: [], bootstrapAdminEmail: "tools-admin@tongpin.test", bootstrapAdminPassword: PASSWORD, bootstrapAdminName: "隔离管理员",
      devEmailPreview: false, isProduction: false, loraExplorerApi: "https://explorer.invalid/api/v2", loraRpcUrl: "https://rpc.invalid",
      resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
    };
    transport.mockImplementation(async (url, init) => {
      expect(new URL(url).hostname).toBe("provider.example.com");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${KEY}`);
      return new URL(url).pathname.endsWith("/images/generations")
        ? Response.json({ data: [{ b64_json: PNG }] })
        : Response.json({ output_text: "隔离测试回复", status: "completed", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } });
    });
    runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false, aiTransport: transport });
    http = await listenLoopback(runtime.app);
    await runtime.store.mutate(db => {
      const admin = db.users.find(user => user.role === "admin")!;
      for (const actor of ["a", "b", "boss"]) db.users.push({ ...admin, id: `tools-${actor}`, role: actor === "boss" ? "boss" : "member", email: `tools-${actor}@tongpin.test`, name: `隔离账号${actor}` });
    });
    for (const actor of ["admin", "a", "b", "boss"]) {
      const login = await request(http!).post("/api/auth/login").send({ email: `tools-${actor}@tongpin.test`, password: PASSWORD }).expect(200);
      sessions[actor] = { token: login.body.accessToken, id: login.body.user.id };
    }
    await request(http!).put("/api/admin/ai/provider").set(headers("admin")).send({
      name: "隔离测试服务", baseUrl: "https://provider.example.com", apiKey: KEY, protocol: "responses", quickModel: "quick", deepModel: "deep",
      maxOutputTokens: 1024, reasoningEffort: "", enabled: true, imageModel: "image-model", imageQuotaTokens: 1000,
    }).expect(200);
    await request(http!).put(`/api/admin/ai/members/${sessions.a.id}/quota`).set(headers("admin")).send({ limitTokens: 100000 }).expect(200);
  });
  beforeEach(() => { transport.mockClear(); });
  afterAll(async () => {
    await closeServer(http);
    if (runtime) await runtime.close();
    if (directory) await rm(directory, { recursive: true });
  });

  it("requires authentication and denies admin access to personal tool APIs", async () => {
    for (const endpoint of ["/api/ai/assets/unknown", "/api/ai/assets/unknown/check", "/api/ai/requests/unknown"]) {
      await request(http!).get(endpoint).expect(401);
      await request(http!).get(endpoint).set(headers("admin")).expect(403);
    }
    await request(http!).post("/api/ai/images").send({ requestId: crypto.randomUUID(), prompt: "未登录" }).expect(401);
    for (const actor of ["admin"]) {
      await request(http!).post("/api/ai/images").set(headers(actor)).send({ requestId: crypto.randomUUID(), prompt: "无成员权限" }).expect(403);
      await request(http!).delete("/api/ai/assets/unknown").set(headers(actor)).expect(403);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("authenticates streaming and replay routes and retains the legacy JSON contract", async () => {
    const body = { requestId: crypto.randomUUID(), conversationId: "stream-isolated", mode: "quick", messages: [{ role: "user", content: "无费用流式协议测试" }] };
    await request(http!).post("/api/ai/chat/stream").send(body).expect(401);
    await request(http!).post("/api/ai/chat/stream").set(headers("admin")).send(body).expect(403);
    await request(http!).post("/api/ai/chat/stream").set(headers("a", sessions.b.id)).send(body).expect(409);
    expect(transport).not.toHaveBeenCalled();
    const streamed = await request(http!).post("/api/ai/chat/stream").set(headers("a")).send(body).expect(200);
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.text).toContain('"type":"run_started"');
    expect(streamed.text).toContain('"type":"usage_updated"');
    expect(streamed.text).toContain('"type":"run_finished"');
    expect(streamed.text).not.toContain(KEY);
    const replay = await request(http!).get(`/api/ai/requests/${body.requestId}/events`).set(headers("a")).expect(200);
    expect(replay.body.events.map((event: { seq: number }) => event.seq)).toEqual([1, 2, 3]);
    expect(replay.body.events[1]).toMatchObject({ type: "usage_updated", data: { providerReported: true, usage: { totalTokens: 20 } } });
    await request(http!).get(`/api/ai/requests/${body.requestId}/events`).set(headers("b")).expect(403);
    const old = await request(http!).post("/api/ai/chat").set(headers("a")).send(body).expect(200);
    expect(old.body.content).toBe("隔离测试回复");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("lists bosses without a default grant and lets only admin enable their isolated AI account", async () => {
    const members = await request(http!).get("/api/admin/ai/members").set(headers("admin")).expect(200);
    expect(members.body.members.find((actor: { id: string }) => actor.id === sessions.boss.id)).toMatchObject({ role: "boss", quota: { limitTokens: 0 } });
    expect((await request(http!).get("/api/ai/status").set(headers("boss")).expect(200)).body.accessGranted).toBe(false);
    for (const endpoint of ["/api/ai/persona", "/api/ai/workspace"]) await request(http!).get(endpoint).set(headers("boss")).expect(403);
    await request(http!).post("/api/ai/images").set(headers("boss")).send({ requestId: crypto.randomUUID(), prompt: "尚未开通" }).expect(403);
    await request(http!).get("/api/admin/ai/provider").set(headers("boss")).expect(403);
    await request(http!).put(`/api/admin/ai/members/${sessions.boss.id}/quota`).set(headers("boss")).send({ limitTokens: 10000 }).expect(403);
    await request(http!).put(`/api/admin/ai/members/${sessions.boss.id}/quota`).set(headers("admin")).send({ limitTokens: 10000 }).expect(200);
    const requestId = crypto.randomUUID(), beforeA = runtime.aiStore.quota(sessions.a.id);
    const response = await request(http!).post("/api/ai/chat").set(headers("boss")).send({ requestId, mode: "quick", messages: [{ role: "user", content: "仅老板的消息" }], userId: sessions.a.id }).expect(200);
    expect(response.body.quota).toMatchObject({ usedTokens: 20, remainingTokens: 9980 });
    expect(runtime.aiStore.quota(sessions.a.id)).toEqual(beforeA);
    await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("boss")).expect(200);
    await request(http!).get(`/api/ai/requests/${requestId}?userId=${sessions.boss.id}`).set(headers("a")).expect(404);
    await request(http!).get("/api/ai/status").set(headers("boss", sessions.a.id)).expect(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("returns safe upstream image diagnostics without repeating a paid failure", async () => {
    const usedBefore = runtime.aiStore.quota(sessions.a.id).usedTokens;
    transport.mockResolvedValueOnce(Response.json({ error: { code: "server_error", param: "output_format", message: `${KEY} PRIVATE_IMAGE_PROMPT` } }, { status: 503 }));
    const prompt = "图片测试";
    const body = { requestId: crypto.randomUUID(), prompt, planRequestId: saveImagePlan("a", prompt) };
    const failed = await request(http!).post("/api/ai/images").set(headers("a")).send(body).expect(502);
    expect(failed.headers["cache-control"]).toBe("no-store");
    expect(failed.body.error).toMatchObject({ code: "AI_PROVIDER_UNAVAILABLE", diagnostic: { operation: "image", httpStatus: 503, billing: "unknown", code: "server_error", param: "output_format" } });
    expect(JSON.stringify(failed.body)).not.toMatch(/tool-routes-fixture-key|PRIVATE_IMAGE_PROMPT/);
    const replay = await request(http!).post("/api/ai/images").set(headers("a")).send(body).expect(502);
    expect(replay.body).toEqual(failed.body);
    expect((await request(http!).get(`/api/ai/requests/${body.requestId}`).set(headers("a")).expect(200)).body).toMatchObject({ status: "uncertain", error: { diagnostic: failed.body.error.diagnostic } });
    await request(http!).get(`/api/ai/requests/${body.requestId}`).set(headers("b")).expect(404);
    expect(runtime.aiStore.quota(sessions.a.id)).toMatchObject({ usedTokens: usedBefore + 1000, reservedTokens: 0 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("persists a granted boss's persona and workspace through the real Node routes without exposing member data", async () => {
    const profile = (name: string) => ({ name, tone: "warm", customStyle: "先给结论", preferences: "中文", onboardingComplete: true });
    const state = (title: string) => ({ view: "chat", mode: "quick", projects: [], conversations: [{ id: "private-chat", title, timeLabel: "刚刚", messages: [{ id: "private-message", role: "user", content: title, time: "10:00" }] }], artifacts: [], drafts: {}, activeConversationId: "private-chat", activeProjectId: null, enabledSkillIds: [] });
    const memberPersona = await request(http!).put("/api/ai/persona").set(headers("a")).send({ expectedRevision: 0, profile: profile("成员专属助手") }).expect(200);
    const memberWorkspace = await request(http!).put("/api/ai/workspace").set(headers("a")).send({ expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("成员私有对话") }).expect(200);
    expect((await request(http!).get(`/api/ai/persona?userId=${sessions.a.id}`).set(headers("boss")).expect(200)).body.profile.name).toBe("");
    expect((await request(http!).get(`/api/ai/workspace?userId=${sessions.a.id}`).set(headers("boss")).expect(200)).body.state).toBeNull();
    const bossPersona = await request(http!).put("/api/ai/persona").set(headers("boss")).send({ expectedRevision: 0, profile: profile("老板专属助手") }).expect(200);
    const bossWorkspace = await request(http!).put("/api/ai/workspace").set(headers("boss")).send({ expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("老板私有对话") }).expect(200);
    expect((await request(http!).get("/api/ai/persona").set(headers("boss")).expect(200)).body).toEqual(bossPersona.body);
    expect((await request(http!).get("/api/ai/workspace").set(headers("boss")).expect(200)).body).toEqual(bossWorkspace.body);
    expect((await request(http!).get("/api/ai/persona").set(headers("a")).expect(200)).body).toEqual(memberPersona.body);
    expect((await request(http!).get("/api/ai/workspace").set(headers("a")).expect(200)).body).toEqual(memberWorkspace.body);
    for (const endpoint of ["/api/ai/persona", "/api/ai/workspace"]) {
      await request(http!).get(endpoint).set(headers("admin")).expect(403);
      await request(http!).get(endpoint).set(headers("boss", sessions.a.id)).expect(409);
      await request(http!).put(endpoint).set(headers("boss", sessions.a.id)).send({ expectedRevision: 1 }).expect(409);
    }
    await runtime.store.mutate(db => { db.users.find(user => user.id === sessions.boss.id)!.status = "disabled"; });
    try {
      for (const endpoint of ["/api/ai/persona", "/api/ai/workspace"]) await request(http!).get(endpoint).set(headers("boss")).expect(401);
    } finally { await runtime.store.mutate(db => { db.users.find(user => user.id === sessions.boss.id)!.status = "active"; }); }
    expect(transport).not.toHaveBeenCalled();
  });
  it("returns safe preflight and send-time shortfall details without calling a provider", async () => {
    const saved = await request(http!).get("/api/admin/ai/provider").set(headers("admin")).expect(200);
    await request(http!).put("/api/admin/ai/provider").set(headers("admin")).send({ ...saved.body.provider, webSearchEnabled: true, webSearchQuotaTokens: 100 }).expect(200);
    const body = { requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "你好" }], webSearch: true, userId: sessions.a.id };
    await request(http!).post("/api/ai/preflight").send(body).expect(401);
    const checked = await request(http!).post("/api/ai/preflight").set(headers("boss")).send(body).expect(200);
    expect(checked.headers["cache-control"]).toBe("no-store");
    expect(checked.body).toMatchObject({ canSend: false, reason: "search_quota_insufficient", quota: { remainingTokens: 9980 }, withoutWebSearch: { canSend: true } });
    const denied = await request(http!).post("/api/ai/chat").set(headers("boss")).send(body).expect(402);
    expect(denied.body.error).toMatchObject({ code: "AI_SEARCH_QUOTA_INSUFFICIENT", details: checked.body });
    for (const actor of ["admin", "b"]) await request(http!).post("/api/ai/preflight").set(headers(actor)).send(body).expect(403);
    await request(http!).post("/api/ai/preflight").set(headers("boss", sessions.a.id)).send(body).expect(409);
    expect(transport).not.toHaveBeenCalled();
    expect(JSON.stringify(checked.body)).not.toContain(KEY);
    await request(http!).get(`/api/ai/requests/${body.requestId}`).set(headers("boss")).expect(404);
  });
  it.each(["wrong-account", ""])("rejects a wrong or empty X-Tongpin-Account %j before tool actions", async boundAccount => {
    const binding = headers("a", boundAccount);
    for (const endpoint of ["/api/ai/assets/unknown", "/api/ai/assets/unknown/check", "/api/ai/requests/unknown"]) {
      const result = await request(http!).get(endpoint).set(binding).expect(409);
      expect(result.body.error.code).toBe("AI_ACCOUNT_CHANGED");
    }
    await request(http!).post("/api/ai/images").set(binding).send({ requestId: crypto.randomUUID(), prompt: "不能跨账号执行" }).expect(409);
    await request(http!).delete("/api/ai/assets/unknown").set(binding).expect(409);
    expect(transport).not.toHaveBeenCalled();
  });
  it("only exposes an image and recovered request to their authenticated owner", async () => {
    const beforeA = runtime.aiStore.quota(sessions.a.id).usedTokens;
    const beforeB = runtime.aiStore.quota(sessions.b.id).usedTokens;
    const { assetId, requestId, result } = await createImage();
    expect(result).toMatchObject({ usage: { convertedTokens: 1000, totalTokens: 1000, billingKind: "image_conversion" } });
    expect(JSON.stringify(result)).not.toContain(PNG); expect(JSON.stringify(result)).not.toContain(KEY);
    expect(runtime.aiStore.quota(sessions.a.id).usedTokens).toBe(beforeA + 1000);
    expect(runtime.aiStore.quota(sessions.b.id).usedTokens).toBe(beforeB);
    const asset = await request(http!).get(`/api/ai/assets/${assetId}`).set(headers("a")).expect(200);
    expect(asset.headers["cache-control"]).toBe("no-store"); expect(asset.body.base64).toBe(PNG);
    const checked = await request(http!).get(`/api/ai/assets/${assetId}/check`).set(headers("a")).expect(200);
    expect(checked.headers["cache-control"]).toBe("no-store");
    expect(checked.body).toEqual({ assetId, mimeType: "image/png", byteLength: 68 });
    expect(JSON.stringify(checked.body)).not.toContain(PNG);
    await request(http!).get(`/api/ai/assets/${assetId}/check`).set(headers("b")).expect(404);
    const recovered = await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
    expect(recovered.body).toMatchObject({ status: "completed", imageResult: { images: [{ assetId }] } });
    for (const endpoint of [`/api/ai/assets/${assetId}`, `/api/ai/requests/${requestId}`]) {
      await request(http!).get(`${endpoint}?userId=${sessions.a.id}`).set(headers("b")).expect(404);
      await request(http!).get(endpoint).set(headers("admin")).expect(403);
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("permits owner deletion only and keeps billed usage and request recovery immutable", async () => {
    const { assetId, requestId } = await createImage();
    const used = runtime.aiStore.quota(sessions.a.id).usedTokens;
    await request(http!).delete(`/api/ai/assets/${assetId}?userId=${sessions.a.id}`).set(headers("b")).expect(404);
    await request(http!).delete(`/api/ai/assets/${assetId}`).set(headers("a", sessions.b.id)).expect(409);
    await request(http!).get(`/api/ai/assets/${assetId}`).set(headers("a")).expect(200);
    await request(http!).delete(`/api/ai/assets/${assetId}`).set(headers("a")).expect(200);
    await request(http!).get(`/api/ai/assets/${assetId}`).set(headers("a")).expect(404);
    await request(http!).get(`/api/ai/assets/${assetId}/check`).set(headers("a")).expect(404);
    await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
    expect(runtime.aiStore.quota(sessions.a.id).usedTokens).toBe(used);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("recovers completed text without exposing prompts or reissuing a provider request", async () => {
    const requestId = crypto.randomUUID(); const prompt = "仅成员甲知道的测试输入";
    await request(http!).post("/api/ai/chat").set(headers("a")).send({ requestId, mode: "quick", messages: [{ role: "user", content: prompt }] }).expect(200);
    const recovered = await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
    expect(recovered.body).toMatchObject({ status: "completed", result: { content: "隔离测试回复", usage: { totalTokens: 20 } } });
    expect(JSON.stringify(recovered.body)).not.toContain(prompt); expect(JSON.stringify(recovered.body)).not.toContain(KEY);
    await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("b")).expect(404);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("shows pending state without issuing another generation and preserves owner isolation", async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await hold; return Response.json({ data: [{ b64_json: PNG }] }); });
    const requestId = crypto.randomUUID();
    const prompt = "仍在生成中的测试图片";
    const generating = request(http!).post("/api/ai/images").set(headers("a")).send({ requestId, prompt, planRequestId: saveImagePlan("a", prompt) }).then(value => value);
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const pending = await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
      expect(pending.body).toEqual({ requestId, status: "pending" });
      await request(http!).get(`/api/ai/requests/${requestId}`).set(headers("b")).expect(404);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { release(); expect((await generating).status).toBe(200); }
  });
  it("blocks zero-quota and deactivated members before generation", async () => {
    const exhausted = await request(http!).post("/api/ai/images").set(headers("b")).send({ requestId: crypto.randomUUID(), prompt: "没有额度" }).expect(403);
    expect(exhausted.body.error.code).toBe("AI_ACCESS_NOT_GRANTED");
    await runtime.store.mutate(db => { db.users.find(user => user.id === sessions.b.id)!.status = "disabled"; });
    try {
      await request(http!).post("/api/ai/images").set(headers("b")).send({ requestId: crypto.randomUUID(), prompt: "已停用" }).expect(401);
      await request(http!).get("/api/ai/requests/unknown").set(headers("b")).expect(401);
    } finally { await runtime.store.mutate(db => { db.users.find(user => user.id === sessions.b.id)!.status = "active"; }); }
    expect(transport).not.toHaveBeenCalled();
  });
});
