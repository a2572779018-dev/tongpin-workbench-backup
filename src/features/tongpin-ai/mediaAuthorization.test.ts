import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../../types";
import type { AiVideoJob } from "../../../shared/aiVideo";
import { AiVideoReply } from "./AiVideoReply";
import { ImageArtifact } from "./ImageArtifact";
import { MediaTaskReply } from "./MediaTaskReply";
import { mediaCacheScope, videoBlobCache } from "./mediaCache";
import { mediaTaskSnapshotCache } from "./mediaTaskSnapshotCache";
import type { MediaTaskRun } from "./mediaTaskClient";

const auth = vi.hoisted(() => ({ session: null as Session | null }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ session: auth.session, api: vi.fn() }) }));

const session = { accessToken: "test", refreshToken: "refresh", user: { id: "member", tenantId: "tenant-a" } } as unknown as Session;
const videoJob: AiVideoJob = {
  id: "job-123456789012", prompt: "test", model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9",
  status: "completed", progress: 100, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 1000, reserved: false,
};

describe("private media mount authorization", () => {
  afterEach(() => { auth.session = null; videoBlobCache.clear(); mediaTaskSnapshotCache.clear(); });

  it("hides a warm video and download control until current-session GETs complete", () => {
    auth.session = session;
    const scope = mediaCacheScope(session);
    videoBlobCache.putJob(scope, videoJob.id, videoJob);
    videoBlobCache.put(scope, videoJob.id, new Blob(["private-video"], { type: "video/mp4" }));
    const html = renderToStaticMarkup(createElement(AiVideoReply, { jobId: videoJob.id }));
    expect(html).toContain("正在读取视频任务");
    expect(html).not.toContain("<video");
    expect(html).not.toContain("下载视频");
  });

  it("hides a warm image until the asset is checked again", () => {
    auth.session = session;
    videoBlobCache.put(mediaCacheScope(session), "image:asset-12345678", new Blob(["private-image"], { type: "image/png" }));
    const html = renderToStaticMarkup(createElement(ImageArtifact, { assetId: "asset-12345678" }));
    expect(html).toContain("正在读取图片");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("下载图片");
  });

  it("hides a terminal media task snapshot until its original request is checked", () => {
    auth.session = session;
    const task: MediaTaskRun = {
      requestId: "request-1", runId: "run-1", conversationId: "conversation-1", userId: "member",
      version: 1, status: "completed", createdAt: 100, updatedAt: 200, deadlineAt: 500,
      tool: { capability: "video", estimatedPoints: 100, serviceRequestId: videoJob.id },
    };
    mediaTaskSnapshotCache.put(mediaCacheScope(session), {
      requestId: task.requestId, runId: task.runId, conversationId: task.conversationId, accountId: "member", intent: "video",
    }, task);
    const html = renderToStaticMarkup(createElement(MediaTaskReply, {
      requestId: task.requestId, runId: task.runId, conversationId: task.conversationId, intent: "video",
    }));
    expect(html).toContain("正在查询原任务");
    expect(html).not.toContain("视频已生成");
    expect(html).not.toContain("<video");
  });
});
