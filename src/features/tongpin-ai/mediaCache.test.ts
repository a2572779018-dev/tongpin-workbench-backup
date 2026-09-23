import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MediaBlobCache, mediaCacheScope } from "./mediaCache";
import type { AiVideoJob } from "../../../shared/aiVideo";
import type { Session } from "../../types";

const job = (status: AiVideoJob["status"] = "completed"): AiVideoJob => ({
  id: "job-123456789012", prompt: "test", model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9",
  status, progress: status === "completed" ? 100 : 50, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 1000, reserved: status !== "completed",
});
describe("private session media cache", () => {
  it("separates authenticated sessions even when tenant user and job IDs match", () => {
    const first = { user: { id: "member" } } as Session;
    const second = { user: { id: "member" } } as Session;
    const scopeA = mediaCacheScope(first), scopeB = mediaCacheScope(second);
    expect(mediaCacheScope(first)).toBe(scopeA);
    expect(scopeB).not.toBe(scopeA);
    const cache = new MediaBlobCache(), blob = new Blob(["tenant-a"]);
    cache.put(scopeA, "shared-job", blob);
    expect(cache.get(scopeB, "shared-job")).toBeUndefined();
    expect(cache.get(scopeA, "shared-job")).toBe(blob);
  });
  it("isolates accounts, evicts least-recently-used blobs and clears on logout", () => {
    const cache = new MediaBlobCache(6), blob = new Blob(["abc"]);
    cache.put("a", "1", blob); cache.put("a", "2", blob);
    expect(cache.get("b", "1")).toBeUndefined(); expect(cache.get("a", "1")).toBe(blob);
    cache.put("a", "3", blob); expect(cache.get("a", "2")).toBeUndefined();
    cache.clear(); expect(cache.get("a", "1")).toBeUndefined();
  });
  it("does not cache unauthenticated or oversized content", () => {
    const cache = new MediaBlobCache(2);
    cache.put("a", "1", new Blob(["abc"])); cache.put("", "1", new Blob(["x"]));
    expect(cache.get("a", "1")).toBeUndefined(); expect(cache.get("", "1")).toBeUndefined();
  });
  it("keeps account-bound status, duration and one stable object URL for warm remounts", () => {
    const cache = new MediaBlobCache(10), blob = new Blob(["video"]), completed = job();
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    cache.putJob("a", completed.id, completed); cache.put("a", completed.id, blob); cache.putDuration("a", completed.id, 5.04); cache.putCurrentTime("a", completed.id, 2.5);
    const first = cache.objectUrl("a", completed.id), second = cache.objectUrl("a", completed.id);
    expect(first).toBeTruthy(); expect(second).toBe(first);
    expect(cache.snapshot("a", completed.id)).toMatchObject({ job: completed, blob, url: first, duration: 5.04, currentTime: 2.5 });
    expect(cache.snapshot("b", completed.id)).toBeUndefined();
    cache.clear();
    expect(revoke).toHaveBeenCalledWith(first); revoke.mockRestore();
  });
  it("deduplicates an in-flight content GET while allowing one caller to unmount", async () => {
    const cache = new MediaBlobCache(10), content = new Blob(["video"]);
    let finish!: (blob: Blob) => void;
    const loader = vi.fn((_signal: AbortSignal) => new Promise<Blob>(resolve => { finish = resolve; }));
    const firstCaller = new AbortController(), secondCaller = new AbortController();
    const first = cache.loadBlob("a", "job", loader, firstCaller.signal);
    const second = cache.loadBlob("a", "job", loader, secondCaller.signal);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    firstCaller.abort(); finish(content);
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toBe(content);
    await expect(cache.loadBlob("a", "job", loader)).resolves.toBe(content);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("deduplicates status refreshes and serves a freshly cached status without another GET", async () => {
    const cache = new MediaBlobCache(), current = job("processing");
    const loader = vi.fn(async () => current);
    const [a, b] = await Promise.all([cache.loadJob("a", current.id, loader), cache.loadJob("a", current.id, loader)]);
    expect(a).toBe(current); expect(b).toBe(current); expect(loader).toHaveBeenCalledTimes(1);
    await expect(cache.loadJob("a", current.id, loader, undefined, 2000)).resolves.toBe(current);
    expect(loader).toHaveBeenCalledTimes(1);
  });
  it("aborts and discards in-flight private media when the session cache is cleared", async () => {
    const cache = new MediaBlobCache(10);
    let finish!: (blob: Blob) => void;
    const loader = vi.fn((_signal: AbortSignal) => new Promise<Blob>(resolve => { finish = resolve; }));
    const pending = cache.loadBlob("old-account", "job", loader);
    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    cache.clear(); finish(new Blob(["private"]));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.snapshot("old-account", "job")).toBeUndefined();
  });
  it("handles a rejected media GET without a detached promise rejection", async () => {
    const cache = new MediaBlobCache();
    await expect(cache.loadBlob("member", "job", async () => { throw Error("GET 404"); }, new AbortController().signal)).rejects.toThrow("GET 404");
  });
  it("clears private playback state whenever the authenticated account changes", () => {
    const auth = readFileSync(new URL("../../auth/AuthContext.tsx", import.meta.url), "utf8");
    expect(auth).toContain("if (sessionRef.current?.user.id !== next?.user.id) videoBlobCache.clear()");
  });
});
