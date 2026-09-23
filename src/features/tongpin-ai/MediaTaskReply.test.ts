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

  it("shows a same-login completed or failed task immediately instead of the query placeholder", () => {
    const current = session(); auth.session = current;
    for (const status of ["completed", "failed"] as const) {
      mediaTaskSnapshotCache.put(mediaCacheScope(current), expected, task(status));
      const html = renderToStaticMarkup(createElement(MediaTaskReply, props));
      expect(html).toContain(status === "completed" ? "图片已生成" : "图片未生成");
      expect(html).not.toContain("正在查询原任务");
    }
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
});
