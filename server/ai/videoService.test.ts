import { mkdtemp, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import { AiVideoService } from "./videoService";
import { createSecretBox } from "./security";
import type { AiTransport } from "./provider";

describe("durable H3 jobs and isolated quotas", () => {
  let dir: string, runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  const task = (status = "queued", progress = 0) => Response.json({ id: "task_fixture_12345678", status, progress });
  const input = () => ({ requestId: crypto.randomUUID(), prompt: "一只猫", seconds: 15, resolution: "768p", aspectRatio: "16:9" });
  const config = { enabled: true, quotaPoints: 1000, apiKey: "sk-video-test-fixture-secret" };
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "tongpin-video-test-")); transport.mockReset(); transport.mockResolvedValue(task());
    runtime = await createNodeAi(path.join(dir, "test.json"), transport);
    await runtime.service.video.configure(config);
    runtime.service.setQuota("a", "admin", { limitTokens: 10000 }); runtime.service.setQuota("b", "admin", { limitTokens: 10000 });
  });
  afterEach(async () => { vi.useRealTimers(); runtime.close(); await rm(dir, { recursive: true }); });
  it("defaults disabled, supports deployment secret and never serializes the key", async () => {
    expect(JSON.stringify(runtime.service.video.settings())).not.toContain(config.apiKey);
    expect((await readFile(path.join(dir, "test.json.ai.sqlite"))).includes(Buffer.from(config.apiKey))).toBe(false);
    runtime.store.sql.exec("DELETE FROM ai_settings WHERE id='video'");
    const video = new AiVideoService(runtime.store, () => createSecretBox("fixture-with-at-least-thirty-two-characters"), transport, () => "deployment-secret");
    expect(video.settings()).toEqual({ enabled: false, quotaPoints: 0, apiKeyConfigured: true });
    await expect(video.submit("a", input())).rejects.toMatchObject({ code: "AI_VIDEO_DISABLED" }); expect(transport).not.toHaveBeenCalled();
  });
  it("requires a positive administrator conversion and valid credentials", async () => {
    await expect(runtime.service.video.configure({ enabled: true, quotaPoints: 0 })).rejects.toMatchObject({ code: "AI_VIDEO_SETTINGS_INVALID" });
    await expect(runtime.service.video.configure({ ...config, apiKey: "bad\nkey" })).rejects.toMatchObject({ code: "AI_KEY_INVALID" });
  });
  it("keeps reference images encrypted, account-bound and expiring; retries do not generate twice", async () => {
    const video = runtime.service.video;
    const dataUrl = "data:image/jpeg;base64,/9j/" + "AAAA".repeat(20000);
    const reference = await video.uploadReference("a", { dataUrl });
    expect(reference.id).toMatch(/^[a-f0-9]{64}$/);
    const stored = runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_video_references WHERE id=?", reference.id)[0].data;
    expect(stored).not.toContain(dataUrl.slice(0, 100));
    const image = await video.referenceContent(reference.id);
    expect(image.status).toBe(200); expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(Uint8Array.from(atob(dataUrl.split(",")[1]), c => c.charCodeAt(0)));
    const req = { ...input(), referenceIds: [reference.id] };
    await expect(video.submit("b", req)).rejects.toMatchObject({ code: "AI_VIDEO_IMAGE_INVALID" });
    await video.submit("a", req); await video.submit("a", req);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0][1].body!).images).toEqual([`https://notify.samhubs.com/api/video-reference/${reference.id}`]);
    await expect(video.submit("a", { ...req, referenceIds: [] })).rejects.toMatchObject({ code: "AI_VIDEO_REQUEST_CONFLICT" });
    expect(JSON.stringify(video.list("a"))).not.toContain(reference.id);
    runtime.store.sql.exec("UPDATE ai_video_references SET expires_at=0 WHERE id=?", reference.id);
    expect((await video.referenceContent(reference.id)).status).toBe(404);
    await expect(video.submit("a", { ...input(), referenceIds: [reference.id] })).rejects.toMatchObject({ code: "AI_VIDEO_IMAGE_INVALID" });
    await expect(video.uploadReference("zero", { dataUrl })).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
  });
  it("reserves once across concurrent duplicate submissions, with private key snapshots", async () => {
    const req = input(); const result = await Promise.all([runtime.service.video.submit("a", req), runtime.service.video.submit("a", req)]);
    expect(transport).toHaveBeenCalledTimes(1); expect(result.every(j => j.id === req.requestId)).toBe(true);
    expect(runtime.service.quota("a")).toMatchObject({ reservedTokens: 1000, usedTokens: 0, remainingTokens: 9000 });
    expect(JSON.stringify(runtime.service.video.list("a"))).not.toMatch(/encryptedKey|sk-video|providerId/);
    await expect(runtime.service.video.submit("a", { ...req, prompt: "other" })).rejects.toMatchObject({ code: "AI_VIDEO_REQUEST_CONFLICT" });
  });
  it("isolates users, blocks zero quotas, limits simultaneous jobs", async () => {
    const req = input(); await runtime.service.video.submit("a", req);
    expect(runtime.service.video.list("b").jobs).toEqual([]);
    await expect(runtime.service.video.refresh("b", req.requestId)).rejects.toMatchObject({ status: 404 });
    await expect(runtime.service.video.content("b", req.requestId)).rejects.toMatchObject({ status: 404 });
    await expect(runtime.service.video.submit("zero", input())).rejects.toMatchObject({ code: "AI_ACCESS_NOT_GRANTED" });
    await expect(runtime.service.video.submit("a", input())).rejects.toMatchObject({ code: "AI_VIDEO_BUSY" });
    await runtime.service.video.submit("b", input());
    runtime.service.setQuota("c", "admin", { limitTokens: 10000 });
    await expect(runtime.service.video.submit("c", input())).rejects.toMatchObject({ code: "AI_VIDEO_BUSY" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it("rejects racing mismatched duplicate input without another paid submission", async () => {
    const req = input();
    const results = await Promise.allSettled([runtime.service.video.submit("a", req), runtime.service.video.submit("a", { ...req, prompt: "不同内容" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { code: "AI_VIDEO_REQUEST_CONFLICT" } });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("a").reservedTokens).toBe(1000);
  });
  it("makes stale jobs visible to admin without resubmitting or releasing money", async () => {
    const req = input(); await runtime.service.video.submit("a", req);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000);
    expect(runtime.service.video.adminPending()).toEqual([expect.objectContaining({ id: req.requestId, status: "uncertain", reserved: true, userId: "a" })]);
    expect(runtime.service.quota("a").reservedTokens).toBe(1000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("settles completion only once and retains original credential after rotation", async () => {
    const req = input(); await runtime.service.video.submit("a", req);
    await runtime.service.video.configure({ ...config, apiKey: "new-video-key", quotaPoints: 9000 });
    transport.mockResolvedValue(task("completed", 100));
    await runtime.service.video.refresh("a", req.requestId); await runtime.service.video.refresh("a", req.requestId);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${config.apiKey}`);
    expect(runtime.service.quota("a")).toMatchObject({ reservedTokens: 0, usedTokens: 1000, remainingTokens: 9000 });
    expect(runtime.store.usage("a").filter(e => e.kind === "video")).toHaveLength(1);
  });
  it("refunds explicit rejected 403 but preserves uncertain submission and never retries", async () => {
    transport.mockResolvedValue(new Response("denied", { status: 403 }));
    const req = input(); expect(await runtime.service.video.submit("a", req)).toMatchObject({ status: "failed", reserved: false });
    expect(runtime.service.quota("a").remainingTokens).toBe(10000);
    transport.mockRejectedValue(new Error("private details and unknown submission"));
    const uncertain = input(); expect(await runtime.service.video.submit("a", uncertain)).toMatchObject({ status: "uncertain", reserved: true });
    await runtime.service.video.submit("a", uncertain); expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(runtime.service.video.list("a"))).not.toContain("private details");
    expect(runtime.service.video.reconcile("a", uncertain.requestId, "admin", { action: "release" }).reserved).toBe(false);
    await expect(runtime.service.video.submit("a", uncertain)).resolves.toMatchObject({ status: "failed" });
    expect(runtime.service.quota("a").remainingTokens).toBe(10000);
    expect(() => runtime.service.video.reconcile("a", uncertain.requestId, "admin", { action: "charge" })).toThrow();
  });
  it("keeps pending jobs on restart without chat recovery stealing their reservation", async () => {
    const req = input(); await runtime.service.video.submit("a", req); runtime.close();
    runtime = await createNodeAi(path.join(dir, "test.json"), transport);
    expect(runtime.service.video.list("a").jobs[0]).toMatchObject({ id: req.requestId, status: "queued" });
    expect(runtime.service.quota("a").reservedTokens).toBe(1000);
    transport.mockResolvedValue(task("completed", 100)); await runtime.service.video.refresh("a", req.requestId);
    expect(runtime.service.quota("a").usedTokens).toBe(1000);
  });
  it("validates content type, downloads only canonical provider path and bounds size", async () => {
    const req = input(); transport.mockResolvedValue(task("completed", 100)); await runtime.service.video.submit("a", req);
    transport.mockResolvedValue(new Response("invalid", { headers: { "Content-Type": "text/html" } }));
    await expect(runtime.service.video.content("a", req.requestId)).rejects.toMatchObject({ code: "AI_VIDEO_CONTENT_INVALID" });
    transport.mockResolvedValue(new Response(new Uint8Array([0,0,0,24]), { headers: { "Content-Type": "video/mp4" } }));
    const response = await runtime.service.video.content("a", req.requestId);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(transport.mock.lastCall?.[0]).toBe("https://www.75api.com/v1/videos/task_fixture_12345678/content");
    expect(transport.mock.lastCall?.[1].maxResponseBytes).toBe(64 * 1024 * 1024);
    expect((await response.arrayBuffer()).byteLength).toBe(4);
  });
  it("GET model test does not submit or reserve quota", async () => {
    transport.mockResolvedValue(Response.json({ data: [{ id: "minimax_h3" }] }));
    expect(await runtime.service.video.test()).toMatchObject({ ok: true });
    expect(transport.mock.calls[0][0]).toBe("https://www.75api.com/v1/models"); expect(transport.mock.calls[0][1].method).toBe("GET");
    expect(runtime.service.quota("a").remainingTokens).toBe(10000);
  });
});
