import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { failedVideoSubmission, restoreVideoRequest, savedVideoRequest } from "./videoRetry";
import type { AiVideoJob } from "../../../shared/aiVideo";

const image = { name: "logo.jpg", dataUrl: "data:image/jpeg;base64,/9j/AAAA" };
const job: AiVideoJob = { id: "a-video-request-id", prompt: "品牌宣传", model: "sd-2-c6", seconds: 10, resolution: "720p", aspectRatio: "16:9", status: "failed", progress: 0, reserved: false, quotaPoints: 100, createdAt: "", updatedAt: "" };
const saved = { requestId: job.id, prompt: job.prompt, model: job.model, seconds: job.seconds, resolution: job.resolution, aspectRatio: job.aspectRatio, referenceImages: [image] };
const plannedSaved = { ...saved, originalPrompt: "用我的 Logo 生成一段品牌短片", planSummary: "使用参考 Logo 的品牌开场短片", planRequestId: "plan-request-id-123456" };
describe("video retry editing", () => {
  it("restores persisted pictures and parameters after reload without downloading or submitting", async () => {
    const read = vi.fn();
    expect(await restoreVideoRequest(job, JSON.parse(JSON.stringify(saved)), read)).toEqual({ ...saved, originalPrompt: job.prompt });
    expect(read).not.toHaveBeenCalled();
  });
  it("restores the original request and reference images but requires a fresh AI plan", async () => {
    const read = vi.fn();
    expect(await restoreVideoRequest({ ...job, planRequestId: plannedSaved.planRequestId }, structuredClone(plannedSaved), read)).toEqual({
      ...saved,
      originalPrompt: plannedSaved.originalPrompt,
    });
    expect(read).not.toHaveBeenCalled();
  });
  it("keeps cached reference images without restoring the consumed server plan", async () => {
    const read = vi.fn();
    const result = await restoreVideoRequest({ ...job, referenceIds: ["a".repeat(64)], planRequestId: "server-plan-id-123456" }, plannedSaved, read);
    expect(result).toMatchObject({ originalPrompt: plannedSaved.originalPrompt });
    expect(result.planRequestId).toBeUndefined();
    expect(result.planSummary).toBeUndefined();
    expect(result.referenceImages).toEqual([image]);
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
    const result = await restoreVideoRequest({ ...job, planRequestId: plannedSaved.planRequestId, referenceIds: ["a".repeat(64)] }, { ...plannedSaved, referenceImages: [] }, read);
    expect(read).toHaveBeenCalledOnce();
    expect(result.referenceImages).toHaveLength(1);
    expect(result).toMatchObject({ originalPrompt: plannedSaved.originalPrompt });
    expect(result.planRequestId).toBeUndefined();
    expect(result.planSummary).toBeUndefined();
  });
  it("turns a deterministic pre-submit rejection into an editable failed card and restores every server reference", async () => {
    const ids = ["a".repeat(64), "b".repeat(64)];
    const persisted = { ...plannedSaved, referenceImages: undefined, referenceIds: ids };
    const failed = failedVideoSubmission(persisted, "参考图与已确认方案不一致");
    expect(failed).toMatchObject({ status: "failed", reserved: false, quotaPoints: 0, referenceIds: ids, planRequestId: plannedSaved.planRequestId });

    const read = vi.fn().mockResolvedValueOnce(image.dataUrl).mockResolvedValueOnce({ ...image, dataUrl: "data:image/jpeg;base64,/9j/BBBB" }.dataUrl);
    const restored = await restoreVideoRequest(failed!, persisted, read);
    expect(read.mock.calls.map(args => args[0])).toEqual(ids);
    expect(restored.referenceImages).toHaveLength(2);
    expect(restored.referenceIds).toBeUndefined();
    expect(restored.planRequestId).toBeUndefined();
    expect(restored.planSummary).toBeUndefined();
  });
  it("turns a durable chat artifact with no server submission into the same editable failed card", () => {
    const message = "未查到视频提交记录。原设置和参考图片已保留，可重新编辑并生成。";
    expect(failedVideoSubmission(plannedSaved, message)).toMatchObject({
      id: plannedSaved.requestId,
      status: "failed",
      reserved: false,
      error: message,
    });
    const reply = readFileSync(new URL("./AiVideoReply.tsx", import.meta.url), "utf8");
    expect(reply).toContain("setMissingSubmissionError");
    expect(reply).toContain(message);
    expect(reply).toContain('Date.now() - started < 10000');
    expect(reply).not.toContain('Date.now() - started < 120000');
  });
  it.each(["uncertain", "processing", "queued", "submitting"] as const)("blocks unpaid retries while %s", async status => {
    await expect(restoreVideoRequest({ ...job, status }, saved, vi.fn())).rejects.toThrow("原任务尚未结算");
  });
  it("rejects a reserved task and unsafe stored image URLs", async () => {
    await expect(restoreVideoRequest({ ...job, reserved: true }, saved, vi.fn())).rejects.toThrow();
    expect(savedVideoRequest({ ...saved, referenceImages: [{ name: "bad", dataUrl: "https://example.com/image" }] })).toBeUndefined();
  });
  it("never restores a partial or forged plan binding", () => {
    expect(savedVideoRequest({ ...saved, planSummary: "没有服务端方案编号" })).toBeUndefined();
    expect(savedVideoRequest({ ...saved, planRequestId: "short", planSummary: "伪造方案" })).toBeUndefined();
    expect(savedVideoRequest({ ...plannedSaved, originalPrompt: "\u0000" })).toBeUndefined();
    expect(savedVideoRequest({ ...plannedSaved, requestId: "short" })).toBeUndefined();
    expect(savedVideoRequest({ ...plannedSaved, prompt: "   " })).toBeUndefined();
    expect(savedVideoRequest({ ...plannedSaved, referenceImages: [{ ...image, name: "bad\nname" }] })).toBeUndefined();
  });
  it("keeps restore GET-only and issues a new ID only from the confirmed composer submission", () => {
    const reply = readFileSync(new URL("./AiVideoReply.tsx", import.meta.url), "utf8");
    const composer = readFileSync(new URL("./AiVideoComposer.tsx", import.meta.url), "utf8");
    expect(reply).not.toContain('method: "POST"');
    expect(composer).toContain("requestId: crypto.randomUUID()");
    expect(composer).toContain("initialRequest?.referenceImages");
    expect(composer).not.toContain("initialRequest.planRequestId");
    expect(composer).toContain("useState<AiToolPlan | null>(null)");
  });
});
