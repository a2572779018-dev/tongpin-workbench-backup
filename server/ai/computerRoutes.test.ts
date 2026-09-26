import express, { type NextFunction, type Request as ExpressRequest, type Response as ExpressResponse } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessCapability, AiHarnessInput } from "../../shared/ai";
import { AiPersonaRepository } from "./persona";
import { createSecretBox } from "./security";
import { AiWorkspaceRepository } from "./workspace";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";
import type { AiTransport } from "./provider";
import { createNodeAi } from "./node";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import type { PublicUser } from "../types";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";

type WorkerUser = Record<string, unknown> & { id: string };
// Loaded by path so the Node typecheck does not pull in Worker-only modules.
const workerRoutesModulePath = "../../cloudflare/src/ai/routes";
const { handleAiRequest } = await import(workerRoutesModulePath) as {
  handleAiRequest(request: Request, service: AiService, user: WorkerUser, users: () => WorkerUser[]): Promise<Response>;
};

/**
 * The computer executor API is one framework-neutral table
 * (server/ai/computerRoutes.ts) mounted by Express and by the Worker. This
 * drives the same scripted scenario through both and compares the responses.
 */

const JEV_KEY = "jev-parity-fixture-key-never-returned";
const TASK = {
  kind: "computer_task",
  goal: "在微信中给联系人「姐姐」发送消息「中秋快乐」",
  apps: [{ name: "微信", bundleId: "com.tencent.xinWeChat" }],
  parameters: [
    { id: "p1", role: "recipient", label: "联系人", value: "姐姐" },
    { id: "p2", role: "message", label: "消息内容", value: "中秋快乐" },
  ],
  successCheck: "与「姐姐」的聊天记录中出现刚发送的「中秋快乐」",
  irreversible: { kind: "send_message", summary: "发送消息给「姐姐」：中秋快乐", recipient: "姐姐", content: "中秋快乐" },
  actionKinds: ["activate_app", "click", "type", "key"],
};

function harnessInput(): AiHarnessInput {
  const route = (modelId: string, capabilities: AiHarnessCapability[]) => ({
    providerId: "primary", modelId, protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities, enabled: true,
  });
  return {
    providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey: "gateway-fixture-key", enabled: true }],
    tiers: { quick: route("q-fast", ["chat"]), standard: route("s-standard", ["chat"]), deep: route("d-deep", ["chat", "computer"]), pro: route("p-pro", ["chat", "computer"]) },
    policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
  };
}

function fixtureTransport(): AiTransport {
  return vi.fn<AiTransport>(async (url, init) => {
    if (url === "https://gateway.example.com/v1/models") return Response.json({ data: ["q-fast", "s-standard", "d-deep", "p-pro"].map(id => ({ id })) });
    if (url === "https://gateway.example.com/v1/chat/completions") {
      return Response.json({ choices: [{ message: { content: JSON.stringify(TASK) } }], usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 } });
    }
    if (url === "https://api.typesafe.ai/v1/models") return Response.json({ models: [{ name: "jev-latest" }, { name: "jev-1.13.0" }] });
    if (url === "https://api.typesafe.ai/v1/systemone") {
      const body = JSON.parse(init.body!) as { questions: Record<string, { type: string; criteria?: Record<string, string> }> };
      const options = Object.keys(body.questions.next_action.criteria!);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === "choice"
        ? { type: "choice", choice: "open_search", confidence: 0.9, probabilities: Object.fromEntries(options.map(option => [option, option === "open_search" ? 1 : 0])) }
        : { type: "noul", noul: 0.1 }]));
      return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 1800, output_tokens: 30 } });
    }
    throw new Error(`unexpected ${url}`);
  });
}

const decision = (step: number, overrides: Record<string, unknown> = {}) => ({
  step,
  observationId: `ob_${"0".repeat(23)}${step}`,
  observation: { trust: "untrusted_screen_content", app: "微信", windowTitle: "微信", axSparse: false, elementsTotal: 2, elements: [{ ref: "e1", role: "text_area", label: "Search", editable: true, searchBox: true }], texts: ["姐姐"] },
  candidates: [
    { id: "open_search", description: "Press Command+F in the \"微信\" window to put keyboard focus in its search box.", risk: "none" },
    { id: "reobserve", description: "Do not act now; take a fresh observation.", risk: "none" },
    { id: "abstain", description: "Stop without acting.", risk: "none" },
    { id: "done", description: "Stop because the success check is satisfied.", risk: "none" },
  ],
  facts: { focus: "none", irreversibleDone: false },
  history: [],
  ...overrides,
});

type Call = { method: string; path: string; role: "admin" | "member"; body?: unknown };
type Reply = { status: number; body: any };

