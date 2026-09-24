import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const value = action(); database.exec("COMMIT"); return value; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}
function state(label: string): AiWorkspaceState {
  return {
    view: "chat", mode: "standard", activeConversationId: "chat-a", activeProjectId: "project-a", enabledSkillIds: ["writing"],
    projects: [{ id: "project-a", title: `项目 ${label}`, timeLabel: "刚刚", contextDocuments: [{ id: "project-doc", name: "brief.txt", mimeType: "text/plain", content: "项目资料" }] }],
    conversations: [{ id: "chat-a", projectId: "project-a", title: `对话 ${label}`, timeLabel: "刚刚", messages: [
      { id: "message-a", role: "user", content: `你好 ${label}😀`, time: "10:00", attachments: [{ id: "media-a", name: "图片.png", mimeType: "image/png", content: "", media: { kind: "image", frames: [{ dataUrl: `data:image/png;base64,${PNG}` }] } }] },
      { id: "message-b", role: "assistant", content: "已完成", time: "10:01", artifactId: "artifact-a" },
    ] }],
    artifacts: [{ id: "artifact-a", conversationId: "chat-a", projectId: "project-a", title: "交付稿", kind: "presentation", updatedLabel: "刚刚", summary: "概要", sections: [], data: { slides: [{ title: "封面", text: label }] } }],
    drafts: { "chat-a": `草稿 ${label}`, "new-conversation": "新对话" },
    draftAttachments: { "chat-a": [{ id: "draft-a", name: "草稿.txt", mimeType: "text/plain", content: "待发资料" }] },
    videoDraftSettings: { "chat-a": { model: "sd-2.5-c1", seconds: 30, resolution: "720p", aspectRatio: "16:9" } },
  };
}

describe("workspace V2 inert shadow migration", () => {
  let directory: string, database: DatabaseSync, sql: AiSql, workspace: AiWorkspaceRepository, shadow: AiWorkspaceV2ShadowRepository;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-workspace-v2-shadow-"));
    database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    sql = adapter(database);
    workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    shadow = new AiWorkspaceV2ShadowRepository(sql, workspace);
    for (const tenant of ["default", "tenant-b"]) {
      const store = new AiStore(sql, tenant); store.initialize();
      store.saveQuota("member-a", { ...emptyQuota(), limitTokens: 10000 });
    }
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });

  it("round-trips all entity kinds without activating V2 or modifying the V1 snapshot", async () => {
    const original = state("甲");
    original.projects.unshift({ id: "z-project", title: "排在前面的项目", timeLabel: "昨天" });
    original.conversations.unshift({ id: "z-chat", projectId: "z-project", title: "排在前面的对话", timeLabel: "昨天", messages: [] });
    original.artifacts.unshift({ id: "z-artifact", conversationId: "z-chat", projectId: "z-project", title: "排在前面的成果", kind: "note", updatedLabel: "昨天", summary: "顺序验收", sections: [] });
    const saved = await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_shadow_meta").get()).toEqual({ count: 0 });
    const staged = await shadow.stageFromV1("member-a");
    expect(staged).toMatchObject({ sourceRevision: 1, stale: false, state: original });
    expect(staged?.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(workspace.read("member-a")).toEqual(saved);
    expect(database.prepare("SELECT schema_version FROM ai_workspaces WHERE user_id='member-a'").get()).toEqual({ schema_version: 1 });
    expect(database.prepare("SELECT DISTINCT kind FROM ai_workspace_v2_shadow_segments").all()).toEqual(expect.arrayContaining([
      { kind: "manifest" }, { kind: "project" }, { kind: "conversation" }, { kind: "artifact" }, { kind: "draft" }, { kind: "draftAttachment" }, { kind: "videoDraftSettings" },
    ]));
    const sizes = database.prepare("SELECT length(CAST(data AS BLOB)) AS size FROM ai_workspace_v2_shadow_segments").all() as Array<{ size: number }>;
    expect(Math.max(...sizes.map(row => row.size))).toBeLessThan(256000);
    database.close(); database = new DatabaseSync(path.join(directory, "workspace.sqlite"));
    sql = adapter(database); workspace = new AiWorkspaceRepository(sql); workspace.initialize();
    shadow = new AiWorkspaceV2ShadowRepository(sql, workspace);
    expect(await shadow.read("member-a")).toMatchObject({ sourceRevision: 1, stale: false, state: original });
  });

  it("marks the shadow stale when V1 changes and keeps equal user IDs isolated by tenant", async () => {
    const first = state("甲"), second = state("乙");
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: first });
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: second }, "tenant-b");
    await shadow.stageFromV1("member-a");
    await shadow.stageFromV1("member-a", "tenant-b");
    expect((await shadow.read("member-a"))?.state).toEqual(first);
    expect((await shadow.read("member-a", "tenant-b"))?.state).toEqual(second);
    first.drafts["chat-a"] = "更新后草稿";
    await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: first });
    expect(await shadow.read("member-a")).toMatchObject({ sourceRevision: 1, currentRevision: 2, stale: true });
    expect(await shadow.read("member-a", "tenant-b")).toMatchObject({ sourceRevision: 1, currentRevision: 1, stale: false });
    await expect(shadow.stageFromV1("ungranted")).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_workspace_v2_shadow_meta WHERE user_id=?").get("ungranted")).toEqual({ count: 0 });
  });

  it("rolls back a failed restage and detects missing chunks without touching V1", async () => {
    const original = state("原版");
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: original });
    const first = await shadow.stageFromV1("member-a");
    const updated = state("新版"); updated.conversations[0].messages[0].content += "😀".repeat(40000);
    await workspace.save("member-a", { expectedRevision: 1, mutationId: crypto.randomUUID(), state: updated });
    const broken: AiSql = { ...sql, exec(query, ...bindings) {
      if (query.startsWith("INSERT INTO ai_workspace_v2_shadow_segments")) throw new Error("fixture shadow write failed");
      sql.exec(query, ...bindings);
    } };
    await expect(new AiWorkspaceV2ShadowRepository(broken, new AiWorkspaceRepository(broken)).stageFromV1("member-a")).rejects.toThrow("fixture shadow write failed");
    expect(await shadow.read("member-a")).toMatchObject({ sourceHash: first?.sourceHash, stale: true, state: original });
    expect(workspace.read("member-a").state).toEqual(updated);
    await shadow.stageFromV1("member-a");
    expect((await shadow.read("member-a"))?.state).toEqual(updated);
    database.prepare("DELETE FROM ai_workspace_v2_shadow_segments WHERE kind='conversation' AND entity_id='chat-a' AND chunk_index=0").run();
    await expect(shadow.read("member-a")).rejects.toMatchObject({ code: "AI_WORKSPACE_CORRUPT" });
    expect(workspace.read("member-a").state).toEqual(updated);
  });
});
