import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AI_WORKSPACE_LIMITS, type AiWorkspaceSaveRequest, type AiWorkspaceState } from "../../shared/aiWorkspace";
import { createAiWorkspaceRouter } from "./workspaceRoutes";
import { ApiError, errorHandler } from "../errors";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { AiWorkspaceRepository, validateAiWorkspaceState } from "./workspace";
import { createRuntime } from "../app";
import type { AppConfig } from "../config";

// Keep Worker global types out of the browser/Node tsconfig. The Worker source is
// separately typechecked by cloudflare/tsconfig.json and executed here unchanged.
const workerRouteModulePath = "../../cloudflare/src/ai/workspaceRoutes";
const { handleAiWorkspaceRequest } = await import(workerRouteModulePath) as {
  handleAiWorkspaceRequest(request: Request, repository: AiWorkspaceRepository, user: { id: string; role: string; status: string }): Promise<Response>;
};

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}
function fixture(): AiWorkspaceState {
  return {
    view: "chat", mode: "deep", sidebarCollapsed: false,
    projects: [{ id: "project-a", title: "客户提案", timeLabel: "刚刚", instructions: "用中文，先给结论", contextDocuments: [{ id: "doc-a", name: "资料.txt", mimeType: "text/plain", content: "客户关注交付时间" }] }],
    conversations: [{ id: "chat-a", projectId: "project-a", title: "提案讨论", timeLabel: "刚刚", messages: [{ id: "message-a", role: "user", content: "你好，世界😀", time: "10:20" }, { id: "message-b", role: "assistant", content: "提案已整理", time: "10:21", status: "ready", artifactId: "artifact-a", requestId: crypto.randomUUID(), model: "test-model", usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, estimated: false } }] }],
    artifacts: [{ id: "artifact-a", conversationId: "chat-a", projectId: "project-a", title: "提案", kind: "presentation", updatedLabel: "刚刚", summary: "交付方案", sections: [{ heading: "计划", lines: ["需求确认", "交付验收"] }], data: { presentation: { title: "提案", slides: [{ title: "计划", bullets: ["需求确认"] }] } } }],
    drafts: { "chat-a": "还有一个问题", "new-conversation": "待发新对话", "new-project-conversation:project-a": "新的项目讨论" },
    draftAttachments: { "new-conversation": [{ id: "draft-doc", name: "草稿.md", mimeType: "text/markdown", content: "说明" }] },
    composerTool: "presentation", webSearch: false,
    activeConversationId: "chat-a", activeProjectId: "project-a", enabledSkillIds: ["writing", "slides"],
  };
}
function saveRequest(state = fixture(), expectedRevision = 0): AiWorkspaceSaveRequest { return { expectedRevision, mutationId: crypto.randomUUID(), state }; }

