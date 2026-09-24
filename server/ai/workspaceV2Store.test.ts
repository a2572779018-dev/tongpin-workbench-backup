import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";
import { readCurrentConversation } from "./workspaceCurrentReads";
import { tenantStorageKey } from "./tenant";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const value = action(); database.exec("COMMIT"); return value; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}
function state(label: string): AiWorkspaceState {
  return {
    view: "chat", mode: "standard", activeConversationId: "chat-a", activeProjectId: "project-a", enabledSkillIds: [],
    projects: [{ id: "project-a", title: `项目${label}`, timeLabel: "刚刚" }],
    conversations: [{ id: "chat-a", projectId: "project-a", title: `对话${label}`, timeLabel: "刚刚", messages: [{ id: "message-a", role: "user", content: `你好${label}`, time: "10:00" }] }],
    artifacts: [{ id: "artifact-a", projectId: "project-a", conversationId: "chat-a", title: "成果", kind: "note", summary: label, updatedLabel: "刚刚", sections: [] }],
    drafts: { "chat-a": `草稿${label}` },
    draftAttachments: { "chat-a": [{ id: "draft-a", name: "说明.txt", mimeType: "text/plain", content: label }] },
    videoDraftSettings: { "chat-a": { model: "sd-2.5-c1", seconds: 30, resolution: "720p", aspectRatio: "16:9" } },
  };
}

