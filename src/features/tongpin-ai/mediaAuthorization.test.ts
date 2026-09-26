import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../../types";
import type { AiVideoJob } from "../../../shared/aiVideo";
import { AiVideoReply, cachedPlayback } from "./AiVideoReply";
import { ImageArtifact } from "./ImageArtifact";
import { MediaTaskReply } from "./MediaTaskReply";
import { mediaCacheScope, transferMediaCacheScope, videoBlobCache } from "./mediaCache";
import { mediaTaskSnapshotCache } from "./mediaTaskSnapshotCache";
import type { MediaTaskRun } from "./mediaTaskClient";

const auth = vi.hoisted(() => ({ session: null as Session | null, api: vi.fn() }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ session: auth.session, api: auth.api }) }));

// Production session shape: the auth routes return no tenant metadata.
const login = (token = "test") => ({ accessToken: token, refreshToken: `${token}-refresh`, user: { id: "member" } }) as unknown as Session;
const videoJob: AiVideoJob = {
  id: "job-123456789012", prompt: "test", model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9",
  status: "completed", progress: 100, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 1000, reserved: false,
};
const pngBlob = () => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0])], { type: "image/png" });
const videoTask: MediaTaskRun = {
  requestId: "request-1", runId: "run-1", conversationId: "conversation-1", userId: "member",
  version: 1, status: "completed", createdAt: 100, updatedAt: 200, deadlineAt: 500,
  tool: { capability: "video", estimatedPoints: 100, serviceRequestId: videoJob.id },
};
const videoExpected = { requestId: "request-1", runId: "run-1", conversationId: "conversation-1", accountId: "member", intent: "video" as const };

describe("generated media remount (stale-while-revalidate)", () => {
  afterEach(() => { auth.session = null; auth.api.mockReset(); videoBlobCache.clear(); mediaTaskSnapshotCache.clear(); });

  it("paints a warm video and its download control on the first render, before any network", () => {
    auth.session = login();
    const scope = mediaCacheScope(auth.session);
    videoBlobCache.putJob(scope, videoJob.id, videoJob);
    videoBlobCache.put(scope, videoJob.id, new Blob(["private-video"], { type: "video/mp4" }));
    const html = renderToStaticMarkup(createElement(AiVideoReply, { jobId: videoJob.id }));
    expect(html).toContain("视频已生成");
    expect(html).toMatch(/<video[^>]+src="blob:/);
    expect(html).toContain("下载视频");
    expect(html).not.toContain("正在读取视频");
    expect(auth.api).not.toHaveBeenCalled();
  });

  it("paints a warm image on the first render without the loading placeholder", () => {
    auth.session = login();
    videoBlobCache.put(mediaCacheScope(auth.session), "image:asset-12345678", pngBlob());
    const html = renderToStaticMarkup(createElement(ImageArtifact, { assetId: "asset-12345678" }));
    expect(html).toMatch(/<img[^>]+src="blob:/);
    expect(html).toContain("下载图片");
    expect(html).not.toContain("正在读取图片");
    expect(auth.api).not.toHaveBeenCalled();
  });

  it("paints a verified terminal task, its video and player at once on remount", () => {
    auth.session = login();
    const scope = mediaCacheScope(auth.session);
    mediaTaskSnapshotCache.put(scope, videoExpected, videoTask);
    videoBlobCache.putJob(scope, videoJob.id, videoJob);
    videoBlobCache.put(scope, videoJob.id, new Blob(["private-video"], { type: "video/mp4" }));
    const html = renderToStaticMarkup(createElement(MediaTaskReply, {
      requestId: videoTask.requestId, runId: videoTask.runId, conversationId: videoTask.conversationId, intent: "video",
    }));
    expect(html).not.toContain("正在查询原任务");
    expect(html).toContain("视频已生成");
    expect(html).toMatch(/<video[^>]+src="blob:/);
  });

  it("keeps the warm media after an access-token refresh of the same login", () => {
    const first = login("first");
    auth.session = first;
    videoBlobCache.put(mediaCacheScope(first), "image:asset-12345678", pngBlob());
    const refreshed = login("rotated");
    expect(transferMediaCacheScope(first, refreshed)).toBe(true);
    auth.session = refreshed;
    expect(renderToStaticMarkup(createElement(ImageArtifact, { assetId: "asset-12345678" }))).toMatch(/<img[^>]+src="blob:/);
  });

  it("never paints another login's bytes, even for the same user and asset IDs", () => {
    const first = login("first");
    videoBlobCache.put(mediaCacheScope(first), "image:asset-12345678", pngBlob());
    videoBlobCache.putJob(mediaCacheScope(first), videoJob.id, videoJob);
    videoBlobCache.put(mediaCacheScope(first), videoJob.id, new Blob(["private-video"], { type: "video/mp4" }));
    auth.session = login("second-login");
    const image = renderToStaticMarkup(createElement(ImageArtifact, { assetId: "asset-12345678" }));
    expect(image).toContain("正在读取图片");
    expect(image).not.toContain("<img");
    const video = renderToStaticMarkup(createElement(AiVideoReply, { jobId: videoJob.id }));
    expect(video).toContain("正在读取视频任务");
    expect(video).not.toContain("<video");
  });

  it("does not paint a player for an unfinished job even when a warm status exists", () => {
    const session = login();
    const scope = mediaCacheScope(session);
    videoBlobCache.putJob(scope, videoJob.id, { ...videoJob, status: "processing", progress: 40 });
    expect(cachedPlayback(scope, videoJob.id)).toMatchObject({ url: "", job: { status: "processing" } });
    expect(cachedPlayback("", videoJob.id)).toMatchObject({ job: null, url: "" });
  });
});