describe("AI durable member workspace", () => {
  let directory: string;
  let database: DatabaseSync;
  let repository: AiWorkspaceRepository;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-workspace-test-"));
    database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    repository = new AiWorkspaceRepository(adapter(database)); repository.initialize();
    const store = new AiStore(repository.sql); store.initialize();
    for (const id of ["member-a", "member-b"]) store.saveQuota(id, { ...emptyQuota(), limitTokens: 10000 });
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });

  it("rejects ungranted members before creating workspace data and preserves pre-existing snapshots", async () => {
    const ungranted = "never-granted";
    expect(() => repository.read(ungranted)).toThrow(expect.objectContaining({ status: 403, code: "AI_ACCESS_NOT_GRANTED" }));
    await expect(repository.save(ungranted, saveRequest())).rejects.toMatchObject({ status: 403, code: "AI_ACCESS_NOT_GRANTED" });
    expect(database.prepare("SELECT user_id FROM ai_workspaces WHERE user_id=?").get(ungranted)).toBeUndefined();
    const saved = await repository.save("member-a", saveRequest());
    database.prepare("UPDATE ai_quotas SET data=? WHERE user_id=?").run(JSON.stringify(emptyQuota()), "member-a");
    await expect(repository.save("member-a", saveRequest(fixture(), 1))).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
    expect(database.prepare("SELECT revision FROM ai_workspaces WHERE user_id=?").get("member-a")).toEqual({ revision: saved.revision });
    new AiStore(repository.sql).saveQuota("member-a", { ...emptyQuota(), limitTokens: 10000 });
    expect(repository.read("member-a")).toEqual(saved);
  });

  it("starts empty and preserves every project, conversation, draft and artifact across process restart", async () => {
    expect(repository.read("member-a")).toEqual({ revision: 0, schemaVersion: 1, updatedAt: null, state: null });
    const request = saveRequest();
    const first = await repository.save("member-a", request);
    database.close(); database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    repository = new AiWorkspaceRepository(adapter(database)); repository.initialize();
    expect(repository.read("member-a")).toEqual(first);
    expect(first.state).toEqual(request.state);
    expect(first.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });
  it("isolates reads, writes and identical mutation ids by authenticated user", async () => {
    const request = saveRequest();
    await repository.save("member-a", request);
    expect(repository.read("member-b").state).toBeNull();
    const other = fixture(); other.projects[0].title = "另一个人的项目";
    await repository.save("member-b", { ...request, state: other });
    expect(repository.read("member-a").state!.projects[0].title).toBe("客户提案");
    expect(repository.read("member-b").state!.projects[0].title).toBe("另一个人的项目");
    await expect(repository.save("member-a", { ...saveRequest(), userId: "member-b" })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    expect(() => repository.read("member-a' OR 1=1--")).toThrow();
  });
  it("wins exactly one concurrent compare-and-swap write", async () => {
    const states = [fixture(), fixture()]; states[1].projects[0].title = "来自另一窗口";
    const results = await Promise.allSettled(states.map(state => repository.save("member-a", saveRequest(state))));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409, code: "AI_WORKSPACE_CONFLICT" } });
    expect(repository.read("member-a").revision).toBe(1);
  });
  it("replays a lost acknowledgement without writing or rolling back later edits", async () => {
    const request = saveRequest();
    const saved = await repository.save("member-a", request);
    expect(await repository.save("member-a", request)).toEqual(saved);
    const newer = fixture(); newer.projects[0].title = "较新的标题";
    const latest = await repository.save("member-a", saveRequest(newer, 1));
    expect(await repository.save("member-a", request)).toEqual(latest);
    expect(repository.read("member-a").revision).toBe(2);
    await expect(repository.save("member-a", { ...request, state: newer })).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
  });
  it("treats reordered JSON object keys as the same mutation", async () => {
    const request = saveRequest();
    const saved = await repository.save("member-a", request);
    const reordered = Object.fromEntries(Object.entries(request.state).reverse()) as unknown as AiWorkspaceState;
    expect(await repository.save("member-a", { state: reordered, mutationId: request.mutationId, expectedRevision: 0 })).toEqual(saved);
  });
  it("validates then snapshots caller data before awaiting the hash", async () => {
    const request = saveRequest();
    const promise = repository.save("member-a", request);
    request.state.projects[0].title = "异步期间篡改";
    const saved = await promise;
    expect(saved.state!.projects[0].title).toBe("客户提案");
  });
  it("does not silently erase history on stale or malformed saves", async () => {
    await repository.save("member-a", saveRequest());
    await expect(repository.save("member-a", saveRequest())).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    const bad = fixture(); bad.conversations[0].projectId = "other-project";
    await expect(repository.save("member-a", saveRequest(bad, 1))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    expect(repository.read("member-a").revision).toBe(1);
    expect(repository.read("member-a").state!.conversations).toHaveLength(1);
  });
  it("permits deleting a project while moving its conversations, artifacts and drafts consistently", async () => {
    await repository.save("member-a", saveRequest());
    const next = fixture(); next.projects = []; next.activeProjectId = null;
    delete next.conversations[0].projectId; delete next.artifacts[0].projectId;
    delete next.drafts["new-project-conversation:project-a"];
    const result = await repository.save("member-a", saveRequest(next, 1));
    expect(result.state!.projects).toEqual([]);
    expect(result.state!.conversations[0].messages).toHaveLength(2);
  });
  it("permits deleting a conversation only with its associated artifacts and drafts removed", async () => {
    const next = fixture(); next.conversations = []; next.activeConversationId = null;
    await expect(repository.save("member-a", saveRequest(next))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    next.artifacts = []; delete next.drafts["chat-a"];
    expect((await repository.save("member-a", saveRequest(next))).state!.conversations).toEqual([]);
  });
  it.each([
    ["duplicate project", (state: AiWorkspaceState) => state.projects.push({ ...state.projects[0] })],
    ["duplicate message", (state: AiWorkspaceState) => state.conversations[0].messages.push({ ...state.conversations[0].messages[0] })],
    ["dangling artifact", (state: AiWorkspaceState) => { state.conversations[0].messages[1].artifactId = "missing"; }],
    ["dangling active conversation", (state: AiWorkspaceState) => { state.activeConversationId = "missing"; }],
    ["dangling draft", (state: AiWorkspaceState) => { state.drafts["missing"] = "secret"; }],
    ["dangling attachment", (state: AiWorkspaceState) => { state.draftAttachments!["missing"] = []; }],
    ["invalid mode", (state: AiWorkspaceState) => { (state as unknown as Record<string, unknown>).mode = "unlimited"; }],
    ["unsafe source URL", (state: AiWorkspaceState) => { state.conversations[0].messages[0].sources = [{ title: "bad", url: "javascript:alert(1)" }]; }],
    ["unknown field", (state: AiWorkspaceState) => { (state as unknown as Record<string, unknown>).admin = true; }],
  ])("rejects %s without creating a snapshot", async (_name, change) => {
    const state = fixture(); change(state);
    await expect(repository.save("member-a", saveRequest(state))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    expect(repository.read("member-a").revision).toBe(0);
  });
  it("rejects prototype keys and executable/non-JSON values in structured data", async () => {
    const state = fixture(); state.artifacts[0].data = JSON.parse('{"__proto__":{"admin":true}}');
    await expect(repository.save("member-a", saveRequest(state))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    const nonJson = fixture(); nonJson.artifacts[0].data = { bad: Number.POSITIVE_INFINITY };
    expect(() => validateAiWorkspaceState(nonJson)).toThrow();
  });
  it("persists text as inert data rather than executing it", async () => {
    const state = fixture(); const content = "<script>throw new Error('not executable')</script>";
    state.conversations[0].messages[0].content = content;
    expect((await repository.save("member-a", saveRequest(state))).state!.conversations[0].messages[0].content).toBe(content);
  });
  it("counts UTF-8 bytes and accepts the exact 2 MiB boundary using safe SQL chunks", async () => {
    const state = fixture(); state.artifacts[0].data = { padding: "" };
    const overhead = new TextEncoder().encode(JSON.stringify(state)).byteLength;
    state.artifacts[0].data.padding = "a".repeat(AI_WORKSPACE_LIMITS.stateBytes - overhead);
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBe(AI_WORKSPACE_LIMITS.stateBytes);
    const saved = await repository.save("member-a", saveRequest(state));
    expect(repository.read("member-a")).toEqual(saved);
    const rows = database.prepare("SELECT length(CAST(data AS BLOB)) AS size FROM ai_workspace_chunks").all() as { size: number }[];
    expect(rows.length).toBeGreaterThan(1); expect(Math.max(...rows.map(row => row.size))).toBeLessThan(256000);
    state.artifacts[0].data.padding += "中";
    await expect(repository.save("member-a", saveRequest(state, 1))).rejects.toMatchObject({ status: 413, code: "AI_WORKSPACE_TOO_LARGE" });
    expect(repository.read("member-a").revision).toBe(1);
  });
  it("does not split Unicode surrogate pairs between SQLite chunks", async () => {
    const state = fixture(); state.artifacts[0].data = { padding: "😀".repeat(70000) };
    const saved = await repository.save("member-a", saveRequest(state));
    expect(repository.read("member-a")).toEqual(saved);
    expect(JSON.stringify(repository.read("member-a"))).not.toContain("�");
  });
  it("rolls back every snapshot chunk when a transaction fails", async () => {
    await repository.save("member-a", saveRequest());
    const before = repository.read("member-a");
    const base = adapter(database);
    const broken: AiSql = { ...base, exec(query, ...bindings) { if (query.startsWith("INSERT INTO ai_workspace_mutations")) throw new Error("fixture disk write failed"); base.exec(query, ...bindings); } };
    const next = fixture(); next.projects[0].title = "不能部分保存";
    await expect(new AiWorkspaceRepository(broken).save("member-a", saveRequest(next, 1))).rejects.toThrow("fixture disk write failed");
    expect(repository.read("member-a")).toEqual(before);
  });
  it("keeps schema initialization additive and detects unsupported schema versions", async () => {
    database.exec("CREATE TABLE original_users(id TEXT); INSERT INTO original_users VALUES('keep-me');");
    repository.initialize(); repository.initialize();
    expect(database.prepare("SELECT * FROM original_users").get()).toMatchObject({ id: "keep-me" });
    await repository.save("member-a", saveRequest());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE user_id=?").run("member-a");
    expect(() => repository.read("member-a")).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" }));
  });
  it("accepts token conversion metadata without letting it modify the quota ledger", async () => {
    const beforeQuota = new AiStore(repository.sql).quota("member-a");
    const state = fixture(); state.conversations[0].messages[1].usage = { inputTokens: 10, outputTokens: 20, totalTokens: 130, convertedTokens: 100, estimated: true, billingKind: "tokens_with_search" };
    expect((await repository.save("member-a", saveRequest(state))).state!.conversations[0].messages[1].usage!.totalTokens).toBe(130);
    expect(new AiStore(repository.sql).quota("member-a")).toEqual(beforeQuota);
  });
  it("bounds entity counts and message length before storage", async () => {
    const state = fixture(); state.conversations[0].messages[0].content = "a".repeat(AI_WORKSPACE_LIMITS.messageCharacters + 1);
    await expect(repository.save("member-a", saveRequest(state))).rejects.toMatchObject({ status: 413 });
    const many = fixture(); many.projects = Array.from({ length: AI_WORKSPACE_LIMITS.projects + 1 }, (_, i) => ({ id: `project-${i}`, title: "项目", timeLabel: "刚刚" }));
    await expect(repository.save("member-a", saveRequest(many))).rejects.toMatchObject({ status: 413 });
  });

  const actor = (id = "member-a", role: "member" | "admin" | "boss" = "member") => ({ id, role, status: "active" as const });
  const invoke = (repository: AiWorkspaceRepository, method: string, body?: unknown, member = actor(), suffix = "") => handleAiWorkspaceRequest(new Request(`https://tongpin.example/api/ai/workspace${suffix}`, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) }), repository, member);
  it("Cloudflare route denies admin, ungranted boss and inactive actors, and ignores account queries", async () => {
    expect((await invoke(repository, "GET", undefined, actor("admin", "admin"))).status).toBe(403);
    expect((await invoke(repository, "GET", undefined, actor("boss", "boss"))).status).toBe(403);
    const inactive = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace"), repository, { ...actor(), status: "disabled" });
    expect(inactive.status).toBe(401);
    expect((await invoke(repository, "PUT", saveRequest())).status).toBe(200);
    const other = await invoke(repository, "GET", undefined, actor("member-b"), "?userId=member-a");
    expect(await other.json()).toMatchObject({ revision: 0, state: null });
    expect(other.headers.get("cache-control")).toBe("no-store");
  });
  it("granted bosses own an isolated workspace without reading a member snapshot", async () => {
    const store = new AiStore(repository.sql);
    store.saveQuota("boss", { ...emptyQuota(), limitTokens: 10000 });
    await repository.save("member-a", saveRequest());
    const empty = await invoke(repository, "GET", undefined, actor("boss", "boss"), "?userId=member-a");
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ revision: 0, state: null });
    expect((await invoke(repository, "PUT", saveRequest(), actor("boss", "boss"))).status).toBe(200);
    expect(repository.read("boss").revision).toBe(1);
    expect(repository.read("member-a").revision).toBe(1);
    const mismatch = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace", { headers: { "X-Tongpin-Account": "member-a" } }), repository, actor("boss", "boss"));
    expect(mismatch.status).toBe(409);
  });
  it("Cloudflare route returns CAS conflicts without echoing confidential snapshots", async () => {
    await invoke(repository, "PUT", saveRequest());
    const conflict = await invoke(repository, "PUT", saveRequest());
    expect(conflict.status).toBe(409);
    expect(await conflict.text()).not.toContain("客户提案");
    const method = await invoke(repository, "DELETE");
    expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET, PUT");
  });
  it("Cloudflare route rejects an account switch header before saving", async () => {
    const send = (expectedAccount: string) => handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace", { method: "PUT", headers: { "Content-Type": "application/json", "X-Tongpin-Account": expectedAccount }, body: JSON.stringify(saveRequest()) }), repository, actor());
    const mismatch = await send("member-b");
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ error: { code: "AI_WORKSPACE_ACCOUNT_CHANGED" } });
    expect(repository.read("member-a").revision).toBe(0);
    expect((await send("member-a")).status).toBe(200);
  });
  it("Cloudflare GET rejects stale or empty account headers without exposing the new member snapshot", async () => {
    await repository.save("member-a", saveRequest());
    for (const expectedAccount of ["member-b", ""]) {
      const response = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace", { headers: { "X-Tongpin-Account": expectedAccount } }), repository, actor());
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: "AI_WORKSPACE_ACCOUNT_CHANGED", message: "当前登录账号已改变，请重新打开工作台" } });
    }
    const response = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace", { headers: { "X-Tongpin-Account": "member-a" } }), repository, actor());
    expect(response.status).toBe(200);
  });
  it("Cloudflare route bounds streamed bodies without trusting content-length and rejects invalid UTF-8", async () => {
    const oversized = await invoke(repository, "PUT", { padding: "x".repeat(AI_WORKSPACE_LIMITS.requestBytes) });
    expect(oversized.status).toBe(413);
    const malformed = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace", { method: "PUT", body: new Uint8Array([0xff]) }), repository, actor());
    expect(malformed.status).toBe(400);
  });
  it("Node route requires authentication, role isolation, no-store, and preserves explicit body errors", async () => {
    const app = express();
    const fixtureAuth: Parameters<typeof createAiWorkspaceRouter>[1] = async (request, _response, next) => {
      const token = request.header("authorization");
      if (!token) { next(new ApiError(401, "AUTH_REQUIRED", "请登录")); return; }
      request.currentUser = { id: token === "admin" ? "admin" : token, role: token === "admin" ? "admin" : "member" } as NonNullable<typeof request.currentUser>;
      next();
    };
    app.use("/api/ai/workspace", createAiWorkspaceRouter(repository, fixtureAuth)); app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture address");
      const url = `http://127.0.0.1:${address.port}/api/ai/workspace`;
      expect((await fetch(url)).status).toBe(401);
      expect((await fetch(url, { headers: { Authorization: "admin" } })).status).toBe(403);
      const headers = { Authorization: "member-a", "Content-Type": "application/json" };
      const mismatch = await fetch(url, { method: "PUT", headers: { ...headers, "X-Tongpin-Account": "member-b" }, body: JSON.stringify(saveRequest()) });
      expect(mismatch.status).toBe(409);
      expect(await mismatch.json()).toMatchObject({ error: { code: "AI_WORKSPACE_ACCOUNT_CHANGED" } });
      expect(repository.read("member-a").revision).toBe(0);
      const saved = await fetch(url, { method: "PUT", headers: { ...headers, "X-Tongpin-Account": "member-a" }, body: JSON.stringify(saveRequest()) });
      expect(saved.status).toBe(200); expect(saved.headers.get("cache-control")).toBe("no-store");
      for (const expectedAccount of ["member-b", ""]) {
        const response = await fetch(url, { headers: { ...headers, "X-Tongpin-Account": expectedAccount } });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "AI_WORKSPACE_ACCOUNT_CHANGED" } });
      }
      expect((await fetch(url, { headers: { ...headers, "X-Tongpin-Account": "member-a" } })).status).toBe(200);
      expect(await (await fetch(`${url}?userId=member-a`, { headers: { Authorization: "member-b" } })).json()).toMatchObject({ state: null });
      expect((await fetch(url, { method: "PUT", headers, body: "{" })).status).toBe(400);
      expect((await fetch(url, { method: "PUT", headers, body: JSON.stringify({ padding: "x".repeat(AI_WORKSPACE_LIMITS.requestBytes) }) })).status).toBe(413);
      expect((await fetch(url, { method: "DELETE", headers })).status).toBe(405);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("wires the actual Node runtime ahead of the smaller body parser and survives an authenticated restart", async () => {
    const password = "WorkspaceFixture20260905!";
    const config: AppConfig = {
      host: "127.0.0.1", port: 0, dataFile: path.join(directory, "runtime.json"),
      jwtSecret: "workspace-fixture-jwt-secret-not-for-production",
      clientOrigins: [], bootstrapAdminEmail: "workspace-admin@tongpin.test", bootstrapAdminPassword: password,
      bootstrapAdminName: "工作台隔离测试管理员", devEmailPreview: false, isProduction: false,
      loraExplorerApi: "https://explorer.invalid/api/v2", loraRpcUrl: "https://rpc.invalid",
      resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
    };
    let runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false, aiTransport: async () => { throw new Error("Workspace tests must not contact AI providers"); } });
    try {
      await runtime.store.mutate(db => {
        const admin = db.users.find(user => user.role === "admin")!;
        db.users.push({ ...admin, id: "runtime-member", role: "member", email: "workspace-member@tongpin.test", name: "工作台验收成员" });
      });
      const session = await request(runtime.app).post("/api/auth/login").send({ email: "workspace-member@tongpin.test", password }).expect(200);
      const headers = { Authorization: `Bearer ${session.body.accessToken}`, "X-Tongpin-Account": session.body.user.id };
      const denied = await request(runtime.app).put("/api/ai/workspace").set(headers).send(saveRequest()).expect(403);
      expect(denied.body.error.code).toBe("AI_ACCESS_NOT_GRANTED");
      const adminGrant = await request(runtime.app).post("/api/auth/login").send({ email: config.bootstrapAdminEmail, password }).expect(200);
      await request(runtime.app).put("/api/admin/ai/members/runtime-member/quota").set("Authorization", `Bearer ${adminGrant.body.accessToken}`).send({ limitTokens: 5000 }).expect(200);
      const state = fixture(); state.artifacts[0].data = { padding: "x".repeat(900000) };
      const saved = await request(runtime.app).put("/api/ai/workspace").set(headers).send(saveRequest(state)).expect(200);
      expect(saved.body.revision).toBe(1);
      await runtime.close();
      runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false });
      const restored = await request(runtime.app).get("/api/ai/workspace").set(headers).expect(200);
      expect(restored.body).toEqual(saved.body);
      await request(runtime.app).get("/api/ai/workspace").expect(401);
      const admin = await request(runtime.app).post("/api/auth/login").send({ email: config.bootstrapAdminEmail, password }).expect(200);
      await request(runtime.app).get("/api/ai/workspace").set("Authorization", `Bearer ${admin.body.accessToken}`).expect(403);
    } finally { await runtime.close(); }
  });
});