describe("workspace V2 prepared per-entity storage (inactive)", () => {
  let directory: string, database: DatabaseSync, sql: AiSql, workspace: AiWorkspaceRepository;
  let shadow: AiWorkspaceV2ShadowRepository, v2: AiWorkspaceV2Store;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-workspace-v2-store-"));
    database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    sql = adapter(database);
    workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    shadow = new AiWorkspaceV2ShadowRepository(sql, workspace);
    v2 = new AiWorkspaceV2Store(sql, workspace); v2.initialize();
    for (const tenant of ["default", "tenant-b"]) {
      const access = new AiStore(sql, tenant); access.initialize();
      access.saveQuota("member-a", { ...emptyQuota(), limitTokens: 10_000 });
    }
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });
  const active = async (label = "甲", tenant = "default") => {
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state(label) }, tenant);
    await shadow.stageFromV1("member-a", tenant);
    const prepared = await v2.prepareFromShadow("member-a", tenant);
    expect(prepared).not.toBeNull();
    const stored = tenantStorageKey(tenant, "member-a");
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=?").run(new Date().toISOString(), tenant, stored);
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=?").run(tenant, stored);
    return prepared!;
  };
  const activeImage = async (assetId: string, label = "甲", tenant = "default") => {
    const value = state(label);
    value.artifacts[0] = { ...value.artifacts[0], kind: "图片", data: { images: [{ assetId }] } };
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: value }, tenant);
    await shadow.stageFromV1("member-a", tenant);
    const prepared = (await v2.prepareFromShadow("member-a", tenant))!;
    const stored = tenantStorageKey(tenant, "member-a");
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=?").run(new Date().toISOString(), tenant, stored);
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=?").run(tenant, stored);
    return { prepared, artifact: value.artifacts[0] };
  };

  it("prepares independent entities without activating V2 or changing the V1 record", async () => {
    const original = state("甲");
    const saved = await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_meta").get()).toEqual({ count: 0 });
    expect(await v2.prepareFromShadow("member-a")).toBeNull();
    await shadow.stageFromV1("member-a");
    const prepared = await v2.prepareFromShadow("member-a");
    expect(prepared).toMatchObject({ sourceRevision: 1, epoch: 1, entityCount: 7 });
    expect(await v2.readPreparedEntity("member-a", "conversation", "chat-a")).toMatchObject({ revision: 1, value: original.conversations[0] });
    expect(await v2.readPreparedEntity("member-a", "draft", "chat-a")).toMatchObject({ value: "草稿甲" });
    expect(await v2.readPreparedEntity("member-a", "manifest", "root")).toMatchObject({ value: { hasDraftAttachments: true, hasVideoDraftSettings: true } });
    expect(await v2.readPreparedEntity("member-a", "conversation", "missing")).toBeNull();
    expect(database.prepare("SELECT activated_at FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ activated_at: null });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT schema_version FROM ai_workspaces WHERE user_id='member-a'").get()).toEqual({ schema_version: 1 });
    expect(workspace.read("member-a")).toEqual(saved);
  });

  it("prepares a tenant-scoped message owner index without activating V2", async () => {
    const original = state("甲");
    original.conversations.push({ id: "chat-b", projectId: "project-a", title: "第二段", timeLabel: "刚刚", messages: [
      { id: "message-b", role: "user", content: "第二段消息", time: "10:01" },
    ] });
    const first = await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    const other = state("乙");
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: other }, "tenant-b");
    await shadow.stageFromV1("member-a"); await shadow.stageFromV1("member-a", "tenant-b");
    await v2.prepareFromShadow("member-a"); await v2.prepareFromShadow("member-a", "tenant-b");
    expect(database.prepare("SELECT tenant_id,user_id,message_id,conversation_id FROM ai_workspace_v2_message_owners ORDER BY tenant_id,message_id").all()).toEqual([
      { tenant_id: "default", user_id: "member-a", message_id: "message-a", conversation_id: "chat-a" },
      { tenant_id: "default", user_id: "member-a", message_id: "message-b", conversation_id: "chat-b" },
      { tenant_id: "tenant-b", user_id: tenantStorageKey("tenant-b", "member-a"), message_id: "message-a", conversation_id: "chat-a" },
    ]);
    expect(database.prepare("SELECT message_index_version,activated_at FROM ai_workspace_v2_meta WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual({ message_index_version: 1, activated_at: null });
    expect(database.prepare("SELECT schema_version FROM ai_workspaces WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual({ schema_version: 1 });
    expect(workspace.read("member-a")).toEqual(first);
  });

  it("replaces the message owner index atomically when V1 is freshly prepared", async () => {
    const first = state("甲");
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: first });
    await shadow.stageFromV1("member-a"); await v2.prepareFromShadow("member-a");
    const next = state("乙");
    next.conversations[0].messages = [{ id: "message-new", role: "user", content: "新消息", time: "11:00" }];
    await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: next });
    await shadow.stageFromV1("member-a");
    expect((await v2.prepareFromShadow("member-a"))?.epoch).toBe(2);
    expect(database.prepare("SELECT message_id,conversation_id FROM ai_workspace_v2_message_owners WHERE tenant_id='default' AND user_id='member-a'").all()).toEqual([
      { message_id: "message-new", conversation_id: "chat-a" },
    ]);
    expect(workspace.read("member-a").state).toEqual(next);
  });

  it("reads only a scoped V2 conversation larger than the old account limit", async () => {
    await active();
    const large = state("甲").conversations[0];
    large.messages = Array.from({ length: 72 }, (_, index) => ({
      id: `message-${index}`, role: "user", content: "中".repeat(42_000), time: "10:00",
    }));
    const bytes = Buffer.from(JSON.stringify(large), "utf8");
    expect(bytes.byteLength).toBeGreaterThan(8 * 1024 * 1024);
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
    const chunks: string[] = [];
    for (let start = 0; start < bytes.length; start += 48 * 1024) chunks.push(bytes.subarray(start, start + 48 * 1024).toString("base64"));
    const storedUser = tenantStorageKey("default", "member-a");
    sql.transaction(() => {
      sql.exec("DELETE FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind='conversation' AND entity_id='chat-a'", "default", storedUser);
      sql.exec("UPDATE ai_workspace_v2_entities SET revision=2,byte_length=?,sha256=?,chunk_count=? WHERE tenant_id=? AND user_id=? AND kind='conversation' AND entity_id='chat-a'", bytes.byteLength, digest, chunks.length, "default", storedUser);
      for (const [index, data] of chunks.entries()) sql.exec("INSERT INTO ai_workspace_v2_entity_chunks(tenant_id,user_id,kind,entity_id,chunk_index,data) VALUES(?,?,?,?,?,?)", "default", storedUser, "conversation", "chat-a", index, data);
    });
    expect(() => workspace.read("member-a")).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" }));
    const current = await readCurrentConversation(new AiStore(sql), "member-a", "chat-a");
    expect(current).toMatchObject({ schemaVersion: 2, revision: 2, conversation: { id: "chat-a", messages: expect.any(Array) } });
    expect(current?.conversation.messages).toHaveLength(72);
    expect(await readCurrentConversation(new AiStore(sql), "member-a", "missing")).toBeNull();
    expect(await readCurrentConversation(new AiStore(sql, "tenant-b"), "member-a", "chat-a")).toBeNull();
    await expect(readCurrentConversation(new AiStore(sql), "ungranted", "chat-a")).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
  });

  it("uses bounded binary chunks, verifies hashes, and survives a database reopen", async () => {
    const original = state("长文本"); original.conversations[0].messages[0].content = "中文😀".repeat(32_000);
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    await shadow.stageFromV1("member-a"); await v2.prepareFromShadow("member-a");
    const chunks = database.prepare("SELECT length(data) AS size FROM ai_workspace_v2_entity_chunks WHERE kind='conversation' AND entity_id='chat-a'").all() as Array<{ size: number }>;
    expect(chunks.length).toBeGreaterThan(2);
    expect(Math.max(...chunks.map(chunk => chunk.size))).toBeLessThanOrEqual(65_536);
    database.close(); database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    sql = adapter(database); workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    v2 = new AiWorkspaceV2Store(sql, workspace); v2.initialize();
    expect((await v2.readPreparedEntity("member-a", "conversation", "chat-a"))?.value).toEqual(original.conversations[0]);
    const first = database.prepare("SELECT data FROM ai_workspace_v2_entity_chunks WHERE kind='conversation' AND entity_id='chat-a' AND chunk_index=0").get() as { data: string };
    const altered = btoa(atob(first.data).replace('"chat-a"', '"chat-b"'));
    expect(altered).not.toBe(first.data);
    database.prepare("UPDATE ai_workspace_v2_entity_chunks SET data=? WHERE kind='conversation' AND entity_id='chat-a' AND chunk_index=0").run(altered);
    await expect(v2.readPreparedEntity("member-a", "conversation", "chat-a")).rejects.toMatchObject({ code: "AI_WORKSPACE_CORRUPT" });
    database.prepare("UPDATE ai_workspace_v2_entity_chunks SET data=? WHERE kind='conversation' AND entity_id='chat-a' AND chunk_index=0").run(first.data);
    database.prepare("DELETE FROM ai_workspace_v2_entity_chunks WHERE kind='conversation' AND entity_id='chat-a' AND chunk_index=1").run();
    await expect(v2.readPreparedEntity("member-a", "conversation", "chat-a")).rejects.toMatchObject({ code: "AI_WORKSPACE_CORRUPT" });
    expect(workspace.read("member-a").state).toEqual(original);
  });

  it("rejects stale shadow and stale prepared data, and isolates equal user IDs by tenant", async () => {
    const first = state("甲"), second = state("乙");
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: first });
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: second }, "tenant-b");
    await shadow.stageFromV1("member-a"); await shadow.stageFromV1("member-a", "tenant-b");
    await v2.prepareFromShadow("member-a"); await v2.prepareFromShadow("member-a", "tenant-b");
    expect((await v2.readPreparedEntity("member-a", "conversation", "chat-a"))?.value).toEqual(first.conversations[0]);
    expect((await v2.readPreparedEntity("member-a", "conversation", "chat-a", "tenant-b"))?.value).toEqual(second.conversations[0]);
    first.drafts["chat-a"] = "已更新";
    await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: first });
    await expect(v2.readPreparedEntity("member-a", "conversation", "chat-a")).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.prepareFromShadow("member-a")).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect((await v2.readPreparedEntity("member-a", "conversation", "chat-a", "tenant-b"))?.value).toEqual(second.conversations[0]);
    await expect(v2.prepareFromShadow("ungranted")).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
  });

  it("rolls back a failed preparation without modifying V1 or the previous prepared snapshot", async () => {
    const first = state("甲"), next = state("乙");
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: first });
    await shadow.stageFromV1("member-a"); await v2.prepareFromShadow("member-a");
    await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: next });
    await shadow.stageFromV1("member-a");
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_entity_chunks")) throw new Error("fixture chunk write failed");
      sql.exec(query, ...bindings);
    } };
    const brokenV2 = new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken));
    await expect(brokenV2.prepareFromShadow("member-a")).rejects.toThrow("fixture chunk write failed");
    expect(database.prepare("SELECT source_revision,epoch FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ source_revision: 1, epoch: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE user_id='member-a'").get()).toEqual({ count: 7 });
    expect(workspace.read("member-a").state).toEqual(next);
  });

  it("rolls back a failed message index insert with the earlier prepared snapshot intact", async () => {
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("甲") });
    await shadow.stageFromV1("member-a"); await v2.prepareFromShadow("member-a");
    const next = state("乙"); next.conversations[0].messages[0].id = "message-new";
    await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: next });
    await shadow.stageFromV1("member-a");
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_message_owners")) throw new Error("fixture message index write failed");
      sql.exec(query, ...bindings);
    } };
    await expect(new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken)).prepareFromShadow("member-a")).rejects.toThrow("fixture message index write failed");
    expect(database.prepare("SELECT source_revision,epoch,message_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ source_revision: 1, epoch: 1, message_index_version: 1 });
    expect(database.prepare("SELECT message_id,conversation_id FROM ai_workspace_v2_message_owners WHERE tenant_id='default' AND user_id='member-a'").all()).toEqual([
      { message_id: "message-a", conversation_id: "chat-a" },
    ]);
    expect(workspace.read("member-a").state).toEqual(next);
  });

  it("rejects inactive writes and keeps V1 authoritative", async () => {
    const saved = await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("甲") });
    await shadow.stageFromV1("member-a");
    const prepared = await v2.prepareFromShadow("member-a");
    await expect(v2.mutateActive("member-a", { epoch: prepared!.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "新草稿" }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" });
    expect(workspace.read("member-a")).toEqual(saved);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations").get()).toEqual({ count: 0 });
  });

  it("uses per-entity CAS so two independent drafts do not conflict", async () => {
    const prepared = await active();
    const first = await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "对话草稿已更新" }] });
    const second = await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "new-conversation", expectedRevision: 0, action: "put", value: "新对话草稿" }] });
    expect(first).toMatchObject({ epoch: prepared.epoch, entities: [{ entityId: "chat-a", revision: 2 }] });
    expect(second).toMatchObject({ epoch: prepared.epoch, entities: [{ entityId: "new-conversation", revision: 1 }] });
    expect(await v2.readActiveEntity("member-a", "draft", "chat-a")).toMatchObject({ revision: 2, value: "对话草稿已更新" });
    expect(await v2.readActiveEntity("member-a", "draft", "new-conversation")).toMatchObject({ revision: 1, value: "新对话草稿" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "过期版本" }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(database.prepare("SELECT epoch FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ epoch: prepared.epoch });
  });

  it("creates an empty conversation at the front and updates only its metadata with CAS", async () => {
    const prepared = await active();
    const conversation = { id: "chat-b", projectId: "project-a", title: "新对话", timeLabel: "刚刚", messages: [] };
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 0, action: "put", value: conversation },
    ] };
    const first = await v2.mutateActive("member-a", request);
    expect(first).toMatchObject({ entities: [{ kind: "conversation", entityId: "chat-b", revision: 1, deleted: false }] });
    expect(await v2.mutateActive("member-a", request)).toEqual(first);
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-b")).toMatchObject({ ordinal: -1, revision: 1, value: conversation });
    const updated = { ...conversation, title: "改过的标题", timeLabel: "今天" };
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 1, action: "put", value: updated },
    ] });
    expect(await v2.mutateActive("member-a", request)).toEqual(first);
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-b")).toMatchObject({ ordinal: -1, revision: 2, value: updated });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 1, action: "put", value: { ...updated, title: "过期覆盖" } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(database.prepare("SELECT message_id,conversation_id FROM ai_workspace_v2_message_owners WHERE tenant_id='default' AND user_id='member-a'").all()).toEqual([
      { message_id: "message-a", conversation_id: "chat-a" },
    ]);
    expect(database.prepare("SELECT revision,schema_version FROM ai_workspaces WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual({ revision: 1, schema_version: 2 });
  });

  it("rejects conversation messages, project moves, deletes and mixed writes", async () => {
    const prepared = await active();
    const old = state("甲").conversations[0];
    const attempt = (value: unknown, expectedRevision = 1) => v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-a", expectedRevision, action: "put", value },
    ] });
    await expect(attempt({ ...old, messages: [...old.messages, { id: "message-b", role: "user", content: "新消息", time: "11:00" }] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(attempt({ ...old, messages: [{ ...old.messages[0], content: "被改写" }] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(attempt({ id: old.id, title: old.title, timeLabel: old.timeLabel, messages: old.messages })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(attempt({ ...old, id: "chat-b" })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-new", expectedRevision: 0, action: "put", value: { ...old, id: "chat-new" } },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "new-conversation", expectedRevision: 0, action: "put", value: { id: "new-conversation", title: "占位冲突", timeLabel: "刚刚", messages: [] } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-a", expectedRevision: 1, action: "delete" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-a", expectedRevision: 1, action: "put", value: old },
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "混合草稿" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-a")).toMatchObject({ revision: 1, value: old });
  });

  it("requires a verified message index and stable project before conversation writes", async () => {
    const prepared = await active();
    const conversation = { id: "chat-b", projectId: "project-a", title: "新对话", timeLabel: "刚刚", messages: [] };
    const save = () => v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 0, action: "put", value: conversation },
    ] });
    database.prepare("UPDATE ai_workspace_v2_meta SET message_index_version=0 WHERE user_id='member-a'").run();
    await expect(save()).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    database.prepare("UPDATE ai_workspace_v2_meta SET message_index_version=1 WHERE user_id='member-a'").run();
    const original = v2.readActiveEntities.bind(v2);
    const spy = vi.spyOn(v2, "readActiveEntities").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      database.prepare("UPDATE ai_workspace_v2_entities SET revision=revision+1 WHERE tenant_id='default' AND user_id='member-a' AND kind='project' AND entity_id='project-a'").run();
      return result;
    });
    try { await expect(save()).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" }); }
    finally { spy.mockRestore(); }
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-b")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual({ count: 0 });
  });

  it("rejects absent projects and damaged message ownership", async () => {
    const prepared = await active();
    const missing = { id: "chat-new", projectId: "missing", title: "新对话", timeLabel: "刚刚", messages: [] };
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-new", expectedRevision: 0, action: "put", value: missing },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    const old = state("甲").conversations[0];
    database.prepare("DELETE FROM ai_workspace_v2_message_owners WHERE tenant_id='default' AND user_id='member-a' AND message_id='message-a'").run();
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-a", expectedRevision: 1, action: "put", value: { ...old, title: "改名" } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-a")).toMatchObject({ revision: 1, value: old });
  });

  it("keeps an already-prepared legacy conversation with the reserved ID editable", async () => {
    const legacy = state("甲");
    legacy.conversations[0].id = "new-conversation";
    legacy.activeConversationId = "new-conversation";
    legacy.artifacts[0].conversationId = "new-conversation";
    legacy.drafts = { "new-conversation": "原草稿" };
    legacy.draftAttachments = { "new-conversation": legacy.draftAttachments!["chat-a"] };
    legacy.videoDraftSettings = { "new-conversation": legacy.videoDraftSettings!["chat-a"] };
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: legacy });
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'").run();
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "new-conversation", expectedRevision: 1, action: "put", value: { ...legacy.conversations[0], title: "旧对话改名" } },
    ] });
    expect(await v2.readActiveEntity("member-a", "conversation", "new-conversation")).toMatchObject({ revision: 2, value: { title: "旧对话改名" } });
  });

  it("enforces the account conversation count without affecting another tenant", async () => {
    const prepared = await active();
    const other = await active("乙", "tenant-b");
    for (let index = 0; index < 499; index++) {
      database.prepare("INSERT INTO ai_workspace_v2_entities(tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count) VALUES('default','member-a','conversation',?,1,?,1,'fixture',1)").run(`extra-${index}`, index + 1);
    }
    const conversation = { id: "chat-b", projectId: "project-a", title: "新对话", timeLabel: "刚刚", messages: [] };
    const request = (epoch: number) => ({ epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 0, action: "put", value: conversation },
    ] });
    await expect(v2.mutateActive("member-a", request(prepared.epoch))).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-b")).toBeNull();
    await v2.mutateActive("member-a", request(other.epoch), "tenant-b");
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-b", "tenant-b")).toMatchObject({ value: conversation });
  });

  it("rolls back a failed conversation entity write without a receipt", async () => {
    const prepared = await active();
    const conversation = { id: "chat-b", projectId: "project-a", title: "新对话", timeLabel: "刚刚", messages: [] };
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 0, action: "put", value: conversation },
    ] };
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_entity_chunks") && bindings[2] === "conversation") throw new Error("fixture conversation write failed");
      sql.exec(query, ...bindings);
    } };
    await expect(new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken)).mutateActive("member-a", request)).rejects.toThrow("fixture conversation write failed");
    expect(await v2.readActiveEntity("member-a", "conversation", "chat-b")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT message_id,conversation_id FROM ai_workspace_v2_message_owners WHERE tenant_id='default' AND user_id='member-a'").all()).toEqual([
      { message_id: "message-a", conversation_id: "chat-a" },
    ]);
  });

  it("rejects forged new image ownership and a duplicate index before changing an existing artifact", async () => {
    const assetId = crypto.randomUUID();
    const { prepared, artifact } = await activeImage(assetId);
    const duplicate = { ...artifact, id: "artifact-b" };
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: duplicate.id, expectedRevision: 0, action: "put", value: duplicate },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    const stored = tenantStorageKey("default", "member-a");
    sql.exec("INSERT INTO ai_workspace_v2_image_artifacts(tenant_id,user_id,conversation_id,asset_id,artifact_id) VALUES(?,?,?,?,?)",
      "default", stored, "chat-a", assetId, "artifact-b");
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: artifact.id, expectedRevision: 1, action: "put", value: { ...artifact, title: "安全改名" } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_AMBIGUOUS_REFERENCE" });
    expect(await v2.readActiveEntity("member-a", "artifact", "artifact-b")).toBeNull();
    expect(await v2.readActiveEntity("member-a", "artifact", "artifact-a")).toMatchObject({ revision: 1, value: artifact });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE user_id='member-a'").get()).toEqual({ count: 0 });
  });

  it("creates a non-image artifact and replays its receipt after the parent changes", async () => {
    const prepared = await active();
    const artifact = { ...state("甲").artifacts[0], id: "artifact-b", title: "新文档" };
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: artifact.id, expectedRevision: 0, action: "put", value: artifact },
    ] };
    const ack = await v2.mutateActive("member-a", request);
    expect(ack).toMatchObject({ entities: [{ kind: "artifact", entityId: "artifact-b", revision: 1, deleted: false }] });
    expect(await v2.readActiveEntity("member-a", "artifact", artifact.id)).toMatchObject({ value: artifact, revision: 1 });
    database.prepare("UPDATE ai_workspace_v2_entities SET revision=revision+1 WHERE tenant_id='default' AND user_id='member-a' AND kind='conversation' AND entity_id='chat-a'").run();
    expect(await v2.mutateActive("member-a", request)).toEqual(ack);
    await expect(v2.mutateActive("member-a", { ...request, ops: [{ ...request.ops[0], value: { ...artifact, title: "其他内容" } }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_image_artifacts WHERE user_id='member-a'").get()).toEqual({ count: 0 });
  });

  it("replays an artifact mutation that commits while its identical request verifies parents", async () => {
    const prepared = await active();
    const artifact = { ...state("甲").artifacts[0], title: "并发更新" };
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: artifact.id, expectedRevision: 1, action: "put", value: artifact },
    ] };
    const delayed = new AiWorkspaceV2Store(sql, workspace);
    const actualRead = delayed.readActiveEntities.bind(delayed);
    let releaseRead!: () => void;
    let enteredRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const entered = new Promise<void>(resolve => { enteredRead = resolve; });
    delayed.readActiveEntities = async (...args) => { enteredRead(); await gate; return actualRead(...args); };
    const concurrent = delayed.mutateActive("member-a", request);
    await entered;
    const ack = await v2.mutateActive("member-a", request);
    releaseRead();
    expect(await concurrent).toEqual(ack);
    expect(await v2.readActiveEntity("member-a", "artifact", artifact.id)).toMatchObject({ revision: 2, value: artifact });
  });

  it("creates and updates one project with CAS, replay and stable identity", async () => {
    const prepared = await active();
    const created = { id: "project-b", title: "新项目", timeLabel: "现在", instructions: "只讨论工作" };
    const create = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: created.id, expectedRevision: 0, action: "put", value: created },
    ] };
    const createAck = await v2.mutateActive("member-a", create);
    expect(createAck).toMatchObject({ entities: [{ kind: "project", entityId: created.id, revision: 1, deleted: false }] });
    expect(await v2.readActiveEntity("member-a", "project", created.id)).toMatchObject({ revision: 1, value: created });
    expect(await v2.mutateActive("member-a", create)).toEqual(createAck);
    const updated = { ...created, title: "已改名" };
    const update = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: created.id, expectedRevision: 1, action: "put", value: updated },
    ] };
    expect(await v2.mutateActive("member-a", update)).toMatchObject({ entities: [{ revision: 2 }] });
    expect(await v2.readActiveEntity("member-a", "project", created.id)).toMatchObject({ revision: 2, value: updated });
    await expect(v2.mutateActive("member-a", { ...create, mutationId: crypto.randomUUID() })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.mutateActive("member-a", { ...create, ops: [{ ...create.ops[0], value: { ...created, title: "篡改" } }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: "wrong-id", expectedRevision: 0, action: "put", value: created },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: created.id, expectedRevision: 2, action: "delete" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
  });

  it("keeps project-only batches atomic and enforces the account-wide 100-project cap", async () => {
    const full = state("满");
    full.projects = Array.from({ length: 99 }, (_, index) => ({ id: `project-${index}`, title: `项目${index}`, timeLabel: "现在" }));
    full.conversations[0].projectId = "project-0";
    full.artifacts[0].projectId = "project-0";
    full.activeProjectId = "project-0";
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: full });
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'").run();
    const project = (id: string) => ({ id, title: id, timeLabel: "现在" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: "project-99", expectedRevision: 0, action: "put", value: project("project-99") },
      { kind: "project", entityId: "project-100", expectedRevision: 0, action: "put", value: project("project-100") },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    expect(await v2.readActiveEntity("member-a", "project", "project-99")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE user_id='member-a'").get()).toEqual({ count: 0 });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: "project-99", expectedRevision: 0, action: "put", value: project("project-99") },
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "不应保存" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    expect(await v2.readActiveEntity("member-a", "project", "project-99")).toBeNull();
    const finalSlot = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: "project-99", expectedRevision: 0, action: "put", value: project("project-99") },
    ] };
    const ack = await v2.mutateActive("member-a", finalSlot);
    expect(ack).toMatchObject({ entities: [{ entityId: "project-99", revision: 1 }] });
    expect(await v2.mutateActive("member-a", finalSlot)).toEqual(ack);
    await expect(v2.mutateActive("member-a", { ...finalSlot, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: "project-100", expectedRevision: 0, action: "put", value: project("project-100") },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
  });

  it("keeps identical project IDs isolated between members of the same tenant", async () => {
    await active("甲");
    new AiStore(sql).saveQuota("member-b", { ...emptyQuota(), limitTokens: 10_000 });
    await workspace.save("member-b", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("乙") });
    await shadow.stageFromV1("member-b");
    const prepared = (await v2.prepareFromShadow("member-b"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-b'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-b'").run();
    const changed = { ...state("乙").projects[0], title: "成员乙独立项目" };
    await v2.mutateActive("member-b", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: changed.id, expectedRevision: 1, action: "put", value: changed },
    ] });
    expect((await v2.readActiveEntity("member-b", "project", changed.id))?.value).toEqual(changed);
    expect((await v2.readActiveEntity("member-a", "project", changed.id))?.value).toEqual(state("甲").projects[0]);
  });

  it("rejects invalid project content, tombstone revival and tenant-crossing writes", async () => {
    const first = await active("甲");
    const second = await active("乙", "tenant-b");
    const current = state("甲").projects[0];
    await expect(v2.mutateActive("member-a", { epoch: first.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: current.id, expectedRevision: 1, action: "put", value: { ...current, instructions: "x".repeat(24_001) } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    const updated = { ...state("乙").projects[0], title: "乙租户独立" };
    expect(await v2.mutateActive("member-a", { epoch: second.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: updated.id, expectedRevision: 1, action: "put", value: updated },
    ] }, "tenant-b")).toMatchObject({ entities: [{ revision: 2 }] });
    expect((await v2.readActiveEntity("member-a", "project", current.id))?.value).toEqual(current);
    database.prepare("UPDATE ai_workspace_v2_entities SET deleted=1 WHERE tenant_id='default' AND user_id='member-a' AND kind='project' AND entity_id='project-a'").run();
    await expect(v2.mutateActive("member-a", { epoch: first.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: current.id, expectedRevision: 1, action: "put", value: current },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
  });

  it("rolls back a project entity write and receipt if SQLite fails", async () => {
    const prepared = await active();
    const project = { id: "project-b", title: "未保存", timeLabel: "现在" };
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_entities") && bindings[2] === "project") throw new Error("fixture project write failed");
      sql.exec(query, ...bindings);
    } };
    const brokenV2 = new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken));
    await expect(brokenV2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "project", entityId: project.id, expectedRevision: 0, action: "put", value: project },
    ] })).rejects.toThrow("fixture project write failed");
    expect(await v2.readActiveEntity("member-a", "project", project.id)).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE user_id='member-a'").get()).toEqual({ count: 0 });
  });

  it("enables only the manifest's attachment flag with CAS and concurrent exact replay", async () => {
    const original = state("甲");
    delete original.draftAttachments;
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'").run();
    const before = (await v2.readActiveEntity("member-a", "manifest", "root"))!.value as { base: object; hasDraftAttachments: boolean; hasVideoDraftSettings: boolean };
    const v1PayloadBefore = database.prepare("SELECT data FROM ai_workspaces WHERE tenant_id='default' AND user_id='member-a'").get();
    expect(before.hasDraftAttachments).toBe(false);
    const enabled = { ...before, hasDraftAttachments: true };
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "manifest", entityId: "root", expectedRevision: 1, action: "put", value: enabled },
    ] };
    const delayed = new AiWorkspaceV2Store(sql, workspace);
    const actualRead = delayed.readActiveEntity.bind(delayed);
    let releaseRead!: () => void;
    let enteredRead!: () => void;
    const gate = new Promise<void>(resolve => { releaseRead = resolve; });
    const entered = new Promise<void>(resolve => { enteredRead = resolve; });
    delayed.readActiveEntity = async (...args) => { enteredRead(); await gate; return actualRead(...args); };
    const concurrent = delayed.mutateActive("member-a", request);
    await entered;
    const ack = await v2.mutateActive("member-a", request);
    releaseRead();
    expect(await concurrent).toEqual(ack);
    expect(ack).toMatchObject({ entities: [{ kind: "manifest", entityId: "root", revision: 2, deleted: false }] });
    expect(await v2.mutateActive("member-a", request)).toEqual(ack);
    expect(await v2.readActiveEntity("member-a", "manifest", "root")).toMatchObject({ revision: 2, value: enabled });
    expect(database.prepare("SELECT data FROM ai_workspaces WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual(v1PayloadBefore);
    await expect(v2.mutateActive("member-a", { ...request, mutationId: crypto.randomUUID() })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.mutateActive("member-a", { ...request, ops: [{ ...request.ops[0], value: { ...enabled, base: { view: "skills" } } }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
  });

  it("keeps the manifest flag and mutation receipt scoped to one tenant", async () => {
    for (const tenant of ["default", "tenant-b"]) {
      const original = state(tenant);
      delete original.draftAttachments;
      if (tenant === "tenant-b") original.view = "skills";
      await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original }, tenant);
      await shadow.stageFromV1("member-a", tenant);
      await v2.prepareFromShadow("member-a", tenant);
      const stored = tenantStorageKey(tenant, "member-a");
      database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=?").run(new Date().toISOString(), tenant, stored);
      database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=?").run(tenant, stored);
    }
    const first = (await v2.readActiveEntity("member-a", "manifest", "root"))!.value as { base: object; hasDraftAttachments: boolean; hasVideoDraftSettings: boolean };
    const second = (await v2.readActiveEntity("member-a", "manifest", "root", "tenant-b"))!.value;
    const request = { epoch: 1, mutationId: crypto.randomUUID(), ops: [
      { kind: "manifest", entityId: "root", expectedRevision: 1, action: "put", value: { ...first, hasDraftAttachments: true } },
    ] };
    await v2.mutateActive("member-a", request);
    expect((await v2.readActiveEntity("member-a", "manifest", "root", "tenant-b"))?.value).toEqual(second);
    await expect(v2.mutateActive("member-a", request, "tenant-b")).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE tenant_id='tenant-b'").get()).toEqual({ count: 0 });
    const tenantRequest = { ...request, ops: [{ ...request.ops[0], value: { ...(second as object), hasDraftAttachments: true } }] };
    expect(await v2.mutateActive("member-a", tenantRequest, "tenant-b")).toMatchObject({ entities: [{ revision: 2 }] });
    await expect(v2.mutateActive("member-a", tenantRequest)).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
  });

  it("rejects manifest field changes, mixed batches, deletion and interrupted writes", async () => {
    const original = state("甲");
    delete original.draftAttachments;
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'").run();
    const before = (await v2.readActiveEntity("member-a", "manifest", "root"))!.value as { base: object; hasDraftAttachments: boolean; hasVideoDraftSettings: boolean };
    const enabled = { ...before, hasDraftAttachments: true };
    const request = (value: unknown) => ({ epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "manifest", entityId: "root", expectedRevision: 1, action: "put", value },
    ] });
    await expect(v2.mutateActive("member-a", request({ ...enabled, base: { ...before.base, mode: "fast" } }))).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(v2.mutateActive("member-a", request({ ...enabled, hasVideoDraftSettings: false }))).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(v2.mutateActive("member-a", request(before))).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    let deep: unknown = "leaf";
    for (let index = 0; index < 14; index++) deep = { child: deep };
    await expect(v2.mutateActive("member-a", request({ ...enabled, base: { ...before.base, extra: deep } }))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", request({ ...enabled, base: { ...before.base, extra: "x".repeat(140_000) } }))).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    await expect(v2.mutateActive("member-a", request({ ...enabled, extra: true }))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { ...request(enabled), ops: [{ kind: "manifest", entityId: "wrong", expectedRevision: 0, action: "put", value: enabled }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "manifest", entityId: "root", expectedRevision: 1, action: "delete" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "manifest", entityId: "root", expectedRevision: 1, action: "put", value: enabled },
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "不可混写" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_entities") && bindings[2] === "manifest") throw new Error("fixture manifest write failed");
      sql.exec(query, ...bindings);
    } };
    await expect(new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken)).mutateActive("member-a", request(enabled))).rejects.toThrow("fixture manifest write failed");
    expect(await v2.readActiveEntity("member-a", "manifest", "root")).toMatchObject({ revision: 1, value: before });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE user_id='member-a'").get()).toEqual({ count: 0 });
  });

  it("writes, clears and re-adds a scoped draft attachment container with CAS", async () => {
    const prepared = await active();
    const originalV1 = database.prepare("SELECT data FROM ai_workspaces WHERE tenant_id='default' AND user_id='member-a'").get();
    const documents = [
      { id: "draft-a", name: "需求.txt", mimeType: "text/plain", content: "第一版" },
      { id: "draft-b", name: "说明.md", mimeType: "text/markdown", content: "请保留" },
    ];
    const put = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 1, action: "put", value: documents },
    ] };
    const ack = await v2.mutateActive("member-a", put);
    expect(ack).toMatchObject({ entities: [{ kind: "draftAttachment", entityId: "chat-a", revision: 2, deleted: false }] });
    expect(await v2.readActiveEntity("member-a", "draftAttachment", "chat-a")).toMatchObject({ revision: 2, value: documents });
    expect(await v2.mutateActive("member-a", put)).toEqual(ack);
    await expect(v2.mutateActive("member-a", { ...put, mutationId: crypto.randomUUID() })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.mutateActive("member-a", { ...put, ops: [{ ...put.ops[0], value: [] }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
    const cleared = await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 2, action: "put", value: [] },
    ] });
    expect(cleared).toMatchObject({ entities: [{ revision: 3, deleted: false }] });
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "chat-a"))?.value).toEqual([]);
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 3, action: "delete" },
    ] });
    expect(await v2.readActiveEntity("member-a", "draftAttachment", "chat-a")).toMatchObject({ revision: 4, deleted: true, value: null });
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 4, action: "put", value: documents },
    ] });
    expect(await v2.readActiveEntity("member-a", "draftAttachment", "chat-a")).toMatchObject({ revision: 5, deleted: false, value: documents });
    expect(database.prepare("SELECT data FROM ai_workspaces WHERE tenant_id='default' AND user_id='member-a'").get()).toEqual(originalV1);
  });

  it("rejects malformed attachment data, missing parents and absent manifest flag", async () => {
    const original = state("甲");
    delete original.draftAttachments;
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'").run();
    const request = (entityId: string, value: unknown) => ({ epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId, expectedRevision: 0, action: "put", value },
    ] });
    const doc = { id: "draft-a", name: "需求.txt", mimeType: "text/plain", content: "正常内容" };
    await expect(v2.mutateActive("member-a", request("chat-a", [doc]))).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    const manifest = (await v2.readActiveEntity("member-a", "manifest", "root"))!;
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "manifest", entityId: "root", expectedRevision: manifest.revision, action: "put", value: { ...(manifest.value as object), hasDraftAttachments: true } },
    ] });
    await expect(v2.mutateActive("member-a", request("missing", [doc]))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", request("chat-a", undefined))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", request("chat-a", [doc, doc]))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", request("chat-a", Array.from({ length: 21 }, (_, i) => ({ ...doc, id: `doc-${i}` }))))).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    await expect(v2.mutateActive("member-a", request("chat-a", [{ ...doc, content: "x".repeat(100_001) }]))).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    await expect(v2.mutateActive("member-a", request("chat-a", [{ ...doc, media: { kind: "image", frames: [{ dataUrl: "data:image/png;base64,invalid" }] } }]))).rejects.toMatchObject({ code: "AI_IMAGE_INVALID" });
    expect(await v2.readActiveEntity("member-a", "draftAttachment", "chat-a")).toBeNull();
    await expect(v2.mutateActive("ungranted", request("chat-a", [doc]))).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
  });

  it("fences manifest changes and rolls back an interrupted attachment write", async () => {
    const prepared = await active();
    const doc = { id: "draft-b", name: "补充.txt", mimeType: "text/plain", content: "补充" };
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 1, action: "put", value: [doc] },
    ] };
    const changing = new AiWorkspaceV2Store(sql, workspace);
    const actualRead = changing.readActiveEntity.bind(changing);
    changing.readActiveEntity = async (...args) => {
      const result = await actualRead(...args);
      if (args[1] === "manifest") database.prepare("UPDATE ai_workspace_v2_entities SET revision=revision+1 WHERE tenant_id='default' AND user_id='member-a' AND kind='manifest' AND entity_id='root'").run();
      return result;
    };
    await expect(changing.mutateActive("member-a", request)).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "chat-a"))?.revision).toBe(1);
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_entity_chunks") && bindings[2] === "draftAttachment") throw new Error("fixture attachment write failed");
      sql.exec(query, ...bindings);
    } };
    await expect(new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken)).mutateActive("member-a", request)).rejects.toThrow("fixture attachment write failed");
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "chat-a"))?.revision).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE mutation_id=?").get(request.mutationId)).toEqual({ count: 0 });
  });

  it("accepts new-conversation attachment drafts but rejects nonexistent project drafts atomically", async () => {
    const prepared = await active();
    const value = [{ id: "draft-new", name: "准备.txt", mimeType: "text/plain", content: "未发送" }];
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "new-conversation", expectedRevision: 0, action: "put", value },
      { kind: "draftAttachment", entityId: "new-project-conversation:project-a", expectedRevision: 0, action: "put", value },
    ] });
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "new-conversation"))?.value).toEqual(value);
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "new-project-conversation:project-a"))?.value).toEqual(value);
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 1, action: "put", value },
      { kind: "draftAttachment", entityId: "new-project-conversation:missing", expectedRevision: 0, action: "put", value },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "chat-a"))?.revision).toBe(1);
  });

  it("rejects an attachment mutation above the total 16 MiB write limit without a partial commit", async () => {
    const prepared = await active();
    const value = Array.from({ length: 20 }, (_, index) => ({
      id: `draft-${index}`, name: "资料.txt", mimeType: "text/plain", content: "中".repeat(100_000),
    }));
    const request = { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draftAttachment", entityId: "chat-a", expectedRevision: 1, action: "put", value },
      { kind: "draftAttachment", entityId: "new-conversation", expectedRevision: 0, action: "put", value },
      { kind: "draftAttachment", entityId: "new-project-conversation:project-a", expectedRevision: 0, action: "put", value },
    ] };
    await expect(v2.mutateActive("member-a", request)).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    expect((await v2.readActiveEntity("member-a", "draftAttachment", "chat-a"))?.revision).toBe(1);
    expect(await v2.readActiveEntity("member-a", "draftAttachment", "new-conversation")).toBeNull();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE mutation_id=?").get(request.mutationId)).toEqual({ count: 0 });
  });

  it("fences artifact ownership changes, deletes and old preparations without a valid image index", async () => {
    const prepared = await active();
    const original = state("甲").artifacts[0];
    const request = (value: unknown) => ({ epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: "artifact-a", expectedRevision: 1, action: "put", value },
    ] });
    await expect(v2.mutateActive("member-a", request({ ...original, conversationId: "missing" }))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", request({ ...original, projectId: undefined }))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: "artifact-a", expectedRevision: 1, action: "delete" },
    ] })).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    database.prepare("UPDATE ai_workspace_v2_meta SET image_index_version=0 WHERE user_id='member-a'").run();
    await expect(v2.readActiveImageSourceEntities("member-a", "chat-a", crypto.randomUUID())).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.mutateActive("member-a", request(original))).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(await v2.readActiveEntity("member-a", "artifact", "artifact-a")).toMatchObject({ revision: 1, value: original });
  });

  it("rolls back an artifact's existing image index if its entity write fails", async () => {
    const assetId = crypto.randomUUID();
    const { prepared, artifact } = await activeImage(assetId);
    const updated = { ...artifact, title: "不应保存" };
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_entities")) throw new Error("fixture artifact write failed");
      sql.exec(query, ...bindings);
    } };
    const brokenV2 = new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken));
    await expect(brokenV2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: updated.id, expectedRevision: 1, action: "put", value: updated },
    ] })).rejects.toThrow("fixture artifact write failed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_image_artifacts WHERE user_id='member-a'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE user_id='member-a'").get()).toEqual({ count: 0 });
    expect(await v2.readActiveEntity("member-a", "artifact", "artifact-a")).toMatchObject({ revision: 1, value: artifact });
  });

  it("keeps identical image IDs isolated across V2 tenants and fences changed parent revisions", async () => {
    const assetId = crypto.randomUUID();
    const first = await activeImage(assetId, "甲");
    const second = await activeImage(assetId, "乙", "tenant-b");
    const mutation = (label: string, epoch: number) => ({ epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: "artifact-a", expectedRevision: 1, action: "put", value: { ...state(label).artifacts[0], kind: "图片", data: { images: [{ assetId }] }, title: "安全改名" } },
    ] });
    await v2.mutateActive("member-a", mutation("乙", second.prepared.epoch), "tenant-b");
    expect((await v2.readActiveImageSourceEntities("member-a", "chat-a", assetId))?.artifactId).toBe("artifact-a");
    expect((await v2.readActiveImageSourceEntities("member-a", "chat-a", assetId, "tenant-b"))?.artifactId).toBe("artifact-a");
    let transactions = 0;
    const racing: AiSql = { ...sql, transaction<T>(action: () => T): T {
      transactions++;
      if (transactions === 3) sql.exec("UPDATE ai_workspace_v2_entities SET revision=revision+1 WHERE tenant_id='default' AND user_id='member-a' AND kind='conversation' AND entity_id='chat-a'");
      return sql.transaction(action);
    } };
    const racingV2 = new AiWorkspaceV2Store(racing, new AiWorkspaceRepository(racing));
    await expect(racingV2.mutateActive("member-a", mutation("甲", first.prepared.epoch))).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect((await v2.readActiveImageSourceEntities("member-a", "chat-a", assetId))?.artifactId).toBe("artifact-a");
    expect((await v2.readActiveEntity("member-a", "artifact", "artifact-a"))?.revision).toBe(1);
  });

  it("preserves the account-wide artifact count limit for V2 creates", async () => {
    const full = state("满");
    full.artifacts = Array.from({ length: 500 }, (_, index) => ({ ...full.artifacts[0], id: `artifact-${index}` }));
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: full });
    await shadow.stageFromV1("member-a");
    const prepared = (await v2.prepareFromShadow("member-a"))!;
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'").run(new Date().toISOString());
    database.prepare("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'").run();
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: "artifact-extra", expectedRevision: 0, action: "put", value: { ...full.artifacts[0], id: "artifact-extra" } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    expect(await v2.readActiveEntity("member-a", "artifact", "artifact-extra")).toBeNull();
  });

  it("replays the same receipt, rejects a reused ID, and rolls back an invalid batch", async () => {
    const prepared = await active();
    const mutationId = crypto.randomUUID();
    const request = { epoch: prepared.epoch, mutationId, ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "第一次" }] };
    const ack = await v2.mutateActive("member-a", request);
    await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 2, action: "put", value: "第二次" }] });
    expect(await v2.mutateActive("member-a", request)).toEqual(ack);
    await expect(v2.mutateActive("member-a", { ...request, ops: [{ ...request.ops[0], value: "篡改" }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_MUTATION_CONFLICT" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draft", entityId: "new-conversation", expectedRevision: 0, action: "put", value: "不应写入" },
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "过期" },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(await v2.readActiveEntity("member-a", "draft", "new-conversation")).toBeNull();
    expect((await v2.readActiveEntity("member-a", "draft", "chat-a"))?.value).toBe("第二次");
  });

  it("keeps deletion tombstones so an old revision cannot recreate an entity", async () => {
    const prepared = await active();
    const created = await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "new-conversation", expectedRevision: 0, action: "put", value: "待删除" }] });
    const deleted = await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "new-conversation", expectedRevision: 1, action: "delete" }] });
    expect(created.entities[0].revision).toBe(1);
    expect(deleted.entities[0].revision).toBe(2);
    expect(await v2.readActiveEntity("member-a", "draft", "new-conversation")).toMatchObject({ revision: 2, deleted: true, value: null });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "new-conversation", expectedRevision: 0, action: "put", value: "旧请求复活" }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
  });

  it("validates draft targets, size, allowed kinds, epoch and tenant access", async () => {
    const prepared = await active();
    const mutate = (kind: string, entityId: string, value: unknown) => v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind, entityId, expectedRevision: 0, action: "put", value }] });
    await expect(mutate("draft", "missing", "bad")).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(mutate("draft", "new-project-conversation:missing", "bad")).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(mutate("draft", "new-conversation", "x".repeat(24_001))).rejects.toMatchObject({ code: "AI_WORKSPACE_TOO_LARGE" });
    await expect(mutate("conversation", "chat-a", state("篡改").conversations[0])).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch + 1, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "bad" }] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "bad" }] }, "tenant-b")).rejects.toMatchObject({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" });
    await expect(v2.mutateActive("ungranted", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [{ kind: "draft", entityId: "new-conversation", expectedRevision: 0, action: "put", value: "bad" }] })).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
  });

  it("uses V1 video-setting validation, fences old clients, and isolates the same account in another tenant", async () => {
    const first = await active("甲");
    const second = await active("乙", "tenant-b");
    expect(() => workspace.read("member-a")).toThrow("工作台记录版本已更新");
    const settings = { model: "sd-2.5-c1", seconds: 30, resolution: "720p", aspectRatio: "16:9" };
    const ack = await v2.mutateActive("member-a", { epoch: second.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "videoDraftSettings", entityId: "chat-a", expectedRevision: 1, action: "put", value: settings },
    ] }, "tenant-b");
    expect(ack.entities).toMatchObject([{ kind: "videoDraftSettings", entityId: "chat-a", revision: 2, deleted: false }]);
    expect((await v2.readActiveEntity("member-a", "videoDraftSettings", "chat-a", "tenant-b"))?.value).toEqual(settings);
    expect((await v2.readActiveEntity("member-a", "videoDraftSettings", "chat-a"))?.value).toEqual(state("甲").videoDraftSettings!["chat-a"]);
    expect((await v2.readActiveEntity("member-a", "draft", "chat-a"))?.value).toBe("草稿甲");
    await expect(v2.mutateActive("member-a", { epoch: first.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "videoDraftSettings", entityId: "chat-a", expectedRevision: 1, action: "put", value: { ...settings, seconds: 31 } },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.mutateActive("member-a", { epoch: first.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "重复" },
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "delete" },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
  });

  it("does not trust a prepared V2 snapshot after the source V1 revision changes", async () => {
    const prepared = await active();
    database.prepare("UPDATE ai_workspaces SET revision=revision+1 WHERE tenant_id=? AND user_id=?").run("default", "member-a");
    await expect(v2.readActiveEntity("member-a", "draft", "chat-a")).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    await expect(v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "不能覆盖" },
    ] })).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
  });

  it("keeps idempotency receipts bounded while stale retries remain fenced by entity revisions", async () => {
    const prepared = await active();
    const firstId = crypto.randomUUID();
    const firstRequest = { epoch: prepared.epoch, mutationId: firstId, ops: [
      { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "第 1 次" },
    ] };
    await v2.mutateActive("member-a", firstRequest);
    for (let revision = 2; revision <= 260; revision++) {
      await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
        { kind: "draft", entityId: "chat-a", expectedRevision: revision, action: "put", value: `第 ${revision} 次` },
      ] });
    }
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=?").get("default", "member-a")).toEqual({ count: 256 });
    await expect(v2.mutateActive("member-a", firstRequest)).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect((await v2.readActiveEntity("member-a", "draft", "chat-a"))?.value).toBe("第 260 次");
  });

  it("adds tombstone support to an existing prepared table on repeat initialization", async () => {
    await active();
    database.exec(`
      CREATE TABLE ai_workspace_v2_entities_before_tombstones (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
        revision INTEGER NOT NULL, ordinal INTEGER NOT NULL, byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL, chunk_count INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,user_id,kind,entity_id)
      );
      INSERT INTO ai_workspace_v2_entities_before_tombstones
        SELECT tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count FROM ai_workspace_v2_entities;
      DROP TABLE ai_workspace_v2_entities;
      ALTER TABLE ai_workspace_v2_entities_before_tombstones RENAME TO ai_workspace_v2_entities;
    `);
    v2.initialize();
    v2.initialize();
    expect(database.prepare("PRAGMA table_info(ai_workspace_v2_entities)").all().some(row => row.name === "deleted")).toBe(true);
    expect((await v2.readActiveEntity("member-a", "draft", "chat-a"))?.value).toBe("草稿甲");
  });

  it("marks an older prepared meta table's image index as unverified until a fresh preparation", async () => {
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("甲") });
    await shadow.stageFromV1("member-a"); await v2.prepareFromShadow("member-a");
    database.exec(`
      CREATE TABLE ai_workspace_v2_meta_before_image_index (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
        source_hash TEXT NOT NULL, epoch INTEGER NOT NULL, prepared_at TEXT NOT NULL,
        activated_at TEXT, PRIMARY KEY(tenant_id,user_id)
      );
      INSERT INTO ai_workspace_v2_meta_before_image_index
        SELECT tenant_id,user_id,source_revision,source_hash,epoch,prepared_at,activated_at FROM ai_workspace_v2_meta;
      DROP TABLE ai_workspace_v2_meta;
      ALTER TABLE ai_workspace_v2_meta_before_image_index RENAME TO ai_workspace_v2_meta;
    `);
    v2.initialize(); v2.initialize();
    expect(database.prepare("SELECT image_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ image_index_version: 0 });
    expect(database.prepare("SELECT message_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ message_index_version: 0 });
    const refreshed = await v2.prepareFromShadow("member-a");
    expect(refreshed?.epoch).toBe(2);
    expect(database.prepare("SELECT image_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ image_index_version: 1 });
    expect(database.prepare("SELECT message_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ message_index_version: 1 });
    expect(workspace.read("member-a").state).toEqual(state("甲"));
  });

  it("marks the immediately previous prepared meta table's message index as unverified", async () => {
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("甲") });
    await shadow.stageFromV1("member-a"); await v2.prepareFromShadow("member-a");
    database.exec(`
      CREATE TABLE ai_workspace_v2_meta_before_message_index (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, source_revision INTEGER NOT NULL,
        source_hash TEXT NOT NULL, epoch INTEGER NOT NULL, prepared_at TEXT NOT NULL,
        activated_at TEXT, image_index_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(tenant_id,user_id)
      );
      INSERT INTO ai_workspace_v2_meta_before_message_index
        SELECT tenant_id,user_id,source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version FROM ai_workspace_v2_meta;
      DROP TABLE ai_workspace_v2_meta;
      ALTER TABLE ai_workspace_v2_meta_before_message_index RENAME TO ai_workspace_v2_meta;
    `);
    v2.initialize(); v2.initialize();
    expect(database.prepare("SELECT image_index_version,message_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ image_index_version: 1, message_index_version: 0 });
    expect((await v2.prepareFromShadow("member-a"))?.epoch).toBe(2);
    expect(database.prepare("SELECT image_index_version,message_index_version FROM ai_workspace_v2_meta WHERE user_id='member-a'").get()).toEqual({ image_index_version: 1, message_index_version: 1 });
    expect(workspace.read("member-a").state).toEqual(state("甲"));
  });

  it("reads one coherent prepared snapshot even when V1 is replaced during async hashing", async () => {
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: state("甲") });
    await shadow.stageFromV1("member-a");
    await v2.prepareFromShadow("member-a");
    let releaseDigest!: () => void;
    let enteredDigest!: () => void;
    const hold = new Promise<void>(resolve => { releaseDigest = resolve; });
    const entered = new Promise<void>(resolve => { enteredDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      enteredDigest();
      await hold;
      return originalDigest(algorithm, data);
    });
    const reading = v2.readPreparedEntity("member-a", "draft", "chat-a");
    try {
      await entered;
      spy.mockRestore();
      await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: state("乙") });
      await shadow.stageFromV1("member-a");
      await v2.prepareFromShadow("member-a");
    } finally {
      spy.mockRestore();
      releaseDigest();
    }
    expect((await reading)?.value).toBe("草稿甲");
    expect((await v2.readPreparedEntity("member-a", "draft", "chat-a"))?.value).toBe("草稿乙");
  });

  it("reads multiple active entities at one tenant-scoped epoch and rejects a corrupted member", async () => {
    const first = await active("甲");
    await active("乙", "tenant-b");
    const refs = [
      { kind: "conversation" as const, entityId: "chat-a" },
      { kind: "artifact" as const, entityId: "artifact-a" },
      { kind: "draft" as const, entityId: "chat-a" },
    ];
    const snapshot = await v2.readActiveEntities("member-a", refs);
    expect(snapshot.epoch).toBe(first.epoch);
    expect(snapshot.entities.map(item => item?.value)).toEqual([state("甲").conversations[0], state("甲").artifacts[0], "草稿甲"]);
    expect((await v2.readActiveEntities("member-a", refs, "tenant-b")).entities[2]?.value).toBe("草稿乙");
    await expect(v2.readActiveEntities("member-a", [refs[0], refs[0]])).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    await expect(v2.readActiveEntities("member-a", Array.from({ length: 33 }, (_, index) => ({ kind: "artifact", entityId: `missing-${index}` })))).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    database.prepare("UPDATE ai_workspace_v2_entity_chunks SET data=? WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=? AND chunk_index=0")
      .run("broken", "default", "member-a", "artifact", "artifact-a");
    await expect(v2.readActiveEntities("member-a", refs)).rejects.toMatchObject({ code: "AI_WORKSPACE_CORRUPT" });
  });

  it("keeps a batch coherent when a draft changes during async verification", async () => {
    const prepared = await active();
    let releaseDigest!: () => void;
    let enteredDigest!: () => void;
    const hold = new Promise<void>(resolve => { releaseDigest = resolve; });
    const entered = new Promise<void>(resolve => { enteredDigest = resolve; });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      enteredDigest();
      await hold;
      return originalDigest(algorithm, data);
    });
    const reading = v2.readActiveEntities("member-a", [{ kind: "draft", entityId: "chat-a" }, { kind: "videoDraftSettings", entityId: "chat-a" }]);
    try {
      await entered;
      spy.mockRestore();
      await v2.mutateActive("member-a", { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
        { kind: "draft", entityId: "chat-a", expectedRevision: 1, action: "put", value: "更新后草稿" },
      ] });
    } finally {
      spy.mockRestore();
      releaseDigest();
    }
    expect((await reading).entities[0]?.value).toBe("草稿甲");
    expect((await v2.readActiveEntity("member-a", "draft", "chat-a"))?.value).toBe("更新后草稿");
  });
});
