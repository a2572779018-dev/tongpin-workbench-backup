import { useState } from "react";
import { usePrivateImage } from "./privateImage";
import "./generated-image-selection.css";

function Choice({ assetId, index, busy, onSelect }: { assetId: string; index: number; busy: boolean; onSelect: (assetId: string) => void }) {
  // Shares the login-scoped image cache with the chat result: a thumbnail that
  // was already shown paints at once and is revalidated in the background.
  const { image, error } = usePrivateImage(assetId);
  const preview = image?.url ?? "";
  return <button type="button" className="tp-ai-image-choice" disabled={busy || !preview || Boolean(error)} onClick={() => onSelect(assetId)} aria-label={`选择第 ${index + 1} 张图片用于视频`}>
    {preview ? <img src={preview} alt={`第 ${index + 1} 张生成图片`} /> : <span role="status">{error || "正在读取图片…"}</span>}
    <strong>第 {index + 1} 张</strong>
  </button>;
}

/** A local, durable question. Clicking a thumbnail only selects a source; the
 * media scheduler still performs its separate server-side cost authorization. */
export function GeneratedImageSelectionCard({ assetIds, onSelect, onCancel }: {
  assetIds: readonly string[];
  onSelect: (assetId: string) => Promise<boolean>;
  onCancel: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choose = async (assetId: string) => {
    if (busy) return;
    setBusy(true); setError("");
    try { if (!await onSelect(assetId)) setError("图片选择尚未完成，请检查记录同步后重试。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "图片选择失败，请重试。"); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try { await onCancel(); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "取消尚未保存，请重试。"); }
    finally { setBusy(false); }
  };
  return <section className="tp-ai-image-selection" aria-label="选择视频参考图片" data-native-cursor>
    <strong>选择用于视频的图片</strong>
    <div className="tp-ai-image-selection__choices">{assetIds.map((assetId, index) => <Choice key={assetId} assetId={assetId} index={index} busy={busy} onSelect={id => void choose(id)} />)}</div>
    <button type="button" className="tp-ai-image-selection__cancel" disabled={busy} onClick={() => void cancel()}>取消</button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
