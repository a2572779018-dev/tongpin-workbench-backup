import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import type { AiVideoList } from "../../../shared/aiVideo";
import { AI_IMAGE_ACCEPT } from "../../../shared/aiMedia";
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
  const [resolution, setResolution] = useState<"480p" | "768p">("768p");
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
    if (data.quota.remainingTokens < data.settings.quotaPoints) { setError("剩余额度不足以生成视频"); return; }
    setWorking(true); setError("");
    try {
      const referenceIds: string[] = [];
      for (const image of images) {
        const result = await api<{ id: string }>("/api/ai/video-references", { method: "POST", headers, body: JSON.stringify({ dataUrl: image.dataUrl }) });
        if (!live.current) return;
        referenceIds.push(result.id);
      }
      if (!live.current) return;
      if (await onSubmit({ requestId: crypto.randomUUID(), prompt: prompt.trim(), seconds, resolution, aspectRatio, ...(referenceIds.length ? { referenceIds } : {}) })) {
        if (live.current) { setImages([]); onClose(); }
      }
    } catch (e) { if (live.current) setError(e instanceof Error ? e.message : "暂时无法提交视频"); }
    finally { lock.current = false; if (live.current) setWorking(false); }
  }
  useImperativeHandle(ref, () => ({ submit: () => void submit() }));
  async function addImages(files: File[]) {
    if (lock.current || !files.length) return;
    if (images.length + files.length > 8) { setError("最多添加 8 张参考图片"); return; }
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
  return <fieldset className="tp-ai-video-composer" disabled={busy}>
    <div className="tp-ai-video-inline-heading"><strong><Video size={16} />生成视频</strong><button type="button" aria-label="取消生成视频" onClick={onClose}><X size={16} /></button></div>
    <div className="tp-ai-video-options">
      <label>时长<select value={seconds} onChange={e => setSeconds(Number(e.target.value))}>{Array.from({ length: 11 }, (_, i) => i + 5).map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
      <label>清晰度<select value={resolution} onChange={e => setResolution(e.target.value as typeof resolution)}><option>480p</option><option>768p</option></select></label>
      <label>画幅<select value={aspectRatio} onChange={e => setAspectRatio(e.target.value as typeof aspectRatio)}><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option></select></label>
    </div>
    <input ref={input} type="file" hidden multiple accept={AI_IMAGE_ACCEPT} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addImages(files); }} />
    <button type="button" disabled={images.length >= 8} onClick={() => input.current?.click()}>添加参考图片（{images.length}/8）</button>
    <div className="tp-ai-video-reference-grid">{images.map((image, index) => <figure key={`${index}-${image.name}`}><img src={image.dataUrl} alt={`参考图 ${index + 1}`} /><figcaption>{image.name}<button type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => setImages(current => current.filter((_, i) => i !== index))}><X size={12} /></button></figcaption></figure>)}</div>
    {images.length ? <p className="tp-ai-video-hint">确认发送后将参考图交给视频服务商；链接 24 小时有效，不支持精确首尾帧。</p> : null}
    {!data ? <p role="status">正在检查视频服务…</p> : unavailable ? <p role="status">请管理员启用视频服务并配置密钥。</p> : null}
    {error ? <p role="alert" className="tp-ai-video-error">{error}<button type="button" onClick={() => void refresh()}>重新检查</button></p> : null}
    {busy ? <p role="status">正在准备视频请求…</p> : <p className="tp-ai-video-hint">在下方描述视频，点击发送确认生成并按管理员设置扣额。</p>}
    {data?.jobs.length && onUseHistory ? <details className="tp-ai-video-hint"><summary>已有视频任务</summary>{data.jobs.map(job => <button type="button" key={job.id} onClick={async () => {
      if (lock.current) return; setWorking(true);
      try { if (await onUseHistory(job.id)) { if (live.current) onClose(); } }
      catch (e) { if (live.current) setError(e instanceof Error ? e.message : "无法读取原任务"); }
      finally { lock.current = false; if (live.current) setWorking(false); }
    }}>查看原任务：{job.prompt.slice(0, 40)}</button>)}</details> : null}
  </fieldset>;
});