const SCENARIO = (taskRequestId: string, quickRequestId: string): Array<Call | ((replies: Reply[]) => Call)> => [
  { method: "GET", path: "/api/admin/ai/computer", role: "admin" },
  { method: "GET", path: "/api/admin/ai/computer", role: "member" },
  { method: "POST", path: "/api/ai/computer/tasks", role: "member", body: { requestId: taskRequestId, mode: "deep", conversationId: "conversation-a", instruction: "用微信给姐姐发中秋快乐" } },
  { method: "PUT", path: "/api/admin/ai/computer", role: "admin", body: { enabled: true, apiKey: JEV_KEY, model: "jev-latest", inputPointsPer1k: 500, outputPointsPer1k: 1000, maxSteps: 30, maxMinutes: 6, minConfidence: 0.5 } },
  { method: "POST", path: "/api/admin/ai/computer/test", role: "admin" },
  { method: "PUT", path: "/api/admin/ai/computer", role: "admin", body: { enabled: true, model: "gpt-4o", inputPointsPer1k: 500, outputPointsPer1k: 1000 } },
  { method: "POST", path: "/api/ai/computer/tasks", role: "member", body: { requestId: quickRequestId, mode: "quick", conversationId: "conversation-a", instruction: "用微信给姐姐发中秋快乐" } },
  { method: "POST", path: "/api/ai/computer/tasks", role: "member", body: { requestId: taskRequestId, mode: "deep", conversationId: "conversation-a", instruction: "用微信给姐姐发中秋快乐" } },
  (replies) => ({ method: "POST", path: `/api/ai/computer/runs/${replies[7].body.run.runId}/decide`, role: "member", body: decision(1) }),
  (replies) => ({ method: "POST", path: `/api/ai/computer/runs/${replies[7].body.run.runId}/decide`, role: "member", body: decision(1) }),
  (replies) => ({ method: "POST", path: `/api/ai/computer/runs/${replies[7].body.run.runId}/decide`, role: "member", body: decision(2, { candidates: [{ id: "shell_rm", description: "x", risk: "none" }] }) }),
  (replies) => ({ method: "GET", path: `/api/ai/computer/runs/${replies[7].body.run.runId}`, role: "member" }),
  (replies) => ({ method: "POST", path: `/api/ai/computer/runs/${replies[7].body.run.runId}/finish`, role: "member", body: { outcome: "abstained", reason: "user_stopped", summary: "未完成：你停止了电脑操作。", steps: 1 } }),
  { method: "GET", path: `/api/ai/computer/runs/cr_${"f".repeat(32)}`, role: "member" },
  { method: "GET", path: "/api/admin/ai/computer", role: "admin" },
];

function normalize(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)
    .replace(/cr_[0-9a-f]{32}/g, "cr_RUN")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "TIME"));
}

