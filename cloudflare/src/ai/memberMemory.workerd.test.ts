import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiChatResponse, AiProviderInput } from "../../../shared/ai";
import type { AiMemoryAdminSettings, AiMemoryAdminStats, AiMemoryReviewStatus, AiMemoryState } from "../../../shared/aiMemory";
import { MEMBER_MEMORY_REVIEW_INSTRUCTIONS } from "../../../server/ai/memberMemoryPrompt";

const TEST_ADMIN = "admin@memory-workerd.example.com";
const TEST_PASSWORD = "WorkerdMemory20260926!";
const TEST_API_KEY = "test-workerd-memory-provider-not-real";
const WORKER_NAME = "tongpin-memory-workerd-test";
type Session = { accessToken: string; user: { id: string; email: string; role: string } };

/** The real bundled Worker + SQLite Durable Object. Every outbound request is a
 * local fixture: no production account, DNS resolver, API key or paid provider. */
describe.sequential("member memory in the production Worker and Durable Object", () => {
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  let other: Session;
  const chatInstructions: string[] = [];
  let reviewCalls = 0;
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    expect(url.hostname).toBe("ai-fixture.example.com");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    if (url.pathname === "/v1/models") return MfResponse.json({ data: [{ id: "fixture-fast" }, { id: "fixture-deep" }] });
    expect(url.pathname).toBe("/v1/responses");
    const body = await request.json() as { instructions?: string };
    if (body.instructions === MEMBER_MEMORY_REVIEW_INSTRUCTIONS) {
      reviewCalls += 1;
      return MfResponse.json({ status: "completed", output_text: JSON.stringify({ operations: [{ target: "user", action: "add", content: "成员负责 LORA Chain 生态合作" }] }), usage: { input_tokens: 600, output_tokens: 30, total_tokens: 630 } });
    }
    chatInstructions.push(String(body.instructions ?? ""));
    return MfResponse.json({ status: "completed", output_text: "好的，已按你的背景整理好本周重点。", usage: { input_tokens: 24, output_tokens: 18, total_tokens: 42 } });
  };
  const api = async <T>(pathname: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST", expectedStatus = 200): Promise<T> => {
    const response = await mf.dispatchFetch(`http://tongpin-fixture.local${pathname}`, {
      method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as T;
    expect(response.status, `${method} ${pathname}: ${JSON.stringify(payload)}`).toBe(expectedStatus);
    return payload;
  };
  const register = async (email: string, name: string) => {
    const registered = await api<{ debugCode: string }>("/api/auth/register", undefined, { email, name, password: TEST_PASSWORD }, "POST", 201);
    await api("/api/auth/verify-email", undefined, { email, code: registered.debugCode });
  };
  const login = (email: string) => api<Session>("/api/auth/login", undefined, { email, password: TEST_PASSWORD });
  const chat = (content: string, conversationId: string) => api<AiChatResponse>("/api/ai/chat", member, { requestId: crypto.randomUUID(), mode: "quick", conversationId, messages: [{ role: "user", content }] });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-memory-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER_NAME, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "workerd-memory-fixture-secret-".repeat(3), BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN, DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local",
        AI_ALLOWED_HOSTS: "ai-fixture.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register(TEST_ADMIN, "记忆验收管理员");
    admin = await login(TEST_ADMIN);
    await register("member@memory-workerd.example.com", "记忆验收成员");
    await register("other@memory-workerd.example.com", "记忆隔离成员");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    for (const email of ["member@memory-workerd.example.com", "other@memory-workerd.example.com"]) {
      const user = users.users.find(item => item.email === email)!;
      await api(`/api/admin/users/${user.id}/access`, admin, { status: "active" }, "PATCH");
      await api(`/api/admin/ai/members/${user.id}/quota`, admin, { limitTokens: 50_000 }, "PUT");
    }
    member = await login("member@memory-workerd.example.com");
    other = await login("other@memory-workerd.example.com");
    const provider: AiProviderInput = { name: "Workerd fixture", baseUrl: "https://ai-fixture.example.com", apiKey: TEST_API_KEY, protocol: "responses", quickModel: "fixture-fast", deepModel: "fixture-deep", maxOutputTokens: 2048, reasoningEffort: "", enabled: true };
    await api("/api/admin/ai/provider", admin, provider, "PUT");
  }, 60_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("migrates the Durable Object and keeps the feature off until an administrator enables it", async () => {
    const storage = await mf.unsafeGetDurableObjectStorage(WORKER_NAME, "TongpinCore", { name: "primary" });
    const tables = await storage.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_member_memor%' ORDER BY name");
    expect(tables.map(row => row.name)).toEqual(["ai_member_memories", "ai_member_memory_reviews", "ai_member_memory_snapshots"]);
    expect(await storage.exec("SELECT module, version FROM ai_schema_migrations ORDER BY version")).toEqual([1, 2, 3].map(version => ({ module: "member_memory", version })));
    expect(await api<AiMemoryState>("/api/ai/memory", member)).toMatchObject({ available: false, revision: 0 });
    await api("/api/ai/memory", admin, undefined, "GET", 403);
    await api("/api/admin/ai/memory", member, undefined, "GET", 403);
  });

  it("learns in the background after a chat and injects a frozen block into new conversations", async () => {
    await api<{ settings: AiMemoryAdminSettings }>("/api/admin/ai/memory", admin, { enabled: true, reviewTier: "quick", pricePoints: 10 }, "PUT");
    const reply = await chat("记住：我负责 LORA Chain 的生态合作", "conv-workerd-1");
    expect(reply.content).toContain("本周重点");
    await vi.waitFor(async () => {
      const [status] = (await api<{ reviews: AiMemoryReviewStatus[] }>(`/api/ai/memory/reviews?requestIds=${reply.requestId}`, member)).reviews;
      expect(status).toEqual({ requestId: reply.requestId, status: "applied", changes: { added: 1, updated: 0, removed: 0 } });
    }, { timeout: 10_000, interval: 100 });
    expect(reviewCalls).toBe(1);
    expect((await api<AiMemoryState>("/api/ai/memory", member)).stores.user.entries).toEqual(["成员负责 LORA Chain 生态合作"]);
    await chat("帮我起草一份合作伙伴周报", "conv-workerd-2");
    expect(chatInstructions.at(-1)).toMatch(/<member_memory id="[0-9a-f]{8}">/);
    expect(chatInstructions.at(-1)).toContain("成员负责 LORA Chain 生态合作");
    // The conversation that taught it keeps its frozen (empty) block.
    await chat("再补充两条风险提示", "conv-workerd-1");
    expect(chatInstructions.at(-1)).not.toContain("member_memory");
  });

  it("keeps memory private: other members see nothing, administrators only aggregates", async () => {
    expect((await api<AiMemoryState>("/api/ai/memory", other)).stores.user.entries).toEqual([]);
    const view = await api<{ settings: AiMemoryAdminSettings; stats: AiMemoryAdminStats }>("/api/admin/ai/memory", admin);
    expect(view.stats).toMatchObject({ membersWithMemory: 1, totalEntries: 1, reviews7d: { applied: 1 }, points7d: 10 });
    expect(JSON.stringify(view)).not.toContain("LORA");
    const cleared = await api<AiMemoryState>("/api/ai/memory", member, undefined, "DELETE");
    expect(cleared.stores.user.entries).toEqual([]);
    const storage = await mf.unsafeGetDurableObjectStorage(WORKER_NAME, "TongpinCore", { name: "primary" });
    expect(await storage.exec("SELECT conversation_id FROM ai_member_memory_snapshots")).toEqual([]);
  });
});
