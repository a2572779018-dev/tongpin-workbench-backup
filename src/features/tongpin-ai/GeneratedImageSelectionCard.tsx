import { useEffect, useState } from "react";
import type { AiImageAsset } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { decodePrivateImage } from "./ImageArtifact";
import "./generated-image-selection.css";

function Choice({ assetId, index, busy, onSelect }: { assetId: string; index: number; busy: boolean; onSelect: (assetId: string) => void }) {
  const { api, session } = useAuth();
  const accountId = session?.user.id ?? "";
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = "";
    setPreview(""); setError("");
    if (!accountId || !/^[A-Za-z0-9_-]{8,160}$/.test(assetId)) { setError("图片不可用"); return; }
    void api<AiImageAsset>(`/api/ai/assets/${encodeURIComponent(assetId)}`, { signal: controller.signal, headers: { "X-Tongpin-Account": accountId } }, 30_000)
      .then(asset => {
        if (controller.signal.aborted) return;
        if (asset.assetId !== assetId) throw new Error("图片与选择项不匹配");
        url = URL.createObjectURL(decodePrivateImage(asset));
        setPreview(url);
      })
      .catch(caught => { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "图片暂时无法读取"); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [accountId, api, assetId]);
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
