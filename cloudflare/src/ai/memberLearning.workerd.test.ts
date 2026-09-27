import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiChatResponse, AiProviderInput } from "../../../shared/ai";
import type { AiMemoryReviewStatus, AiMemoryState } from "../../../shared/aiMemory";
import type { AiMemoryRecallEvent } from "../../../shared/aiMemoryLearning";
import type { AiWorkspaceConversation, AiWorkspaceSnapshot } from "../../../shared/aiWorkspace";
import { MEMBER_MEMORY_REVIEW_INSTRUCTIONS } from "../../../server/ai/memberMemoryPrompt";

const TEST_ADMIN = "admin@learning-workerd.example.com";
const TEST_PASSWORD = "WorkerdLearning20260927!";
const TEST_API_KEY = "test-workerd-learning-provider-not-real";
const WORKER_NAME = "tongpin-learning-workerd-test";
type Session = { accessToken: string; user: { id: string; email: string; role: string } };

/** The real bundled Worker + SQLite Durable Object: trigram FTS5 index, recall
 * and personal skills. Every outbound request is a local fixture. */
describe.sequential("history recall and personal skills in the production Worker and Durable Object", () => {
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  let other: Session;
  const chatInstructions: string[] = [];
  const reviewPayloads: Array<Record<string, unknown>> = [];
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    expect(url.hostname).toBe("ai-fixture.example.com");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    if (url.pathname === "/v1/models") return MfResponse.json({ data: [{ id: "fixture-fast" }, { id: "fixture-deep" }] });
    const body = await request.json() as { instructions?: string; input?: Array<{ content: string }> };
    if (body.instructions === MEMBER_MEMORY_REVIEW_INSTRUCTIONS) {
      const payload = JSON.parse(String(body.input?.[0]?.content ?? "{}")) as Record<string, unknown>;
      reviewPayloads.push(payload);
      const skill = typeof payload.技能评估 === "object"
        ? { action: "create", name: "周报格式", when_to_use: "成员要写每周工作汇报时", instructions: "1. 先写本周结论\n2. 列出完成事项和数据\n3. 写风险和下周计划", triggers: ["周报", "每周汇报"] }
        : null;
      return MfResponse.json({ status: "completed", output_text: JSON.stringify({ operations: [], skill }), usage: { input_tokens: 700, output_tokens: 60, total_tokens: 760 } });
    }
    chatInstructions.push(String(body.instructions ?? ""));
    return MfResponse.json({ status: "completed", output_text: "好的，已经整理好了。", usage: { input_tokens: 24, output_tokens: 18, total_tokens: 42 } });
  };
  const api = async <T>(pathname: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST", expectedStatus = 200): Promise<T> => {
    const response = await mf.dispatchFetch(`http://tongpin-fixture.local${pathname}`, {
      method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as T;
    expect(response.status, `${method} ${pathname}: ${JSON.stringify(payload).slice(0, 300)}`).toBe(expectedStatus);
    return payload;
  };
  const register = async (email: string, name: string) => {
    const registered = await api<{ debugCode: string }>("/api/auth/register", undefined, { email, name, password: TEST_PASSWORD }, "POST", 201);
    await api("/api/auth/verify-email", undefined, { email, code: registered.debugCode });
  };
  const login = (email: string) => api<Session>("/api/auth/login", undefined, { email, password: TEST_PASSWORD });
  const chat = (session: Session, content: string, conversationId: string) => api<AiChatResponse>("/api/ai/chat", session, { requestId: crypto.randomUUID(), mode: "quick", conversationId, messages: [{ role: "user", content }] });
  const revisions = new Map<string, number>();
  const saveWorkspace = async (session: Session, conversations: AiWorkspaceConversation[]) => {
    const snapshot = await api<AiWorkspaceSnapshot>("/api/ai/workspace", session, {
      expectedRevision: revisions.get(session.user.id) ?? 0, mutationId: crypto.randomUUID(),
      state: { view: "chat", mode: "quick", conversations, projects: [], artifacts: [], drafts: {}, activeConversationId: null, activeProjectId: null, enabledSkillIds: [] },
    }, "PUT");
    revisions.set(session.user.id, snapshot.revision);
  };
  const sql = async <T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string): Promise<T[]> =>
    (await mf.unsafeGetDurableObjectStorage(WORKER_NAME, "TongpinCore", { name: "primary" })).exec<T>(query);
  const conversation = (id: string, title: string, messages: Array<[string, "user" | "assistant", string]>): AiWorkspaceConversation =>
    ({ id, title, timeLabel: "刚刚", messages: messages.map(([messageId, role, content]) => ({ id: messageId, role, content, time: "10:00", ...(role === "assistant" ? { status: "ready" as const } : {}) })) });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-learning-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER_NAME, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "workerd-learning-fixture-secret-".repeat(3), BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN, DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local",
        AI_ALLOWED_HOSTS: "ai-fixture.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register(TEST_ADMIN, "回忆验收管理员");
    admin = await login(TEST_ADMIN);
    await register("member@learning-workerd.example.com", "回忆验收成员");
    await register("other@learning-workerd.example.com", "回忆隔离成员");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    for (const email of ["member@learning-workerd.example.com", "other@learning-workerd.example.com"]) {
      const user = users.users.find(item => item.email === email)!;
      await api(`/api/admin/users/${user.id}/access`, admin, { status: "active" }, "PATCH");
      await api(`/api/admin/ai/members/${user.id}/quota`, admin, { limitTokens: 50_000 }, "PUT");
    }
    member = await login("member@learning-workerd.example.com");
    other = await login("other@learning-workerd.example.com");
    const provider: AiProviderInput = { name: "Workerd fixture", baseUrl: "https://ai-fixture.example.com", apiKey: TEST_API_KEY, protocol: "responses", quickModel: "fixture-fast", deepModel: "fixture-deep", maxOutputTokens: 2048, reasoningEffort: "", enabled: true };
    await api("/api/admin/ai/provider", admin, provider, "PUT");
  }, 60_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("migrates to member_memory v3 with a trigram FTS5 index on the Durable Object SQLite", async () => {
    expect(await sql("SELECT module, version FROM ai_schema_migrations ORDER BY version")).toEqual([1, 2, 3].map(version => ({ module: "member_memory", version })));
    const [fts] = await sql<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='ai_member_history_fts'");
    expect(fts.sql).toContain("tokenize='trigram'");
    expect(fts.sql).toContain("contentless_delete=1");
    // Off by default: saving a workspace indexes nothing until an administrator enables memory.
    await saveWorkspace(member, [conversation("conv-report", "季度汇报", [["m1", "user", "帮我做一个季度汇报模板"], ["m2", "assistant", "季度汇报模板：一、本季度完成情况；二、遇到的问题；三、下季度计划。"]])]);
    expect(await sql("SELECT COUNT(*) AS count FROM ai_member_history_chunks")).toEqual([{ count: 0 }]);
  });

  it("indexes each workspace save and recalls it into a new conversation (DO FTS5 MATCH)", async () => {
    const saved = await api<{ settings: { recallEnabled: boolean } }>("/api/admin/ai/memory", admin, { enabled: true, reviewTier: "quick", pricePoints: 10 }, "PUT");
    expect(saved.settings.recallEnabled).toBe(true);
    await saveWorkspace(member, [conversation("conv-report", "季度汇报", [["m1", "user", "帮我做一个季度汇报模板"], ["m2", "assistant", "季度汇报模板：一、本季度完成情况；二、遇到的问题；三、下季度计划。"]])]);
    expect(await sql("SELECT message_id FROM ai_member_history_chunks ORDER BY message_id")).toEqual([{ message_id: "m1" }, { message_id: "m2" }]);
    expect(await sql("SELECT COUNT(*) AS count FROM ai_member_history_fts WHERE ai_member_history_fts MATCH 'body:\"汇报模\"'")).toEqual([{ count: 2 }]);
    const reply = await chat(member, "上次那个汇报模板再发我看看", "conv-new");
    const instructions = chatInstructions.at(-1)!;
    expect(instructions).toMatch(/<member_history id="[0-9a-f]{8}">/);
    expect(instructions).toContain("《季度汇报》");
    expect(instructions).toContain("季度汇报模板：一、本季度完成情况");
    await vi.waitFor(async () => {
      const [status] = (await api<{ reviews: AiMemoryReviewStatus[] }>(`/api/ai/memory/reviews?requestIds=${reply.requestId}`, member)).reviews;
      expect(status.activity).toEqual({ recalled: 2, trigger: "reference", skills: [] });
    }, { timeout: 10_000, interval: 100 });
    const detail = await api<{ recall: AiMemoryRecallEvent }>(`/api/ai/memory/recalls/${reply.requestId}`, member);
    expect(detail.recall.snippets.map(snippet => snippet.conversationTitle)).toEqual(["季度汇报", "季度汇报"]);
    // An edit reaches the index on the next save.
    await saveWorkspace(member, [conversation("conv-report", "季度汇报", [["m1", "user", "帮我做一个季度汇报模板"], ["m2", "assistant", "月度复盘模板：目标、结果、改进。"]])]);
    expect(await sql("SELECT COUNT(*) AS count FROM ai_member_history_fts WHERE ai_member_history_fts MATCH 'body:\"复盘模\"'")).toEqual([{ count: 1 }]);
    expect(await sql("SELECT COUNT(*) AS count FROM ai_member_history_fts WHERE ai_member_history_fts MATCH 'body:\"本季度\"'")).toEqual([{ count: 0 }]);
    // A name that titles another conversation is an entity (json_each on the DO SQLite).
    await saveWorkspace(member, [
      conversation("conv-report", "季度汇报", [["m1", "user", "帮我做一个季度汇报模板"], ["m2", "assistant", "月度复盘模板：目标、结果、改进。"]]),
      conversation("conv-lora", "LORA 生态合作", [["l1", "user", "LORA Chain 生态合作方案怎么写"], ["l2", "assistant", "LORA 生态合作方案分三部分：目标伙伴、合作方式、里程碑。"]]),
    ]);
    await chat(member, "LORA 的里程碑下一步怎么排", "conv-next");
    expect(chatInstructions.at(-1)).toContain("《LORA 生态合作》");
  });

  it("never recalls another member's conversations", async () => {
    const reply = await chat(other, "上次那个汇报模板再发我看看", "conv-other");
    expect(chatInstructions.at(-1)).not.toContain("member_history");
    const list = await api<{ recall: unknown }>(`/api/ai/memory/recalls/${reply.requestId}`, member);
    expect(list.recall).toBeNull();
    expect((await api<AiMemoryState>("/api/ai/memory", other)).recall).toMatchObject({ indexedMessages: 0 });
  });

  it("proposes a personal skill after repeated requests, and applies it once the member adopts it", async () => {
    await saveWorkspace(member, [
      conversation("conv-w1", "第 37 周周报", [["w1", "user", "帮我写本周周报，先写结论再列完成事项和数据"]]),
      conversation("conv-w2", "第 38 周周报", [["w2", "user", "帮我写本周周报，先写结论再列完成事项和风险"]]),
    ]);
    const third = await chat(member, "帮我写本周周报，先写结论再列完成事项和下周计划", "conv-w3");
    await vi.waitFor(async () => {
      const [status] = (await api<{ reviews: AiMemoryReviewStatus[] }>(`/api/ai/memory/reviews?requestIds=${third.requestId}`, member)).reviews;
      expect(status).toMatchObject({ status: "applied", skillProposed: true });
    }, { timeout: 10_000, interval: 100 });
    expect(reviewPayloads.at(-1)).toMatchObject({ 技能评估: { 原因: expect.stringContaining("共 3 次") } });
    const state = await api<AiMemoryState>("/api/ai/memory", member);
    const [proposed] = state.skills!.items;
    expect(proposed).toMatchObject({ status: "proposed", name: "周报格式" });
    await chat(member, "帮我写这周的周报", "conv-w4");
    expect(chatInstructions.at(-1)).not.toContain("member_skills");
    await api<AiMemoryState>("/api/ai/memory/skills", member, { action: "adopt", id: proposed.id, expectedRevision: proposed.revision });
    await chat(member, "帮我写这周的周报", "conv-w5");
    expect(chatInstructions.at(-1)).toContain(`技能「周报格式」（@${proposed.id}）`);
    expect(await api("/api/ai/memory/skills", other)).toEqual({ enabled: true, skills: [] });
  });
});