describe("computer executor routes: Worker ↔ Express parity", () => {
  let database: DatabaseSync;
  let directory: string;
  let node: Awaited<ReturnType<typeof createNodeAi>>;
  let http: Server | undefined;
  let workerTransport: AiTransport;
  let nodeTransport: AiTransport;
  let workerService: AiService;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T {
        database.exec("BEGIN");
        try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; }
      },
    };
    const store = new AiStore(sql); store.initialize();
    new AiPersonaRepository(sql).initialize();
    new AiWorkspaceRepository(sql).initialize();
    workerTransport = fixtureTransport();
    workerService = new AiService(store, () => createSecretBox("worker-computer-route-fixture-secret-32-bytes"), workerTransport);
    const workerScoped = workerService.forTenant("tenant-alpha");
    await workerScoped.saveHarness(harnessInput());
    await workerScoped.discoverHarnessProvider("primary");
    workerScoped.setQuota("member-a", "admin", { limitTokens: 200_000 });

    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-computer-routes-"));
    nodeTransport = fixtureTransport();
    node = await createNodeAi(path.join(directory, "fixture.json"), nodeTransport);
    const nodeScoped = node.service.forTenant("tenant-alpha");
    await nodeScoped.saveHarness(harnessInput());
    await nodeScoped.discoverHarnessProvider("primary");
    nodeScoped.setQuota("member-a", "admin", { limitTokens: 200_000 });

    const timestamp = new Date().toISOString();
    const user = (id: string, role: "admin" | "member"): PublicUser => ({
      id, tenantId: "tenant-alpha", email: `${id}@example.com`, name: id, role, status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0,
      emailVerifiedAt: timestamp, lastLoginAt: timestamp, createdAt: timestamp, updatedAt: timestamp, hasCustomAvatar: false,
    });
    const users = { read: async <T,>(read: (value: { users: PublicUser[] }) => T) => read({ users: [user("member-a", "member"), user("admin-a", "admin")] }) } as unknown as JsonStore;
    const requireAuth = (incoming: ExpressRequest, _response: ExpressResponse, next: NextFunction) => {
      incoming.currentUser = incoming.get("X-Test-Role") === "admin" ? user("admin-a", "admin") : user("member-a", "member");
      next();
    };
    const app = express();
    app.use(express.json());
    const auth = requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>;
    app.use("/api/admin/ai", createAiRouter(node.service, users, auth, true));
    app.use("/api/ai", createAiRouter(node.service, users, auth, false));
    app.use((error: { status?: number; code?: string; message?: string }, _request: ExpressRequest, response: ExpressResponse, _next: NextFunction) => {
      response.status(error.status ?? 500).json({ error: { code: error.code ?? "TEST_ROUTE_ERROR", message: error.message ?? "failed" } });
    });
    http = await listenLoopback(app);
  });

  afterEach(async () => {
    database.close();
    await closeServer(http); http = undefined;
    node.close();
    await rm(directory, { recursive: true });
  });

  const principal = (role: "admin" | "member"): WorkerUser => ({
    id: role === "admin" ? "admin-a" : "member-a", tenant_id: "tenant-alpha", name: role, role, status: "active", email: `${role}@example.com`,
    password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0, avatar_data_url: null,
    email_verified_at: "2026-09-27T00:00:00Z", last_login_at: null, created_at: "2026-09-27T00:00:00Z", updated_at: "2026-09-27T00:00:00Z",
  });

  async function viaWorker(call: Call): Promise<Reply> {
    const response = await handleAiRequest(new Request(`https://tongpin.example.com${call.path}`, {
      method: call.method,
      headers: { "X-Tongpin-Account": principal(call.role).id, ...(call.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
    }), workerService, principal(call.role), () => [principal("member"), principal("admin")]);
    return { status: response.status, body: await response.json() };
  }
  async function viaExpress(call: Call): Promise<Reply> {
    const headers = { "X-Test-Role": call.role, "X-Tongpin-Account": call.role === "admin" ? "admin-a" : "member-a" };
    const pending = call.method === "GET" ? request(http!).get(call.path).set(headers)
      : call.method === "PUT" ? request(http!).put(call.path).set(headers).send(call.body as object)
        : request(http!).post(call.path).set(headers).send((call.body ?? {}) as object);
    const response = await pending;
    return { status: response.status, body: response.body };
  }

  it("serves the same statuses and bodies on both deployments", async () => {
    const taskRequestId = "computer-11111111-1111-4111-8111-111111111111";
    const quickRequestId = "computer-22222222-2222-4222-8222-222222222222";
    const worker: Reply[] = [];
    const express: Reply[] = [];
    for (const entry of SCENARIO(taskRequestId, quickRequestId)) {
      worker.push(await viaWorker(typeof entry === "function" ? entry(worker) : entry));
      express.push(await viaExpress(typeof entry === "function" ? entry(express) : entry));
    }
    const statuses = worker.map(reply => reply.status);
    expect(statuses).toEqual([200, 403, 503, 200, 200, 400, 403, 200, 200, 200, 400, 200, 200, 404, 200]);
    expect(express.map(reply => reply.status)).toEqual(statuses);
    // Role gating is enforced by each stack's own middleware; everything the
    // shared table answers must be byte-for-byte equivalent.
    for (const [index, reply] of worker.entries()) {
      if (index === 1) continue;
      expect(normalize(express[index].body), `step ${index}`).toEqual(normalize(reply.body));
    }
    expect(worker[2].body.error.code).toBe("AI_COMPUTER_JEV_DISABLED");
    expect(worker[5].body.error.code).toBe("AI_COMPUTER_SETTINGS_INVALID");
    expect(worker[6].body.error).toMatchObject({ code: "AI_TIER_CAPABILITY_DISABLED", message: expect.stringContaining("快速档位未开放电脑操作") });
    expect(worker[7].body).toMatchObject({ kind: "run", run: { task: { goal: TASK.goal }, decisionModel: "jev-latest" } });
    expect(worker[8].body).toMatchObject({ step: 1, replayed: false, decision: { selectedId: "open_search" }, usage: { points: 930, estimated: false } });
    expect(worker[9].body).toMatchObject({ step: 1, replayed: true });
    expect(worker[10].body.error.code).toBe("AI_COMPUTER_INPUT_INVALID");
    expect(worker[12].body.run).toMatchObject({ status: "abstained", reason: "user_stopped", steps: 1 });
    expect(worker[14].body.settings).toMatchObject({ enabled: true, apiKeyConfigured: true, availableModels: ["jev-latest", "jev-1.13.0"] });
    for (const reply of [...worker, ...express]) expect(JSON.stringify(reply.body)).not.toContain(JEV_KEY);
    // Each stack called TypeSafe exactly twice (model list + one decision; the replay is served from the run).
    for (const transport of [workerTransport, nodeTransport]) {
      expect(vi.mocked(transport).mock.calls.filter(([url]) => String(url).startsWith("https://api.typesafe.ai/"))).toHaveLength(2);
    }
  });
});
