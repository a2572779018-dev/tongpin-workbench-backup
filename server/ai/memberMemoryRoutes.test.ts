import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_MEMORY_LIMITS } from "../../shared/aiMemory";
import { createRuntime } from "../app";
import type { AppConfig } from "../config";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";
import { MEMBER_MEMORY_REVIEW_INSTRUCTIONS } from "./memberMemoryPrompt";
import { memberMemoryRuntime } from "./memberMemoryService";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import type { AiService } from "./service";

const workerRouteModulePath = "../../cloudflare/src/ai/memberMemoryRoutes";
const { handleAiMemberMemoryRequest } = await import(workerRouteModulePath) as {
  handleAiMemberMemoryRequest(request: Request, service: AiService, user: { id: string; role: string; status: string }): Promise<Response>;
};

const provider = {
  name: "Fixture", baseUrl: "https://api.example.com/", apiKey: "fixture-provider-key-not-real", protocol: "chat_completions",
  quickModel: "quick-model", deepModel: "deep-model", maxOutputTokens: 1024, reasoningEffort: "", enabled: true,
};
const transport = vi.fn<AiTransport>(async (_url, init) => {
  const body = JSON.parse(init.body ?? "{}") as { messages?: Array<{ content: string }> };
  if (!body.messages) return Response.json({ data: [{ id: "quick-model" }] });
  const content = body.messages[0].content === MEMBER_MEMORY_REVIEW_INSTRUCTIONS
    ? JSON.stringify({ operations: [{ target: "user", action: "add", content: "成员在市场部负责品牌" }] })
    : "好的，已经为你整理好了本周工作重点。";
  return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
});

