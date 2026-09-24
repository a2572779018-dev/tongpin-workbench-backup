import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiVideoPlanParameters } from "../../shared/ai";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { aiVideoReferenceFingerprint } from "../../shared/aiVideoReferences";
import type { AiTransport } from "./provider";
import { createSecretBox } from "./security";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { tenantStorageKey } from "./tenant";
import { AiVideoService } from "./videoService";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";
// Bounded structural JPEG fixture. Codec conversion itself is exercised by the browser helper.
const JPEG = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 192, 0, 17, 8, 0, 1, 0, 1, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 0, 0, 255, 217]).toString("base64")}`;

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

describe("generated image to real video-reference mapping", () => {
  let database: DatabaseSync, store: AiStore, workspace: AiWorkspaceRepository, video: AiVideoService, assetId: string;
  const transport = vi.fn<AiTransport>();
  const conversationId = "source-conversation";
  const state = (id = assetId, deleted = false): AiWorkspaceState => ({
    view: "chat", mode: "quick", projects: [], drafts: {}, enabledSkillIds: [], activeProjectId: null, activeConversationId: conversationId,
    conversations: [
      { id: conversationId, title: "人物图", timeLabel: "刚刚", messages: [{ id: "image-message", role: "assistant", content: "图片已生成", time: "10:00", artifactId: "image-artifact" }] },
      { id: "other-conversation", title: "其他对话", timeLabel: "刚刚", messages: [] },
    ],
    artifacts: [{ id: "image-artifact", conversationId, title: "人物图", kind: "图片", summary: "图片", updatedLabel: "刚刚", sections: [], data: { images: [{ assetId: id, mimeType: "image/png", deleted }] } }],
  });
  const save = async (value = state(), userId = "member", tenantId = store.tenantId) => workspace.save(userId, { expectedRevision: workspace.read(userId, tenantId).revision, mutationId: crypto.randomUUID(), state: value }, tenantId);
  const source = () => video.generatedReferenceSource("member", { conversationId, assetId });
  const mapped = async () => {
    const resolved = await source();
    return video.uploadReference("member", { dataUrl: JPEG, generatedAsset: { assetId, conversationId, sourceFingerprint: resolved.sourceFingerprint } });
  };
  const submit = async (referenceId: string, targetConversationId = conversationId) => {
    const requestId = crypto.randomUUID(), planRequestId = crypto.randomUUID(), prompt = "让刚才的人物走过街道";
    const parameters: AiVideoPlanParameters = { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceCount: 1, referenceFingerprints: [await aiVideoReferenceFingerprint(JPEG)] };
    store.saveRequest({ requestId: planRequestId, userId: "member", conversationId: targetConversationId, hash: "fixture", status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60000, inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "fixture", mode: "quick", result: { requestId: planRequestId, content: "视频方案", model: "fixture", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "video", prompt, summary: "人物视频", videoParameters: parameters } } });
    return video.submit("member", { requestId, planRequestId, conversationId: targetConversationId, prompt, model: parameters.model, seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceIds: [referenceId] });
  };
  const activatePreparedV2 = async (userId = "member", tenantId = store.tenantId) => {
    const shadow = new AiWorkspaceV2ShadowRepository(store.sql, workspace);
    const v2 = new AiWorkspaceV2Store(store.sql, workspace); v2.initialize();
    await shadow.stageFromV1(userId, tenantId);
    await v2.prepareFromShadow(userId, tenantId);
    const storedUser = tenantStorageKey(tenantId, userId);
    store.sql.transaction(() => {
      store.sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=?", new Date().toISOString(), tenantId, storedUser);
      store.sql.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=?", tenantId, storedUser);
    });
    return { v2, storedUser };
  };
  beforeEach(async () => {
    database = new DatabaseSync(":memory:"); store = new AiStore(adapter(database), "reference-tenant"); store.initialize();
    workspace = new AiWorkspaceRepository(store.sql); workspace.initialize();
    for (const userId of ["member", "other-member"]) store.saveQuota(userId, { ...emptyQuota(), limitTokens: 10000 });
    const box = await createSecretBox("generated-image-reference-fixture-secret-32-bytes");
    transport.mockReset(); transport.mockResolvedValue(Response.json({ id: "task_fixture_12345678", status: "queued", progress: 0 }));
    video = new AiVideoService(store, async () => box, transport);
    await video.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-only-no-network" });
    const key = tenantStorageKey(store.tenantId, "video");
    const settings = JSON.parse(store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=?", key)[0].data);
    store.sql.exec("UPDATE ai_settings SET data=? WHERE id=?", JSON.stringify({ ...settings, verifiedModels: ["minimax_h3"], verifiedConfigVersion: settings.configVersion, verifiedKeyVersion: settings.keyVersion }), key);
    assetId = store.saveAsset("member", "image/png", PNG, Buffer.from(PNG, "base64").length).assetId;
    await save();
  });
  afterEach(() => database.close());

  it("resolves the saved same-conversation original PNG without provider calls or quota changes", async () => {
    const before = store.quota("member");
    expect(await source()).toEqual({ assetId, conversationId, mimeType: "image/png", base64: PNG, sourceFingerprint: await aiVideoReferenceFingerprint(`data:image/png;base64,${PNG}`) });
    expect(store.quota("member")).toEqual(before); expect(transport).not.toHaveBeenCalled();
  });
  it("resolves only the indexed V2 image artifact and rechecks it with the assistant message before paid video", async () => {
    const { v2 } = await activatePreparedV2();
    expect(await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId)).toMatchObject({ artifactId: "image-artifact", batch: { epoch: 1 } });
    expect(() => workspace.read("member", store.tenantId)).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_VERSION_UNSUPPORTED" }));
    expect(await source()).toMatchObject({ assetId, conversationId, mimeType: "image/png" });
    const reference = await mapped();
    await submit(reference.id);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not trust a stale or ambiguous V2 asset index after the image artifact changes", async () => {
    const { v2, storedUser } = await activatePreparedV2();
    store.sql.transaction(() => {
      store.sql.exec("DELETE FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind='artifact' AND entity_id='image-artifact'", store.tenantId, storedUser);
      store.sql.exec("UPDATE ai_workspace_v2_entities SET deleted=1,revision=revision+1,byte_length=0,sha256='',chunk_count=0 WHERE tenant_id=? AND user_id=? AND kind='artifact' AND entity_id='image-artifact'", store.tenantId, storedUser);
    });
    expect(await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId)).toMatchObject({ artifactId: "image-artifact", batch: { epoch: 1 } });
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    store.sql.exec("INSERT INTO ai_workspace_v2_image_artifacts(tenant_id,user_id,conversation_id,asset_id,artifact_id) VALUES(?,?,?,?,?)", store.tenantId, storedUser, conversationId, assetId, "other-artifact");
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    expect(transport).not.toHaveBeenCalled();
    expect(store.quota("member").reservedTokens).toBe(0);
  });
  it("rejects a V2 image artifact that no assistant message in the source conversation owns", async () => {
    const detached = state(); detached.conversations[0].messages = [];
    await save(detached);
    const { v2 } = await activatePreparedV2();
    expect((await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId))?.artifactId).toBe("image-artifact");
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects duplicated V1 image owners before preparing a V2 index without changing the current workspace", async () => {
    const duplicated = state();
    duplicated.artifacts.push({ ...duplicated.artifacts[0], id: "second-image-artifact" });
    await save(duplicated);
    const shadow = new AiWorkspaceV2ShadowRepository(store.sql, workspace);
    const v2 = new AiWorkspaceV2Store(store.sql, workspace); v2.initialize();
    await shadow.stageFromV1("member", store.tenantId);
    await expect(v2.prepareFromShadow("member", store.tenantId)).rejects.toMatchObject({ code: "AI_WORKSPACE_AMBIGUOUS_REFERENCE" });
    expect(workspace.read("member", store.tenantId).state?.artifacts).toHaveLength(2);
    expect(store.sql.all("SELECT artifact_id FROM ai_workspace_v2_image_artifacts")).toHaveLength(0);
    expect(store.sql.all("SELECT epoch FROM ai_workspace_v2_meta")).toHaveLength(0);
  });
  it("keeps legacy image kinds indexed in V2 and refuses a different conversation or removed asset", async () => {
    const legacy = state(); legacy.artifacts[0].kind = "image"; await save(legacy);
    const { v2 } = await activatePreparedV2();
    expect((await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId))?.artifactId).toBe("image-artifact");
    await expect(video.generatedReferenceSource("member", { conversationId: "other-conversation", assetId })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    const reference = await mapped();
    store.deleteAsset("member", assetId);
    await expect(submit(reference.id)).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    expect(transport).not.toHaveBeenCalled();
    expect(store.quota("member").reservedTokens).toBe(0);
  });
  it("omits deleted images from the V2 index", async () => {
    await save(state(assetId, true));
    const { v2 } = await activatePreparedV2();
    expect(await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId)).toBeNull();
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
  });
  it("does not borrow another member's V2 image bytes or another tenant's index", async () => {
    await save(state(), "other-member");
    await activatePreparedV2("other-member");
    await expect(video.generatedReferenceSource("other-member", { conversationId, assetId })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    const other = new AiStore(store.sql, "other-tenant"); other.saveQuota("member", { ...emptyQuota(), limitTokens: 10000 });
    const noImages = state(); noImages.artifacts = []; noImages.conversations[0].messages = [];
    await save(noImages, "member", other.tenantId);
    const { v2 } = await activatePreparedV2("member", other.tenantId);
    expect(await v2.readActiveImageSourceEntities("member", conversationId, assetId, other.tenantId)).toBeNull();
    expect(await source()).toMatchObject({ assetId, conversationId });
  });
  it("preserves existing V2 image ownership and removes its index when the image is removed", async () => {
    const { v2 } = await activatePreparedV2();
    const nextAssetId = store.saveAsset("member", "image/png", PNG, Buffer.from(PNG, "base64").length).assetId;
    const updated = { ...state().artifacts[0], title: "标题已更新" };
    const mutationId = crypto.randomUUID();
    const request = { epoch: 1, mutationId, ops: [{ kind: "artifact", entityId: updated.id, expectedRevision: 1, action: "put", value: updated }] };
    const ack = await v2.mutateActive("member", request, store.tenantId);
    expect(ack).toMatchObject({ entities: [{ kind: "artifact", entityId: "image-artifact", revision: 2, deleted: false }] });
    expect(await v2.mutateActive("member", request, store.tenantId)).toEqual(ack);
    expect((await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId))?.artifactId).toBe("image-artifact");
    await expect(v2.mutateActive("member", { epoch: 1, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: updated.id, expectedRevision: 2, action: "put", value: { ...updated, data: { images: [{ assetId: nextAssetId }] } } },
    ] }, store.tenantId)).rejects.toMatchObject({ code: "V2_OPERATION_NOT_READY" });
    expect(await source()).toMatchObject({ assetId, conversationId });
    await v2.mutateActive("member", { epoch: 1, mutationId: crypto.randomUUID(), ops: [
      { kind: "artifact", entityId: updated.id, expectedRevision: 2, action: "put", value: { ...updated, data: { images: [] } } },
    ] }, store.tenantId);
    expect(await v2.readActiveImageSourceEntities("member", conversationId, assetId, store.tenantId)).toBeNull();
    expect(await v2.mutateActive("member", request, store.tenantId)).toEqual(ack);
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    await expect(video.generatedReferenceSource("member", { conversationId, assetId: nextAssetId })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("also accepts legacy machine-name image artifacts", async () => {
    const legacy = state(); legacy.artifacts[0].kind = "image"; await save(legacy);
    expect(await source()).toMatchObject({ assetId, conversationId, mimeType: "image/png" });
  });
  it("maps an explicitly converted JPEG into actual provider images[] and an encrypted capability", async () => {
    const reference = await mapped();
    const stored = JSON.parse(store.sql.all<{ data: string }>("SELECT data FROM ai_video_references WHERE tenant_id=?", store.tenantId)[0].data);
    expect(stored).toMatchObject({ generatedAsset: { assetId, conversationId, sourceFingerprint: expect.any(String) }, fingerprint: await aiVideoReferenceFingerprint(JPEG) });
    expect(JSON.stringify(stored)).not.toContain(JPEG);
    await submit(reference.id);
    const body = JSON.parse(transport.mock.calls[0][1].body!);
    expect(body.images).toHaveLength(1);
    expect(body.images[0]).toMatch(/^https:\/\/notify\.samhubs\.com\/api\/video-reference\/[a-f0-9]{64}$/);
    const publicId = body.images[0].split("/").at(-1)!;
    const response = await video.referenceContent(publicId);
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(JPEG.split(",")[1]);
  });
  it("rejects a different source conversation instead of degrading to a text video", async () => {
    await expect(video.generatedReferenceSource("member", { conversationId: "other-conversation", assetId })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects another member even when they forge a matching saved artifact", async () => {
    await save(state(), "other-member");
    await expect(video.generatedReferenceSource("other-member", { conversationId, assetId })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
  });
  it("isolates same user and conversation IDs in another tenant", async () => {
    const other = new AiStore(store.sql, "other-tenant"); other.saveQuota("member", { ...emptyQuota(), limitTokens: 10000 });
    await save(state(), "member", other.tenantId);
    const otherVideo = new AiVideoService(other, async () => createSecretBox("other-tenant-fixture-secret-32-bytes"), transport);
    await otherVideo.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-other-key" });
    await expect(otherVideo.generatedReferenceSource("member", { conversationId, assetId })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
  });
  it("rejects deleted source artifacts and unsaved or detached image artifacts", async () => {
    await save(state(assetId, true));
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    const detached = state(); detached.conversations[0].messages = []; await save(detached);
    await expect(source()).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
  });
  it("rejects arbitrary URLs and malformed or missing source IDs", async () => {
    for (const invalid of [{ conversationId, assetId: "https://evil.example/image" }, { assetId }, { conversationId, assetId: "../other" }]) {
      await expect(video.generatedReferenceSource("member", invalid)).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_INVALID" });
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires explicit JPEG normalization and does not relabel PNG bytes", async () => {
    const resolved = await source();
    const generatedAsset = { assetId, conversationId, sourceFingerprint: resolved.sourceFingerprint };
    await expect(video.uploadReference("member", { dataUrl: `data:image/png;base64,${PNG}`, generatedAsset })).rejects.toMatchObject({ code: "AI_VIDEO_IMAGE_INVALID" });
    await expect(video.uploadReference("member", { dataUrl: "data:image/jpeg;base64,/9j/AAAA", generatedAsset })).rejects.toMatchObject({ code: "AI_VIDEO_IMAGE_INVALID" });
    expect(store.sql.all("SELECT id FROM ai_video_references")).toHaveLength(0);
  });
  it("rejects stale source fingerprints before storing or reserving anything", async () => {
    await expect(video.uploadReference("member", { dataUrl: JPEG, generatedAsset: { assetId, conversationId, sourceFingerprint: "0".repeat(64) } })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_CHANGED" });
    expect(store.sql.all("SELECT id FROM ai_video_references")).toHaveLength(0);
    expect(store.quota("member").reservedTokens).toBe(0);
  });
  it("revalidates source ownership at upload after a source was deleted", async () => {
    const resolved = await source(); store.deleteAsset("member", assetId);
    await expect(video.uploadReference("member", { dataUrl: JPEG, generatedAsset: { assetId, conversationId, sourceFingerprint: resolved.sourceFingerprint } })).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
  });
  it("cannot reuse a mapped reference from a different conversation", async () => {
    const reference = await mapped();
    await expect(submit(reference.id, "other-conversation")).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_CONVERSATION" });
    expect(transport).not.toHaveBeenCalled(); expect(store.quota("member").reservedTokens).toBe(0);
  });
  it("rejects deleted or changed source assets before the paid submit", async () => {
    const reference = await mapped(); store.deleteAsset("member", assetId);
    await expect(submit(reference.id)).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_NOT_FOUND" });
    expect(transport).not.toHaveBeenCalled(); expect(store.quota("member").reservedTokens).toBe(0);
  });
  it("rejects a mutated source blob even when its asset ID still exists", async () => {
    const reference = await mapped();
    const bytes = Buffer.from(PNG, "base64"); bytes[35] ^= 1;
    store.sql.exec("UPDATE ai_asset_chunks SET data=? WHERE asset_id=?", bytes.toString("base64"), tenantStorageKey(store.tenantId, assetId));
    await expect(submit(reference.id)).rejects.toMatchObject({ code: "AI_GENERATED_REFERENCE_CHANGED" });
    expect(transport).not.toHaveBeenCalled(); expect(store.quota("member").reservedTokens).toBe(0);
  });
  it("rejects missing AI entitlement and disabled video without reading image bytes", async () => {
    await expect(video.generatedReferenceSource("not-entitled", { conversationId, assetId })).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
    await video.configure({ enabled: false, quotaPoints: 100 });
    await expect(source()).rejects.toMatchObject({ code: "AI_VIDEO_DISABLED" });
    expect(transport).not.toHaveBeenCalled();
  });
});
