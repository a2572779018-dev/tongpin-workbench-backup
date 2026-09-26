import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AiMemoryReviewStatus } from "../../../shared/aiMemory";
import {
  createMemoryReviewWatcher, currentMemoryReviewSource, memberMemoryApi, memoryEntryLength, MEMORY_REVIEW_POLL_DELAYS_MS, memoryReviewSummary,
  memoryUsagePercent, setMemoryReviewSource, subscribeMemoryReviewSource,
} from "./memberMemoryClient";
import { MemoryUpdateIndicator } from "./MemoryUpdateIndicator";

function fakeTimers() {
  let now = 0;
  const pending: Array<{ at: number; callback: () => void; id: number }> = [];
  let nextId = 1;
  return {
    now: () => now,
    setTimeout: (callback: () => void, ms: number) => { const id = nextId++; pending.push({ at: now + ms, callback, id }); return id; },
    clearTimeout: (handle: unknown) => { const index = pending.findIndex(item => item.id === handle); if (index >= 0) pending.splice(index, 1); },
    async advance(ms: number) {
      now += ms;
      for (;;) {
        pending.sort((a, b) => a.at - b.at);
        const next = pending[0];
        if (!next || next.at > now) break;
        pending.shift();
        next.callback();
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      }
    },
  };
}
const id = (suffix: string) => `request-${suffix.padStart(12, "0")}`;

