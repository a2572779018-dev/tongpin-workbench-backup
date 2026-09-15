import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import type { AiVideoList } from "../../../shared/aiVideo";
import { AI_IMAGE_ACCEPT } from "../../../shared/aiMedia";
import { VIDEO_MODELS, videoModel, videoSeconds, type VideoModelId, type VideoResolution } from "../../../shared/aiVideoModels";
import type { VideoChatRequest } from "./videoChat";
import "./ai-video.css";

export interface VideoComposerHandle { submit(): void }
export const AiVideoComposer = forwardRef<VideoComposerHandle, {
  prompt: string; onClose(): void; onBusy(busy: boolean): void;
  onSubmit(request: VideoChatRequest): Promise<boolean>;
  onUseHistory?: (jobId: string) => Promise<boolean>;
}>(function AiVideoComposer({ prompt, onClose, onBusy, onSubmit, onUseHistory }, ref) {
  const { api, session } = useAuth();
  const [data, setData] = useState<AiVideoList | null>(null);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(15);
  const [model, setModel] = useState<VideoModelId>("minimax_h3");
  const [resolution, setResolution] = useState<VideoResolution>("768p");
  const [submitted, setSubmitted] = useState(false);
  const [dragging, setDragging] = useState(false);
  const spec = videoModel(model)!;
  function selectModel(id: VideoModelId, res?: VideoResolution) {
    const next = videoModel(id)!;
    const r = res ?? next.resolutions[next.resolutions.length - 1];
    const durations = videoSeconds(id, r);
    setModel(id); setResolution(r); setSeconds(n => durations.includes(n) ? n : durations[durations.length - 1]);
  }
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">("16:9");
  const [images, setImages] = useState<Array<{ name: string; dataUrl: string }>>([]);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), live = useRef(true), input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const headers = { "X-Tongpin-Account": session?.user.id ?? "" };
  function setWorking(value: boolean) { lock.current = value; setBusy(value); onBusy(value); }
  async function refresh() {
    try { const result = await api<AiVideoList>("/api/ai/videos", { headers }); if (live.current) { setData(result); setError(""); } }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "视频服务暂时不可用"); }
  }
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; controller.current?.abort(); }; }, [api, session?.user.id]);
  const unavailable = !data?.settings.enabled || !data.settings.apiKeyConfigured;
  async function submit() {
    if (lock.current) return;
    if (!prompt.trim()) { setError("请在对话输入框描述要生成的视频"); return; }
    if (unavailable || !data) { setError("视频服务未启用或未配置密钥，请联系管理员"); return; }
    if (data.jobs.some(job => job.reserved)) { setError("已有视频正在处理或等待核对，请先查看原任务"); return; }
    if (data.quota.remainingTokens < data.settings.quotaPoints) { setError("剩余额度不足以生成这段视频，请联系管理员增加额度。尚未提交生成任务。"); return; }
    if (images.length > spec.maxImages || (spec.requiresImage && !images.length)) { setError(spec.requiresImage && !images.length ? "此模型需要添加参考图片" : `最多添加 ${spec.maxImages} 张参考图片`); return; }
    setWorking(true); setError(""); setSubmitted(true);
    try {
      if (await onSubmit({ requestId: crypto.randomUUID(), prompt: prompt.trim(), model, seconds, resolution, aspectRatio, ...(images.length ? { referenceImages: images } : {}) })) {
        if (live.current) { setImages([]); onClose(); }
      } else if (live.current) setSubmitted(false);
    } catch (e) { if (live.current) { setSubmitted(false); setError(e instanceof Error ? e.message : "暂时无法提交视频"); } }
    finally { lock.current = false; if (live.current) setWorking(false); }
  }
  useImperativeHandle(ref, () => ({ submit: () => void submit() }));
  async function addImages(files: File[]) {
    if (lock.current || !files.length) return;
    if (images.length + files.length > spec.maxImages) { setError(`最多添加 ${spec.maxImages} 张参考图片`); return; }
    setWorking(true); setError("");
    const abort = new AbortController(); controller.current = abort;
    try {
      const { extractMediaAttachment } = await import("./mediaAttachments");
      const next: typeof images = [];
      for (const file of files) {
        if (!/\.(png|jpe?g|webp)$/i.test(file.name)) throw new Error("请选择 PNG、JPEG 或 WebP 图片");
        const result = await extractMediaAttachment(file, abort.signal);
        if (result.media?.kind !== "image") throw new Error("请选择图片");
        next.push({ name: file.name, dataUrl: result.media.frames[0].dataUrl });
      }
      if (live.current) setImages(current => [...current, ...next]);
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "图片读取失败"); }
    finally { lock.current = false; if (live.current) setWorking(false); }
  }
  if (submitted) return null;
  return <><fieldset className={`tp-ai-video-composer${dragging ? " is-dragging" : ""}`} disabled={busy}
    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDragging(true); }}
    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
    onDrop={e => { e.preventDefault(); e.stopPropagation(); setDragging(false); void addImages(Array.from(e.dataTransfer.files)); }}>
    <div className="tp-ai-video-inline-heading"><strong><Video size={16} />生成视频</strong><button type="button" aria-label="取消生成视频" onClick={onClose}><X size={16} /></button></div>
    <div className="tp-ai-video-options">
      <label>模型<select value={model} onChange={e => selectModel(e.target.value as VideoModelId)}>{VIDEO_MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</select></label>
      <label>时长<select value={seconds} onChange={e => setSeconds(Number(e.target.value))}>{videoSeconds(model, resolution).map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
      <label>清晰度<select value={resolution} onChange={e => selectModel(model, e.target.value as VideoResolution)}>{spec.resolutions.map(r => <option key={r}>{r}</option>)}</select></label>
      <label>画幅<select value={aspectRatio} onChange={e => setAspectRatio(e.target.value as typeof aspectRatio)}><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option></select></label>
    </div>
    <input ref={input} type="file" hidden multiple accept={AI_IMAGE_ACCEPT} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addImages(files); }} />
    <button type="button" disabled={images.length >= spec.maxImages} onClick={() => input.current?.click()}>拖入或添加参考图片（{images.length}/{spec.maxImages}）</button>
    <div className="tp-ai-video-reference-grid">{images.map((image, index) => <figure key={`${index}-${image.name}`}><img src={image.dataUrl} alt={`参考图 ${index + 1}`} /><figcaption>{image.name}<button type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => setImages(current => current.filter((_, i) => i !== index))}><X size={12} /></button></figcaption></figure>)}</div>
    {!data ? <p role="status">正在检查视频服务…</p> : unavailable ? <p role="status">请管理员启用视频服务并配置密钥。</p> : null}
    {busy ? <p role="status">正在读取图片…</p> : null}
    {data?.jobs.length && onUseHistory ? <details className="tp-ai-video-hint"><summary>已有视频任务</summary>{data.jobs.map(job => <button type="button" key={job.id} onClick={async () => {
      if (lock.current) return; setWorking(true);
      try { if (await onUseHistory(job.id)) { if (live.current) onClose(); } }
      catch (e) { if (live.current) setError(e instanceof Error ? e.message : "无法读取原任务"); }
      finally { lock.current = false; if (live.current) setWorking(false); }
    }}>查看原任务：{job.prompt.slice(0, 40)}</button>)}</details> : null}
  </fieldset>
    {error ? <p role="alert" className="tp-ai-video-error tp-ai-video-submit-error">{error}<button type="button" onClick={() => void refresh()}>重新检查</button></p> : null}
  </>;
});
