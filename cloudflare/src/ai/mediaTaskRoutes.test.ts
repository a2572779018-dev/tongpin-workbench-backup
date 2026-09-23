import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiPersonaRepository } from "../../../server/ai/persona";
import { createSecretBox } from "../../../server/ai/security";
import { AiService } from "../../../server/ai/service";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import type { AiTransport } from "../../../server/ai/provider";
import type { SubmitMediaTask } from "../../../server/ai/mediaTaskOrchestrator";
import { AiWorkspaceRepository } from "../../../server/ai/workspace";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const provider = {
  name: "Worker media route fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret-only",
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

describe("Cloudflare authenticated media-task routes", () => {
  let database: DatabaseSync;
  let store: AiStore;
  let service: AiService;
  const transport = vi.fn<AiTransport>();
  const principal = (id = "member-a", tenantId = "tenant-alpha") => ({
    id, tenant_id: tenantId, name: id, role: "member", status: "active", email: `${id}@example.com`,
    password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0,
    avatar_data_url: null, email_verified_at: "2026-09-23T00:00:00Z", last_login_at: null,
    created_at: "2026-09-23T00:00:00Z", updated_at: "2026-09-23T00:00:00Z",
  } as UserRow);
  const users = () => [principal("member-a"), principal("member-b")];
  const invoke = (
    path: string, method: string, actor = principal(), body?: unknown,
    keepAlive?: (task: Promise<void>) => void, rawBody?: string,
  ) => handleAiRequest(new Request(`https://tongpin.example.com${path}`, {
    method,
    headers: {
      "X-Tongpin-Account": actor.id, "X-Tongpin-Tenant": "tenant-spoofed",
      ...((body === undefined && rawBody === undefined) ? {} : { "content-type": "application/json" }),
    },
    ...((body === undefined && rawBody === undefined) ? {} : { body: rawBody ?? JSON.stringify(body) }),
  }), service, actor, users, {}, keepAlive);
  const jsonTask = async (response: Response) => (await response.json() as { task: Record<string, any> }).task;
  const quickly = async <T,>(promise: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Worker route blocked on waitUntil task")), 1000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T {
        database.exec("BEGIN");
        try { const result = action(); database.exec("COMMIT"); return result; }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      },
    };
    store = new AiStore(sql); store.initialize();
    new AiPersonaRepository(sql).initialize();
    new AiWorkspaceRepository(sql).initialize();
    transport.mockReset();
    service = new AiService(store, () => createSecretBox("worker-media-route-fixture-secret-at-least-32-bytes"), transport);
    for (const tenantId of ["tenant-alpha", "tenant-beta"]) {
      const scoped = service.forTenant(tenantId);
      await scoped.saveProvider(provider);
      scoped.setQuota("member-a", "admin", { limitTokens: 20_000 });
      scoped.setQuota("member-b", "admin", { limitTokens: 20_000 });
    }
  });

  afterEach(() => { database.close(); });

  it("returns 202 queued, gives advance to keepAlive, recovers by request, and does not invent authorization", async () => {
    const planner = deferred<Response>();
    const kept: Promise<void>[] = [];
    const keepAlive = vi.fn((task: Promise<void>) => { kept.push(task); });
    transport.mockImplementationOnce(() => planner.promise);
    const forged = { ...taskInput(), userId: "member-b", tenantId: "tenant-beta" };
    expect((await invoke("/api/ai/media-tasks", "POST", principal(), forged, keepAlive)).status).toBe(400);
    const input = taskInput();
    const response = await quickly(invoke("/api/ai/media-tasks", "POST", principal(), input, keepAlive));
    expect(response.status).toBe(202);
    const submitted = await jsonTask(response);
    expect(submitted).toMatchObject({ requestId: input.requestId, tenantId: "tenant-alpha", userId: "member-a", status: "queued" });
    expect(submitted.authorization).toBeUndefined();
    expect(keepAlive).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    const recovered = await jsonTask(await invoke(`/api/ai/media-tasks/by-request/${input.requestId}`, "GET"));
    expect(recovered.runId).toBe(submitted.runId);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}`, "GET", principal("member-b"))).status).toBe(404);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}`, "GET", principal("member-a", "tenant-beta"))).status).toBe(404);

    planner.resolve(plan());
    await kept[0];
    const staged = await jsonTask(await invoke(`/api/ai/media-tasks/by-request/${input.requestId}`, "GET"));
    expect(staged.status).toBe("awaiting_authorization");
    expect(staged.authorization).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(service.forTenant("tenant-alpha").store.usage("member-a").filter(entry => entry.kind === "image")).toHaveLength(0);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/events`, "GET")).status).toBe(200);
    expect((await (await invoke(`/api/ai/media-tasks/${submitted.runId}/events`, "GET")).json() as { events: unknown[] }).events).toEqual([]);

    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/authorize`, "POST", principal(), { confirmed: false, maxPointsPerTool: 1000 })).status).toBe(400);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/authorize`, "POST", principal(), undefined, undefined, '{"confirmed":')).status).toBe(400);
    transport.mockResolvedValueOnce(image());
    const authorized = await invoke(`/api/ai/media-tasks/${submitted.runId}/authorize`, "POST", principal(), { confirmed: true, maxPointsPerTool: 1000 });
    expect(authorized.status).toBe(200);
    const completed = await jsonTask(authorized);
    expect(completed.status).toBe("completed");
    const events = (await (await invoke(`/api/ai/media-tasks/${submitted.runId}/events`, "GET")).json() as { events: Array<Record<string, any>> }).events;
    expect(events).toMatchObject([{ type: "artifact_ready", requestId: input.requestId, runId: submitted.runId, seq: 1, data: { capability: "image", artifactIds: completed.tool.artifactIds } }]);
    expect((await (await invoke(`/api/ai/media-tasks/${submitted.runId}/events?after=1`, "GET")).json() as { events: unknown[] }).events).toEqual([]);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/events`, "GET", principal("member-b"))).status).toBe(404);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/events`, "GET", principal("member-a", "tenant-beta"))).status).toBe(404);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/events?after=-1`, "GET")).status).toBe(400);
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
  });

  it("validates answer JSON and supports explicit advance plus owner-only cancellation", async () => {
    const kept: Promise<void>[] = [];
    transport.mockResolvedValueOnce(clarification());
    const input = taskInput({ requestText: "帮我画一张宠物图片" });
    const response = await invoke("/api/ai/media-tasks", "POST", principal(), input, task => { kept.push(task); });
    const submitted = await jsonTask(response);
    await kept[0];
    const waiting = await jsonTask(await invoke(`/api/ai/media-tasks/${submitted.runId}`, "GET"));
    expect(waiting.status).toBe("awaiting_input");
    const questionId = waiting.freeQuestion.questionId as string;
    const eventsUrl = `/api/ai/media-tasks/${submitted.runId}/events`;
    const opened = (await (await invoke(eventsUrl, "GET")).json() as { events: Array<Record<string, any>> }).events;
    expect(opened).toMatchObject([{ type: "question_opened", requestId: input.requestId, runId: submitted.runId,
      seq: 1, data: { kind: "free_text", questionId, prompt: expect.any(String), deadlineAt: waiting.freeQuestion.deadlineAt } }]);
    expect((await (await invoke(`${eventsUrl}?after=1`, "GET")).json() as { events: unknown[] }).events).toEqual([]);
    expect((await invoke(eventsUrl, "GET", principal("member-b"))).status).toBe(404);
    expect((await invoke(eventsUrl, "GET", principal("member-a", "tenant-beta"))).status).toBe(404);

    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/answer`, "POST", principal(), { questionId, answer: "" })).status).toBe(400);
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}/answer`, "POST", principal(), undefined, undefined, "not-json")).status).toBe(400);
    const answered = await invoke(`/api/ai/media-tasks/${submitted.runId}/answer`, "POST", principal(), { questionId, answer: "一只蓝色的猫" });
    expect((await jsonTask(answered)).status).toBe("queued");

    transport.mockResolvedValueOnce(plan("一只蓝色的猫"));
    const advanced = await invoke(`/api/ai/media-tasks/${submitted.runId}/advance`, "POST");
    expect((await jsonTask(advanced)).status).toBe("awaiting_authorization");
    expect((await invoke(`/api/ai/media-tasks/${submitted.runId}`, "DELETE", principal("member-b"))).status).toBe(404);
    const cancelled = await invoke(`/api/ai/media-tasks/${submitted.runId}`, "DELETE");
    expect((await jsonTask(cancelled)).status).toBe("cancelled");
    expect((await (await invoke(eventsUrl, "GET")).json() as { events: unknown[] }).events).toEqual(opened);
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(0);
  });

  it("keeps an explicit send-time confirmation while the Worker response does not await paid execution", async () => {
    const planner = deferred<Response>();
    const kept: Promise<void>[] = [];
    transport.mockImplementationOnce(() => planner.promise).mockResolvedValueOnce(image());
    const input = taskInput({ confirmedMediaExecution: { confirmed: true, maxPointsPerTool: 1000 } });
    const response = await quickly(invoke("/api/ai/media-tasks", "POST", principal(), input, task => { kept.push(task); }));
    expect(response.status).toBe(202);
    const submitted = await jsonTask(response);
    expect(submitted).toMatchObject({ status: "queued", authorization: { capabilities: ["image"], maxPointsPerTool: 1000 } });
    expect(kept).toHaveLength(1);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    planner.resolve(plan());
    await kept[0];
    const completed = await jsonTask(await invoke(`/api/ai/media-tasks/by-request/${input.requestId}`, "GET"));
    expect(completed).toMatchObject({ status: "completed", tool: { artifactIds: [expect.any(String)] } });
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/images/generations"))).toHaveLength(1);
  });
});
