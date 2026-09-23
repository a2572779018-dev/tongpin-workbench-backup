import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import type { AiVideoPlanParameters } from "../../shared/ai";
import { aiVideoReferenceFingerprint } from "../../shared/aiVideoReferences";
import { createSecretBox } from "./security";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { tenantStorageKey } from "./tenant";
import type { AiTransport } from "./provider";
import { AiVideoService } from "./videoService";
import { AiWorkspaceRepository } from "./workspace";

const JPEG = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0, 0, 255, 217]).toString("base64")}`;
const CONVERSATION = "video-source-conversation";
const DOCUMENT = "original-video-document";

function sqlite(database: DatabaseSync): AiSql {
  return {
    exec(query, ...args) { if (args.length) database.prepare(query).run(...args); else database.exec(query); },
    all<T>(query: string, ...args: Array<string | number | null>): T[] { return database.prepare(query).all(...args) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

function workspaceState(conversationId = CONVERSATION, documentId = DOCUMENT, selectedFrameIndex = 1): AiWorkspaceState {
  return {
    view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, enabledSkillIds: [], activeProjectId: null, activeConversationId: conversationId,
    conversations: [{ id: conversationId, title: "视频参考", timeLabel: "刚刚", messages: [{ id: "uploaded-source-video", role: "user", content: "用这段视频做人物参考", time: "10:00", attachments: [{
      id: documentId, name: "actor.mp4", mimeType: "video/mp4", content: "已抽取两个静态画面，不包含音轨", media: {
        kind: "video", durationSeconds: 6, frames: [{ dataUrl: JPEG, timeSeconds: 1 }, { dataUrl: JPEG, timeSeconds: 4.5 }], selectedFrameIndex,
      },
    }] }] }, { id: "other-conversation", title: "其他会话", timeLabel: "刚刚", messages: [] }],
  };
}

describe("video reference originating from an uploaded video frame", () => {
  let database: DatabaseSync, store: AiStore, workspace: AiWorkspaceRepository, video: AiVideoService;
  const transport = vi.fn<AiTransport>();
  const sourceVideo = { conversationId: CONVERSATION, documentId: DOCUMENT, name: "actor.mp4", timeSeconds: 4.5 };
  const upload = (source: object = sourceVideo, userId = "member") => video.uploadReference(userId, { dataUrl: JPEG, sourceVideo: source });
  const save = async (value = workspaceState(), userId = "member", tenantId = store.tenantId) => workspace.save(userId, {
    expectedRevision: workspace.read(userId, tenantId).revision, mutationId: crypto.randomUUID(), state: value,
  }, tenantId);
  const submit = async (referenceId: string, conversationId = CONVERSATION) => {
    const requestId = crypto.randomUUID(), planRequestId = crypto.randomUUID(), prompt = "让视频中的人物走进城市";
    const videoParameters: AiVideoPlanParameters = { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceCount: 1, referenceFingerprints: [await aiVideoReferenceFingerprint(JPEG)] };
    store.saveRequest({ requestId: planRequestId, userId: "member", conversationId, hash: "fixture", status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "fixture", mode: "quick", result: { requestId: planRequestId, content: "方案", model: "fixture", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "video", prompt, summary: "视频方案", videoParameters } },
    });
    return video.submit("member", { requestId, planRequestId, conversationId, prompt, model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [referenceId] });
  };

  beforeEach(async () => {
    database = new DatabaseSync(":memory:"); store = new AiStore(sqlite(database), "source-video-tenant"); store.initialize();
    workspace = new AiWorkspaceRepository(store.sql); workspace.initialize();
    for (const userId of ["member", "other-member"]) store.saveQuota(userId, { ...emptyQuota(), limitTokens: 10_000 });
    const box = await createSecretBox("source-video-reference-fixture-secret-32-bytes");
    transport.mockReset(); transport.mockResolvedValue(Response.json({ id: "task_fixture_12345678", status: "queued", progress: 0 }));
    video = new AiVideoService(store, async () => box, transport);
    await video.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-only-no-network" });
    const key = tenantStorageKey(store.tenantId, "video");
    const settings = JSON.parse(store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=?", key)[0].data);
    store.sql.exec("UPDATE ai_settings SET data=? WHERE id=?", JSON.stringify({ ...settings, verifiedModels: ["minimax_h3"], verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion }), key);
    await save();
  });
  afterEach(() => database.close());

  it("stores only the selected frame's scoped provenance and sends its actual bytes to the provider", async () => {
    const reference = await upload();
    const stored = JSON.parse(store.sql.all<{ data: string }>("SELECT data FROM ai_video_references WHERE tenant_id=?", store.tenantId)[0].data);
    expect(stored).toMatchObject({ sourceVideo: { conversationId: CONVERSATION, documentId: DOCUMENT, name: "actor.mp4", timeSeconds: 4.5, frameFingerprint: await aiVideoReferenceFingerprint(JPEG) } });
    expect(JSON.stringify(stored)).not.toContain(JPEG);
    await submit(reference.id);
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body.images).toHaveLength(1);
    const content = await video.referenceContent(body.images[0].split("/").at(-1)!);
    expect(Buffer.from(await content.arrayBuffer()).toString("base64")).toBe(JPEG.split(",")[1]);
  });

  it("rejects fabricated source documents, conversations and times before storing or charging", async () => {
    for (const value of [
      { ...sourceVideo, documentId: "missing-document" },
      { ...sourceVideo, conversationId: "other-conversation" },
      { ...sourceVideo, timeSeconds: 1 },
      { ...sourceVideo, name: "unrelated.mp4" },
      { ...sourceVideo, timeSeconds: Number.NaN },
    ]) await expect(upload(value)).rejects.toMatchObject({ code: expect.stringMatching(/^AI_VIDEO_SOURCE_/) });
    expect(store.sql.all("SELECT id FROM ai_video_references")).toHaveLength(0);
    expect(store.quota("member").reservedTokens).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });

  it("checks ownership and tenant from persisted workspace, not caller JSON", async () => {
    await save(workspaceState(), "other-member");
    await expect(upload(sourceVideo, "other-member")).resolves.toMatchObject({ id: expect.any(String) });
    const other = new AiStore(store.sql, "other-tenant"); other.saveQuota("member", { ...emptyQuota(), limitTokens: 10_000 });
    const otherVideo = new AiVideoService(other, async () => createSecretBox("other-tenant-source-video-fixture-secret"), transport);
    await otherVideo.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-other" });
    await expect(otherVideo.uploadReference("member", { dataUrl: JPEG, sourceVideo })).rejects.toMatchObject({ code: "AI_VIDEO_SOURCE_NOT_FOUND" });
  });

  it("rechecks the source frame before paid submission and rejects changed or deleted records", async () => {
    const reference = await upload();
    await save(workspaceState(CONVERSATION, DOCUMENT, 0));
    await expect(submit(reference.id)).rejects.toMatchObject({ code: "AI_VIDEO_SOURCE_CHANGED" });
    expect(transport).not.toHaveBeenCalled(); expect(store.quota("member").reservedTokens).toBe(0);
  });

  it("cannot reuse a selected frame in another conversation", async () => {
    const reference = await upload();
    await expect(submit(reference.id, "other-conversation")).rejects.toMatchObject({ code: "AI_VIDEO_SOURCE_CONVERSATION" });
    expect(transport).not.toHaveBeenCalled(); expect(store.quota("member").reservedTokens).toBe(0);
  });
});
