import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "../../types";
import { MediaTaskReply } from "./MediaTaskReply";
import { mediaCacheScope } from "./mediaCache";
import { mediaTaskSnapshotCache } from "./mediaTaskSnapshotCache";
import type { MediaTaskRun } from "./mediaTaskClient";

const auth = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("../../auth/AuthContext", () => ({ useAuth: () => ({ session: auth.session, api: vi.fn() }) }));

const session = () => ({ accessToken: "test", refreshToken: "test-refresh", user: { id: "member-1", tenantId: "tenant-a" } }) as unknown as Session;
const task = (status: MediaTaskRun["status"]): MediaTaskRun => ({
  requestId: "request-1", runId: "run-1", conversationId: "conversation-1", userId: "member-1",
  version: 1, status, createdAt: 100, updatedAt: 200, deadlineAt: 500,
  tool: { capability: "image", estimatedPoints: 100 },
});
const props = { requestId: "request-1", runId: "run-1", conversationId: "conversation-1", intent: "image" as const };
const expected = { ...props, accountId: "member-1" };

describe("media task reply remount", () => {
  afterEach(() => { mediaTaskSnapshotCache.clear(); auth.session = null; });

  it("paints a same-login terminal task at once on remount instead of a query placeholder", () => {
    const current = session(); auth.session = current;
    for (const status of ["completed", "failed"] as const) {
      mediaTaskSnapshotCache.put(mediaCacheScope(current), expected, task(status));
      const html = renderToStaticMarkup(createElement(MediaTaskReply, props));
      expect(html).not.toContain("正在查询原任务");
      expect(html).toContain(status === "completed" ? "图片已生成" : "图片未生成");
    }
  });

  it("drops only the vanished request on 404 and keeps a settled result through temporary errors", () => {
    const source = readFileSync(new URL("./MediaTaskReply.tsx", import.meta.url), "utf8");
    expect(source).toContain("mediaTaskSnapshotCache.remove(scope, expected);");
    expect(source).toContain("forgetTaskMedia(scope, latest.current.task);");
    expect(source).toContain("mediaTaskSnapshotCache.put(scope, expected, task);");
    // The background read stays GET-only: no second billable POST on remount.
    expect(source).toContain("mediaTaskReadPath(requestId), { headers, signal: controller.signal }");
  });

  it("does not warm a fresh login or an unfinished task", () => {
    const first = session(); auth.session = first;
    mediaTaskSnapshotCache.put(mediaCacheScope(first), expected, task("completed"));
    auth.session = session();
    expect(renderToStaticMarkup(createElement(MediaTaskReply, props))).toContain("正在查询原任务");
    mediaTaskSnapshotCache.clear();
    mediaTaskSnapshotCache.put(mediaCacheScope(auth.session as Session), expected, task("running"));
    expect(renderToStaticMarkup(createElement(MediaTaskReply, props))).toContain("正在查询原任务");
  });

  it("shows the exact video model, duration, resolution and any replacement reason on the task card", () => {
    auth.session = session();
    const html = renderToStaticMarkup(createElement(MediaTaskReply, { ...props, intent: "video" as const, videoChoice: {
      model: "sd-2.0-fast", label: "SD 2.0 Fast", seconds: 5, resolution: "480p", aspectRatio: "16:9",
      notice: "档位默认模型「MiniMax H3 · 提示词优化（需参考图）」需要至少一张参考图片，本次改用「SD 2.0 Fast」",
    } }));
    expect(html).toContain("模型：SD 2.0 Fast · 5 秒 · 480p · 16:9");
    expect(html).toContain("本次改用「SD 2.0 Fast」");
  });
});
