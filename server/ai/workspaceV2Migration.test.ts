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
import { tenantStorageKey } from "./tenant";

const TENANT = "local-test";
const USER = "local-v2-test-migration";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try { const result = action(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
}

function initialState(): AiWorkspaceState {
  return {
    view: "chat", mode: "quick", activeConversationId: "chat-a", activeProjectId: null, enabledSkillIds: [],
    projects: [], conversations: [{ id: "chat-a", title: "第一段", timeLabel: "刚刚", messages: [
      { id: "message-a", role: "user", content: "旧消息", time: "10:00" },
    ] }], artifacts: [], drafts: { "chat-a": "先前草稿" },
  };
}

describe("local-test-only V1 to V2 activation and rollback", () => {
  let directory: string, database: DatabaseSync, sql: AiSql;
  let workspace: AiWorkspaceRepository, shadow: AiWorkspaceV2ShadowRepository, v2: AiWorkspaceV2Store;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-v2-migration-"));
    database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    sql = adapter(database);
    workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    new AiStore(sql, TENANT).initialize();
    new AiStore(sql, TENANT).saveQuota(USER, { ...emptyQuota(), limitTokens: 1000 });
    shadow = new AiWorkspaceV2ShadowRepository(sql, workspace);
    v2 = new AiWorkspaceV2Store(sql, workspace, { allowLocalTestMigration: true }); v2.initialize();
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });

  async function prepare() {
    await workspace.save(USER, { expectedRevision: 0, mutationId: crypto.randomUUID(), state: initialState() }, TENANT);
    await shadow.stageFromV1(USER, TENANT);
    return (await v2.prepareFromShadow(USER, TENANT))!;
  }

  it("keeps activation disabled for normal stores and non-test accounts", async () => {
    const prepared = await prepare();
    const normal = new AiWorkspaceV2Store(sql, workspace);
    await expect(normal.activatePreparedForLocalTest(USER, prepared, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" });
    await expect(v2.activatePreparedForLocalTest("member-a", prepared, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" });
    expect(workspace.read(USER, TENANT).schemaVersion).toBe(1);
  });

  it("activates atomically, rejects old V1 writes, then rolls latest V2 messages back without loss", async () => {
    const prepared = await prepare();
    const oldSnapshot = workspace.read(USER, TENANT);
    const activated = await v2.activatePreparedForLocalTest(USER, prepared, TENANT);
    expect(activated).toMatchObject({ epoch: prepared.epoch, sourceRevision: prepared.sourceRevision });
    expect(v2.workspaceVersion(USER, TENANT)).toBe(2);
    expect(() => workspace.read(USER, TENANT)).toThrowError();
    await expect(workspace.save(USER, { expectedRevision: oldSnapshot.revision, mutationId: crypto.randomUUID(), state: initialState() }, TENANT))
      .rejects.toMatchObject({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" });
    await v2.appendActiveMessages(USER, { epoch: prepared.epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 1,
      messages: [{ id: "message-b", role: "assistant", content: "V2 新消息", time: "10:01" }] }, TENANT);
    const restored = await v2.rollbackActiveForLocalTest(USER, TENANT);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.revision).toBe(oldSnapshot.revision + 1);
    expect(restored.state?.conversations[0].messages.map(message => message.content)).toEqual(["旧消息", "V2 新消息"]);
    expect(workspace.read(USER, TENANT)).toEqual(restored);
    expect(v2.workspaceVersion(USER, TENANT)).toBe(1);
    await expect(workspace.save(USER, { expectedRevision: oldSnapshot.revision, mutationId: crypto.randomUUID(), state: initialState() }, TENANT))
      .rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
  });

  it("rejects stale or corrupted preparation without partial activation", async () => {
    const prepared = await prepare();
    await expect(v2.activatePreparedForLocalTest(USER, { ...prepared, sourceHash: "0".repeat(64) }, TENANT))
      .rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    const stored = tenantStorageKey(TENANT, USER);
    database.prepare("UPDATE ai_workspace_v2_entity_chunks SET data='AAAA' WHERE tenant_id=? AND user_id=? AND kind='conversation' AND entity_id='chat-a' AND chunk_index=0")
      .run(TENANT, stored);
    await expect(v2.activatePreparedForLocalTest(USER, prepared, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_CORRUPT" });
    expect(workspace.read(USER, TENANT).schemaVersion).toBe(1);
    expect(database.prepare("SELECT activated_at FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?").get(TENANT, stored))
      .toEqual({ activated_at: null });
  });

  it("restores newly created conversations, their messages and drafts in V1 order", async () => {
    const prepared = await prepare();
    await v2.activatePreparedForLocalTest(USER, prepared, TENANT);
    await v2.mutateActive(USER, { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "conversation", entityId: "chat-b", expectedRevision: 0, action: "put", value: { id: "chat-b", title: "新对话", timeLabel: "现在", messages: [] } },
    ] }, TENANT);
    await v2.appendActiveMessages(USER, { epoch: prepared.epoch, mutationId: crypto.randomUUID(), conversationId: "chat-b", expectedRevision: 1,
      messages: [{ id: "message-b", role: "user", content: "V2 新对话", time: "10:02" }] }, TENANT);
    await v2.mutateActive(USER, { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "draft", entityId: "chat-b", expectedRevision: 0, action: "put", value: "续聊草稿" },
    ] }, TENANT);
    const restored = await v2.rollbackActiveForLocalTest(USER, TENANT);
    expect(restored.state?.conversations.map(conversation => conversation.id)).toEqual(["chat-b", "chat-a"]);
    expect(restored.state?.conversations[0].messages[0].content).toBe("V2 新对话");
    expect(restored.state?.drafts["chat-b"]).toBe("续聊草稿");
    expect(workspace.read(USER, TENANT).state).toEqual(restored.state);
  });

  it("does not activate after the V1 source revision moves", async () => {
    const prepared = await prepare();
    const changed = initialState(); changed.drafts["chat-a"] = "更新了 V1";
    await workspace.save(USER, { expectedRevision: 1, mutationId: crypto.randomUUID(), state: changed }, TENANT);
    await expect(v2.activatePreparedForLocalTest(USER, prepared, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(workspace.read(USER, TENANT).state).toEqual(changed);
  });

  it("rolls back a failed V1 chunk write without deactivating V2", async () => {
    const prepared = await prepare();
    await v2.activatePreparedForLocalTest(USER, prepared, TENANT);
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_chunks")) throw new Error("fixture rollback chunk write failed");
      sql.exec(query, ...bindings);
    } };
    const failing = new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken), { allowLocalTestMigration: true });
    await expect(failing.rollbackActiveForLocalTest(USER, TENANT)).rejects.toThrow("fixture rollback chunk write failed");
    expect(v2.workspaceVersion(USER, TENANT)).toBe(2);
    expect((await v2.readActiveEntity(USER, "conversation", "chat-a", TENANT))?.value).toEqual(initialState().conversations[0]);
    expect(database.prepare("SELECT schema_version FROM ai_workspaces WHERE tenant_id=? AND user_id=?").get(TENANT, tenantStorageKey(TENANT, USER)))
      .toEqual({ schema_version: 2 });
  });

  it("keeps migration epochs monotonic across rollback and re-activation", async () => {
    const first = await prepare();
    await v2.activatePreparedForLocalTest(USER, first, TENANT);
    await v2.rollbackActiveForLocalTest(USER, TENANT);
    await shadow.stageFromV1(USER, TENANT);
    const second = (await v2.prepareFromShadow(USER, TENANT))!;
    expect(second.epoch).toBe(first.epoch + 1);
    await v2.activatePreparedForLocalTest(USER, second, TENANT);
    await expect(v2.appendActiveMessages(USER, { epoch: first.epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 1,
      messages: [{ id: "stale-after-rollback", role: "user", content: "旧客户端", time: "10:03" }] }, TENANT))
      .rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
  });

  it("keeps V1 authoritative if activation's version flip fails", async () => {
    const prepared = await prepare();
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("UPDATE ai_workspaces SET schema_version=2")) throw new Error("fixture activation version flip failed");
      sql.exec(query, ...bindings);
    } };
    const failing = new AiWorkspaceV2Store(broken, new AiWorkspaceRepository(broken), { allowLocalTestMigration: true });
    await expect(failing.activatePreparedForLocalTest(USER, prepared, TENANT)).rejects.toThrow("fixture activation version flip failed");
    expect(workspace.read(USER, TENANT).state).toEqual(initialState());
    expect(database.prepare("SELECT activated_at FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?").get(TENANT, tenantStorageKey(TENANT, USER)))
      .toEqual({ activated_at: null });
    expect(v2.workspaceVersion(USER, TENANT)).toBe(1);
  });

  it("rejects a malformed non-null activation marker before flipping V1", async () => {
    const prepared = await prepare();
    database.prepare("UPDATE ai_workspace_v2_meta SET activated_at='' WHERE tenant_id=? AND user_id=?")
      .run(TENANT, tenantStorageKey(TENANT, USER));
    await expect(v2.activatePreparedForLocalTest(USER, prepared, TENANT)).rejects.toMatchObject({ code: "AI_WORKSPACE_CONFLICT" });
    expect(workspace.read(USER, TENANT).state).toEqual(initialState());
    expect(v2.workspaceVersion(USER, TENANT)).toBe(1);
  });

  it("rejects video settings without their manifest flag so rollback remains possible", async () => {
    const prepared = await prepare(); // This V1 fixture has no videoDraftSettings field.
    await v2.activatePreparedForLocalTest(USER, prepared, TENANT);
    await expect(v2.mutateActive(USER, { epoch: prepared.epoch, mutationId: crypto.randomUUID(), ops: [
      { kind: "videoDraftSettings", entityId: "chat-a", expectedRevision: 0, action: "put",
        value: { model: "sd-2.5-c1", seconds: 10, resolution: "720p", aspectRatio: "16:9" } },
    ] }, TENANT)).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    expect(await v2.readActiveEntity(USER, "videoDraftSettings", "chat-a", TENANT)).toBeNull();
    expect((await v2.rollbackActiveForLocalTest(USER, TENANT)).state).toEqual(initialState());
  });
});
