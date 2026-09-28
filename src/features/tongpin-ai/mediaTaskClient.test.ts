import { describe, expect, it } from "vitest";
import {
  mediaArtifactAwaitsTask,
  mediaTaskAnswerPath,
  mediaTaskAuthorizationAmount,
  mediaTaskAuthorizationNotice,
  mediaTaskAuthorizePath,
  mediaTaskCancelPath,
  mediaTaskGrantActive,
  mediaTaskImageIds,
  mediaTaskIsSettled,
  mediaTaskNeedsPolling,
  mediaTaskReadPath,
  mediaTaskStatusText,
  parseMediaTaskResponse,
  type MediaTaskRun,
} from "./mediaTaskClient";

const task = (overrides: Partial<MediaTaskRun> = {}): MediaTaskRun => ({
  requestId: "request-1", runId: "run-1", conversationId: "conversation-1", userId: "member-1",
  version: 1, status: "queued", createdAt: 100, updatedAt: 100, deadlineAt: 1000,
  ...overrides,
});

describe("media task reply client boundary", () => {
  it("queries the original request and escapes all path IDs", () => {
    expect(mediaTaskReadPath("id/with space")).toBe("/api/ai/media-tasks/by-request/id%2Fwith%20space");
    expect(mediaTaskAnswerPath("run/1")).toBe("/api/ai/media-tasks/run%2F1/answer");
    expect(mediaTaskAuthorizePath("run/1")).toBe("/api/ai/media-tasks/run%2F1/authorize");
    expect(mediaTaskCancelPath("run/1")).toBe("/api/ai/media-tasks/run%2F1");
  });

  it("accepts only the current account, request, run and capability", () => {
    const expected = { requestId: "request-1", runId: "run-1", conversationId: "conversation-1", accountId: "member-1", intent: "image" as const };
    expect(parseMediaTaskResponse({ task: task() }, expected)).toEqual(task());
    expect(() => parseMediaTaskResponse({}, expected)).toThrow("不完整");
    expect(() => parseMediaTaskResponse({ task: task({ requestId: "other" }) }, expected)).toThrow("不匹配");
    expect(() => parseMediaTaskResponse({ task: task({ runId: "other" }) }, expected)).toThrow("不匹配");
    expect(() => parseMediaTaskResponse({ task: task({ userId: "other" }) }, expected)).toThrow("不匹配");
    expect(() => parseMediaTaskResponse({ task: task({ conversationId: "other" }) }, expected)).toThrow("不匹配");
    expect(() => parseMediaTaskResponse({ task: task({ status: "invented" as MediaTaskRun["status"] }) }, expected)).toThrow("不匹配");
    expect(() => parseMediaTaskResponse({ task: task({ tool: { capability: "video", estimatedPoints: 20 } }) }, expected)).toThrow("不匹配");
  });

  it("shows only ready images, deduplicates IDs, and never declares partial as complete", () => {
    const tool: NonNullable<MediaTaskRun["tool"]> = { capability: "image", estimatedPoints: 25,
      artifactIds: ["asset_final_01"], partialArtifactIds: ["asset_part_01", "asset_part_01", "invalid/id"] };
    expect(mediaTaskImageIds(task({ status: "running", tool }))).toEqual([]);
    expect(mediaTaskImageIds(task({ status: "partial", tool }))).toEqual(["asset_part_01"]);
    expect(mediaTaskImageIds(task({ status: "completed", tool }))).toEqual(["asset_final_01"]);
    expect(mediaTaskStatusText("partial", "image")).not.toContain("已生成");
  });

  it("requires a valid explicit amount for authorization and settles only terminal statuses", () => {
    expect(mediaTaskAuthorizationAmount(task({ status: "awaiting_authorization", tool: { capability: "video", estimatedPoints: 250 } }))).toBe(250);
    expect(mediaTaskAuthorizationAmount(task({ status: "running", tool: { capability: "video", estimatedPoints: 250 } }))).toBeNull();
    expect(mediaTaskAuthorizationAmount(task({ status: "awaiting_authorization", tool: { capability: "video", estimatedPoints: NaN } }))).toBeNull();
    expect(mediaTaskAuthorizationAmount(task({ status: "awaiting_authorization", tool: { capability: "video", estimatedPoints: -1 } }))).toBeNull();
    expect(mediaTaskAuthorizationAmount(task({ status: "awaiting_authorization", authorization: { grantId: "granted" }, tool: { capability: "video", estimatedPoints: 250 } }))).toBeNull();
    expect(mediaTaskNeedsPolling("awaiting_input")).toBe(true);
    expect(mediaTaskNeedsPolling("partial")).toBe(true);
    expect(mediaTaskIsSettled("unknown")).toBe(true);
    expect(mediaTaskNeedsPolling("completed")).toBe(false);
  });

  it("offers the confirmation again for a grant the server paused, with the reason", () => {
    const tool = { capability: "image" as const, estimatedPoints: 250 };
    // Current server: the stale grant is dropped when the task pauses.
    const dropped = task({ status: "awaiting_authorization", dueAt: null, errorCode: "AI_MEDIA_GRANT_NOT_AUTHORIZED", tool });
    expect(mediaTaskGrantActive(dropped)).toBe(false);
    expect(mediaTaskAuthorizationAmount(dropped)).toBe(250);
    expect(mediaTaskAuthorizationNotice(dropped)).toBe("上次确认已失效，请重新确认生成");
    // An older server kept the stale grant but scheduled nothing.
    const kept = task({ status: "awaiting_authorization", authorization: { grantId: "stale" }, dueAt: null, errorCode: "AI_MEDIA_GRANT_BUDGET_CHANGED", tool });
    expect(mediaTaskGrantActive(kept)).toBe(false);
    expect(mediaTaskAuthorizationAmount(kept)).toBe(250);
    expect(mediaTaskAuthorizationNotice(kept)).toBe("额度有变化，请重新确认生成");
    // A grant the server is still carrying out is never offered twice.
    const active = task({ status: "awaiting_authorization", authorization: { grantId: "live" }, dueAt: 150, errorCode: "AI_MEDIA_GRANT_BUDGET_CHANGED", tool });
    expect(mediaTaskGrantActive(active)).toBe(true);
    expect(mediaTaskAuthorizationAmount(active)).toBeNull();
    expect(mediaTaskAuthorizationNotice(active)).toBeNull();
    expect(mediaTaskAuthorizationNotice(task({ status: "failed", errorCode: "AI_MEDIA_GRANT_BUDGET_CHANGED", tool }))).toBeNull();
    expect(mediaTaskAuthorizationNotice(task({ status: "awaiting_authorization", errorCode: "AI_SOMETHING_ELSE", tool }))).toBeNull();
    expect(mediaTaskAuthorizationNotice(task({ status: "awaiting_authorization", tool }))).toBeNull();
  });

  it("says why a paid step that was refused before sending waits for confirmation again", () => {
    const tool = { capability: "video" as const, estimatedPoints: 3000 };
    const released = (errorCode: string) => task({ status: "awaiting_authorization", dueAt: null, errorCode, tool });
    expect(mediaTaskAuthorizationNotice(released("AI_REQUEST_IN_PROGRESS"))).toBe("对话正忙，稍后再确认生成");
    expect(mediaTaskAuthorizationNotice(released("AI_CAPACITY_BUSY"))).toBe("生成任务较多，稍后再确认生成");
    expect(mediaTaskAuthorizationNotice(released("AI_VIDEO_BUSY"))).toBe("生成任务较多，稍后再确认生成");
    expect(mediaTaskAuthorizationNotice(released("AI_QUOTA_INSUFFICIENT"))).toBe("额度不足，补充后再确认生成");
    expect(mediaTaskAuthorizationNotice(released("AI_QUOTA_EXHAUSTED"))).toBe("额度不足，补充后再确认生成");
    expect(mediaTaskAuthorizationNotice(released("AI_ASSET_CAPACITY"))).toBe("图片空间已满，删除旧图后再确认生成");
    expect(mediaTaskAuthorizationAmount(released("AI_REQUEST_IN_PROGRESS"))).toBe(3000);
  });
});

