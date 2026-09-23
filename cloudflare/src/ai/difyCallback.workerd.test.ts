import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolPlanContextFingerprint } from "../../../server/ai/toolPlans";
import { DifyToolRuntime } from "../../../server/ai/difyRuntime";
import { AiStore, type AiSql, type StoredRequest } from "../../../server/ai/storage";
import { AiService } from "../../../server/ai/service";
import { createSecretBox } from "../../../server/ai/security";

const SERVICE_SECRET = "worker-dify-service-credential-at-least-32-bytes";
const JWT_SECRET = "dify-worker-fixture-secret-".repeat(4);
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PASSWORD = "DifyWorkerFixture2026!";

describe("Dify callback through the bundled Worker and SQLite Durable Object", () => {
  let directory: string;
  let mf: Miniflare;
  let providerPosts = 0;
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") return MfResponse.json({ Status: 0, Answer: [{ type: 1, data: "1.1.1.1" }] });
    expect(url.hostname).toBe("provider.example.com");
    expect(url.pathname).toBe("/v1/images/generations");
    expect(request.headers.get("Authorization")).toBe("Bearer fixture-provider-key-not-real");
    providerPosts++;
    return MfResponse.json({ data: [{ b64_json: PNG }] });
  };
  const api = async (path: string, body?: unknown, authorization?: string, method = "POST") => {
    const response = await mf.dispatchFetch(`http://tongpin-fixture.local${path}`, {
      method, headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: `Bearer ${authorization}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-dify-worker-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: "tongpin-dify-worker-fixture", modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: { JWT_SECRET, BOOTSTRAP_ADMIN_EMAIL: "admin@fixture.local", DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local", AI_ALLOWED_HOSTS: "provider.example.com", DIFY_TOOL_ENABLED: "true", DIFY_APP_ID: "worker-fixture-app", DIFY_TOOL_SECRET: SERVICE_SECRET, LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com" },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
  }, 30_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("routes capability callbacks without a browser session and bounds their body before Durable Object parsing", async () => {
    const callback = "http://tongpin-fixture.local/api/dify/tools/invoke";
    const missing = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ error: { code: "DIFY_TOOL_AUTH_INVALID" } });
    const wrongService = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json", "X-Dify-Tool-Secret": "wrong-service-credential-at-least-32-bytes", Authorization: `Bearer ${"a".repeat(64)}` }, body: "{}" });
    expect(wrongService.status).toBe(401);
    expect(await wrongService.json()).toMatchObject({ error: { code: "DIFY_TOOL_AUTH_INVALID" } });
    const missingGrant = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json", "X-Dify-Tool-Secret": SERVICE_SECRET }, body: "{}" });
    expect(missingGrant.status).toBe(401);
    expect(await missingGrant.json()).toMatchObject({ error: { code: "DIFY_TOOL_AUTH_INVALID" } });
    const wrongGrant = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json", "X-Dify-Tool-Secret": SERVICE_SECRET, Authorization: `Bearer ${"a".repeat(64)}` }, body: JSON.stringify({ tenantId: "default" }) });
    expect(wrongGrant.status).toBe(403);
    expect(await wrongGrant.json()).toMatchObject({ error: { code: "DIFY_TOOL_AUTH_INVALID" } });
    const tooLarge = await mf.dispatchFetch(callback, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(17_000) }) });
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
  }, 30_000);
  it("accepts a real member-approved callback only with both credentials and charges once", async () => {
    const adminEmail = "admin@fixture.local", memberEmail = "member@fixture.local";
    for (const [email, name] of [[adminEmail, "Admin"], [memberEmail, "Member"]]) {
      const registered = await api("/api/auth/register", { email, name, password: PASSWORD });
      expect(registered.status).toBe(201);
      expect((await api("/api/auth/verify-email", { email, code: registered.body.debugCode })).status).toBe(200);
    }
    const admin = await api("/api/auth/login", { email: adminEmail, password: PASSWORD });
    expect(admin.body.user.role).toBe("admin");
    const users = await api("/api/admin/users", undefined, admin.body.accessToken, "GET");
    const memberId = (users.body.users as Array<{ id: string; email: string }>).find(user => user.email === memberEmail)!.id;
    expect((await api(`/api/admin/users/${memberId}/access`, { status: "active" }, admin.body.accessToken, "PATCH")).status).toBe(200);
    const member = await api("/api/auth/login", { email: memberEmail, password: PASSWORD });
    expect(member.status).toBe(200);
    const provider = { name: "Fixture", baseUrl: "https://provider.example.com", apiKey: "fixture-provider-key-not-real", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true, imageModel: "fixture-image", imageQuotaTokens: 100 };
    expect((await api("/api/admin/ai/provider", provider, admin.body.accessToken, "PUT")).status).toBe(200);
    expect((await api(`/api/admin/ai/members/${memberId}/quota`, { limitTokens: 1000 }, admin.body.accessToken, "PUT")).status).toBe(200);
    const planRequestId = crypto.randomUUID(), requestId = crypto.randomUUID();
    const storage = await mf.unsafeGetDurableObjectStorage("tongpin-dify-worker-fixture", "TongpinCore", { name: "primary" });
    const saved: StoredRequest = { requestId: planRequestId, userId: memberId, conversationId: "worker-dify-conversation", hash: "fixture", kind: "chat", status: "completed", model: "quick", mode: "quick", inputReserve: 0, outputReserve: 0, createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000, toolPlanExpiresAt: Date.now() + 600_000, toolPlanContextFingerprint: await toolPlanContextFingerprint(), result: { requestId: planRequestId, content: "Fixture saved plan", model: "quick", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "image", summary: "fixture", prompt: "one test image" } } };
    await storage.exec("INSERT INTO ai_requests(user_id,request_id,data) VALUES(?,?,?)", memberId, planRequestId, JSON.stringify(saved));
    expect((await api("/api/ai/dify/grants", { planRequestId, requestId, maxPoints: 100 }, member.body.accessToken)).status).toBe(404);
    // Miniflare's inspection handle exposes asynchronous SQL only, not the Durable Object
    // transaction API. Issue through the real runtime against an identical isolated AI
    // snapshot, then insert only its server-side grant row into the Worker fixture.
    const grantDb = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) grantDb.prepare(query).run(...bindings); else grantDb.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return grantDb.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { grantDb.exec("BEGIN"); try { const result = action(); grantDb.exec("COMMIT"); return result; } catch (error) { grantDb.exec("ROLLBACK"); throw error; } },
    };
    const localStore = new AiStore(sql); localStore.initialize();
    const localService = new AiService(localStore, () => createSecretBox("worker-grant-fixture-secret-at-least-32-bytes"), async () => Response.json({}));
    let approved: Awaited<ReturnType<DifyToolRuntime["issueGrant"]>>;
    try {
      const settings = await storage.exec<{ id: string; tenant_id: string; data: string }>("SELECT id,tenant_id,data FROM ai_settings");
      for (const row of settings) localStore.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?)", row.id, row.tenant_id, row.data);
      const quotas = await storage.exec<{ user_id: string; tenant_id: string; data: string }>("SELECT user_id,tenant_id,data FROM ai_quotas WHERE user_id=?", memberId);
      for (const row of quotas) localStore.sql.exec("INSERT INTO ai_quotas(user_id,tenant_id,data) VALUES(?,?,?)", row.user_id, row.tenant_id, row.data);
      localStore.saveRequest(saved);
      approved = await new DifyToolRuntime(localService, { enabled: true, appId: "worker-fixture-app" }, (tenantId, userId) => tenantId === "default" && userId === memberId).issueGrant({ tenantId: "default", userId: memberId }, { planRequestId, requestId, maxPoints: 100 });
      const grant = localStore.sql.all<{ token_hash: string; tenant_id: string; user_id: string; plan_id: string; request_id: string; expires_at: number; data: string }>("SELECT * FROM ai_dify_tool_grants WHERE request_id=?", requestId)[0];
      await storage.exec("INSERT INTO ai_dify_tool_grants(token_hash,tenant_id,user_id,plan_id,request_id,expires_at,data) VALUES(?,?,?,?,?,?,?)", grant.token_hash, grant.tenant_id, grant.user_id, grant.plan_id, grant.request_id, grant.expires_at, grant.data);
    } finally { grantDb.close(); }
    const { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds } = approved.claims;
    const callback = { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds, toolCallId: `call-${requestId}`, toolName: "image.generate", input: approved.input };
    const invoke = async (serviceCredential: string, grant: string) => {
      const response = await mf.dispatchFetch("http://tongpin-fixture.local/api/dify/tools/invoke", { method: "POST", headers: { "Content-Type": "application/json", "X-Dify-Tool-Secret": serviceCredential, Authorization: `Bearer ${grant}` }, body: JSON.stringify(callback) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    expect((await invoke("wrong-service-credential-at-least-32-bytes", approved.authorization)).status).toBe(401);
    expect((await invoke(SERVICE_SECRET, "a".repeat(64))).status).toBe(403);
    expect(providerPosts).toBe(0);
    const first = await invoke(SERVICE_SECRET, approved.authorization);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ output: { requestId, status: "completed" }, ledger: { chargedPoints: 100, userId: memberId } });
    expect((await invoke(SERVICE_SECRET, approved.authorization)).body).toEqual(first.body);
    expect(providerPosts).toBe(1);
  }, 30_000);
});
