import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiChatResponse, AiImageResponse, AiProviderInput, AiStatus } from "../../../shared/ai";
import type { AiWorkspaceSnapshot, AiWorkspaceState } from "../../../shared/aiWorkspace";
import type { AiPersonaSnapshot } from "../../../shared/aiPersona";

const TEST_ADMIN = "admin@workerd.example.com";
const TEST_PASSWORD = "WorkerdOnly20260905!";
const TEST_API_KEY = "test-workerd-provider-not-real";
const WORKER_NAME = "tongpin-ai-workerd-test";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
type Session = { accessToken: string; user: { id: string; email: string; role: string } };
type ErrorBody = { error: { code: string; message: string } };

/** The real bundled entry point + SQLite DO run under workerd. Every outbound request is
 * intercepted: no production account, database, DNS resolver, API key or paid provider is used. */
describe.sequential("AI production Worker and SQLite Durable Object integration", () => {
  let directory: string;
  let code: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  let other: Session;
  let postCount = 0;
  let releasePending: (() => void) | undefined;
  let holdNextPost = false;
  let rejectNextPost = false;
  let redirectNextModels = false;
  let privateDns = false;
  let sourceResponse = "workerd 中的真实路由回复（上游为隔离 fixture）";
  let lastChatInstructions = "";
  const outboundUrls: string[] = [];
  const provider: AiProviderInput = { name: "Workerd fixture", baseUrl: "https://ai-fixture.example.com", apiKey: TEST_API_KEY, protocol: "responses", quickModel: "fixture-fast", deepModel: "fixture-deep", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, imageModel: "fixture-image", imageQuotaTokens: 1000 };
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    outboundUrls.push(url.toString());
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
      expect(url.searchParams.get("name")).toBe("ai-fixture.example.com");
      return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: privateDns ? "10.0.0.1" : "1.1.1.1" }] : [] });
    }
    // No network fallthrough exists. An unexpected destination is a test failure, not a fetch.
    expect(url.hostname).toBe("ai-fixture.example.com");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    if (url.pathname === "/v1/models" && request.method === "GET") {
      if (redirectNextModels) { redirectNextModels = false; return new MfResponse(null, { status: 302, headers: { Location: "https://attacker.example.com/steal" } }); }
      return MfResponse.json({ data: [{ id: "fixture-fast" }, { id: "fixture-deep" }, { id: "fixture-image" }] });
    }
    expect(request.method).toBe("POST");
    postCount++;
    if (holdNextPost) {
      holdNextPost = false;
      await new Promise<void>(resolve => { releasePending = resolve; });
    }
    if (rejectNextPost) { rejectNextPost = false; return MfResponse.json({ error: { message: TEST_API_KEY } }, { status: 401 }); }
    if (url.pathname === "/v1/images/generations") return MfResponse.json({ data: [{ b64_json: PNG }] });
    expect(url.pathname).toBe("/v1/responses");
    lastChatInstructions = String((await request.json() as { instructions?: string }).instructions ?? "");
    return MfResponse.json({ status: "completed", output_text: sourceResponse, usage: { input_tokens: 24, output_tokens: 48, total_tokens: 72 } });
  };
  const start = () => new Miniflare({ ...convertV4MiniflareOptions({
    name: WORKER_NAME, modules: true, script: code,
    compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
    durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
    resourcePersistencePath: directory,
    bindings: {
      JWT_SECRET: "workerd-fixture-secret-".repeat(4), BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN,
      DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local",
      AI_ALLOWED_HOSTS: "ai-fixture.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
    },
    outboundService: outbound, log: new Log(LogLevel.ERROR),
  }), unsafeInspectDurableObjects: true });
  const api = async <T>(pathname: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST", expectedStatus = 200): Promise<T> => {
    const response = await mf.dispatchFetch(`http://tongpin-fixture.local${pathname}`, {
      method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as T;
    expect(response.status, `${method} ${pathname}: ${response.status} ${(payload as ErrorBody)?.error?.code ?? ""} outbound=${outboundUrls.join(",")}`).toBe(expectedStatus);
    return payload;
  };
  const register = async (email: string, name: string) => {
    const registered = await api<{ debugCode: string; delivery: string }>("/api/auth/register", undefined, { email, name, password: TEST_PASSWORD }, "POST", 201);
    expect(registered.delivery).toBe("preview");
    await api("/api/auth/verify-email", undefined, { email, code: registered.debugCode });
  };
  const login = (email: string) => api<Session>("/api/auth/login", undefined, { email, password: TEST_PASSWORD });
  const requestBody = () => ({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "请检查云端对话" }] });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-ai-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", target: "es2022", external: ["cloudflare:*", "node:*"] });
    code = bundled.outputFiles[0].text;
    mf = start(); await mf.ready;
    expect((await api<{ storage: string }>("/api/health")).storage).toBe("durable-object-sqlite");
    await register(TEST_ADMIN, "Workerd 验收管理员");
    admin = await login(TEST_ADMIN);
    expect(admin.user.role).toBe("admin");
    await register("member@workerd.example.com", "Workerd 验收成员");
    await register("other@workerd.example.com", "Workerd 隔离成员");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    for (const email of ["member@workerd.example.com", "other@workerd.example.com"]) {
      const user = users.users.find(item => item.email === email)!;
      expect(user).toBeDefined();
      await api(`/api/admin/users/${user.id}/access`, admin, { status: "active" }, "PATCH");
    }
    member = await login("member@workerd.example.com");
    other = await login("other@workerd.example.com");
  }, 30_000);
  afterAll(async () => { releasePending?.(); if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("creates additive AI tables in the real DO and keeps admin/member boundaries", async () => {
    const storage = await mf.unsafeGetDurableObjectStorage(WORKER_NAME, "TongpinCore", { name: "primary" });
    const tables = await storage.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_%'");
    expect(tables.map(item => item.name)).toEqual(expect.arrayContaining(["ai_settings", "ai_quotas", "ai_requests", "ai_usage", "ai_workspaces", "ai_assets", "ai_asset_chunks"]));
    await api<ErrorBody>("/api/admin/ai/provider", member, undefined, "GET", 403);
    await api<ErrorBody>("/api/ai/status", admin, undefined, "GET", 403);
    expect((await api<AiStatus>("/api/ai/status", member)).quota.remainingTokens).toBe(0);
    await api<ErrorBody>("/api/ai/chat", member, requestBody(), "POST", 503);
    expect(postCount).toBe(0);
  });
  it("discovers models through safe outbound transport, encrypts provider settings and denies unlisted domains", async () => {
    const discovery = await api<{ models: string[] }>("/api/admin/ai/provider/test", admin, { baseUrl: provider.baseUrl, apiKey: TEST_API_KEY });
    expect(discovery.models).toContain("fixture-fast");
    const saved = await api<{ provider: unknown }>("/api/admin/ai/provider", admin, provider, "PUT");
    expect(JSON.stringify(saved)).not.toContain(TEST_API_KEY);
    const storage = await mf.unsafeGetDurableObjectStorage(WORKER_NAME, "TongpinCore", { name: "primary" });
    const rows = await storage.exec<{ data: string }>("SELECT data FROM ai_settings WHERE id='provider'");
    expect(rows[0].data).not.toContain(TEST_API_KEY);
    expect(JSON.parse(rows[0].data).encryptedKey).toMatch(/^v1\./);
    const before = outboundUrls.length;
    const denied = await api<ErrorBody>("/api/admin/ai/provider/test", admin, { baseUrl: "https://attacker.example.com", apiKey: "new-fake-key" }, "POST", 400);
    expect(denied.error.code).toBe("AI_HOST_NOT_ALLOWED");
    expect(outboundUrls.length).toBe(before);
  });
  it("enforces zero quota before outbound, then accounts actual provider tokens without cross-user reads", async () => {
    const before = postCount;
    await api("/api/ai/chat", member, requestBody(), "POST", 402);
    expect(postCount).toBe(before);
    await api(`/api/admin/ai/members/${member.user.id}/quota`, admin, { limitTokens: 20_000 }, "PUT");
    const request = requestBody();
    const response = await api<AiChatResponse>("/api/ai/chat", member, request);
    expect(response).toMatchObject({ content: sourceResponse, usage: { totalTokens: 72 }, quota: { usedTokens: 72, reservedTokens: 0 } });
    expect((await api<AiChatResponse>("/api/ai/chat", member, request)).usage.totalTokens).toBe(72);
    expect(postCount).toBe(before + 1);
    await api(`/api/ai/requests/${request.requestId}`, other, undefined, "GET", 404);
    expect((await api<AiStatus>("/api/ai/status", other)).quota.usedTokens).toBe(0);
  });
  it("does not follow redirects with credentials and rejects a private DNS answer inside workerd", async () => {
    redirectNextModels = true;
    const redirected = await api<ErrorBody>("/api/admin/ai/provider/test", admin, {}, "POST", 502);
    expect(redirected.error.code).toBe("AI_PROVIDER_REDIRECT");
    expect(outboundUrls.some(url => url.includes("attacker.example.com"))).toBe(false);
    privateDns = true;
    const denied = await api<ErrorBody>("/api/admin/ai/provider/test", admin, {}, "POST", 400);
    privateDns = false;
    expect(denied.error.code).toBe("AI_URL_UNSAFE");
  });
  it("serializes concurrent reservations across actual DO fetch interleaving and releases rejected requests", async () => {
    holdNextPost = true;
    const before = postCount;
    const first = api<AiChatResponse>("/api/ai/chat", member, requestBody());
    // Observe immediately even if a setup regression makes the request reject before polling.
    void first.catch(() => {});
    await vi.waitFor(() => expect(postCount).toBe(before + 1));
    expect((await api<AiStatus>("/api/ai/status", member)).quota.reservedTokens).toBeGreaterThan(0);
    await api("/api/ai/images", member, { requestId: crypto.randomUUID(), prompt: "检查并发" }, "POST", 409);
    releasePending?.(); releasePending = undefined;
    await first;
    const usedBeforeFailure = (await api<AiStatus>("/api/ai/status", member)).quota.usedTokens;
    rejectNextPost = true;
    const rejected = await api<ErrorBody>("/api/ai/chat", member, requestBody(), "POST", 502);
    expect(rejected.error.code).toBe("AI_PROVIDER_AUTH");
    expect(JSON.stringify(rejected)).not.toContain(TEST_API_KEY);
    expect((await api<AiStatus>("/api/ai/status", member)).quota).toMatchObject({ usedTokens: usedBeforeFailure, reservedTokens: 0 });
  });
  it("persists projects and conversations across a real workerd restart, rejects stale writes and preserves independent workspaces", async () => {
    const state: AiWorkspaceState = { view: "chat", mode: "quick", projects: [{ id: "project-one", title: "真实保存项目", timeLabel: "刚刚" }], conversations: [{ id: "conversation-one", projectId: "project-one", title: "项目内对话", timeLabel: "刚刚", messages: [{ id: "message-one", role: "user", content: "重启后应保留", time: "14:00" }] }], artifacts: [], drafts: {}, activeConversationId: "conversation-one", activeProjectId: "project-one", enabledSkillIds: [] };
    const saved = await api<AiWorkspaceSnapshot>("/api/ai/workspace", member, { expectedRevision: 0, mutationId: crypto.randomUUID(), state }, "PUT");
    expect(saved.revision).toBe(1);
    await api("/api/ai/workspace", member, { expectedRevision: 0, mutationId: crypto.randomUUID(), state }, "PUT", 409);
    expect((await api<AiWorkspaceSnapshot>("/api/ai/workspace", other)).state).toBeNull();
    const used = (await api<AiStatus>("/api/ai/status", member)).quota.usedTokens;
    await mf.dispose(); mf = start(); await mf.ready;
    const restored = await api<AiWorkspaceSnapshot>("/api/ai/workspace", member);
    expect(restored).toEqual(saved);
    expect((await api<AiStatus>("/api/ai/status", member)).quota.usedTokens).toBe(used);
    expect(JSON.stringify(await api("/api/admin/ai/provider", admin))).not.toContain(TEST_API_KEY);
  });
  it("stores private generated image assets in SQLite, supports recovery without rebilling and denies another member", async () => {
    const before = postCount;
    const request = { requestId: crypto.randomUUID(), prompt: "隔离图片 fixture" };
    const generated = await api<AiImageResponse>("/api/ai/images", member, request);
    const assetId = generated.images[0].assetId;
    expect(generated.usage).toMatchObject({ totalTokens: 1000, inputTokens: 0, outputTokens: 0, convertedTokens: 1000, estimated: true });
    expect(JSON.stringify(generated)).not.toContain(PNG);
    expect((await api<{ base64: string }>(`/api/ai/assets/${assetId}`, member)).base64).toBe(PNG);
    await api(`/api/ai/assets/${assetId}`, other, undefined, "GET", 404);
    expect((await api<{ imageResult: AiImageResponse }>(`/api/ai/requests/${request.requestId}`, member)).imageResult.images).toEqual(generated.images);
    await mf.dispose(); mf = start(); await mf.ready;
    expect((await api<{ base64: string }>(`/api/ai/assets/${assetId}`, member)).base64).toBe(PNG);
    await api("/api/ai/images", member, request);
    expect(postCount).toBe(before + 1);
    await api(`/api/ai/assets/${assetId}`, member, undefined, "DELETE");
    await api(`/api/ai/assets/${assetId}`, member, undefined, "GET", 404);
  });
  it("keeps an explicitly confirmed assistant identity after workerd restart without sharing another member's preferences", async () => {
    const profile = { name: "小频", tone: "concise", customStyle: "先给结论", preferences: "偏好简体中文", onboardingComplete: true };
    const saved = await api<AiPersonaSnapshot>("/api/ai/persona", member, { expectedRevision: 0, profile }, "PUT");
    expect(saved.profile.name).toBe("小频");
    await mf.dispose(); mf = start(); await mf.ready;
    expect((await api<AiPersonaSnapshot>("/api/ai/persona", member)).profile).toEqual(profile);
    expect((await api<AiPersonaSnapshot>("/api/ai/persona", other)).profile.name).toBe("");
    await api("/api/ai/chat", member, requestBody());
    expect(lastChatInstructions).toContain('你的专属称呼是 "小频"');
    expect(lastChatInstructions).toContain("偏好简体中文");
    await api("/api/ai/persona", admin, undefined, "GET", 403);
  });
});