describe("reply review-status watcher", () => {
  it("batches lookups for every visible reply into one request and caches settled results", async () => {
    const timers = fakeTimers();
    const fetcher = vi.fn(async (ids: readonly string[]) => ids.map((requestId): AiMemoryReviewStatus => requestId === id("a")
      ? { requestId, status: "applied", changes: { added: 1, updated: 0, removed: 0 } } : { requestId, status: "none" }));
    const watcher = createMemoryReviewWatcher(fetcher, timers);
    const seen: AiMemoryReviewStatus[] = [];
    watcher.watch(id("a"), status => seen.push(status));
    watcher.watch(id("b"), status => seen.push(status));
    watcher.watch("not a request id", () => { throw new Error("never"); });
    await timers.advance(MEMORY_REVIEW_POLL_DELAYS_MS[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toEqual([id("a"), id("b")]);
    expect(seen.map(item => item.status)).toEqual(["applied", "none"]);
    // A settled reply is served from cache.
    const cached = vi.fn();
    watcher.watch(id("a"), cached);
    await Promise.resolve();
    expect(cached).toHaveBeenCalledWith(expect.objectContaining({ status: "applied" }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-checks a running review on a bounded backoff and stops after the schedule", async () => {
    const timers = fakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async (ids: readonly string[]) => ids.map((requestId): AiMemoryReviewStatus => (++calls < 3 ? { requestId, status: "pending" } : { requestId, status: "applied", changes: { added: 0, updated: 1, removed: 0 } })));
    const watcher = createMemoryReviewWatcher(fetcher, timers);
    const listener = vi.fn();
    watcher.watch(id("c"), listener);
    for (const delay of MEMORY_REVIEW_POLL_DELAYS_MS.slice(0, 3)) await timers.advance(delay);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ status: "applied" }));
    const never = vi.fn(async (ids: readonly string[]) => ids.map((requestId): AiMemoryReviewStatus => ({ requestId, status: "pending" })));
    const stubborn = createMemoryReviewWatcher(never, timers);
    stubborn.watch(id("d"), () => undefined);
    for (const delay of MEMORY_REVIEW_POLL_DELAYS_MS) await timers.advance(delay);
    await timers.advance(120_000);
    expect(never).toHaveBeenCalledTimes(MEMORY_REVIEW_POLL_DELAYS_MS.length);
  });

  it("stops polling once every listener unsubscribed and tolerates network errors", async () => {
    const timers = fakeTimers();
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    const watcher = createMemoryReviewWatcher(fetcher, timers);
    const stop = watcher.watch(id("e"), () => undefined);
    await timers.advance(MEMORY_REVIEW_POLL_DELAYS_MS[0]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    stop();
    await timers.advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("member memory client", () => {
  it("binds every call to the signed-in account", async () => {
    const api = vi.fn(async (..._args: unknown[]) => ({ reviews: [] }));
    const client = memberMemoryApi(api as never, "member-a");
    await client.read();
    await client.update(3, { action: "add", target: "user", content: "成员偏好先给结论" });
    await client.setLearning(false);
    await client.clear();
    await client.reviews([id("a"), id("b")]);
    expect(api.mock.calls.map(call => [call[0], (call[1] as RequestInit | undefined)?.method ?? "GET"])).toEqual([
      ["/api/ai/memory", "GET"], ["/api/ai/memory/entries", "POST"], ["/api/ai/memory/settings", "PUT"], ["/api/ai/memory", "DELETE"],
      [`/api/ai/memory/reviews?requestIds=${encodeURIComponent(`${id("a")},${id("b")}`)}`, "GET"],
    ]);
    for (const call of api.mock.calls) expect((call[1] as RequestInit).headers).toEqual({ "X-Tongpin-Account": "member-a" });
    expect(JSON.parse((api.mock.calls[1][1] as RequestInit).body as string)).toEqual({ expectedRevision: 3, operation: { action: "add", target: "user", content: "成员偏好先给结论" } });
  });

  it("summarizes only counts and computes usage", () => {
    expect(memoryReviewSummary({ requestId: id("a"), status: "applied", changes: { added: 2, updated: 1, removed: 1 } })).toBe("新增 2 条，更新 1 条，删除 1 条");
    expect(memoryReviewSummary({ requestId: id("a"), status: "unchanged" })).toBeNull();
    expect(memoryReviewSummary(undefined)).toBeNull();
    expect(memoryUsagePercent(670, 1000)).toBe(67);
    expect(memoryEntryLength("  成员\n偏好  ")).toBe(5);
  });

  it("renders no badge without a signed-in review source (e.g. server render or tests)", () => {
    setMemoryReviewSource(null);
    expect(renderToStaticMarkup(createElement(MemoryUpdateIndicator, { requestId: id("a") }))).toBe("");
  });

  it("switches the review source with the account", () => {
    const listener = vi.fn();
    const stop = subscribeMemoryReviewSource(listener);
    setMemoryReviewSource("member-a", async () => []);
    const first = currentMemoryReviewSource();
    setMemoryReviewSource("member-a", async () => []);
    expect(currentMemoryReviewSource()).toBe(first);
    setMemoryReviewSource("member-b", async () => []);
    expect(currentMemoryReviewSource()?.accountId).toBe("member-b");
    expect(currentMemoryReviewSource()?.watcher).not.toBe(first?.watcher);
    setMemoryReviewSource(null);
    expect(currentMemoryReviewSource()).toBeNull();
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
  });
});

describe("memory UI privacy invariants", () => {
  const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");
  it("the administrator view never calls member memory endpoints", () => {
    const admin = read("./AdminAiMemorySettings.tsx");
    expect(admin).toContain("/api/admin/ai/memory");
    expect(admin).not.toMatch(/["'`]\/api\/ai\/memory/);
  });
  it("the member panel offers the opt-out switch, per-entry edits and clear-all", () => {
    const panel = read("./MemberMemoryPanel.tsx");
    for (const copy of ["AI 对你的了解", "允许同频 AI 记住我", "清空全部记忆", "管理员和老板无法查看"]) expect(panel).toContain(copy);
    expect(read("./TongpinAISidebar.tsx")).toContain("<MemberMemoryNavEntry user={user} />");
    expect(read("./ChatMessageRow.tsx")).toContain("<MemoryUpdateIndicator requestId={message.requestId} />");
  });
});
