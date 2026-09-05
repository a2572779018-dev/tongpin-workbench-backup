import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type AppRuntime } from "../app";
import type { AppConfig } from "../config";
import type { AiTransport } from "./provider";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const KEY = "tool-routes-fixture-key-not-real";
const PASSWORD = "ToolRoutesFixture20260905!";

describe.sequential("AI tool APIs through real isolated Node authentication", () => {
  let directory: string;
  let runtime: AppRuntime;
  const sessions: Record<string, { token: string; id: string }> = {};
  const transport = vi.fn<AiTransport>();
  function headers(actor: string, accountId = sessions[actor].id) {
    return { Authorization: `Bearer ${sessions[actor].token}`, "X-Tongpin-Account": accountId };
  }
  async function createImage() {
    const requestId = crypto.randomUUID();
    const response = await request(runtime.app).post("/api/ai/images").set(headers("a")).send({ requestId, prompt: "隔离测试的私有图片", userId: sessions.b.id }).expect(200);
    return { requestId, assetId: response.body.images[0].assetId as string, result: response.body };
  }
  beforeAll(async () => {
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
    await runtime.store.mutate(db => {
      const admin = db.users.find(user => user.role === "admin")!;
      for (const actor of ["a", "b", "boss"]) db.users.push({ ...admin, id: `tools-${actor}`, role: actor === "boss" ? "boss" : "member", email: `tools-${actor}@tongpin.test`, name: `隔离账号${actor}` });
    });
    for (const actor of ["admin", "a", "b", "boss"]) {
      const login = await request(runtime.app).post("/api/auth/login").send({ email: `tools-${actor}@tongpin.test`, password: PASSWORD }).expect(200);
      sessions[actor] = { token: login.body.accessToken, id: login.body.user.id };
    }
    await request(runtime.app).put("/api/admin/ai/provider").set(headers("admin")).send({
      name: "隔离测试服务", baseUrl: "https://provider.example.com", apiKey: KEY, protocol: "responses", quickModel: "quick", deepModel: "deep",
      maxOutputTokens: 1024, reasoningEffort: "", enabled: true, imageModel: "image-model", imageQuotaTokens: 1000,
    }).expect(200);
    await request(runtime.app).put(`/api/admin/ai/members/${sessions.a.id}/quota`).set(headers("admin")).send({ limitTokens: 100000 }).expect(200);
  });
  beforeEach(() => { transport.mockClear(); });
  afterAll(async () => {
    if (runtime) await runtime.close();
    if (directory) await rm(directory, { recursive: true });
  });

  it("requires authentication and denies admin/boss access to member tool APIs", async () => {
    for (const endpoint of ["/api/ai/assets/unknown", "/api/ai/requests/unknown"]) {
      await request(runtime.app).get(endpoint).expect(401);
      for (const actor of ["admin", "boss"]) await request(runtime.app).get(endpoint).set(headers(actor)).expect(403);
    }
    await request(runtime.app).post("/api/ai/images").send({ requestId: crypto.randomUUID(), prompt: "未登录" }).expect(401);
    for (const actor of ["admin", "boss"]) {
      await request(runtime.app).post("/api/ai/images").set(headers(actor)).send({ requestId: crypto.randomUUID(), prompt: "无成员权限" }).expect(403);
      await request(runtime.app).delete("/api/ai/assets/unknown").set(headers(actor)).expect(403);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["wrong-account", ""])("rejects a wrong or empty X-Tongpin-Account %j before tool actions", async boundAccount => {
    const binding = headers("a", boundAccount);
    for (const endpoint of ["/api/ai/assets/unknown", "/api/ai/requests/unknown"]) {
      const result = await request(runtime.app).get(endpoint).set(binding).expect(409);
      expect(result.body.error.code).toBe("AI_ACCOUNT_CHANGED");
    }
    await request(runtime.app).post("/api/ai/images").set(binding).send({ requestId: crypto.randomUUID(), prompt: "不能跨账号执行" }).expect(409);
    await request(runtime.app).delete("/api/ai/assets/unknown").set(binding).expect(409);
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
    const asset = await request(runtime.app).get(`/api/ai/assets/${assetId}`).set(headers("a")).expect(200);
    expect(asset.headers["cache-control"]).toBe("no-store"); expect(asset.body.base64).toBe(PNG);
    const recovered = await request(runtime.app).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
    expect(recovered.body).toMatchObject({ status: "completed", imageResult: { images: [{ assetId }] } });
    for (const endpoint of [`/api/ai/assets/${assetId}`, `/api/ai/requests/${requestId}`]) {
      await request(runtime.app).get(`${endpoint}?userId=${sessions.a.id}`).set(headers("b")).expect(404);
      await request(runtime.app).get(endpoint).set(headers("admin")).expect(403);
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("permits owner deletion only and keeps billed usage and request recovery immutable", async () => {
    const { assetId, requestId } = await createImage();
    const used = runtime.aiStore.quota(sessions.a.id).usedTokens;
    await request(runtime.app).delete(`/api/ai/assets/${assetId}?userId=${sessions.a.id}`).set(headers("b")).expect(404);
    await request(runtime.app).delete(`/api/ai/assets/${assetId}`).set(headers("a", sessions.b.id)).expect(409);
    await request(runtime.app).get(`/api/ai/assets/${assetId}`).set(headers("a")).expect(200);
    await request(runtime.app).delete(`/api/ai/assets/${assetId}`).set(headers("a")).expect(200);
    await request(runtime.app).get(`/api/ai/assets/${assetId}`).set(headers("a")).expect(404);
    await request(runtime.app).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
    expect(runtime.aiStore.quota(sessions.a.id).usedTokens).toBe(used);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("recovers completed text without exposing prompts or reissuing a provider request", async () => {
    const requestId = crypto.randomUUID(); const prompt = "仅成员甲知道的测试输入";
    await request(runtime.app).post("/api/ai/chat").set(headers("a")).send({ requestId, mode: "quick", messages: [{ role: "user", content: prompt }] }).expect(200);
    const recovered = await request(runtime.app).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
    expect(recovered.body).toMatchObject({ status: "completed", result: { content: "隔离测试回复", usage: { totalTokens: 20 } } });
    expect(JSON.stringify(recovered.body)).not.toContain(prompt); expect(JSON.stringify(recovered.body)).not.toContain(KEY);
    await request(runtime.app).get(`/api/ai/requests/${requestId}`).set(headers("b")).expect(404);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("shows pending state without issuing another generation and preserves owner isolation", async () => {
    let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
    transport.mockImplementationOnce(async () => { await hold; return Response.json({ data: [{ b64_json: PNG }] }); });
    const requestId = crypto.randomUUID();
    const generating = request(runtime.app).post("/api/ai/images").set(headers("a")).send({ requestId, prompt: "仍在生成中的测试图片" }).then(value => value);
    try {
      await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
      const pending = await request(runtime.app).get(`/api/ai/requests/${requestId}`).set(headers("a")).expect(200);
      expect(pending.body).toEqual({ requestId, status: "pending" });
      await request(runtime.app).get(`/api/ai/requests/${requestId}`).set(headers("b")).expect(404);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally { release(); expect((await generating).status).toBe(200); }
  });
  it("blocks zero-quota and deactivated members before generation", async () => {
    const exhausted = await request(runtime.app).post("/api/ai/images").set(headers("b")).send({ requestId: crypto.randomUUID(), prompt: "没有额度" }).expect(402);
    expect(exhausted.body.error.code).toBe("AI_QUOTA_EXHAUSTED");
    await runtime.store.mutate(db => { db.users.find(user => user.id === sessions.b.id)!.status = "disabled"; });
    try {
      await request(runtime.app).post("/api/ai/images").set(headers("b")).send({ requestId: crypto.randomUUID(), prompt: "已停用" }).expect(401);
      await request(runtime.app).get("/api/ai/requests/unknown").set(headers("b")).expect(401);
    } finally { await runtime.store.mutate(db => { db.users.find(user => user.id === sessions.b.id)!.status = "active"; }); }
    expect(transport).not.toHaveBeenCalled();
  });
});
