import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../types";
import { ApiRequestError } from "../../lib/api";
import { mediaCacheScope, transferMediaCacheScope } from "./mediaCache";
import { MediaTaskSnapshotCache, mediaTaskReadInvalidatesSnapshot } from "./mediaTaskSnapshotCache";
import type { MediaTaskRun } from "./mediaTaskClient";

const login = (id: string, tenantId: string) => ({ accessToken: "test", refreshToken: "test-refresh", user: { id, tenantId } }) as unknown as Session;
const task = (overrides: Partial<MediaTaskRun> = {}): MediaTaskRun => ({
  requestId: "request-1", runId: "run-1", conversationId: "conversation-1", userId: "member-1",
  version: 1, status: "completed", createdAt: 100, updatedAt: 200, deadlineAt: 500,
  tool: { capability: "image", estimatedPoints: 100, artifactIds: ["asset-one"] },
  ...overrides,
});
const expected = { requestId: "request-1", runId: "run-1", conversationId: "conversation-1", accountId: "member-1", intent: "image" as const };

describe("completed media task warm snapshot", () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("hydrates only a terminal task for the same authenticated login and request", () => {
    const session = login("member-1", "tenant-a"), scope = mediaCacheScope(session);
    const cache = new MediaTaskSnapshotCache();
    cache.put(scope, expected, task());
    expect(cache.snapshot(scope, expected)).toEqual(task());
    expect(cache.snapshot(scope, { ...expected, requestId: "request-2" })).toBeNull();
    expect(cache.snapshot(scope, { ...expected, conversationId: "conversation-2" })).toBeNull();
    expect(cache.snapshot(scope, { ...expected, accountId: "member-2" })).toBeNull();
    expect(cache.snapshot(scope, { ...expected, runId: "run-2" })).toBeNull();
    expect(cache.snapshot(scope, { ...expected, intent: "video" })).toBeNull();
  });

  it("never stores incomplete tasks or a mismatched server response", () => {
    const cache = new MediaTaskSnapshotCache(), scope = mediaCacheScope(login("member-1", "tenant-a"));
    cache.put(scope, expected, task({ status: "running" }));
    expect(cache.snapshot(scope, expected)).toBeNull();
    cache.put(scope, expected, task({ userId: "someone-else" }));
    expect(cache.snapshot(scope, expected)).toBeNull();
    cache.put(scope, expected, task({ status: "completed" }));
    cache.put(scope, expected, task({ status: "running", version: 2 }));
    expect(cache.snapshot(scope, expected)).toBeNull();
  });

  it("expires warm status and bounds memory without persisting private task details", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-23T09:00:00Z"));
    const cache = new MediaTaskSnapshotCache(10_000, 1), scope = mediaCacheScope(login("member-1", "tenant-a"));
    cache.put(scope, expected, task());
    vi.advanceTimersByTime(9_999);
    expect(cache.snapshot(scope, expected)).not.toBeNull();
    vi.advanceTimersByTime(2);
    expect(cache.snapshot(scope, expected)).toBeNull();
    cache.put(scope, expected, task());
    const second = { ...expected, requestId: "request-2" };
    cache.put(scope, second, task({ requestId: "request-2" }));
    expect(cache.snapshot(scope, expected)).toBeNull();
    expect(cache.snapshot(scope, second)).not.toBeNull();
  });

  it("continues same-login token rotation but isolates new logins, tenants and clear", () => {
    const first = login("member-1", "tenant-a"), rotated = login("member-1", "tenant-a");
    const newLogin = login("member-1", "tenant-a"), otherTenant = login("member-1", "tenant-b");
    const cache = new MediaTaskSnapshotCache(), scope = mediaCacheScope(first);
    cache.put(scope, expected, task());
    expect(transferMediaCacheScope(first, rotated)).toBe(true);
    expect(cache.snapshot(mediaCacheScope(rotated), expected)).not.toBeNull();
    expect(cache.snapshot(mediaCacheScope(newLogin), expected)).toBeNull();
    expect(cache.snapshot(mediaCacheScope(otherTenant), expected)).toBeNull();
    cache.clear();
    expect(cache.snapshot(scope, expected)).toBeNull();
  });

  it("invalidates on authorization, deletion or identity mismatch, not a temporary network failure", () => {
    for (const status of [401, 403, 404, 409]) expect(mediaTaskReadInvalidatesSnapshot(new ApiRequestError(status, "ERROR", "denied"))).toBe(true);
    expect(mediaTaskReadInvalidatesSnapshot(new Error("任务响应与当前对话或账号不匹配，请重新打开工作台"))).toBe(true);
    expect(mediaTaskReadInvalidatesSnapshot(new ApiRequestError(503, "NETWORK_UNAVAILABLE", "暂时离线"))).toBe(false);
    const cache = new MediaTaskSnapshotCache(), scope = mediaCacheScope(login("member-1", "tenant-a"));
    cache.put(scope, expected, task());
    cache.remove(scope, expected);
    expect(cache.snapshot(scope, expected)).toBeNull();
  });
});
