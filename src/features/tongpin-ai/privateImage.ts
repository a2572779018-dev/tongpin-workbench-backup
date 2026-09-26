import { useCallback, useEffect, useState } from "react";
import type { AiImageAsset, AiImageMimeType } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { mediaCacheScope, videoBlobCache } from "./mediaCache";
import { mediaAccessRevoked, privateImageCacheId, revalidateWarmImage } from "./mediaRevalidation";

type Api = <T>(path: string, init?: RequestInit, timeoutMs?: number, responseMode?: "json" | "blob" | "image" | "stream") => Promise<T>;

const PRIVATE_IMAGE_ID = /^[A-Za-z0-9_-]{8,160}$/;

export function decodePrivateImage(value: AiImageAsset): Blob {
  if (!value || !["image/png", "image/jpeg", "image/webp"].includes(value.mimeType) || typeof value.base64 !== "string" || !value.base64 || value.base64.length > 16_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)) throw new Error("图片格式无效或文件过大");
  let binary: string;
  try { binary = atob(value.base64); } catch { throw new Error("图片数据不完整，请重新加载"); }
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!(value.mimeType === "image/png" && png || value.mimeType === "image/jpeg" && jpeg || value.mimeType === "image/webp" && webp)) throw new Error("图片内容与文件格式不一致");
  return new Blob([bytes], { type: value.mimeType });
}

export interface PrivateImageView {
  url: string;
  mimeType: AiImageMimeType;
}

/** Synchronous, network-free read of a warm image for this login scope. */
export function warmPrivateImage(scope: string, assetId: string, mimeType?: AiImageMimeType): PrivateImageView | null {
  if (!scope || !PRIVATE_IMAGE_ID.test(assetId)) return null;
  const cacheId = privateImageCacheId(assetId);
  const blob = videoBlobCache.get(scope, cacheId);
  if (!blob || (mimeType && blob.type !== mimeType)) return null;
  const url = videoBlobCache.objectUrl(scope, cacheId);
  return url ? { url, mimeType: blob.type as AiImageMimeType } : null;
}

/** Full authorized GET; concurrent mounts of the same image share one request. */
export async function loadPrivateImage({ api, scope, accountId, assetId, mimeType, signal }: {
  api: Api; scope: string; accountId: string; assetId: string; mimeType?: AiImageMimeType; signal: AbortSignal;
}): Promise<PrivateImageView> {
  const cacheId = privateImageCacheId(assetId);
  try {
    const blob = await videoBlobCache.loadBlob(scope, cacheId, async sharedSignal => {
      const asset = await api<AiImageAsset>(`/api/ai/assets/${encodeURIComponent(assetId)}`, { signal: sharedSignal, headers: { "X-Tongpin-Account": accountId } }, 30_000);
      if (asset.assetId !== assetId || mimeType && asset.mimeType !== mimeType) throw new Error("图片响应不匹配，请重新加载");
      return decodePrivateImage(asset);
    }, signal);
    const url = videoBlobCache.objectUrl(scope, cacheId);
    if (!url) throw new Error("图片缓存暂时不可用");
    return { url, mimeType: blob.type as AiImageMimeType };
  } catch (error) {
    if (mediaAccessRevoked(error)) videoBlobCache.remove(scope, cacheId);
    throw error;
  }
}

interface PrivateImageState {
  identity: string;
  image: PrivateImageView | null;
  error: string;
  loading: boolean;
}

function initialImageState(identity: string, scope: string, accountId: string, assetId: string, mimeType?: AiImageMimeType): PrivateImageState {
  if (!accountId || !PRIVATE_IMAGE_ID.test(assetId)) return { identity, image: null, error: "图片标识无效，请重新生成", loading: false };
  const image = warmPrivateImage(scope, assetId, mimeType);
  return { identity, image, error: "", loading: !image };
}

/** Stale-while-revalidate for private generated images: a warm Blob of the
 * same login paints on the first render (no "正在读取图片…" flash); the
 * server is asked in the background and the image disappears only when it
 * answers 401/403/404/409 or reports different content. Memory only. */
export function usePrivateImage(assetId: string, mimeType?: AiImageMimeType) {
  const { api, session } = useAuth();
  const accountId = session?.user.id ?? "";
  const scope = mediaCacheScope(session);
  const identity = JSON.stringify([scope, accountId, assetId, mimeType ?? ""]);
  const [state, setState] = useState<PrivateImageState>(() => initialImageState(identity, scope, accountId, assetId, mimeType));
  const [attempt, setAttempt] = useState(0);
  const shown = state.identity === identity ? state : initialImageState(identity, scope, accountId, assetId, mimeType);

  useEffect(() => {
    if (!accountId || !PRIVATE_IMAGE_ID.test(assetId)) {
      setState(initialImageState(identity, scope, accountId, assetId, mimeType));
      return;
    }
    const controller = new AbortController();
    const release = videoBlobCache.retain(scope, privateImageCacheId(assetId));
    const warm = warmPrivateImage(scope, assetId, mimeType);
    if (warm) {
      setState(current => current.identity === identity && current.image?.url === warm.url && !current.error && !current.loading
        ? current : { identity, image: warm, error: "", loading: false });
      void revalidateWarmImage({ api, scope, accountId, assetId, mimeType, signal: controller.signal })
        .then(result => {
          if (controller.signal.aborted || result.outcome !== "dropped") return;
          setState({ identity, image: null, error: result.message, loading: false });
        }, () => undefined);
    } else {
      setState(current => current.identity === identity && current.loading && !current.image && !current.error
        ? current : { identity, image: null, error: "", loading: true });
      void loadPrivateImage({ api, scope, accountId, assetId, mimeType, signal: controller.signal })
        .then(image => { if (!controller.signal.aborted) setState({ identity, image, error: "", loading: false }); },
          caught => {
            if (controller.signal.aborted) return;
            setState({ identity, image: null, error: caught instanceof Error ? caught.message : "图片加载失败，请重试", loading: false });
          });
    }
    return () => { controller.abort(); release(); };
  }, [accountId, api, assetId, attempt, identity, mimeType, scope]);

  const retry = useCallback((discardWarmCopy = false) => {
    if (discardWarmCopy) {
      // The displayed Blob URL is revoked with the entry; show loading, not a broken image.
      videoBlobCache.remove(scope, privateImageCacheId(assetId));
      setState({ identity, image: null, error: "", loading: true });
    }
    setAttempt(current => current + 1);
  }, [assetId, identity, scope]);
  const forget = useCallback(() => {
    videoBlobCache.remove(scope, privateImageCacheId(assetId));
    setState({ identity, image: null, error: "", loading: false });
  }, [assetId, identity, scope]);

  return { image: shown.image, error: shown.error, loading: shown.loading, scope, accountId, retry, forget };
}
