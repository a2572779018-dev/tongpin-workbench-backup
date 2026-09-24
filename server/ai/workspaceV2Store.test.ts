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
});
