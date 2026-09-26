import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MEDIA_CACHE_BYTE_LIMIT, MEDIA_CACHE_ENTRY_LIMIT, MediaBlobCache, mediaCacheScope, transferMediaCacheScope } from "./mediaCache";
import type { AiVideoJob } from "../../../shared/aiVideo";
import type { Session } from "../../types";

const job = (status: AiVideoJob["status"] = "completed"): AiVideoJob => ({
  id: "job-123456789012", prompt: "test", model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9",
  status, progress: status === "completed" ? 100 : 50, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), quotaPoints: 1000, reserved: status !== "completed",
});
const login = (id: string, tenantId?: string, token = "token") => ({
  accessToken: token, refreshToken: `${token}-refresh`, user: { id, ...(tenantId === undefined ? {} : { tenantId }) },
}) as unknown as Session;
describe("private session media cache", () => {
  it("keeps warm media across an authenticated refresh of the same principal", () => {
    const before = login("member", "tenant-a", "old");
    const after = login("member", "tenant-a", "new");
    const scope = mediaCacheScope(before), cache = new MediaBlobCache();
    const blob = new Blob(["private-video"]);
    cache.put(scope, "job", blob);
    expect(transferMediaCacheScope(before, after)).toBe(true);
    expect(mediaCacheScope(after)).toBe(scope);
    expect(cache.get(mediaCacheScope(after), "job")).toBe(blob);
  });
  it("refuses scope transfer when identity or tenant is changed or ambiguous", () => {
    const original = login("member", "tenant-a");
    const sameIdOtherTenant = login("member", "tenant-b");
    const noTenant = login("member");
    const otherAccount = login("other", "tenant-a");
    const originalScope = mediaCacheScope(original);
    for (const next of [sameIdOtherTenant, noTenant, otherAccount]) {
      expect(transferMediaCacheScope(original, next)).toBe(false);
      expect(mediaCacheScope(next)).not.toBe(originalScope);
    }
  });
  it("keeps one scope across repeated refreshes of the production session shape (no tenant fields)", () => {
    // cloudflare/src/platform.ts toPublicUser() returns no tenant metadata;
    // the server resolves such principals to the default tenant.
    const cache = new MediaBlobCache(), blob = new Blob(["private-image"]);
    let current = login("legacy-member", undefined, "old");
    const scope = mediaCacheScope(current);
    cache.put(scope, "image:asset", blob);
    for (const token of ["rotated-1", "rotated-2", "rotated-3"]) {
      const next = login("legacy-member", undefined, token);
      expect(transferMediaCacheScope(current, next)).toBe(true);
      expect(mediaCacheScope(next)).toBe(scope);
      current = next;
    }
    // A profile update keeps the same login chain as well.
    const profile = { ...current, user: { ...current.user, name: "新名字" } } as Session;
    expect(transferMediaCacheScope(current, profile)).toBe(true);
    expect(cache.get(mediaCacheScope(profile), "image:asset")).toBe(blob);
    // A new login is never transferred and therefore never shares the scope.
    expect(mediaCacheScope(login("legacy-member", undefined, "new-login"))).not.toBe(scope);
  });
  it("treats a missing tenant as the server's default tenant, never as another tenant", () => {
    const legacy = login("member", undefined, "old");
    expect(transferMediaCacheScope(legacy, login("member", "default", "new"))).toBe(true);
    expect(transferMediaCacheScope(login("member", "default", "old"), login("member", undefined, "new"))).toBe(true);
    expect(transferMediaCacheScope(login("member", undefined, "old"), login("member", "tenant-b", "new"))).toBe(false);
    expect(transferMediaCacheScope(login("member", "tenant-b", "old"), login("member", undefined, "new"))).toBe(false);
    const conflicting = { accessToken: "t", refreshToken: "r", user: { id: "member", tenantId: "tenant-a", org_id: "tenant-b" } } as unknown as Session;
    expect(transferMediaCacheScope(conflicting, login("member", "tenant-a"))).toBe(false);
    expect(transferMediaCacheScope(login("member", "tenant-a"), conflicting)).toBe(false);
    const numeric = { accessToken: "t", refreshToken: "r", user: { id: "member", tenantId: 7 } } as unknown as Session;
    expect(transferMediaCacheScope(numeric, login("member"))).toBe(false);
  });
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
  it("budgets 256 MB / 400 entries in memory and never evicts media that is on screen", () => {
    expect(MEDIA_CACHE_BYTE_LIMIT).toBe(256 * 1024 * 1024);
    expect(MEDIA_CACHE_ENTRY_LIMIT).toBe(400);
    const cache = new MediaBlobCache(6, 2), blob = new Blob(["abc"]);
    cache.put("a", "shown", blob);
    const release = cache.retain("a", "shown");
    cache.put("a", "2", blob); cache.put("a", "3", blob);
    // snapshot() does not touch LRU order, so "shown" stays the oldest entry.
    expect(cache.snapshot("a", "shown")?.blob).toBe(blob);
    expect(cache.snapshot("a", "2")).toBeUndefined();
    release();
    cache.put("a", "4", blob);
    expect(cache.snapshot("a", "shown")).toBeUndefined();
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
    expect(auth).toContain("if (!preserveMediaScope || !transferMediaCacheScope(previous, next)) {");
    expect(auth).toContain("videoBlobCache.clear();");
    expect(auth).toContain("mediaTaskSnapshotCache.clear();");
    expect(auth).toContain("await setSession(normalizeSession(next));");
    expect(auth).toContain("await setSession(normalized, true);");
    expect(auth).toContain("await setSession({ ...current, user: normalizeUser(user) }, true);");
    expect(auth).toContain("await setSession({ ...saved, user: normalizeUser(result.user) });");
  });
});