describe("page-level reads of saved media tasks", () => {
  const image = (data: Record<string, unknown>) => ({ kind: "图片", data: { mediaTaskRequestId: "request-1", ...data } });
  const video = (data: Record<string, unknown>) => ({ kind: "视频", data: { mediaTaskRequestId: "request-2", ...data } });

  it("keeps reading a task that is still running, or completed without its results on the artifact yet", () => {
    for (const status of ["queued", "planning", "awaiting_input", "awaiting_authorization", "running", "partial", undefined]) {
      expect(mediaArtifactAwaitsTask(image({ mediaTaskStatus: status }))).toBe(true);
      expect(mediaArtifactAwaitsTask(video({ mediaTaskStatus: status }))).toBe(true);
    }
    // The read re-queries an unknown video's provider task; nothing advances an unknown image.
    expect(mediaArtifactAwaitsTask(video({ mediaTaskStatus: "unknown" }))).toBe(true);
    expect(mediaArtifactAwaitsTask(image({ mediaTaskStatus: "unknown" }))).toBe(false);
    expect(mediaArtifactAwaitsTask(image({ mediaTaskStatus: "completed" }))).toBe(true);
    expect(mediaArtifactAwaitsTask(image({ mediaTaskStatus: "completed", images: [{ assetId: "a" }] }))).toBe(false);
    expect(mediaArtifactAwaitsTask(video({ mediaTaskStatus: "completed" }))).toBe(true);
    expect(mediaArtifactAwaitsTask(video({ mediaTaskStatus: "completed", mediaTaskServiceRequestId: "svc-1" }))).toBe(false);
  });

  it("stops at a failed or cancelled task, which has no results to wait for", () => {
    // Before: a cancelled video without a service request (or a failed image
    // without images) was read again every 12 s for as long as the page stayed open.
    expect(mediaArtifactAwaitsTask(video({ mediaTaskStatus: "cancelled" }))).toBe(false);
    expect(mediaArtifactAwaitsTask(video({ mediaTaskStatus: "failed" }))).toBe(false);
    expect(mediaArtifactAwaitsTask(image({ mediaTaskStatus: "failed" }))).toBe(false);
    expect(mediaArtifactAwaitsTask(image({ mediaTaskStatus: "cancelled" }))).toBe(false);
  });

  it("decides the page's background reads", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync(new URL("../../pages/TongpinAIPage.tsx", import.meta.url), "utf8");
    expect(page).toContain("const pendingMediaRequests = artifacts.filter(mediaArtifactAwaitsTask)");
  });

  it("ignores artifacts that are not media tasks or were never submitted", () => {
    expect(mediaArtifactAwaitsTask({ kind: "图片" })).toBe(false);
    expect(mediaArtifactAwaitsTask({ kind: "视频", data: { videoJobId: "job-1" } })).toBe(false);
    expect(mediaArtifactAwaitsTask(image({ mediaTaskSubmitError: "余额不足" }))).toBe(false);
  });
});
