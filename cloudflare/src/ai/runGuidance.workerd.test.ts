import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiHarnessInput, AiHarnessTrace } from "../../../shared/ai";
import type { AiRunGuidanceItem } from "../../../shared/aiRunGuidance";
import { AI_RUN_GUIDANCE_FRAMING, AI_SUPPLEMENT_FRAMING } from "../../../server/ai/runGuidance";

const TEST_ADMIN = "admin@guidance.workerd.example.com";
const TEST_PASSWORD = "WorkerdOnly20260926!";
const TEST_API_KEY = "test-guidance-provider-not-real";
const WORKER_NAME = "tongpin-guidance-workerd-test";
type Session = { accessToken: string; user: { id: string; email: string; role: string } };
type ProviderBody = { messages: Array<{ role: string; content: string }> };

/** The bundled Worker + SQLite Durable Object under workerd. Every outbound
 * request is intercepted; no real account, provider or key is involved. */
describe.sequential("mid-run guidance in the production Worker and SQLite Durable Object", () => {
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  let other: Session;
  const bodies: ProviderBody[] = [];
  let nextContent = "完成";
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
      return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    }
    expect(url.hostname).toBe("ai-fixture.example.com");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    if (url.pathname === "/v1/models") return MfResponse.json({ data: ["q-fast", "s-standard", "d-deep", "p-pro"].map(id => ({ id })) });
    expect(url.pathname).toBe("/v1/chat/completions");
    bodies.push(await request.json() as ProviderBody);
    return MfResponse.json({ choices: [{ message: { content: nextContent } }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } });
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
  const storage = () => mf.unsafeGetDurableObjectStorage(WORKER_NAME, "TongpinCore", { name: "primary" });
  /** A react run whose first tool step finished: its next model step is a continuation. */
  const plantPlannedRun = async (userId: string) => {
    const requestId = crypto.randomUUID(), runId = crypto.randomUUID(), now = new Date().toISOString();
    const db = await storage();
    await db.exec("INSERT INTO ai_harness_runs(user_id,id,request_id,tenant_id,conversation_id,tier,provider_id,capability,goal_kind,goal_summary,background_capable,status,reasoning_summary,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      userId, runId, requestId, "default", "conversation-steer", "quick", "primary", "presentation", "presentation", "完成当前演示文稿任务。", 1, "planned", "等待下一步", Date.now(), Date.now());
    const step = (kind: string, extra: Record<string, unknown>) => db.exec("INSERT INTO ai_harness_steps(user_id,run_id,id,tenant_id,data) VALUES(?,?,?,?,?)", userId, runId, crypto.randomUUID(), "default",
      JSON.stringify({ id: crypto.randomUUID(), kind, capability: "presentation", title: kind, summary: "已完成", status: "succeeded", createdAt: now, updatedAt: now, ...extra }));
    await step("strategy", { strategy: "react", maxToolSteps: 3 });
    await step("tool", { sequence: 1, proposalId: crypto.randomUUID(), approvalStatus: "consumed" });
    return requestId;
  };

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-guidance-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER_NAME, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "guidance-workerd-fixture-secret-".repeat(3), BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN,
        DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local",
        AI_ALLOWED_HOSTS: "ai-fixture.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register(TEST_ADMIN, "Guidance 管理员");
    admin = await login(TEST_ADMIN);
    await register("member@guidance.workerd.example.com", "Guidance 成员");
    await register("other@guidance.workerd.example.com", "Guidance 其他成员");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    for (const email of ["member@guidance.workerd.example.com", "other@guidance.workerd.example.com"]) {
      const user = users.users.find(item => item.email === email)!;
      await api(`/api/admin/users/${user.id}/access`, admin, { status: "active" }, "PATCH");
      await api(`/api/admin/ai/members/${user.id}/quota`, admin, { limitTokens: 50_000 }, "PUT");
    }
    member = await login("member@guidance.workerd.example.com");
    other = await login("other@guidance.workerd.example.com");
    const route = (modelId: string) => ({ providerId: "primary", modelId, protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities: ["chat" as const, "presentation" as const], enabled: true });
    const harness: AiHarnessInput = {
      providers: [{ id: "primary", name: "Guidance fixture", baseUrl: "https://ai-fixture.example.com/v1", protocol: "chat_completions", apiKey: TEST_API_KEY, enabled: true }],
      tiers: { quick: route("q-fast"), standard: route("s-standard"), deep: route("d-deep"), pro: route("p-pro") },
      policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: false },
    };
    await api("/api/admin/ai/harness", admin, harness, "PUT");
    await api("/api/admin/ai/harness/providers/primary/discover", admin, {});
  }, 60_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("stores guidance per member, injects it into the run's next model step once, then closes it", async () => {
    const requestId = await plantPlannedRun(member.user.id);
    const url = `/api/ai/requests/${requestId}/guidance`;
    const accepted = await api<{ guidance: AiRunGuidanceItem; created: boolean }>(url, member, { id: "guidance-workerd-00001", text: "第二页改成对比表" });
    expect(accepted).toMatchObject({ created: true, guidance: { id: "guidance-workerd-00001", status: "pending" } });
    await api(url, other, { id: "guidance-workerd-00002", text: "越权" }, "POST", 404);
    expect(await api<{ guidance: AiRunGuidanceItem[] }>(url, other)).toEqual({ guidance: [] });
    await api(`${url}/guidance-workerd-00001`, other, undefined, "DELETE", 404);
    await api(url, member, { id: "guidance-workerd-00003", text: "越权", userId: other.user.id }, "POST", 400);

    nextContent = '{"action":"complete","summary":"已按补充完成"}';
    const resumed = await api<{ trace: AiHarnessTrace }>(`/api/ai/runs/${requestId}/resume`, member, {});
    expect(resumed.trace).toMatchObject({ status: "succeeded", reasoningSummary: "已按补充完成" });
    const users = bodies.at(-1)!.messages.filter(message => message.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1].content).toBe(`${AI_RUN_GUIDANCE_FRAMING}\n第二页改成对比表`);
    expect(JSON.stringify(bodies.at(-1))).not.toContain("越权");

    expect(await api<{ guidance: AiRunGuidanceItem[] }>(url, member)).toMatchObject({ guidance: [{ id: "guidance-workerd-00001", status: "delivered" }] });
    expect((await api<{ error: { code: string } }>(`${url}/guidance-workerd-00001`, member, undefined, "DELETE", 409)).error.code).toBe("AI_GUIDANCE_DELIVERED");
    expect((await api<{ error: { code: string } }>(url, member, { id: "guidance-workerd-00004", text: "晚了" }, "POST", 409)).error.code).toBe("AI_RUN_NOT_ACTIVE");
    const rows = await (await storage()).exec<{ text: string; tenant_id: string; user_id: string }>("SELECT text,tenant_id,user_id FROM ai_run_guidance");
    expect(rows).toEqual([{ text: "", tenant_id: "default", user_id: member.user.id }]);
  });

  it("frames a supplement follow-up for the model only", async () => {
    nextContent = "好的，已改成英文。";
    const response = await api<{ content: string }>("/api/ai/chat", member, {
      requestId: crypto.randomUUID(), conversationId: "conversation-supplement", mode: "quick", supplement: true,
      messages: [{ role: "user", content: "写一份周报" }, { role: "user", content: "改成英文" }],
    });
    expect(response.content).toBe("好的，已改成英文。");
    const messages = bodies.at(-1)!.messages.filter(message => message.role === "user");
    expect(messages.at(-1)!.content).toBe(`${AI_SUPPLEMENT_FRAMING}\n改成英文`);
    expect(messages[0].content).toBe("写一份周报");
  });
});
