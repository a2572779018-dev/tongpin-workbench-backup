import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { restoreVideoRequest, savedVideoRequest } from "./videoRetry";
import type { AiVideoJob } from "../../../shared/aiVideo";

const image = { name: "logo.jpg", dataUrl: "data:image/jpeg;base64,/9j/AAAA" };
const job: AiVideoJob = { id: "a-video-request-id", prompt: "品牌宣传", model: "sd-2-c6", seconds: 10, resolution: "720p", aspectRatio: "16:9", status: "failed", progress: 0, reserved: false, quotaPoints: 100, createdAt: "", updatedAt: "" };
const saved = { requestId: job.id, prompt: job.prompt, model: job.model, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio, referenceImages: [image] };
describe("video retry editing", () => {
  it("restores persisted pictures and parameters after reload without downloading or submitting", async () => {
    const read = vi.fn();
    expect(await restoreVideoRequest(job, JSON.parse(JSON.stringify(saved)), read)).toEqual(saved);
    expect(read).not.toHaveBeenCalled();
  });
  it("recovers legacy references in their original order", async () => {
    const ids = ["a".repeat(64), "b".repeat(64)], read = vi.fn().mockResolvedValue(image.dataUrl);
    const result = await restoreVideoRequest({ ...job, referenceIds: ids }, undefined, read);
    expect(read.mock.calls.map(args => args[0])).toEqual(ids);
    expect(result.referenceImages).toHaveLength(2);
  });
  it("never silently drops unavailable reference images", async () => {
    await expect(restoreVideoRequest(job, undefined, vi.fn())).rejects.toThrow("旧记录");
    await expect(restoreVideoRequest({ ...job, referenceIds: ["a".repeat(64)] }, undefined, vi.fn().mockRejectedValue(Error("expired")))).rejects.toThrow("expired");
  });
  it("does not trust an incomplete saved request over the original job image count", async () => {
    const read = vi.fn().mockResolvedValue(image.dataUrl);
    const result = await restoreVideoRequest({ ...job, referenceIds: ["a".repeat(64)] }, { ...saved, referenceImages: [] }, read);
    expect(read).toHaveBeenCalledOnce();
    expect(result.referenceImages).toHaveLength(1);
  });
  it.each(["uncertain", "processing", "queued", "submitting"] as const)("blocks unpaid retries while %s", async status => {
    await expect(restoreVideoRequest({ ...job, status }, saved, vi.fn())).rejects.toThrow("原任务尚未结算");
  });
  it("rejects a reserved task and unsafe stored image URLs", async () => {
    await expect(restoreVideoRequest({ ...job, reserved: true }, saved, vi.fn())).rejects.toThrow();
    expect(savedVideoRequest({ ...saved, referenceImages: [{ name: "bad", dataUrl: "https://example.com/image" }] })).toBeUndefined();
  });
  it("keeps restore GET-only and issues a new ID only from the confirmed composer submission", () => {
    const reply = readFileSync(new URL("./AiVideoReply.tsx", import.meta.url), "utf8");
    const composer = readFileSync(new URL("./AiVideoComposer.tsx", import.meta.url), "utf8");
    expect(reply).not.toContain('method: "POST"');
    expect(composer).toContain("requestId: crypto.randomUUID()");
    expect(composer).toContain("initialRequest?.referenceImages");
  });
});
