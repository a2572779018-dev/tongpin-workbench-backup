import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, type AppRuntime } from "../app";
import type { AppConfig } from "../config";
import type { AiProviderInput, AiStatus } from "../../shared/ai";

// These accounts, keys and files belong only to this test's private temporary
// database. Never point this suite at the running application or a remote API.
const ADMIN_EMAIL = "ai-admin@tongpin.test";
const TEST_PASSWORD = "AiAcceptance123!";
const PROVIDER_KEY = "sk-tongpin-acceptance-not-a-real-secret";

interface TestMember {
  id: string;
  token: string;
  email: string;
}

describe.sequential("AI acceptance through real isolated account routes", () => {
  let temporaryRoot: string;
  let config: AppConfig;
  let runtime: AppRuntime;
  let adminToken: string;
  let adminId: string;
  let memberA: TestMember;
  let memberB: TestMember;
  let chatCalls = 0;
  let transportError = false;
  let releaseChat: (() => void) | undefined;
  let blockChat = false;
  let omitUsage = false;
  let excessiveUsage = false;
  const provider: AiProviderInput = {
    name: "隔离测试供应商",
    baseUrl: "https://models.example.com",
    protocol: "chat_completions",
    apiKey: PROVIDER_KEY,
    quickModel: "acceptance-quick",
    deepModel: "acceptance-deep",
    maxOutputTokens: 256,
    reasoningEffort: "",
    enabled: true,
  };

  const fakeTransport = vi.fn(async (url: string, init: {
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  }) => {
    // A direct injected transport is the sole outbound capability of the suite.
    // Public-looking URLs exercise validation but never undergo DNS/network I/O.
    expect(new URL(url).hostname).toBe("models.example.com");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${PROVIDER_KEY}`);
    if (init.method === "GET") {
      expect(new URL(url).pathname).toBe("/v1/models");
      return Response.json({ data: [{ id: "acceptance-quick" }, { id: "acceptance-deep" }] });
    }
    chatCalls += 1;
    expect(new URL(url).pathname).toBe("/v1/chat/completions");
    const body = JSON.parse(init.body ?? "{}");
    expect(body.model).toBe("acceptance-quick");
    if (blockChat) {
      await new Promise<void>((resolve) => { releaseChat = resolve; });
    }
    if (transportError) {
      return Response.json({ error: { message: `Provider rejected ${PROVIDER_KEY}` } }, { status: 401 });
    }
    return Response.json({
      id: "chatcmpl-isolated-fixture",
      choices: [{ message: { role: "assistant", content: "这是隔离测试上游的确定性回复。" }, finish_reason: "stop" }],
      ...(omitUsage ? {} : { usage: excessiveUsage
        ? { prompt_tokens: 999_999, completion_tokens: 999_999, total_tokens: 1_999_998 }
        : { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 } }),
    });
  });

  function authenticated(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function assertNoProviderKey(payload: unknown) {
    expect(JSON.stringify(payload)).not.toContain(PROVIDER_KEY);
  }

  function chatBody(requestId: string, content = "你好") {
    return { requestId, mode: "quick", messages: [{ role: "user", content }] };
  }

  async function status(member: TestMember): Promise<AiStatus> {
    const result = await request(runtime.app)
      .get("/api/ai/status")
      .set(authenticated(member.token))
      .expect(200);
    assertNoProviderKey(result.body);
    return result.body as AiStatus;
  }

  async function setLimit(member: TestMember, limitTokens: number) {
    const result = await request(runtime.app)
      .put(`/api/admin/ai/members/${member.id}/quota`)
      .set(authenticated(adminToken))
      .send({ limitTokens, reason: "隔离验收限额调整" })
      .expect(200);
    assertNoProviderKey(result.body);
  }

  async function startRuntime() {
    return createRuntime(config, {
      attachSockets: false,
      startLoraCollector: false,
      aiTransport: fakeTransport,
    });
  }

  async function login(email: string) {
    const result = await request(runtime.app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    return result.body as {
      accessToken: string;
      user: { id: string; role: string; status: string };
    };
  }

  async function registerMember(name: string, email: string): Promise<TestMember> {
    const registered = await request(runtime.app)
      .post("/api/auth/register")
      .send({ name, email, password: TEST_PASSWORD })
      .expect(201);
    expect(registered.body.delivery).toBe("preview");
    expect(registered.body.debugCode).toMatch(/^\d{6}$/);
    const verified = await request(runtime.app)
      .post("/api/auth/verify-email")
      .send({ email, code: registered.body.debugCode })
      .expect(200);
    expect(verified.body.nextStep).toBe("await_approval");
    await request(runtime.app)
      .post("/api/auth/login")
      .send({ email, password: TEST_PASSWORD })
      .expect(403);
    await request(runtime.app)
      .patch(`/api/admin/users/${verified.body.user.id}/access`)
      .set(authenticated(adminToken))
      .send({ status: "active" })
      .expect(200);
    const session = await login(email);
    expect(session.user.role).toBe("member");
    return { id: session.user.id, token: session.accessToken, email };
  }

  beforeAll(async () => {
    // Registration preview codes are disposable fixtures, not useful test logs.
    vi.spyOn(console, "info").mockImplementation(() => {});
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tongpin-ai-acceptance-"));
    // Literal config deliberately avoids loadConfig()/dotenv and any user's
    // existing secret, mail, bootstrap-account or data-file configuration.
    config = {
      host: "127.0.0.1",
      port: 0,
      dataFile: path.join(temporaryRoot, "database.json"),
      jwtSecret: "tongpin-acceptance-only-jwt-secret-not-for-real-use",
      clientOrigins: ["http://127.0.0.1:5173"],
      bootstrapAdminEmail: ADMIN_EMAIL,
      bootstrapAdminPassword: TEST_PASSWORD,
      bootstrapAdminName: "隔离验收管理员",
      devEmailPreview: true,
      isProduction: false,
      loraExplorerApi: "https://explorer.invalid/api/v2",
      loraRpcUrl: "https://rpc.invalid",
      resend: { apiKey: "", from: "" },
      smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
    };
    runtime = await startRuntime();
    const admin = await login(ADMIN_EMAIL);
    expect(admin.user.role).toBe("admin");
    adminToken = admin.accessToken;
    adminId = admin.user.id;
    memberA = await registerMember("验收成员甲", "ai-member-a@tongpin.test");
    memberB = await registerMember("验收成员乙", "ai-member-b@tongpin.test");
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    releaseChat?.();
    if (runtime) {
      await runtime.close();
    }
    if (!temporaryRoot) return;
    const resolved = path.resolve(temporaryRoot);
    const allowedPrefix = path.join(path.resolve(os.tmpdir()), "tongpin-ai-acceptance-");
    if (!resolved.startsWith(allowedPrefix)) throw new Error("Refusing unsafe test cleanup");
    await rm(resolved, { recursive: true, force: true });
  });

  it("creates two distinct real members only after email verification and admin approval", async () => {
    expect(memberA.id).not.toBe(memberB.id);
    const a = await request(runtime.app)
      .get("/api/auth/me")
      .set(authenticated(memberA.token))
      .expect(200);
    const b = await request(runtime.app)
      .get("/api/auth/me")
      .set(authenticated(memberB.token))
      .expect(200);
    expect(a.body.user.id).toBe(memberA.id);
    expect(b.body.user.id).toBe(memberB.id);
    assertNoProviderKey([a.body, b.body]);
    await request(runtime.app).get("/api/admin/users").expect(401);
    await request(runtime.app)
      .get("/api/admin/users")
      .set(authenticated(memberA.token))
      .expect(403);
    const registry = await request(runtime.app)
      .get("/api/admin/users")
      .set(authenticated(adminToken))
      .expect(200);
    expect(registry.body.users).toHaveLength(3);
    assertNoProviderKey(registry.body);
  });

  it("can discover models from an unsaved address and key before a first model is chosen", async () => {
    const initial = await request(runtime.app).get("/api/admin/ai/provider")
      .set(authenticated(adminToken)).expect(200);
    expect(initial.body.provider).toBeNull();
    const result = await request(runtime.app).post("/api/admin/ai/provider/test")
      .set(authenticated(adminToken)).send({ baseUrl: provider.baseUrl, apiKey: PROVIDER_KEY }).expect(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.models).toContain("acceptance-quick");
    assertNoProviderKey(result.body);
    const stillUnsaved = await request(runtime.app).get("/api/admin/ai/provider")
      .set(authenticated(adminToken)).expect(200);
    expect(stillUnsaved.body.provider).toBeNull();
    expect((await status(memberA)).configured).toBe(false);
    expect(chatCalls).toBe(0);
  });

  it("accepts provider configuration only from admin and never returns its secret", async () => {
    await request(runtime.app).get("/api/admin/ai/provider").expect(401);
    for (const member of [memberA, memberB]) {
      await request(runtime.app).get("/api/admin/ai/provider").set(authenticated(member.token)).expect(403);
      await request(runtime.app).put("/api/admin/ai/provider").set(authenticated(member.token)).send(provider).expect(403);
      await request(runtime.app).post("/api/admin/ai/provider/test").set(authenticated(member.token)).expect(403);
      await request(runtime.app).put(`/api/admin/ai/members/${member.id}/quota`)
        .set(authenticated(member.token)).send({ limitTokens: 999_999, reason: "unauthorized" }).expect(403);
    }
    const saved = await request(runtime.app).put("/api/admin/ai/provider")
      .set(authenticated(adminToken)).send(provider).expect(200);
    assertNoProviderKey(saved.body);
    const read = await request(runtime.app).get("/api/admin/ai/provider").set(authenticated(adminToken)).expect(200);
    expect(read.body.provider.apiKeyConfigured).toBe(true);
    expect(read.body.provider.baseUrl).toBe("https://models.example.com/v1");
    expect(read.body.provider).not.toHaveProperty("apiKey");
    expect(read.body.provider).not.toHaveProperty("encryptedKey");
    assertNoProviderKey(read.body);
    const storage = await readFile(`${config.dataFile}.ai.sqlite`);
    expect(storage.includes(Buffer.from(PROVIDER_KEY))).toBe(false);
    expect(chatCalls).toBe(0);
  });

  it("tests the saved connection without spending member quota; zero quota never calls upstream", async () => {
    const connected = await request(runtime.app).post("/api/admin/ai/provider/test")
      .set(authenticated(adminToken)).expect(200);
    expect(connected.body.ok).toBe(true);
    expect(connected.body.models).toContain("acceptance-quick");
    assertNoProviderKey(connected.body);
    const before = fakeTransport.mock.calls.length;
    for (const member of [memberA, memberB]) {
      const current = await status(member);
      expect(current.configured).toBe(true);
      expect(current.quota.limitTokens).toBe(0);
      expect(current.quota.remainingTokens).toBe(0);
      const response = await request(runtime.app).post("/api/ai/chat")
        .set(authenticated(member.token)).send(chatBody(`zero-${member.id}`));
      expect(response.status).toBeGreaterThanOrEqual(400);
      assertNoProviderKey(response.body);
    }
    expect(fakeTransport.mock.calls.length).toBe(before);
  });

  it("preserves an omitted key only for the same destination and rejects unsafe address changes", async () => {
    const { apiKey: _key, ...withoutKey } = provider;
    const retained = await request(runtime.app).put("/api/admin/ai/provider")
      .set(authenticated(adminToken)).send(withoutKey).expect(200);
    expect(retained.body.provider.apiKeyConfigured).toBe(true);
    assertNoProviderKey(retained.body);
    const before = fakeTransport.mock.calls.length;
    const changed = await request(runtime.app).put("/api/admin/ai/provider")
      .set(authenticated(adminToken))
      .send({ ...withoutKey, baseUrl: "https://different.example.com" }).expect(400);
    assertNoProviderKey(changed.body);
    for (const baseUrl of [
      "http://models.example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://169.254.169.254",
      "https://models.example.com:8443",
      "https://user:password@models.example.com",
      "https://models.example.com?target=internal",
    ]) {
      const denied = await request(runtime.app).put("/api/admin/ai/provider")
        .set(authenticated(adminToken)).send({ ...provider, baseUrl });
      expect(denied.status).toBe(400);
      assertNoProviderKey(denied.body);
    }
    expect(fakeTransport.mock.calls.length).toBe(before);
    const current = await request(runtime.app).get("/api/admin/ai/provider").set(authenticated(adminToken)).expect(200);
    expect(current.body.provider.baseUrl).toBe("https://models.example.com/v1");
  });

  it("charges only the allocated member and makes retries idempotent", async () => {
    await setLimit(memberA, 8_000);
    expect((await status(memberB)).quota.limitTokens).toBe(0);
    const body = chatBody("accepted-first-turn");
    const before = chatCalls;
    const completed = await request(runtime.app).post("/api/ai/chat")
      .set(authenticated(memberA.token)).send(body).expect(200);
    expect(completed.body.content).toBe("这是隔离测试上游的确定性回复。");
    expect(completed.body.usage).toMatchObject({ inputTokens: 19, outputTokens: 7, totalTokens: 26, estimated: false });
    expect(completed.body.quota).toMatchObject({ usedTokens: 26, reservedTokens: 0, remainingTokens: 7_974 });
    assertNoProviderKey(completed.body);
    const repeated = await request(runtime.app).post("/api/ai/chat")
      .set(authenticated(memberA.token)).send(body).expect(200);
    expect(repeated.body.content).toBe(completed.body.content);
    assertNoProviderKey(repeated.body);
    expect(chatCalls).toBe(before + 1);
    await request(runtime.app).post("/api/ai/chat")
      .set(authenticated(memberA.token)).send(chatBody(body.requestId, "different payload")).expect(409);
    expect(chatCalls).toBe(before + 1);
    const aUsage = await request(runtime.app).get("/api/ai/usage").set(authenticated(memberA.token)).expect(200);
    const bUsage = await request(runtime.app).get("/api/ai/usage").set(authenticated(memberB.token)).expect(200);
    expect(aUsage.body.entries.filter((entry: { kind: string }) => entry.kind === "chat")).toHaveLength(1);
    expect(bUsage.body.entries).toHaveLength(0);
    for (const entry of aUsage.body.entries) expect(entry.userId).toBe(memberA.id);
    assertNoProviderKey([aUsage.body, bUsage.body]);
  });

  it("persists provider settings, usage and member caps through a server restart", async () => {
    await runtime.close();
    runtime = await startRuntime();
    memberA.token = (await login(memberA.email)).accessToken;
    memberB.token = (await login(memberB.email)).accessToken;
    const current = await status(memberA);
    expect(current.configured).toBe(true);
    expect(current.quota).toMatchObject({ limitTokens: 8_000, usedTokens: 26, reservedTokens: 0, remainingTokens: 7_974 });
    expect((await status(memberB)).quota).toMatchObject({ limitTokens: 0, usedTokens: 0 });
    const before = chatCalls;
    await request(runtime.app).post("/api/ai/chat").set(authenticated(memberA.token))
      .send(chatBody("accepted-first-turn")).expect(200);
    expect(chatCalls).toBe(before);
  });

  it("blocks immediately at exhaustion and only an admin increase restores access", async () => {
    await setLimit(memberA, 26);
    const before = chatCalls;
    const denied = await request(runtime.app).post("/api/ai/chat")
      .set(authenticated(memberA.token)).send(chatBody("empty-after-limit-adjustment"));
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(chatCalls).toBe(before);
    expect((await status(memberA)).quota.remainingTokens).toBe(0);
    await setLimit(memberA, 8_000);
    expect((await status(memberA)).quota).toMatchObject({ usedTokens: 26, remainingTokens: 7_974 });
  });

  it("ignores a forged member identity and rejects invalid quota values", async () => {
    for (const limitTokens of [-1, 0.5, 1_000_000_001, "8000"]) {
      await request(runtime.app).put(`/api/admin/ai/members/${memberA.id}/quota`)
        .set(authenticated(adminToken)).send({ limitTokens, reason: "invalid input" }).expect(400);
    }
    const before = chatCalls;
    const forged = await request(runtime.app).post("/api/ai/chat").set(authenticated(memberB.token))
      .send({ ...chatBody("forged-owner-identity"), userId: memberA.id, quota: { remainingTokens: 999_999 } });
    expect(forged.status).toBe(402);
    expect(chatCalls).toBe(before);
    expect((await status(memberB)).quota.usedTokens).toBe(0);
    const otherUsage = await request(runtime.app).get(`/api/ai/usage?userId=${memberA.id}`)
      .set(authenticated(memberB.token)).expect(200);
    expect(otherUsage.body.entries).toHaveLength(0);
  });

  it("does not turn upstream authentication failure into member logout or reveal upstream credentials", async () => {
    transportError = true;
    try {
      const response = await request(runtime.app).post("/api/ai/chat")
        .set(authenticated(memberA.token)).send(chatBody("upstream-auth-error"));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).not.toBe(401);
      assertNoProviderKey(response.body);
      expect(JSON.stringify(response.body)).not.toContain("Provider rejected");
      await request(runtime.app).get("/api/auth/me").set(authenticated(memberA.token)).expect(200);
    } finally {
      transportError = false;
    }
  });

  it("reserves atomically before upstream work so concurrent sends cannot overrun the cap", async () => {
    blockChat = true;
    const before = chatCalls;
    const first = request(runtime.app).post("/api/ai/chat").set(authenticated(memberA.token))
      .send(chatBody("held-concurrent-turn")).then(response => response);
    try {
      await vi.waitFor(() => expect(chatCalls).toBe(before + 1));
      const reserved = await status(memberA);
      expect(reserved.quota.reservedTokens).toBeGreaterThan(0);
      // Lower the cap exactly to committed + reserved tokens while first is in
      // flight. A second request must observe zero available quota atomically.
      await setLimit(memberA, reserved.quota.usedTokens + reserved.quota.reservedTokens);
      const second = await request(runtime.app).post("/api/ai/chat").set(authenticated(memberA.token))
        .send(chatBody("second-concurrent-turn"));
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect(chatCalls).toBe(before + 1);
    } finally {
      blockChat = false;
      releaseChat?.();
      releaseChat = undefined;
    }
    const result = await first;
    expect(result.status).toBe(200);
    expect((await status(memberA)).quota.reservedTokens).toBe(0);
    assertNoProviderKey(result.body);
  });

  it("marks missing provider usage as estimated and charges the reservation instead of allowing free requests", async () => {
    await setLimit(memberA, 8_000);
    const before = await status(memberA);
    omitUsage = true;
    try {
      const result = await request(runtime.app).post("/api/ai/chat")
        .set(authenticated(memberA.token)).send(chatBody("missing-usage-provider")).expect(200);
      expect(result.body.usage.estimated).toBe(true);
      expect(result.body.usage.totalTokens).toBeGreaterThan(0);
      expect(result.body.quota.usedTokens - before.quota.usedTokens).toBe(result.body.usage.totalTokens);
      expect(result.body.quota.reservedTokens).toBe(0);
      assertNoProviderKey(result.body);
    } finally {
      omitUsage = false;
    }
  });

  it("does not settle a late result twice after stale-request recovery", async () => {
    await setLimit(memberA, 8_000);
    blockChat = true;
    const requestId = "late-result-after-recovery";
    const before = chatCalls;
    const pendingResponse = request(runtime.app).post("/api/ai/chat").set(authenticated(memberA.token))
      .send(chatBody(requestId)).then(response => response);
    let recoveredUsed = 0;
    try {
      await vi.waitFor(() => expect(chatCalls).toBe(before + 1));
      const persisted = runtime.aiStore.request(memberA.id, requestId);
      expect(persisted?.status).toBe("pending");
      // Only expire this suite's own pending fixture, simulating a process
      // suspension that lets recovery precede a late upstream completion.
      runtime.aiStore.sql.transaction(() => {
        runtime.aiStore.saveRequest({ ...persisted!, expiresAt: Date.now() - 1 });
      });
      recoveredUsed = (await status(memberA)).quota.usedTokens;
      expect(runtime.aiStore.request(memberA.id, requestId)?.status).toBe("uncertain");
    } finally {
      blockChat = false;
      releaseChat?.();
      releaseChat = undefined;
    }
    const lateResponse = await pendingResponse;
    assertNoProviderKey(lateResponse.body);
    expect((await status(memberA)).quota.usedTokens).toBe(recoveredUsed);
    const usage = await request(runtime.app).get("/api/ai/usage").set(authenticated(memberA.token)).expect(200);
    expect(usage.body.entries.filter((entry: { requestId: string }) => entry.requestId === requestId)).toHaveLength(1);
  });

  it("does not let impossible provider usage exceed the reserved hard member cap", async () => {
    await setLimit(memberA, 8_000);
    excessiveUsage = true;
    try {
      const response = await request(runtime.app).post("/api/ai/chat")
        .set(authenticated(memberA.token)).send(chatBody("excessive-provider-usage"));
      assertNoProviderKey(response.body);
      const current = await status(memberA);
      expect(current.quota.usedTokens).toBeLessThanOrEqual(current.quota.limitTokens);
      expect(current.quota.reservedTokens).toBe(0);
      const stored = runtime.aiStore.request(memberA.id, "excessive-provider-usage");
      expect(stored?.status).toBe("uncertain");
    } finally {
      excessiveUsage = false;
    }
  });

  it("keeps both admin and boss accounts outside the member-only AI runtime and quota registry", async () => {
    await request(runtime.app).get("/api/ai/status").set(authenticated(adminToken)).expect(403);
    await request(runtime.app).post("/api/ai/chat").set(authenticated(adminToken))
      .send(chatBody("admin-member-runtime-denied")).expect(403);
    await request(runtime.app).put(`/api/admin/ai/members/${adminId}/quota`)
      .set(authenticated(adminToken)).send({ limitTokens: 500, reason: "non-member" }).expect(403);
    await request(runtime.app).patch(`/api/admin/users/${memberB.id}/role`)
      .set(authenticated(adminToken)).send({ role: "boss" }).expect(200);
    try {
      await request(runtime.app).get("/api/ai/status").set(authenticated(memberB.token)).expect(403);
      await request(runtime.app).post("/api/ai/chat").set(authenticated(memberB.token))
        .send(chatBody("boss-member-runtime-denied")).expect(403);
      await request(runtime.app).put(`/api/admin/ai/members/${memberB.id}/quota`)
        .set(authenticated(adminToken)).send({ limitTokens: 500, reason: "non-member" }).expect(403);
      const registry = await request(runtime.app).get("/api/admin/ai/members").set(authenticated(adminToken)).expect(200);
      expect(registry.body.members.map((member: { id: string }) => member.id)).toEqual([memberA.id]);
      assertNoProviderKey(registry.body);
    } finally {
      await request(runtime.app).patch(`/api/admin/users/${memberB.id}/role`)
        .set(authenticated(adminToken)).send({ role: "member" }).expect(200);
    }
  });

  it("denies a disabled member even when the existing bearer token is still unexpired", async () => {
    const before = fakeTransport.mock.calls.length;
    await request(runtime.app).patch(`/api/admin/users/${memberA.id}/access`)
      .set(authenticated(adminToken)).send({ status: "disabled" }).expect(200);
    await request(runtime.app).get("/api/ai/status").set(authenticated(memberA.token)).expect(401);
    await request(runtime.app).post("/api/ai/chat").set(authenticated(memberA.token))
      .send(chatBody("disabled-user-turn")).expect(401);
    expect(fakeTransport.mock.calls.length).toBe(before);
  });
});
