import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../../lib/api";
import { videoBlobCache } from "./mediaCache";
import { mediaAccessRevoked, privateImageCacheId, revalidateWarmImage, revalidateWarmVideo } from "./mediaRevalidation";
import { loadPrivateImage, warmPrivateImage } from "./privateImage";

const PNG = [137, 80, 78, 71, 13, 10, 26, 10, 0];
const pngBlob = () => new Blob([new Uint8Array(PNG)], { type: "image/png" });
const pngAsset = (assetId: string) => ({ assetId, mimeType: "image/png", base64: btoa(String.fromCharCode(...PNG)) });
const scope = "member:login-scope";
const assetId = "asset-12345678";
const imageKey = privateImageCacheId(assetId);
const options = (api: unknown, extra: Record<string, unknown> = {}) => ({ api: api as never, scope, accountId: "member", assetId, signal: new AbortController().signal, ...extra });
const never = () => new Promise<never>(() => undefined);

describe("stale-while-revalidate for private generated media", () => {
  afterEach(() => { videoBlobCache.clear(); });

  it("remount without network: a warm image is available synchronously while the check is still pending", async () => {
    videoBlobCache.put(scope, imageKey, pngBlob());
    const offline = vi.fn(never);
    const warm = warmPrivateImage(scope, assetId);
    expect(warm).toMatchObject({ mimeType: "image/png" });
    expect(warm?.url).toMatch(/^blob:/);
    // Same Blob URL on every remount: the <img> never flashes a placeholder.
    expect(warmPrivateImage(scope, assetId)?.url).toBe(warm?.url);
    const controller = new AbortController();
    const pending = revalidateWarmImage(options(offline, { signal: controller.signal }));
    expect(offline).toHaveBeenCalledTimes(1);
    expect(warmPrivateImage(scope, assetId)?.url).toBe(warm?.url);
    controller.abort();
    await expect(Promise.race([pending, Promise.resolve("still-pending")])).resolves.toBe("still-pending");
    // Another login, a wrong MIME type or a malformed ID never reads the warm bytes.
    expect(warmPrivateImage("member:other-login", assetId)).toBeNull();
    expect(warmPrivateImage(scope, assetId, "image/jpeg")).toBeNull();
    expect(warmPrivateImage(scope, "../x")).toBeNull();
  });

  it("asks the server in the background on every mount and keeps the image when it confirms", async () => {
    videoBlobCache.put(scope, imageKey, pngBlob());
    const api = vi.fn(async () => ({ assetId, mimeType: "image/png", byteLength: PNG.length }));
    await expect(revalidateWarmImage(options(api))).resolves.toEqual({ outcome: "verified" });
    await expect(revalidateWarmImage(options(api))).resolves.toEqual({ outcome: "verified" });
    expect(api).toHaveBeenCalledTimes(2);
    expect(api).toHaveBeenCalledWith(`/api/ai/assets/${assetId}/check`, expect.objectContaining({ headers: { "X-Tongpin-Account": "member" } }), 30_000);
    expect(videoBlobCache.get(scope, imageKey)).toBeDefined();
  });

  it.each([401, 403, 404, 409])("background revalidation removes a warm image when the server answers %i", async status => {
    videoBlobCache.put(scope, imageKey, pngBlob());
    const url = warmPrivateImage(scope, assetId)?.url;
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const api = vi.fn(async () => { throw new ApiRequestError(status, "DENIED", "无权查看"); });
    const result = await revalidateWarmImage(options(api));
    expect(result.outcome).toBe("dropped");
    expect(videoBlobCache.get(scope, imageKey)).toBeUndefined();
    expect(warmPrivateImage(scope, assetId)).toBeNull();
    expect(revoke).toHaveBeenCalledWith(url);
    revoke.mockRestore();
  });

  it("background revalidation removes a warm image whose server metadata no longer matches the bytes", async () => {
    for (const changed of [{ byteLength: 999 }, { mimeType: "image/jpeg" }, { assetId: "asset-other-0001" }]) {
      videoBlobCache.put(scope, imageKey, pngBlob());
      const api = vi.fn(async () => ({ assetId, mimeType: "image/png", byteLength: PNG.length, ...changed }));
      await expect(revalidateWarmImage(options(api))).resolves.toEqual({ outcome: "dropped", message: "图片授权或内容已变化，请重新加载" });
      expect(videoBlobCache.get(scope, imageKey)).toBeUndefined();
    }
  });

  it("keeps the warm copy on timeouts, 5xx and offline errors", async () => {
    videoBlobCache.put(scope, imageKey, pngBlob());
    for (const failure of [new ApiRequestError(503, "NETWORK_UNAVAILABLE", "离线"), new ApiRequestError(502, "BAD_GATEWAY", "x"), new TypeError("fetch failed")]) {
      const api = vi.fn(async () => { throw failure; });
      await expect(revalidateWarmImage(options(api))).resolves.toEqual({ outcome: "stale" });
      expect(videoBlobCache.get(scope, imageKey)).toBeDefined();
    }
    expect(mediaAccessRevoked(new ApiRequestError(503, "X", "x"))).toBe(false);
    expect(mediaAccessRevoked(new ApiRequestError(404, "X", "x"))).toBe(true);
    expect(mediaAccessRevoked(new Error("404"))).toBe(false);
  });

  it("reports a missing warm copy without any request so the caller performs the full GET", async () => {
    const api = vi.fn();
    await expect(revalidateWarmImage(options(api))).resolves.toEqual({ outcome: "missing" });
    await expect(revalidateWarmVideo({ ...options(api), jobId: "job-123456789012" })).resolves.toEqual({ outcome: "missing" });
    await expect(revalidateWarmImage(options(api, { scope: "" }))).resolves.toEqual({ outcome: "missing" });
    expect(api).not.toHaveBeenCalled();
  });

  it("does not drop or report anything for an aborted (unmounted) check", async () => {
    videoBlobCache.put(scope, imageKey, pngBlob());
    const controller = new AbortController();
    const api = vi.fn(async () => { controller.abort(); throw new ApiRequestError(404, "AI_ASSET_NOT_FOUND", "x"); });
    await expect(revalidateWarmImage(options(api, { signal: controller.signal }))).rejects.toThrow();
    expect(videoBlobCache.get(scope, imageKey)).toBeDefined();
  });

  it("revalidates a warm video with the lightweight probe only, never a second MP4 download", async () => {
    const jobId = "job-123456789012";
    videoBlobCache.put(scope, jobId, new Blob(["video"], { type: "video/mp4" }));
    const routes: string[] = [];
    const available = vi.fn(async (route: string) => { routes.push(route); return { available: true }; });
    await expect(revalidateWarmVideo({ ...options(available), jobId })).resolves.toEqual({ outcome: "verified" });
    expect(routes).toEqual([`/api/ai/videos/${jobId}/content/check`]);
    const unavailable = vi.fn(async () => ({ available: false }));
    await expect(revalidateWarmVideo({ ...options(unavailable), jobId })).resolves.toMatchObject({ outcome: "dropped" });
    expect(videoBlobCache.get(scope, jobId)).toBeUndefined();
    videoBlobCache.put(scope, jobId, new Blob(["video"], { type: "video/mp4" }));
    const deleted = vi.fn(async () => { throw new ApiRequestError(404, "AI_VIDEO_NOT_FOUND", "没有找到"); });
    await expect(revalidateWarmVideo({ ...options(deleted), jobId })).resolves.toEqual({ outcome: "dropped", message: "视频已删除或当前账号无权查看" });
    expect(videoBlobCache.get(scope, jobId)).toBeUndefined();
  });

  it("downloads a cold image once for concurrent mounts and evicts it when access is revoked", async () => {
    let finish!: (value: unknown) => void;
    const api = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const first = loadPrivateImage({ api: api as never, scope, accountId: "member", assetId, signal: new AbortController().signal });
    const second = loadPrivateImage({ api: api as never, scope, accountId: "member", assetId, signal: new AbortController().signal });
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    finish(pngAsset(assetId));
    const [a, b] = await Promise.all([first, second]);
    expect(a.url).toBe(b.url);
    expect(api).toHaveBeenCalledTimes(1);
    videoBlobCache.remove(scope, imageKey);
    const denied = vi.fn(async () => { throw new ApiRequestError(403, "FORBIDDEN", "无权查看"); });
    await expect(loadPrivateImage({ api: denied as never, scope, accountId: "member", assetId, signal: new AbortController().signal })).rejects.toThrow("无权查看");
    expect(videoBlobCache.snapshot(scope, imageKey)).toBeUndefined();
    const mismatched = vi.fn(async () => pngAsset("asset-other-0001"));
    await expect(loadPrivateImage({ api: mismatched as never, scope, accountId: "member", assetId, signal: new AbortController().signal })).rejects.toThrow("不匹配");
  });
});
