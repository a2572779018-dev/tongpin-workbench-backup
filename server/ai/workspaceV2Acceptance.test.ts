import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";
import { handleAiWorkspaceV2Request } from "./workspaceV2Protocol";
import { tenantStorageKey } from "./tenant";

const TENANT = "local-test";
const USER = "local-v2-test-acceptance";
const principal = { id: USER, role: "member", status: "active", tenantId: TENANT };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
const JPEG = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0, 0, 255, 217]).toString("base64")}`;

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try { const value = action(); database.exec("COMMIT"); return value; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

describe("#27 local V2 acceptance beyond the former account cap", () => {
  let directory: string, filename: string, database: DatabaseSync, sql: AiSql;
  let workspace: AiWorkspaceRepository, v2: AiWorkspaceV2Store, ai: AiStore, epoch: number, assetId: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-v2-acceptance-"));
    filename = path.join(directory, "workspace.sqlite");
    database = new DatabaseSync(filename); sql = adapter(database);
    workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    ai = new AiStore(sql, TENANT); ai.initialize(); ai.saveQuota(USER, { ...emptyQuota(), limitTokens: 1000 });
    assetId = ai.saveAsset(USER, "image/png", PNG, Buffer.from(PNG, "base64").length).assetId;
    v2 = new AiWorkspaceV2Store(sql, workspace, { allowLocalTestMigration: true }); v2.initialize();
    const state: AiWorkspaceState = {
      view: "chat", mode: "quick", activeConversationId: "chat-a", activeProjectId: null, enabledSkillIds: [], projects: [],
      conversations: [{ id: "chat-a", title: "起始会话", timeLabel: "刚刚", messages: [
        { id: "seed-image", role: "assistant", content: "已有图片", time: "10:00", artifactId: "image-artifact" },
        { id: "seed-video", role: "user", content: "已有视频参考", time: "10:01", attachments: [{
          id: "source-video", name: "reference.mp4", mimeType: "video/mp4", content: "已抽取静态画面", media: {
            kind: "video", durationSeconds: 6, frames: [{ dataUrl: JPEG, timeSeconds: 1 }, { dataUrl: JPEG, timeSeconds: 4.5 }], selectedFrameIndex: 1,
          },
        }] },
        { id: "seed-result", role: "assistant", content: "已有成果", time: "10:02", artifactId: "result-artifact" },
      ] }],
      artifacts: [
        { id: "image-artifact", conversationId: "chat-a", title: "已有图片", kind: "图片", summary: "图片", updatedLabel: "刚刚", sections: [], data: { images: [{ assetId, mimeType: "image/png" }] } },
        { id: "result-artifact", conversationId: "chat-a", title: "已有成果", kind: "note", summary: "结论", updatedLabel: "刚刚", sections: [{ heading: "结论", lines: ["保留"] }] },
      ],
      drafts: { "chat-a": "上次草稿" }, draftAttachments: { "chat-a": [{ id: "source-note", name: "资料.txt", mimeType: "text/plain", content: "上次附件" }] },
    };
    await workspace.save(USER, { expectedRevision: 0, mutationId: crypto.randomUUID(), state }, TENANT);
    await new AiWorkspaceV2ShadowRepository(sql, workspace).stageFromV1(USER, TENANT);
    const prepared = (await v2.prepareFromShadow(USER, TENANT))!;
    await v2.activatePreparedForLocalTest(USER, prepared, TENANT);
    epoch = prepared.epoch;
  });

  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });

  const route = (suffix: string, method = "GET", body?: unknown) => new Request(`http://localhost/api/ai/workspace-v2${suffix}`, {
    method, headers: { "X-Tongpin-Account": USER, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const call = (suffix: string, method = "GET", body?: unknown) => handleAiWorkspaceV2Request(route(suffix, method, body), v2, principal);
  const create = async (id: string) => {
    const response = await call("/mutate", "POST", { epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: id, expectedRevision: 0, action: "put", value: { id, title: id, timeLabel: "刚刚", messages: [] } },
    ] });
    expect(response.status).toBe(200);
    return (await response.json()) as { entities: Array<{ revision: number }> };
  };
  const bulkAppend = async (id: string, firstRevision: number, count: number, characters: number, sequenceBase = 0) => {
    let revision = firstRevision;
    for (let offset = 0; offset < count; offset += 8) {
      const messages = Array.from({ length: Math.min(8, count - offset) }, (_, index) => ({
        id: `${id}-bulk-${sequenceBase + offset + index}`, role: "user" as const, content: `${id}:${sequenceBase + offset + index}:` + "x".repeat(characters), time: "10:03",
      }));
      const ack = await v2.appendActiveMessages(USER, { epoch, mutationId: crypto.randomUUID(), conversationId: id, expectedRevision: revision, messages }, TENANT);
      revision = ack.revision;
    }
    return revision;
  };

  it("continues and creates chats beyond 8 MiB without V1 rewrites, then survives a DB reopen", async () => {
    const storedUser = tenantStorageKey(TENANT, USER);
    const before = database.prepare("SELECT revision,data FROM ai_workspaces WHERE tenant_id=? AND user_id=?").get(TENANT, storedUser);
    await create("chat-b");
    let aRevision = await bulkAppend("chat-a", 1, 48, 100_000);
    await bulkAppend("chat-b", 1, 48, 100_000);
    const bytes = database.prepare("SELECT SUM(byte_length) AS bytes FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND deleted=0").get(TENANT, storedUser) as { bytes: number };
    expect(bytes.bytes).toBeGreaterThan(8 * 1024 * 1024);
    expect(await (await call("/bootstrap")).json()).toMatchObject({ schemaVersion: 2, conversations: expect.arrayContaining([expect.objectContaining({ entityId: "chat-b", revision: 7, title: "chat-b", timeLabel: "刚刚" })]) });

    await create("chat-c");
    const promptId = crypto.randomUUID();
    const user = { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-c", expectedRevision: 1,
      message: { id: "chat-c-user", role: "user", content: "新对话仍可发送", time: "10:04", requestId: promptId } };
    const userAck = await call("/append-user", "POST", user);
    expect(userAck.status).toBe(200);
    expect(await (await call("/append-user", "POST", user)).json()).toEqual(await userAck.clone().json());
    ai.saveRequest({ requestId: promptId, userId: USER, hash: "fixture", status: "completed", kind: "chat", createdAt: "2026-09-24T10:04:00.000Z", expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, model: "local-fixture", mode: "quick", conversationId: "chat-c",
      result: { requestId: promptId, content: "本地服务器记录的回复", model: "local-fixture", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false } } });
    const committed = await call("/commit-assistant", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-c", expectedRevision: 2, requestId: promptId, messageId: "chat-c-assistant" });
    expect(committed.status).toBe(200);
    expect(await (await call("/conversations/chat-c/messages")).json()).toMatchObject({ messages: [
      { id: "chat-c-user", content: "新对话仍可发送" }, { id: "chat-c-assistant", content: "本地服务器记录的回复" },
    ] });
    const continued = await call("/append-user", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: aRevision,
      message: { id: "chat-a-continued", role: "user", content: "长对话继续", time: "10:05" } });
    expect(continued.status).toBe(200);
    aRevision = (await continued.json() as { revision: number }).revision;
    const latest = await (await call("/conversations/chat-a/messages?limit=2")).json() as { messages: Array<{ id: string }>; hasMore: boolean; nextBefore: string };
    expect(latest.messages.at(-1)?.id).toBe("chat-a-continued");
    expect(latest.hasMore).toBe(true);
    expect(await (await call(`/conversations/chat-a/messages?limit=2&before=${latest.nextBefore}`)).json()).toMatchObject({ hasMore: true });
    expect(await (await call("/conversations/chat-b/messages?limit=2")).json()).toMatchObject({ messages: [{ id: "chat-b-bulk-46" }, { id: "chat-b-bulk-47" }] });
    expect((database.prepare("SELECT revision,data FROM ai_workspaces WHERE tenant_id=? AND user_id=?").get(TENANT, storedUser))).toEqual(before);
    expect(() => workspace.read(USER, TENANT)).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" }));
    await expect(workspace.save(USER, { expectedRevision: 1, mutationId: crypto.randomUUID(), state: {
      view: "chat", mode: "quick", activeConversationId: null, activeProjectId: null, enabledSkillIds: [], projects: [], conversations: [], artifacts: [], drafts: {},
    } }, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" });
    await expect(v2.rollbackActiveForLocalTest(USER, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    expect(v2.workspaceVersion(USER, TENANT)).toBe(2);

    database.close(); database = new DatabaseSync(filename); sql = adapter(database);
    workspace = new AiWorkspaceRepository(sql); v2 = new AiWorkspaceV2Store(sql, workspace, { allowLocalTestMigration: true });
    ai = new AiStore(sql, TENANT);
    expect(await (await call("/bootstrap")).json()).toMatchObject({ schemaVersion: 2, conversations: expect.arrayContaining([expect.objectContaining({ entityId: "chat-c" })]) });
    expect(await (await call("/conversations/chat-c/messages")).json()).toMatchObject({ messages: [
      { id: "chat-c-user" }, { id: "chat-c-assistant" },
    ] });
    expect(await (await call("/conversations/chat-a/context")).json()).toMatchObject({ draft: { value: "上次草稿" }, draftAttachment: { value: [{ id: "source-note" }] } });
    expect(await (await call("/artifacts/image-artifact?conversationId=chat-a")).json()).toMatchObject({ artifact: { data: { images: [{ assetId }] } } });
    expect(await (await call("/artifacts/result-artifact?conversationId=chat-a")).json()).toMatchObject({ artifact: { summary: "结论" } });
    expect((await v2.readActiveImageSourceEntities(USER, "chat-a", assetId, TENANT))?.artifactId).toBe("image-artifact");
    expect(ai.assetMetadata(USER, assetId)).toMatchObject({ assetId });
    const firstPage = await (await call("/conversations/chat-a/messages?limit=3&before=chat-a-bulk-0")).json() as { messages: Array<{ id: string; attachments?: unknown[] }> };
    expect(firstPage.messages.find(item => item.id === "seed-video")?.attachments).toMatchObject([{ media: { kind: "video", selectedFrameIndex: 1 } }]);
    expect(await (await call("/artifacts/image-artifact?conversationId=chat-b")).status).toBe(404);
    const afterReopen = await call("/append-user", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: aRevision,
      message: { id: "chat-a-after-reopen", role: "user", content: "重开后继续", time: "10:06" } });
    expect(afterReopen.status).toBe(200);
  }, 120_000);

  it("serializes two windows by CAS and preserves both after the losing window refreshes", async () => {
    const payload = (id: string, revision: number) => ({ epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: revision,
      message: { id, role: "user", content: id, time: "10:07" } });
    const [one, two] = await Promise.all([call("/append-user", "POST", payload("window-one", 1)), call("/append-user", "POST", payload("window-two", 1))]);
    expect([one.status, two.status].sort()).toEqual([200, 409]);
    const winner = one.status === 200 ? "window-one" : "window-two";
    const loser = one.status === 409 ? "window-one" : "window-two";
    expect((await (await call("/conversations/chat-a/messages?limit=1")).json() as { messages: Array<{ id: string }> }).messages[0].id).toBe(winner);
    expect((await call("/append-user", "POST", payload(loser, 2))).status).toBe(200);
    expect(await (await call("/conversations/chat-a/messages?limit=2")).json()).toMatchObject({ messages: [{ id: winner }, { id: loser }] });
    expect((await call("/append-user", "POST", payload(winner, 3))).status).toBe(400);
  });

  it("rejects a single conversation over 16 MiB with no half-written owner or receipt", async () => {
    let revision = 1;
    for (let batch = 0; batch < 16; batch++) revision = await bulkAppend("chat-a", revision, 8, 127_000, batch * 8);
    revision = await bulkAppend("chat-a", revision, 4, 127_000, 128);
    const entity = await v2.readActiveEntity(USER, "conversation", "chat-a", TENANT);
    expect(entity?.revision).toBe(revision);
    const before = database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=?").get(TENANT, tenantStorageKey(TENANT, USER));
    const mutationId = crypto.randomUUID();
    const response = await call("/append-user", "POST", { epoch, mutationId, conversationId: "chat-a", expectedRevision: revision,
      message: { id: "over-limit", role: "user", content: "x".repeat(127_000), time: "10:08" } });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "AI_WORKSPACE_TOO_LARGE" } });
    expect((await v2.readActiveEntity(USER, "conversation", "chat-a", TENANT))?.revision).toBe(revision);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=?").get(TENANT, tenantStorageKey(TENANT, USER))).toEqual(before);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_message_appends WHERE tenant_id=? AND user_id=? AND mutation_id=?").get(TENANT, tenantStorageKey(TENANT, USER), mutationId)).toEqual({ count: 0 });
  }, 120_000);
});
