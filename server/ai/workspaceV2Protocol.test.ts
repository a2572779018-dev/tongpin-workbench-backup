import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiSql } from "./storage";
import { AiStore, emptyQuota } from "./storage";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";
import { handleAiWorkspaceV2Request } from "./workspaceV2Protocol";
import { createAiWorkspaceV2Router } from "./workspaceV2Routes";
import { ApiError, errorHandler } from "../errors";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const value = action(); database.exec("COMMIT"); return value; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}
const principal = { id: "member-a", role: "member", status: "active", tenantId: "default" };
const state = { view: "chat" as const, mode: "standard" as const, activeConversationId: "chat-a", activeProjectId: null,
  enabledSkillIds: [], projects: [], artifacts: [], drafts: { "chat-a": "草稿" },
  conversations: [{ id: "chat-a", title: "初始", timeLabel: "刚刚", messages: [{ id: "first", role: "user" as const, content: "旧消息", time: "10:00" }] }] };

describe("workspace V2 member protocol", () => {
  let directory: string, database: DatabaseSync, sql: AiSql, workspace: AiWorkspaceRepository, v2: AiWorkspaceV2Store;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-v2-protocol-"));
    database = new DatabaseSync(path.join(directory, "store.sqlite")); sql = adapter(database);
    workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    v2 = new AiWorkspaceV2Store(sql, workspace); v2.initialize();
    const ai = new AiStore(sql); ai.initialize(); ai.saveQuota("member-a", { ...emptyQuota(), limitTokens: 1000 });
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });
  const call = (route: string, method = "GET", body?: unknown, actor = principal) => handleAiWorkspaceV2Request(new Request(`http://localhost/api/ai/workspace-v2${route}`, {
    method, headers: { "X-Tongpin-Account": actor.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), v2, actor);
  const activate = async () => {
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state });
    await new AiWorkspaceV2ShadowRepository(sql, workspace).stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'", new Date().toISOString());
    sql.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'");
    return prepared.epoch;
  };

  it("probes V1 without reading its snapshot, then exposes only V2 metadata and bounded messages", async () => {
    expect(await (await call("/bootstrap")).json()).toEqual({ schemaVersion: 1 });
    const epoch = await activate();
    const response = await call("/bootstrap");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ schemaVersion: 2, epoch, conversations: [{ entityId: "chat-a", title: "初始" }] });
    expect(await (await call("/conversations/chat-a/messages?limit=1")).json()).toMatchObject({ messages: [{ id: "first", content: "旧消息" }], hasMore: false });
  });

  it("creates a conversation and saves a user message, while rejecting forged assistant and usage fields", async () => {
    const epoch = await activate();
    const created = await (await call("/mutate", "POST", { epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 0, action: "put", value: { id: "chat-b", title: "新对话", timeLabel: "刚刚", messages: [] } },
    ] })).json() as { entities: Array<{ revision: number }> };
    expect(created.entities[0].revision).toBe(1);
    const input = { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-b", expectedRevision: 1,
      message: { id: "user-b", role: "user", content: "你好", time: "10:01", requestId: crypto.randomUUID() } };
    expect((await call("/append-user", "POST", { ...input, message: { ...input.message, role: "assistant" } })).status).toBe(400);
    expect((await call("/append-user", "POST", { ...input, message: { ...input.message, usage: { totalTokens: 0 } } })).status).toBe(400);
    const saved = await (await call("/append-user", "POST", input)).json();
    expect(saved).toMatchObject({ entityId: "chat-b", revision: 2, messageIds: ["user-b"] });
    expect(await (await call("/append-user", "POST", input)).json()).toEqual(saved);
    expect(await (await call("/conversations/chat-b/messages")).json()).toMatchObject({ messages: [{ id: "user-b", content: "你好" }] });
  });

  it("commits only a completed server-owned answer for the matching conversation", async () => {
    const epoch = await activate();
    const requestId = crypto.randomUUID();
    const ai = new AiStore(sql);
    ai.saveRequest({ requestId, userId: "member-a", hash: "hash", status: "completed", kind: "chat", createdAt: "2026-09-24T10:00:00.000Z", expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, model: "server-model", mode: "standard", conversationId: "chat-a",
      result: { requestId, content: "服务端真实回复", model: "server-model", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false } } });
    const body = { epoch, mutationId: requestId, conversationId: "chat-a", expectedRevision: 1, requestId, messageId: "assistant-a" };
    expect((await call("/commit-assistant", "POST", { ...body, content: "伪造回答", usage: {} })).status).toBe(400);
    expect((await call("/commit-assistant", "POST", body)).status).toBe(409); // A completed provider call alone does not prove a saved user turn.
    expect((await call("/append-user", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 1,
      message: { id: "prompt-a", role: "user", content: "你好", time: "10:00", requestId } })).status).toBe(200);
    const linked = { ...body, expectedRevision: 2 };
    expect(await (await call("/commit-assistant", "POST", linked)).json()).toMatchObject({ revision: 3, messageIds: ["assistant-a"] });
    expect(await (await call("/commit-assistant", "POST", linked)).json()).toMatchObject({ revision: 3 });
    const page = await (await call("/conversations/chat-a/messages")).json() as { messages: Array<{ content: string; model?: string }> };
    expect(page.messages.at(-1)).toMatchObject({ content: "服务端真实回复", model: "server-model" });
    expect((await call("/commit-assistant", "POST", { ...body, mutationId: crypto.randomUUID(), expectedRevision: 3, messageId: "assistant-b" })).status).toBe(409);
  });

  it("commits recorded citation markers together with their sources", async () => {
    const epoch = await activate();
    const requestId = crypto.randomUUID();
    const sources = [{ title: "天气", url: "https://weather.example/sh" }, { title: "新闻", url: "https://news.example/sh" }];
    const citations = [{ n: 1, sourceIndex: 0, end: 4 }, { n: 2, sourceIndex: 1, end: 8 }];
    new AiStore(sql).saveRequest({ requestId, userId: "member-a", hash: "hash", status: "completed", kind: "chat", createdAt: "2026-09-24T10:00:00.000Z", expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, model: "server-model", mode: "standard", conversationId: "chat-a",
      result: { requestId, content: "今天晴。明天阴。", model: "server-model", sources, citations, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false } } });
    expect((await call("/append-user", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 1,
      message: { id: "prompt-a", role: "user", content: "天气", time: "10:00", requestId } })).status).toBe(200);
    expect((await call("/commit-assistant", "POST", { epoch, mutationId: requestId, conversationId: "chat-a", expectedRevision: 2, requestId, messageId: "assistant-a" })).status).toBe(200);
    const page = await (await call("/conversations/chat-a/messages")).json() as { messages: Array<{ sources?: unknown; citations?: unknown }> };
    expect(page.messages.at(-1)).toMatchObject({ sources, citations });
  });

  it("renames without browser message resubmission and persists draft and attachment references separately", async () => {
    const epoch = await activate();
    const renamed = await call("/rename-conversation", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 1, title: "新标题" });
    expect(renamed.status).toBe(200);
    expect(await (await call("/bootstrap")).json()).toMatchObject({ conversations: [{ title: "新标题", revision: 2 }] });
    expect(await (await call("/conversations/chat-a/messages")).json()).toMatchObject({ messages: [{ id: "first", content: "旧消息" }] });
    const draft = await call("/mutate", "POST", { epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "继续讨论" },
    ] });
    expect(draft.status).toBe(200);
    const attachment = { id: "doc-a", name: "材料.md", mimeType: "text/markdown", content: "需要保留的背景" };
    const manifest = await (await call("/bootstrap")).json() as { manifest: object; manifestRevision: number };
    if (!(manifest.manifest as { hasDraftAttachments?: boolean }).hasDraftAttachments) {
      expect((await call("/mutate", "POST", { epoch, mutationId: crypto.randomUUID(), ops: [
        { kind: "manifest", entityId: "root", expectedRevision: manifest.manifestRevision, action: "put", value: { ...manifest.manifest, hasDraftAttachments: true } },
      ] })).status).toBe(200);
    }
    expect((await call("/mutate", "POST", { epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 0, action: "put", value: [attachment] },
    ] })).status).toBe(200);
    expect(await (await call("/conversations/chat-a/context")).json()).toMatchObject({
      draft: { value: "继续讨论" }, draftAttachment: { value: [attachment] },
    });
  });

  it("keeps tenant, account, role and artifact reads scoped", async () => {
    await activate();
    expect((await call("/bootstrap", "GET", undefined, { ...principal, id: "wrong" })).status).toBe(403);
    expect((await call("/bootstrap", "GET", undefined, { ...principal, role: "admin" })).status).toBe(403);
    expect((await call("/artifacts/not-found?conversationId=chat-a")).status).toBe(404);
    const response = await handleAiWorkspaceV2Request(new Request("http://localhost/api/ai/workspace-v2/bootstrap", { headers: { "X-Tongpin-Account": "other" } }), v2, principal);
    expect(response.status).toBe(409);
  });

  it("mounts the real Node route before the legacy 768 KiB parser", async () => {
    const epoch = await activate();
    const app = express();
    const fixtureAuth: Parameters<typeof createAiWorkspaceV2Router>[1] = async (request, _response, next) => {
      if (!request.header("authorization")) { next(new ApiError(401, "AUTH_REQUIRED", "请登录")); return; }
      request.currentUser = principal as NonNullable<typeof request.currentUser>;
      next();
    };
    app.use("/api/ai/workspace-v2", createAiWorkspaceV2Router(v2, fixtureAuth));
    app.use(express.json({ limit: "768kb" }));
    app.use(errorHandler);
    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    try {
      const address = server.address(); if (!address || typeof address === "string") throw new Error("missing fixture port");
      const url = `http://127.0.0.1:${address.port}/api/ai/workspace-v2`;
      expect((await fetch(`${url}/bootstrap`)).status).toBe(401);
      const headers = { authorization: "member-a", "X-Tongpin-Account": "member-a", "Content-Type": "application/json" };
      const opened = await fetch(`${url}/bootstrap`, { headers });
      expect(opened.status).toBe(200);
      expect(await opened.json()).toMatchObject({ schemaVersion: 2, epoch });
      const oversizedForLegacy = await fetch(`${url}/mutate`, { method: "POST", headers, body: JSON.stringify({ padding: "x".repeat(900_000) }) });
      expect(oversizedForLegacy.status).toBe(400); // Reached V2 validator, not legacy parser's 413.
      expect(await oversizedForLegacy.json()).toMatchObject({ error: { code: "AI_WORKSPACE_INVALID" } });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
