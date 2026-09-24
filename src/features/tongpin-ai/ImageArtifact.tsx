import { Download, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AiImageAsset, AiImageMimeType } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import { saveBlobWithFeedback } from "./downloadFeedback";
import { mediaCacheScope, videoBlobCache } from "./mediaCache";
import "./generated-content.css";

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

export function ImageArtifact({ assetId, mimeType, title = "AI 生成图片", onDeleted }: { assetId: string; mimeType?: AiImageMimeType; title?: string; onDeleted?: (assetId: string) => void }) {
  const { api, session } = useAuth();
  const accountId = session?.user.id ?? "";
  const cacheScope = mediaCacheScope(session);
  const [image, setImage] = useState<{ url: string; mimeType: AiImageMimeType; cacheScope: string; assetId: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [deletedId, setDeletedId] = useState("");
  const deletingRef = useRef(false);
  const cacheId = `image:${assetId}`;
  useEffect(() => {
    const controller = new AbortController();
    // A cached Blob is not proof the asset still belongs to this session.
    setImage(null); setError(""); setLoading(true);
    if (!accountId || !/^[A-Za-z0-9_-]{8,160}$/.test(assetId)) { setLoading(false); setError("图片标识无效，请重新生成"); return; }
    const release = videoBlobCache.retain(cacheScope, cacheId);
    void (async () => {
      const warm = videoBlobCache.get(cacheScope, cacheId);
      if (warm) {
        const checked = await api<{ assetId: string; mimeType: AiImageMimeType; byteLength: number }>(`/api/ai/assets/${encodeURIComponent(assetId)}/check`, { signal: controller.signal, headers: { "X-Tongpin-Account": accountId } }, 30_000);
        if (checked.assetId !== assetId || checked.byteLength !== warm.size || checked.mimeType !== warm.type || mimeType && checked.mimeType !== mimeType) {
          videoBlobCache.remove(cacheScope, cacheId);
          throw new Error("图片授权或内容已变化，请重新加载");
        }
        return warm;
      }
      const asset = await api<AiImageAsset>(`/api/ai/assets/${encodeURIComponent(assetId)}`, { signal: controller.signal, headers: { "X-Tongpin-Account": accountId } }, 30_000);
      if (asset.assetId !== assetId || mimeType && asset.mimeType !== mimeType) throw new Error("图片响应不匹配，请重新加载");
      return decodePrivateImage(asset);
    })()
      .then(blob => {
        if (controller.signal.aborted) return;
        videoBlobCache.put(cacheScope, cacheId, blob);
        const url = videoBlobCache.objectUrl(cacheScope, cacheId);
        if (!url) throw new Error("图片缓存暂时不可用");
        setImage({ url, mimeType: blob.type as AiImageMimeType, cacheScope, assetId });
      })
      .catch(caught => {
        if (controller.signal.aborted) return;
        if (caught instanceof ApiRequestError && [401, 403, 404, 409].includes(caught.status)) videoBlobCache.remove(cacheScope, cacheId);
        setError(caught instanceof Error ? caught.message : "图片加载失败，请重试");
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); release(); };
  }, [accountId, api, assetId, cacheId, cacheScope, mimeType, version]);
  const visibleImage = image?.cacheScope === cacheScope && image.assetId === assetId ? image : null;
  async function deleteImage() {
    if (!accountId || deletingRef.current) return;
    deletingRef.current = true; setDeleting(true); setError("");
    try {
      await api(`/api/ai/assets/${encodeURIComponent(assetId)}`, { method: "DELETE", headers: { "X-Tongpin-Account": accountId } });
      videoBlobCache.remove(cacheScope, cacheId);
      setImage(null); setDeletedId(`${cacheScope}:${assetId}`);
      onDeleted?.(assetId);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "删除失败，请重试"); }
    finally { deletingRef.current = false; setDeleting(false); }
  }
  if (deletedId === `${cacheScope}:${assetId}`) return <p role="status">图片已删除，生成额度不退还。</p>;
  return <figure className="tp-ai-generated-image">
    {loading ? <p role="status">正在读取图片…</p> : error ? <p role="alert">{error}<button type="button" onClick={() => setVersion(current => current + 1)}><RefreshCw size={15} />重试</button></p> : null}
    {visibleImage ? <><img src={visibleImage.url} alt={title} onError={() => setError("图片无法显示，请重新加载")} />
      <figcaption><span>{title}</span><button type="button" onClick={() => {
        const blob = videoBlobCache.get(cacheScope, cacheId);
        if (blob) void saveBlobWithFeedback(blob, `tongpin-ai-${assetId}.${visibleImage.mimeType === "image/jpeg" ? "jpg" : visibleImage.mimeType === "image/webp" ? "webp" : "png"}`);
      }}><Download size={15} />下载图片</button></figcaption>
      <details className="tp-ai-image-delete"><summary>删除图片</summary><p>删除后无法恢复，也不会退还生成额度。需要保留请先下载。</p>
        <button type="button" disabled={deleting} onClick={() => void deleteImage()}><Trash2 size={15} />{deleting ? "正在删除…" : "确认删除图片"}</button>
      </details></> : null}
  </figure>;
}