describe("member memory HTTP boundaries", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "tongpin-memory-routes-")); transport.mockClear(); });
  afterEach(async () => { await memberMemoryRuntime.idle(); await rm(directory, { recursive: true }); });

  it("Express: authenticates, keeps admin/member boundaries, and never exposes memory to administrators", async () => {
    const password = "MemoryFixture20260926!";
    const config: AppConfig = {
      host: "127.0.0.1", port: 0, dataFile: path.join(directory, "runtime.json"), jwtSecret: "memory-fixture-jwt-secret-not-for-production",
      clientOrigins: [], bootstrapAdminEmail: "memory-admin@tongpin.test", bootstrapAdminPassword: password, bootstrapAdminName: "隔离管理员",
      devEmailPreview: false, isProduction: false, loraExplorerApi: "https://explorer.invalid/api/v2", loraRpcUrl: "https://rpc.invalid",
      resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
    };
    const runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false, aiTransport: transport });
    let http: Server | undefined;
    try {
      http = await listenLoopback(runtime.app);
      await runtime.store.mutate(db => {
        const admin = db.users.find(user => user.role === "admin")!;
        db.users.push({ ...admin, id: "memory-member", role: "member", email: "memory-member@tongpin.test", name: "成员甲" });
        db.users.push({ ...admin, id: "memory-boss", role: "boss", email: "memory-boss@tongpin.test", name: "老板" });
      });
      const login = async (email: string) => (await request(http!).post("/api/auth/login").send({ email, password }).expect(200)).body.accessToken as string;
      const adminToken = await login(config.bootstrapAdminEmail);
      const admin = { Authorization: `Bearer ${adminToken}` };
      const member = { Authorization: `Bearer ${await login("memory-member@tongpin.test")}`, "X-Tongpin-Account": "memory-member" };
      const boss = { Authorization: `Bearer ${await login("memory-boss@tongpin.test")}`, "X-Tongpin-Account": "memory-boss" };

      await request(http!).get("/api/ai/memory").expect(401);
      await request(http!).get("/api/ai/memory").set(admin).expect(403);
      await request(http!).get("/api/admin/ai/memory").set(member).expect(403);
      expect((await request(http!).get("/api/ai/memory").set(member).expect(403)).body.error.code).toBe("AI_ACCESS_NOT_GRANTED");

      await request(http!).put("/api/admin/ai/provider").set(admin).send(provider).expect(200);
      for (const id of ["memory-member", "memory-boss"]) await request(http!).put(`/api/admin/ai/members/${id}/quota`).set(admin).send({ limitTokens: 50_000 }).expect(200);
      expect((await request(http!).get("/api/admin/ai/memory").set(admin).expect(200)).body.settings.enabled).toBe(false);
      await request(http!).put("/api/admin/ai/memory").set(admin).send({ enabled: true, reviewTier: "quick", pricePoints: 20 }).expect(200);
      await request(http!).put("/api/admin/ai/memory").set(admin).send({ enabled: true, reviewTier: "quick", pricePoints: 20, userId: "x" }).expect(400);

      const initial = await request(http!).get("/api/ai/memory").set(member).expect(200);
      expect(initial.headers["cache-control"]).toBe("no-store");
      expect(initial.body).toMatchObject({ revision: 0, available: true, learningEnabled: true, pricePoints: 20, stores: { user: { entries: [], limitCharacters: 600 }, memory: { limitCharacters: 1000 } } });
      const added = await request(http!).post("/api/ai/memory/entries").set(member).send({ expectedRevision: 0, operation: { action: "add", target: "user", content: "成员偏好先给结论" } }).expect(200);
      expect(added.body.stores.user.entries).toEqual(["成员偏好先给结论"]);
      await request(http!).post("/api/ai/memory/entries").set(member).send({ expectedRevision: 0, operation: { action: "add", target: "user", content: "过期版本" } }).expect(409);
      expect((await request(http!).post("/api/ai/memory/entries").set(member).send({ expectedRevision: 1, operation: { action: "add", target: "user", content: "我的密码是 Tongpin#2026" } }).expect(400)).body.error.code).toBe("AI_MEMORY_SECRET");
      await request(http!).post("/api/ai/memory/entries").set({ ...member, "X-Tongpin-Account": "someone-else" }).send({ expectedRevision: 1, operation: { action: "add", target: "user", content: "x" } }).expect(409);
      await request(http!).post("/api/ai/memory/entries").set(member).send({ padding: "x".repeat(AI_MEMORY_LIMITS.requestBytes) }).expect(413);

      // A real chat through the Express route triggers the background review.
      const chat = await request(http!).post("/api/ai/chat").set(member).send({ requestId: crypto.randomUUID(), mode: "quick", conversationId: "conv-1", messages: [{ role: "user", content: "记住我在市场部负责品牌" }] }).expect(200);
      await memberMemoryRuntime.idle();
      const reviews = await request(http!).get("/api/ai/memory/reviews").query({ requestIds: chat.body.requestId }).set(member).expect(200);
      expect(reviews.body.reviews).toEqual([{ requestId: chat.body.requestId, status: "applied", changes: { added: 1, updated: 0, removed: 0 } }]);
      await request(http!).get("/api/ai/memory/reviews").query({ requestIds: "bad id" }).set(member).expect(400);
      expect((await request(http!).get("/api/ai/memory").set(member).expect(200)).body.stores.user.entries).toEqual(["成员偏好先给结论", "成员在市场部负责品牌"]);

      // A boss only ever sees their own memory; administrators only aggregates.
      expect((await request(http!).get("/api/ai/memory").set(boss).expect(200)).body.stores.user.entries).toEqual([]);
      expect((await request(http!).get("/api/ai/memory/reviews").query({ requestIds: chat.body.requestId }).set(boss).expect(200)).body.reviews[0].status).toBe("none");
      const adminView = await request(http!).get("/api/admin/ai/memory").set(admin).expect(200);
      expect(adminView.body.stats).toMatchObject({ membersWithMemory: 1, totalEntries: 2, reviews7d: { applied: 1 }, points7d: 20 });
      expect(JSON.stringify(adminView.body)).not.toContain("市场部");
      expect(JSON.stringify((await request(http!).get("/api/admin/ai/usage").set(admin).expect(200)).body)).not.toContain("市场部");

      await request(http!).put("/api/ai/memory/settings").set(member).send({ learningEnabled: false }).expect(200);
      const cleared = await request(http!).delete("/api/ai/memory").set(member).expect(200);
      expect(cleared.body).toMatchObject({ learningEnabled: false, stores: { user: { entries: [] }, memory: { entries: [] } } });
      await request(http!).get("/api/ai/memory/unknown").set(member).expect(404);
    } finally { await closeServer(http); await runtime.close(); }
  });

  it("Cloudflare: binds every request to the authenticated account and role", async () => {
    const node = await createNodeAi(path.join(directory, "worker.json"), transport);
    try {
      await node.service.saveProvider(provider as never);
      node.service.setQuota("member-a", "admin", { limitTokens: 10_000 });
      const call = (pathname: string, method = "GET", user = { id: "member-a", role: "member", status: "active" }, body?: BodyInit, headers: Record<string, string> = {}) =>
        handleAiMemberMemoryRequest(new Request(`https://tongpin.example${pathname}`, { method, headers, ...(body !== undefined ? { body } : {}) }), node.service, user);
      const admin = { id: "admin-1", role: "admin", status: "active" };
      expect((await call("/api/ai/memory", "GET", admin)).status).toBe(403);
      expect((await call("/api/admin/ai/memory")).status).toBe(403);
      expect((await call("/api/ai/memory", "GET", { id: "member-a", role: "member", status: "disabled" })).status).toBe(401);
      expect((await call("/api/ai/memory", "GET", undefined, undefined, { "X-Tongpin-Account": "member-b" })).status).toBe(409);
      const adminPut = await call("/api/admin/ai/memory", "PUT", admin, JSON.stringify({ enabled: true, reviewTier: "quick", pricePoints: 0 }));
      expect(adminPut.status).toBe(200);
      expect(await adminPut.json()).toMatchObject({ settings: { enabled: true, pricePoints: 0 }, stats: { membersWithMemory: 0 } });
      const state = await call("/api/ai/memory");
      expect(state.status).toBe(200);
      expect(await state.json()).toMatchObject({ revision: 0, available: true });
      const added = await call("/api/ai/memory/entries", "POST", undefined, JSON.stringify({ expectedRevision: 0, operation: { action: "add", target: "memory", content: "成员负责 LORA Chain 的生态合作" } }));
      expect(await added.json()).toMatchObject({ revision: 1, stores: { memory: { entries: ["成员负责 LORA Chain 的生态合作"] } } });
      expect((await call("/api/ai/memory/settings", "PUT", undefined, JSON.stringify({ learningEnabled: false }))).status).toBe(200);
      expect((await call("/api/ai/memory/reviews?requestIds=request-aaaaaaaaaaaa")).status).toBe(200);
      const wrongMethod = await call("/api/ai/memory", "PUT");
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get("allow")).toBe("GET, DELETE");
      expect((await call("/api/ai/memory/entries", "POST", undefined, new Uint8Array([0xff]))).status).toBe(400);
      expect((await call("/api/ai/memory/entries", "POST", undefined, JSON.stringify({ padding: "x".repeat(AI_MEMORY_LIMITS.requestBytes) }))).status).toBe(413);
      expect((await call("/api/ai/memory/nope")).status).toBe(404);
      const cleared = await call("/api/ai/memory", "DELETE");
      expect(await cleared.json()).toMatchObject({ stores: { memory: { entries: [] } } });
      // Another member of the same organization sees nothing of member-a.
      node.service.setQuota("member-b", "admin", { limitTokens: 10_000 });
      expect(await (await call("/api/ai/memory", "GET", { id: "member-b", role: "member", status: "active" })).json()).toMatchObject({ revision: 0 });
    } finally { node.close(); }
  });
});
