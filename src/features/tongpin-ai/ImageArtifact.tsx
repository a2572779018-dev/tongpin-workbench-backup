import { Download, RefreshCw, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import type { AiImageMimeType } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { saveBlobWithFeedback } from "./downloadFeedback";
import { videoBlobCache } from "./mediaCache";
import { privateImageCacheId } from "./mediaRevalidation";
import { usePrivateImage } from "./privateImage";
import "./generated-content.css";

export { decodePrivateImage } from "./privateImage";

export function ImageArtifact({ assetId, mimeType, title = "AI 生成图片", onDeleted }: { assetId: string; mimeType?: AiImageMimeType; title?: string; onDeleted?: (assetId: string) => void }) {
  const { api } = useAuth();
  // A warm image of this login paints immediately; the hook revalidates it in
  // the background and hides it only if access was revoked or content changed.
  const { image, error, loading, scope, accountId, retry, forget } = usePrivateImage(assetId, mimeType);
  const [paintError, setPaintError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deletedId, setDeletedId] = useState("");
  const deletingRef = useRef(false);
  async function deleteImage() {
    if (!accountId || deletingRef.current) return;
    deletingRef.current = true; setDeleting(true); setDeleteError("");
    try {
      await api(`/api/ai/assets/${encodeURIComponent(assetId)}`, { method: "DELETE", headers: { "X-Tongpin-Account": accountId } });
      forget();
      setDeletedId(`${scope}:${assetId}`);
      onDeleted?.(assetId);
    } catch (caught) { setDeleteError(caught instanceof Error ? caught.message : "删除失败，请重试"); }
    finally { deletingRef.current = false; setDeleting(false); }
  }
  if (deletedId === `${scope}:${assetId}`) return <p role="status">图片已删除，生成额度不退还。</p>;
  const message = paintError || error;
  return <figure className="tp-ai-generated-image">
    {loading ? <p role="status">正在读取图片…</p> : message ? <p role="alert">{message}<button type="button" onClick={() => {
      // A Blob that failed to paint is discarded so the retry downloads it again.
      const discard = Boolean(paintError);
      setPaintError(""); retry(discard);
    }}><RefreshCw size={15} />重试</button></p> : null}
    {deleteError ? <p role="alert">{deleteError}</p> : null}
    {image ? <><img src={image.url} alt={title} onError={() => setPaintError("图片无法显示，请重新加载")} />
      <figcaption><span>{title}</span><button type="button" onClick={() => {
        const blob = videoBlobCache.get(scope, privateImageCacheId(assetId));
        if (blob) void saveBlobWithFeedback(blob, `tongpin-ai-${assetId}.${image.mimeType === "image/jpeg" ? "jpg" : image.mimeType === "image/webp" ? "webp" : "png"}`);
      }}><Download size={15} />下载图片</button></figcaption>
      <details className="tp-ai-image-delete"><summary>删除图片</summary><p>删除后无法恢复，也不会退还生成额度。需要保留请先下载。</p>
        <button type="button" disabled={deleting} onClick={() => void deleteImage()}><Trash2 size={15} />{deleting ? "正在删除…" : "确认删除图片"}</button>
      </details></> : null}
  </figure>;
}
