import type { AiImageMimeType } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";
import { videoBlobCache, type MediaBlobCache } from "./mediaCache";

type Api = <T>(path: string, init?: RequestInit, timeoutMs?: number, responseMode?: "json" | "blob" | "image" | "stream") => Promise<T>;

/** Only these answers prove the current login lost access (sign-out, forbidden,
 * deleted, account changed). Timeouts and 5xx keep the warm copy visible. */
const REVOKED_MEDIA_STATUSES = new Set([401, 403, 404, 409]);

export function mediaAccessRevoked(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && REVOKED_MEDIA_STATUSES.has(error.status);
}

export type WarmRevalidation =
  /** No warm bytes for this login: the caller must perform the full GET. */
  | { outcome: "missing" }
  | { outcome: "verified" }
  /** Temporary failure: keep showing the warm copy, check again next mount. */
  | { outcome: "stale" }
  /** Revoked, deleted or changed: evicted from memory, must be hidden. */
  | { outcome: "dropped"; message: string };

interface WarmCheckOptions {
  api: Api;
  scope: string;
  accountId: string;
  signal: AbortSignal;
  cache?: MediaBlobCache;
}

export function privateImageCacheId(assetId: string): string {
  return `image:${assetId}`;
}

/** Every mount asks the server again (the same request volume as before);
 * only the display no longer waits for the answer. */
async function revalidate(
  { scope, signal, cache = videoBlobCache }: WarmCheckOptions,
  cacheId: string,
  check: () => Promise<string | null>,
  revokedMessage: string,
): Promise<WarmRevalidation> {
  if (!scope || !cache.get(scope, cacheId)) return { outcome: "missing" };
  try {
    const mismatch = await check();
    signal.throwIfAborted();
    if (mismatch) {
      cache.remove(scope, cacheId);
      return { outcome: "dropped", message: mismatch };
    }
    return { outcome: "verified" };
  } catch (error) {
    if (signal.aborted) throw error;
    if (!mediaAccessRevoked(error)) return { outcome: "stale" };
    cache.remove(scope, cacheId);
    return { outcome: "dropped", message: error.status === 404 ? revokedMessage : error.message || revokedMessage };
  }
}

/** Background check of a warm private image: metadata only, never the bytes. */
export function revalidateWarmImage(options: WarmCheckOptions & { assetId: string; mimeType?: AiImageMimeType }): Promise<WarmRevalidation> {
  const { api, accountId, assetId, mimeType, signal, scope, cache = videoBlobCache } = options;
  const cacheId = privateImageCacheId(assetId);
  return revalidate(options, cacheId, async () => {
    const warm = cache.get(scope, cacheId);
    const checked = await api<{ assetId: string; mimeType: AiImageMimeType; byteLength: number }>(
      `/api/ai/assets/${encodeURIComponent(assetId)}/check`,
      { signal, headers: { "X-Tongpin-Account": accountId } },
      30_000,
    );
    const changed = !warm || checked?.assetId !== assetId || checked.byteLength !== warm.size
      || checked.mimeType !== warm.type || Boolean(mimeType && checked.mimeType !== mimeType);
    return changed ? "图片授权或内容已变化，请重新加载" : null;
  }, "图片已删除或当前账号无权查看");
}

/** Background check of a warm private video: account + provider availability
 * through the lightweight probe, never a second MP4 download. */
export function revalidateWarmVideo(options: WarmCheckOptions & { jobId: string }): Promise<WarmRevalidation> {
  const { api, accountId, jobId, signal } = options;
  return revalidate(options, jobId, async () => {
    const checked = await api<{ available: true }>(
      `/api/ai/videos/${encodeURIComponent(jobId)}/content/check`,
      { signal, headers: { "X-Tongpin-Account": accountId } },
      30_000,
    );
    return checked?.available === true ? null : "视频授权检查未通过，请重新查询";
  }, "视频已删除或当前账号无权查看");
}
