import express, { type NextFunction, type Request, type Response as ExpressResponse } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import type { PublicUser } from "../types";
import { AiWorkspaceRepository } from "./workspace";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import type { SubmitMediaTask } from "./mediaTaskOrchestrator";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const provider = {
  name: "Media route fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret-only",
  protocol: "chat_completions" as const, quickModel: "text-model", deepModel: "text-model",
  maxOutputTokens: 2048, reasoningEffort: "" as const, enabled: true,
  imageModel: "image-model", imageQuotaTokens: 1000,
};
const plan = (prompt = "蓝色科技海报") => Response.json({
  choices: [{ message: { content: JSON.stringify({ kind: "image", summary: "准备图片", prompt }) } }],
  usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 },
});
const clarification = () => Response.json({
  choices: [{ message: { content: JSON.stringify({ kind: "clarification", question: "想画什么主题？" }) } }],
  usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
});
const image = () => Response.json({ data: [{ b64_json: PNG }] });
const taskInput = (overrides: Partial<SubmitMediaTask> = {}): SubmitMediaTask => ({
  requestId: crypto.randomUUID(), conversationId: "conversation-a", entrypoint: "menu",
  tier: "quick", intent: "image", requestText: "生成一张蓝色科技海报", sourceAssetIds: [], ...overrides,
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};

describe("Node authenticated media-task routes", () => {
  let directory: string;
  let node: Awaited<ReturnType<typeof createNodeAi>>;
  let app: express.Express;
  const transport = vi.fn<AiTransport>();
  const actorHeaders = (userId = "member-a", tenantId = "tenant-alpha") => ({
    "X-Test-User": userId, "X-Authenticated-Tenant": tenantId, "X-Tongpin-Account": userId,
  });
  const get = (url: string, userId = "member-a", tenantId = "tenant-alpha") => request(app).get(url).set(actorHeaders(userId, tenantId));
  const post = (url: string, body?: unknown, userId = "member-a", tenantId = "tenant-alpha") => {
    const call = request(app).post(url).set(actorHeaders(userId, tenantId));
    return body === undefined ? call : call.send(body as string | object);
  };
  const remove = (url: string, userId = "member-a", tenantId = "tenant-alpha") => request(app).delete(url).set(actorHeaders(userId, tenantId));
  const waitForStatus = async (requestId: string, status: string) => {
    let last: Record<string, unknown> | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const response = await get(`/api/ai/media-tasks/by-request/${requestId}`).expect(200);
      last = response.body.task;
      if (last?.status === status) return last;
      await new Promise<void>(resolve => setTimeout(resolve, 5));
    }
    throw new Error(`media task did not reach ${status}: ${JSON.stringify(last)}`);
  };
  const quickly = async <T,>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("route blocked on background advance")), 1000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-media-routes-"));
    transport.mockReset();
    node = await createNodeAi(path.join(directory, "fixture.json"), transport);
    new AiWorkspaceRepository(node.store.sql).initialize();
    for (const tenantId of ["tenant-alpha", "tenant-beta"]) {
      const scoped = node.service.forTenant(tenantId);
      await scoped.saveProvider(provider);
      scoped.setQuota("member-a", "admin", { limitTokens: 20_000 });
      scoped.setQuota("member-b", "admin", { limitTokens: 20_000 });
    }
    const timestamp = new Date().toISOString();
    const activeUsers: PublicUser[] = ["member-a", "member-b"].map(id => ({
      id, tenantId: "tenant-alpha", email: `${id}@example.com`, name: id, role: "member", status: "active",
      jobTitle: "", avatarSeed: 1, avatarVersion: 0, emailVerifiedAt: timestamp, lastLoginAt: timestamp,
      createdAt: timestamp, updatedAt: timestamp, hasCustomAvatar: false,
    }));
    const users = { read: async <T,>(read: (value: { users: PublicUser[] }) => T) => read({ users: activeUsers }) } as unknown as JsonStore;
    const requireAuth = (incoming: Request, _response: ExpressResponse, next: NextFunction) => {
      const id = incoming.get("X-Test-User") || "member-a";
      incoming.currentUser = {
        id, tenantId: incoming.get("X-Authenticated-Tenant") || "tenant-alpha", email: `${id}@example.com`, name: id,
        role: "member", status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0,
        emailVerifiedAt: timestamp, lastLoginAt: timestamp, createdAt: timestamp, updatedAt: timestamp, hasCustomAvatar: false,
      };
      next();
    };
    app = express();
    app.use(express.json());
    app.use("/api/ai", createAiRouter(node.service, users, requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>));
    app.use((error: { status?: number; code?: string; message?: string }, _request: Request, response: ExpressResponse, _next: NextFunction) => {
      response.status(error.status ?? 500).json({ error: { code: error.code ?? "TEST_ROUTE_ERROR", message: error.message ?? "failed" } });
    });
  });

  afterEach(async () => { node.close(); await rm(directory, { recursive: true }); });

  it("returns queued before finish-time planning, recovers by request, isolates the principal, and never invents payment consent", async () => {
    const planner = deferred<Response>();
    transport.mockImplementationOnce(() => planner.promise);
    const forged = { ...taskInput(), userId: "member-b", tenantId: "tenant-beta" };
    await post("/api/ai/media-tasks", forged).expect(400);
    const input = taskInput();
    const submitted = await quickly(post("/api/ai/media-tasks", input).then(response => response));
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body.task).toMatchObject({ requestId: input.requestId, tenantId: "tenant-alpha", userId: "member-a", status: "queued" });
    expect(submitted.body.task.authorization).toBeUndefined();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    expect((await get(`/api/ai/media-tasks/by-request/${input.requestId}`)).body.task.runId).toBe(submitted.body.task.runId);
    await get(`/api/ai/media-tasks/${submitted.body.task.runId}`, "member-b").expect(404);
    await get(`/api/ai/media-tasks/${submitted.body.task.runId}`, "member-a", "tenant-beta").expect(404);

    planner.resolve(plan());
    const staged = await waitForStatus(input.requestId, "awaiting_authorization");
    expect(staged.authorization).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(node.service.forTenant("tenant-alpha").store.usage("member-a").filter(entry => entry.kind === "image")).toHaveLength(0);

    await post(`/api/ai/media-tasks/${submitted.body.task.runId}/authorize`, { confirmed: false, maxPointsPerTool: 1000 }).expect(400);
    await request(app).post(`/api/ai/media-tasks/${submitted.body.task.runId}/authorize`).set(actorHeaders()).set("Content-Type", "application/json").send('{"confirmed":').expect(400);
    expect(transport).toHaveBeenCalledTimes(1);
    transport.mockResolvedValueOnce(image());
    const authorized = await post(`/api/ai/media-tasks/${submitted.body.task.runId}/authorize`, { confirmed: true, maxPointsPerTool: 1000 }).expect(200);
    expect(authorized.body.task.status).toBe("completed");
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
  });

  it("validates answer JSON, supports explicit advance, and cancels without a paid call", async () => {
    transport.mockResolvedValueOnce(clarification());
    const input = taskInput({ requestText: "帮我画一张宠物图片" });
    const submitted = await post("/api/ai/media-tasks", input).expect(202);
    const waiting = await waitForStatus(input.requestId, "awaiting_input");
    const questionId = (waiting.freeQuestion as { questionId: string }).questionId;

    await post(`/api/ai/media-tasks/${submitted.body.task.runId}/answer`, { questionId, answer: "" }).expect(400);
    await request(app).post(`/api/ai/media-tasks/${submitted.body.task.runId}/answer`).set(actorHeaders()).set("Content-Type", "application/json").send("not-json").expect(400);
    transport.mockResolvedValueOnce(plan("一只蓝色的猫"));
    const answered = await post(`/api/ai/media-tasks/${submitted.body.task.runId}/answer`, { questionId, answer: "一只蓝色的猫" }).expect(200);
    expect(answered.body.task.status).toBe("queued");

    await waitForStatus(input.requestId, "awaiting_authorization");
    const advanced = await post(`/api/ai/media-tasks/${submitted.body.task.runId}/advance`).expect(200);
    expect(advanced.body.task.status).toBe("awaiting_authorization");
    const cancelled = await remove(`/api/ai/media-tasks/${submitted.body.task.runId}`).expect(200);
    expect(cancelled.body.task.status).toBe("cancelled");
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(0);
  });

  it("passes an explicit send-time confirmation through while the HTTP response remains queued and non-blocking", async () => {
    const planner = deferred<Response>();
    transport.mockImplementationOnce(() => planner.promise).mockResolvedValueOnce(image());
    const input = taskInput({ confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 } });
    const submitted = await quickly(post("/api/ai/media-tasks", input).then(response => response));
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
    expect(submitted.body.task).toMatchObject({ status: "queued", authorization: { capabilities: ["image"], maxPointsPerTool: 1000 } });
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    planner.resolve(plan());
    const completed = await waitForStatus(input.requestId, "completed");
    expect(completed).toMatchObject({ tool: { artifactIds: [expect.any(String)] } });
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
  });
});
