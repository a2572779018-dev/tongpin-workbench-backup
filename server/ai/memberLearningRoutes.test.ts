import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { createRuntime } from "../app";
import type { AppConfig } from "../config";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";
import { MEMBER_MEMORY_REVIEW_INSTRUCTIONS } from "./memberMemoryPrompt";
import { memberMemoryRuntime } from "./memberMemoryService";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import type { AiService } from "./service";
import { AiWorkspaceRepository } from "./workspace";

const workerRouteModulePath = "../../cloudflare/src/ai/memberMemoryRoutes";
const { handleAiMemberMemoryRequest } = await import(workerRouteModulePath) as {
  handleAiMemberMemoryRequest(request: Request, service: AiService, user: { id: string; role: string; status: string }): Promise<Response>;
};

const provider = {
  name: "Fixture", baseUrl: "https://api.example.com/", apiKey: "fixture-provider-key-not-real", protocol: "chat_completions",
  quickModel: "quick-model", deepModel: "deep-model", maxOutputTokens: 1024, reasoningEffort: "", enabled: true,
};
const instructions: string[] = [];
const transport = vi.fn<AiTransport>(async (_url, init) => {
  const body = JSON.parse(init.body ?? "{}") as { messages?: Array<{ content: string }> };
  if (!body.messages) return Response.json({ data: [{ id: "quick-model" }] });
  const review = body.messages[0].content === MEMBER_MEMORY_REVIEW_INSTRUCTIONS;
  if (!review) instructions.push(body.messages[0].content);
  return Response.json({ choices: [{ message: { content: review ? JSON.stringify({ operations: [], skill: null }) : "好的，已经整理好了。" } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
});
const report: AiWorkspaceState = {
  view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, activeConversationId: null, activeProjectId: null, enabledSkillIds: [],
  conversations: [{ id: "conv-report", title: "季度汇报", timeLabel: "刚刚", messages: [
    { id: "m1", role: "user", content: "帮我做一个季度汇报模板，要有完成情况、问题和下季度计划", time: "10:00" },
    { id: "m2", role: "assistant", content: "季度汇报模板：一、本季度完成情况；二、遇到的问题；三、下季度计划。", time: "10:01", status: "ready" },
  ] }],
};
const skill = { name: "会议纪要", whenToUse: "整理会议记录时", instructions: "按结论、决策、待办、负责人、截止时间整理。", triggers: ["会议纪要", "纪要"] };

describe("history recall and personal skills over HTTP (Express and Worker parity)", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), "tongpin-learning-routes-")); transport.mockClear(); instructions.length = 0; });
  afterEach(async () => { await memberMemoryRuntime.idle(); await rm(directory, { recursive: true }); });

  it("Express: a saved workspace is recalled in chat; excerpts and skills stay with their owner", async () => {
    const password = "LearningFixture20260927!";
    const config: AppConfig = {
      host: "127.0.0.1", port: 0, dataFile: path.join(directory, "runtime.json"), jwtSecret: "learning-fixture-jwt-secret-not-for-production",
      clientOrigins: [], bootstrapAdminEmail: "learning-admin@tongpin.test", bootstrapAdminPassword: password, bootstrapAdminName: "隔离管理员",
      devEmailPreview: false, isProduction: false, loraExplorerApi: "https://explorer.invalid/api/v2", loraRpcUrl: "https://rpc.invalid",
      resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
    };
    const runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false, aiTransport: transport });
    let http: Server | undefined;
    try {
      http = await listenLoopback(runtime.app);
      await runtime.store.mutate(db => {
        const admin = db.users.find(user => user.role === "admin")!;
        db.users.push({ ...admin, id: "learning-member", role: "member", email: "learning-member@tongpin.test", name: "成员甲" });
        db.users.push({ ...admin, id: "learning-boss", role: "boss", email: "learning-boss@tongpin.test", name: "老板" });
      });
      const login = async (email: string) => (await request(http!).post("/api/auth/login").send({ email, password }).expect(200)).body.accessToken as string;
      const admin = { Authorization: `Bearer ${await login(config.bootstrapAdminEmail)}` };
      const member = { Authorization: `Bearer ${await login("learning-member@tongpin.test")}`, "X-Tongpin-Account": "learning-member" };
      const boss = { Authorization: `Bearer ${await login("learning-boss@tongpin.test")}`, "X-Tongpin-Account": "learning-boss" };
      await request(http!).put("/api/admin/ai/provider").set(admin).send(provider).expect(200);
      for (const id of ["learning-member", "learning-boss"]) await request(http!).put(`/api/admin/ai/members/${id}/quota`).set(admin).send({ limitTokens: 50_000 }).expect(200);
      const enabled = await request(http!).put("/api/admin/ai/memory").set(admin).send({ enabled: true, reviewTier: "quick", pricePoints: 0 }).expect(200);
      expect(enabled.body.settings).toMatchObject({ recallEnabled: true, skillsEnabled: true });

      // The real workspace route feeds the index.
      await request(http!).put("/api/ai/workspace").set(member).send({ expectedRevision: 0, mutationId: crypto.randomUUID(), state: report }).expect(200);
      const chat = await request(http!).post("/api/ai/chat").set(member).send({ requestId: crypto.randomUUID(), mode: "quick", conversationId: "conv-new", messages: [{ role: "user", content: "上次那个汇报模板再发我看看" }] }).expect(200);
      expect(instructions.at(-1)).toContain("季度汇报模板：一、本季度完成情况");
      await memberMemoryRuntime.idle();
      const reviews = await request(http!).get("/api/ai/memory/reviews").query({ requestIds: chat.body.requestId }).set(member).expect(200);
      expect(reviews.body.reviews[0].activity).toEqual({ recalled: 2, trigger: "reference", skills: [] });
      const detail = await request(http!).get(`/api/ai/memory/recalls/${chat.body.requestId}`).set(member).expect(200);
      expect(detail.headers["cache-control"]).toBe("no-store");
      expect(detail.body.recall).toMatchObject({ requestId: chat.body.requestId, count: 2, snippets: [{ conversationTitle: "季度汇报" }, { conversationTitle: "季度汇报" }] });
      expect((await request(http!).get(`/api/ai/memory/recalls/${chat.body.requestId}`).set(boss).expect(200)).body).toEqual({ recall: null });
      await request(http!).get("/api/ai/memory/recalls/bad%20id").set(member).expect(400);
      await request(http!).get(`/api/ai/memory/recalls/${chat.body.requestId}`).set(admin).expect(403);

      // Personal skills: create, list for the @ picker, validate, isolate.
      const created = await request(http!).post("/api/ai/memory/skills").set(member).send({ action: "create", skill }).expect(200);
      const [item] = created.body.skills.items;
      expect(item).toMatchObject({ status: "adopted", origin: "member", name: "会议纪要" });
      expect((await request(http!).get("/api/ai/memory/skills").set(member).expect(200)).body).toEqual({ enabled: true, skills: [{ id: item.id, name: "会议纪要", whenToUse: "整理会议记录时" }] });
      expect((await request(http!).get("/api/ai/memory/skills").set(boss).expect(200)).body).toEqual({ enabled: true, skills: [] });
      expect((await request(http!).post("/api/ai/memory/skills").set(member).send({ action: "create", skill: { ...skill, instructions: "验证码 482913 按这个格式写" } }).expect(400)).body.error.code).toBe("AI_MEMORY_SECRET");
      await request(http!).post("/api/ai/memory/skills").set(boss).send({ action: "delete", id: item.id, expectedRevision: 1 }).expect(404);
      await request(http!).post("/api/ai/memory/skills").set(member).send({ action: "delete", id: item.id, expectedRevision: 9 }).expect(409);
      // Members see recall and skills in their state; administrators only aggregates.
      const state = await request(http!).get("/api/ai/memory").set(member).expect(200);
      expect(state.body.recall).toMatchObject({ enabled: true, indexedConversations: 1, indexedMessages: 2, recent: [{ count: 2 }] });
      const adminView = await request(http!).get("/api/admin/ai/memory").set(admin).expect(200);
      expect(adminView.body.stats).toMatchObject({ recall: { indexedMembers: 1, indexedMessages: 2, recalls7d: 1 }, skills: { adopted: 1, proposed: 0 } });
      expect(JSON.stringify(adminView.body)).not.toMatch(/季度汇报|会议纪要/);
    } finally { await closeServer(http); await runtime.close(); }
  });

  it("Cloudflare: the same endpoints, bound to the authenticated account", async () => {
    const node = await createNodeAi(path.join(directory, "worker.json"), transport);
    try {
      const workspace = new AiWorkspaceRepository(node.store.sql);
      workspace.initialize();
      await node.service.saveProvider(provider as never);
      node.service.setQuota("member-a", "admin", { limitTokens: 10_000 });
      node.service.setQuota("member-b", "admin", { limitTokens: 10_000 });
      node.service.memberMemory.saveAdminSettings({ enabled: true, reviewTier: "quick", pricePoints: 0 });
      await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: report });
      const reply = await node.service.chat("member-a", { requestId: crypto.randomUUID(), mode: "quick", conversationId: "conv-new", messages: [{ role: "user", content: "上次那个汇报模板再发我看看" }] });
      const memberA = { id: "member-a", role: "member", status: "active" };
      const call = (pathname: string, method = "GET", user = memberA, body?: BodyInit) =>
        handleAiMemberMemoryRequest(new Request(`https://tongpin.example${pathname}`, { method, ...(body !== undefined ? { body } : {}) }), node.service, user);
      const detail = await call(`/api/ai/memory/recalls/${reply.requestId}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ recall: { count: 2, trigger: "reference" } });
      expect(await (await call(`/api/ai/memory/recalls/${reply.requestId}`, "GET", { id: "member-b", role: "member", status: "active" })).json()).toEqual({ recall: null });
      expect((await call("/api/ai/memory/recalls/%E0%A4%A")).status).toBe(400);
      const created = await call("/api/ai/memory/skills", "POST", memberA, JSON.stringify({ action: "create", skill }));
      expect(created.status).toBe(200);
      const [item] = ((await created.json()) as { skills: { items: Array<{ id: string }> } }).skills.items;
      expect(await (await call("/api/ai/memory/skills")).json()).toEqual({ enabled: true, skills: [{ id: item.id, name: "会议纪要", whenToUse: "整理会议记录时" }] });
      expect((await call("/api/ai/memory/skills", "POST", memberA, JSON.stringify({ action: "explode" }))).status).toBe(400);
      expect((await call("/api/ai/memory/skills", "GET", { id: "admin-1", role: "admin", status: "active" })).status).toBe(403);
      expect(await (await call("/api/ai/memory/skills", "GET", { id: "member-b", role: "member", status: "active" })).json()).toEqual({ enabled: true, skills: [] });
    } finally { node.close(); }
  });
});
