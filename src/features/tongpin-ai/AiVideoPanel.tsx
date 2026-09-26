import { useCallback, useEffect, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import type { AiVideoJob, AiVideoList } from "../../../shared/aiVideo";
import { AI_IMAGE_ACCEPT } from "../../../shared/aiMedia";
import { ApiRequestError } from "../../lib/api";
import { mediaCacheScope, videoBlobCache } from "./mediaCache";
import "./ai-video.css";

const labels: Record<AiVideoJob["status"], string> = { submitting: "提交中", queued: "排队中", processing: "生成中", completed: "已完成", failed: "未完成", uncertain: "费用待核对" };
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请稍后重试";

/** Account-bound persistent video jobs; opening/closing never submits a generation. */
export function AiVideoPanel({ onClose, initialPrompt = "", onQuotaChange }: { onClose: () => void; initialPrompt?: string; onQuotaChange?: () => void }) {
  const { api, session } = useAuth();
  const account = session?.user.id;
  const cacheScope = mediaCacheScope(session);
  const openedAccount = useRef(account);
  const dialog = useRef<HTMLDialogElement>(null), live = useRef(true), busyRef = useRef(false);
  const [data, setData] = useState<AiVideoList | null>(null), [error, setError] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt), [seconds, setSeconds] = useState(15);
  const [resolution, setResolution] = useState<"480p" | "768p">("768p"), [ratio, setRatio] = useState<"16:9" | "9:16">("16:9");
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState<{ url: string; id: string } | null>(null);
  const [mode, setMode] = useState<"text" | "image">("text");
  const [references, setReferences] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const [reading, setReading] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null), readingRef = useRef(false);
  const imageAbort = useRef<AbortController | null>(null);
  const [pending, setPending] = useState<{ requestId: string; prompt: string; seconds: number; resolution: string; aspectRatio: string } | null>(null);
  const header = useCallback(() => ({ "X-Tongpin-Account": account ?? "" }), [account]);
  const refresh = useCallback(async () => { const result = await api<AiVideoList>("/api/ai/videos", { headers: header() }); if (live.current) setData(result); }, [api, header]);
  useEffect(() => {
    live.current = true; const before = document.activeElement as HTMLElement | null; dialog.current?.showModal();
    void refresh().catch(e => { if (live.current) setError(errorText(e)); });
    return () => { live.current = false; imageAbort.current?.abort(); dialog.current?.close(); before?.focus(); };
  }, [refresh]);
  // The login-scoped media cache owns the Blob URL; keep it from LRU eviction while shown.
  useEffect(() => preview ? videoBlobCache.retain(cacheScope, preview.id) : undefined, [cacheScope, preview]);
  useEffect(() => { if (openedAccount.current !== account) onClose(); }, [account, onClose]);
  useEffect(() => {
    if (!data?.jobs.some(j => ["queued", "processing", "submitting"].includes(j.status))) return;
    const timer = setTimeout(async () => {
      if (document.hidden) { void refresh().catch(() => {}); return; }
      try {
        for (const job of data.jobs.filter(j => ["queued", "processing"].includes(j.status))) await api(`/api/ai/videos/${encodeURIComponent(job.id)}`, { headers: header() }, 30000);
        await refresh(); onQuotaChange?.();
      } catch (e) { if (live.current) setError(errorText(e)); }
    }, 15000);
    return () => clearTimeout(timer);
  }, [data, api, header, refresh, onQuotaChange]);
  async function submit() {
    if (busyRef.current || readingRef.current || pending || !data?.settings.enabled || !data.settings.apiKeyConfigured || !prompt.trim() || (mode === "image" && !references.length)) return;
    busyRef.current = true; setBusy(true); setError("");
    let submitted = false;
    try {
      const referenceIds: string[] = [];
      if (mode === "image") for (const reference of references) {
        const result = await api<{ id: string }>("/api/ai/video-references", { method: "POST", headers: header(), body: JSON.stringify({ dataUrl: reference.dataUrl }) });
        if (!live.current) return;
        referenceIds.push(result.id);
      }
      const request = { requestId: crypto.randomUUID(), prompt: prompt.trim(), seconds, resolution, aspectRatio: ratio, ...(referenceIds.length ? { referenceIds } : {}) };
      setPending(request); submitted = true;
      await api("/api/ai/videos", { method: "POST", headers: header(), body: JSON.stringify(request) }, 80000);
      if (live.current) { setPending(null); setPrompt(""); setReferences([]); submitted = false; await refresh(); onQuotaChange?.(); }
    } catch (e) { if (live.current) {
      const rejected = e instanceof ApiRequestError && [400, 401, 402, 403, 409, 413, 429].includes(e.status);
      if (rejected) setPending(null);
      setError(submitted && !rejected ? `${errorText(e)}。请先查询提交结果，不要重复生成。` : errorText(e));
    } }
    finally { busyRef.current = false; if (live.current) setBusy(false); }
  }
  async function addImages(files: File[]) {
    if (readingRef.current || busyRef.current) return;
    if (references.length + files.length > 8) { setError("最多添加 8 张参考图片"); return; }
    readingRef.current = true; setReading(true); setError("");
    const controller = new AbortController(); imageAbort.current = controller;
    try {
      const { extractMediaAttachment } = await import("./mediaAttachments");
      const next: typeof references = [];
      for (const file of files) {
        if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
        const image = await extractMediaAttachment(file, controller.signal);
        if (image.media?.kind !== "image") throw new Error("请选择图片");
        next.push({ name: file.name, dataUrl: image.media.frames[0].dataUrl });
      }
      if (live.current) setReferences(items => [...items, ...next]);
    } catch (e) { if (live.current) setError(errorText(e)); }
    finally { readingRef.current = false; if (live.current) setReading(false); }
  }
  async function checkSubmission() {
    if (!pending || busyRef.current) return;
    busyRef.current = true; setBusy(true);
    try {
      // A check is strictly read-only: it never resubmits a possibly paid request.
      await api(`/api/ai/videos/${encodeURIComponent(pending.requestId)}`, { headers: header() }, 30000);
      if (live.current) { setPending(null); setError(""); await refresh(); onQuotaChange?.(); }
    } catch (e) { if (live.current) setError(errorText(e)); }
    finally { busyRef.current = false; if (live.current) setBusy(false); }
  }
  async function view(job: AiVideoJob) {
    if (busyRef.current) return; busyRef.current = true; setBusy(true); setError("");
    try {
      // The job was just listed for this account; a video already played in
      // chat (same login) opens from memory instead of a second MP4 download.
      await videoBlobCache.loadBlob(cacheScope, job.id, signal => api<Blob>(`/api/ai/videos/${encodeURIComponent(job.id)}/content`, { headers: header(), signal }, 130000, "blob"));
      const url = videoBlobCache.objectUrl(cacheScope, job.id);
      if (!url) throw new Error("视频缓存暂时不可用，请重试");
      if (live.current) setPreview({ id: job.id, url });
    } catch (e) {
      if (e instanceof ApiRequestError && [401, 403, 404, 409].includes(e.status)) videoBlobCache.remove(cacheScope, job.id);
      if (live.current) setError(errorText(e));
    }
    finally { busyRef.current = false; if (live.current) setBusy(false); }
  }
  const active = data?.jobs.some(j => j.reserved);
  if (openedAccount.current !== account) return null;
  return <dialog ref={dialog} className="tp-ai-video-dialog" aria-labelledby="tp-video-title" onCancel={e => { e.preventDefault(); onClose(); }}>
    <header><h2 id="tp-video-title"><Video size={22} />生成视频</h2><button type="button" aria-label="关闭视频窗口" onClick={onClose}><X size={20} /></button></header>
    <div className="tp-ai-video-body">
      {!data && !error ? <p role="status">正在读取视频服务…</p> : null}
      {error ? <p role="alert" className="tp-ai-video-error">{error}</p> : null}
      {data && (!data.settings.enabled || !data.settings.apiKeyConfigured) ? <p role="status">{!data.settings.enabled ? "视频服务未启用，请在管理员「AI 管理 → 视频生成」中开启。" : "视频服务尚未配置密钥，请联系管理员。"}<button type="button" disabled={busy} onClick={() => void refresh().catch(e => setError(errorText(e)))}>重新检查</button></p> : null}
      <form onSubmit={e => { e.preventDefault(); void submit(); }}>
        <fieldset disabled={busy || reading || Boolean(pending) || !data?.settings.enabled || !data.settings.apiKeyConfigured || active}>
          <div className="tp-ai-video-modes" role="group" aria-label="生成方式">
            <button type="button" aria-pressed={mode === "text"} onClick={() => setMode("text")}>文字生视频</button>
            <button type="button" aria-pressed={mode === "image"} onClick={() => setMode("image")}>图片参考生视频</button>
          </div>
          {mode === "image" ? <div className="tp-ai-video-references">
            <input ref={imageInput} type="file" accept={AI_IMAGE_ACCEPT} multiple hidden onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addImages(files); }} />
            <button type="button" disabled={references.length >= 8} onClick={() => imageInput.current?.click()}>添加参考图片（{references.length}/8）</button>
            <div className="tp-ai-video-reference-grid">{references.map((item, i) => <figure key={`${i}-${item.name}`}><img src={item.dataUrl} alt={`参考图 ${i + 1}：${item.name}`} /><figcaption>参考图 {i + 1}<button type="button" aria-label={`移除参考图 ${i + 1}`} onClick={() => setReferences(items => items.filter((_, index) => index !== i))}><X size={14} /></button></figcaption></figure>)}</div>
            <p className="tp-ai-video-hint">确认生成后将图片发送给视频服务商，图片链接 24 小时后失效。当前模型支持图片参考，不支持精确指定首尾帧。</p>
          </div> : null}
          <label>视频描述<textarea value={prompt} maxLength={4000} onChange={e => setPrompt(e.target.value)} placeholder="例如：清晨阳光下，一只橘猫坐在窗边，镜头缓慢推进。" /></label>
          <div className="tp-ai-video-options"><label>时长<select value={seconds} onChange={e => setSeconds(Number(e.target.value))}>{Array.from({ length: 11 }, (_, i) => i + 5).map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
            <label>清晰度<select value={resolution} onChange={e => setResolution(e.target.value as typeof resolution)}><option>480p</option><option>768p</option></select></label>
            <label>画幅<select value={ratio} onChange={e => setRatio(e.target.value as typeof ratio)}><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option></select></label></div>
          <button className="is-primary" type="submit" disabled={!prompt.trim() || (mode === "image" && !references.length) || !data || data.quota.remainingTokens < data.settings.quotaPoints}>确认生成</button>
        </fieldset>
      </form>
      {reading ? <p role="status">正在处理参考图片…</p> : null}
      {data?.settings.enabled && data.quota.remainingTokens < data.settings.quotaPoints ? <p role="status">剩余额度不足以生成一段视频，请联系管理员调整额度。</p> : null}
      {pending ? <button type="button" disabled={busy} onClick={() => void checkSubmission()}>核对本次提交</button> : null}
      <div className="tp-ai-video-history-heading"><h3>我的视频</h3><button type="button" disabled={busy} onClick={() => { setError(""); void refresh().catch(e => setError(errorText(e))); }}>刷新任务</button></div>
      {!data?.jobs.length && data ? <p className="tp-ai-video-hint">还没有生成的视频</p> : null}
      {data?.jobs.map(job => <article key={job.id} className="tp-ai-video-job">
        <strong>{labels[job.status]}{["queued", "processing"].includes(job.status) ? ` · ${Math.round(job.progress)}%` : ""}</strong>
        <p>{job.prompt}</p><small>{job.seconds} 秒 · {job.resolution} · {new Date(job.createdAt).toLocaleString("zh-CN")}</small>
        {job.error ? <p className="tp-ai-video-error">{job.error}</p> : null}
        {job.status === "completed" ? <button type="button" disabled={busy} onClick={() => void view(job)}>加载视频</button> : null}
        {preview?.id === job.id ? <><video src={preview.url} controls preload="metadata" /><a href={preview.url} download={`同频视频-${job.id}.mp4`}>下载 MP4</a></> : null}
      </article>)}
    </div>
  </dialog>;
}
