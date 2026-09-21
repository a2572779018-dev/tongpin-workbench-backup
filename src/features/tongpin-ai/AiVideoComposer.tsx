import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Video, X } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import type { AiVideoList } from "../../../shared/aiVideo";
import type { AiToolPlan } from "../../../shared/ai";
import type { AiMode } from "../../../shared/ai";
import { AI_IMAGE_ACCEPT } from "../../../shared/aiMedia";
import type { VideoResolution } from "../../../shared/aiVideoModels";
import type { VideoChatRequest } from "./videoChat";
import "./ai-video.css";

export interface VideoComposerHandle { submit(): void }
export const AiVideoComposer = forwardRef<VideoComposerHandle, {
  prompt: string; onClose(): void; onBusy(busy: boolean): void;
  tier: AiMode;
  initialRequest?: VideoChatRequest;
  initialReferenceImages?: Array<{ name: string; dataUrl: string }>;
  onPlan(request: VideoChatRequest): Promise<AiToolPlan>;
  onSubmit(request: VideoChatRequest): Promise<boolean>;
  onUseHistory?: (jobId: string) => Promise<boolean>;
}>(function AiVideoComposer({ prompt, tier, onClose, onBusy, onPlan, onSubmit, onUseHistory, initialRequest, initialReferenceImages }, ref) {
  const { api, session } = useAuth();
  const [data, setData] = useState<AiVideoList | null>(null);
  const [error, setError] = useState("");
  const [seconds, setSeconds] = useState(initialRequest?.seconds ?? 15);
  const [resolution, setResolution] = useState<VideoResolution>(initialRequest?.resolution ?? "768p");
  const [submitted, setSubmitted] = useState(false);
  // A plan is a single-use approval, not reusable draft data. Retrying restores
  // the user's prompt/settings/references, then asks the AI for a fresh plan.
  const [plan, setPlan] = useState<AiToolPlan | null>(null);
  const [plannedFrom, setPlannedFrom] = useState(initialRequest?.originalPrompt ?? initialRequest?.prompt ?? "");
  const [dragging, setDragging] = useState(false);
  const profile = data?.settings.profile;
  const modelAvailable = Boolean(profile);
  const [aspectRatio, setAspectRatio] = useState<"16:9" | "9:16">(initialRequest?.aspectRatio ?? "16:9");
  const [images, setImages] = useState<Array<{ name: string; dataUrl: string }>>(
    initialRequest?.referenceImages ?? initialReferenceImages ?? [],
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false), live = useRef(true), input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { if (plan && prompt.trim() !== plannedFrom) setPlan(null); }, [plan, plannedFrom, prompt]);
  const headers = { "X-Tongpin-Account": session?.user.id ?? "" };
  function setWorking(value: boolean) { lock.current = value; setBusy(value); onBusy(value); }
  async function refresh() {
    try { const result = await api<AiVideoList>(`/api/ai/videos?tier=${encodeURIComponent(tier)}`, { headers }); if (live.current) {
      setData(result); setError("");
      const nextProfile = result.settings.profile;
      if (nextProfile) {
        const nextResolution = nextProfile.resolutions.includes(resolution) ? resolution : nextProfile.resolutions.at(-1)!;
        const durations = nextProfile.seconds[nextResolution] ?? [];
        setPlan(null); setResolution(nextResolution); setSeconds(current => durations.includes(current) ? current : durations.at(-1) ?? current);
      }
    } }
    catch (e) { if (live.current) setError(e instanceof Error ? e.message : "视频服务暂时不可用"); }
  }
  useEffect(() => { live.current = true; void refresh(); return () => { live.current = false; controller.current?.abort(); }; }, [api, session?.user.id, tier]);
  const unavailable = !data?.settings.enabled || !data.settings.apiKeyConfigured;
  async function submit() {
    if (lock.current) return;
    if (!prompt.trim()) { setError("请在对话输入框描述要生成的视频"); return; }
    if (unavailable || !data) { setError("视频服务未启用或未配置密钥，请联系管理员"); return; }
    if (!modelAvailable) { setError("当前业务档位尚未配置可用的视频生成功能，请联系管理员"); return; }
    if (data.jobs.some(job => job.reserved)) { setError("已有视频正在处理或等待核对，请先查看原任务"); return; }
    if (data.quota.remainingTokens < data.settings.quotaPoints) { setError("剩余额度不足以生成这段视频，请联系管理员增加额度。尚未提交生成任务。"); return; }
    if (!profile || images.length > profile.maxImages || (profile.requiresImage && !images.length)) { setError(profile?.requiresImage && !images.length ? "当前档位需要添加参考图片" : `最多添加 ${profile?.maxImages ?? 0} 张参考图片`); return; }
    const base: VideoChatRequest = { requestId: crypto.randomUUID(), prompt: prompt.trim(), seconds, resolution, aspectRatio, ...(images.length ? { referenceImages: images } : {}) };
    setWorking(true); setError("");
    try {
      if (!plan) {
        const next = await onPlan(base);
        if (next.kind !== "video") throw new Error("同频 AI 返回的不是视频任务，请重新整理");
        if (live.current) { setPlannedFrom(prompt.trim()); setPlan(next); }
        return;
      }
      setSubmitted(true);
      if (await onSubmit({ ...base, prompt: plan.prompt, originalPrompt: initialRequest?.originalPrompt ?? prompt.trim(), planSummary: plan.summary, ...(plan.planRequestId ? { planRequestId: plan.planRequestId } : {}), ...(plan.trace ? { planTrace: plan.trace } : {}) })) {
        if (live.current) { setImages([]); onClose(); }
      } else if (live.current) setSubmitted(false);
    } catch (e) { if (live.current) { setSubmitted(false); setError(e instanceof Error ? e.message : "暂时无法提交视频"); } }
    finally { lock.current = false; if (live.current) setWorking(false); }
  }
  useImperativeHandle(ref, () => ({ submit: () => void submit() }));
  async function addImages(files: File[]) {
    if (lock.current || !files.length) return;
    if (!modelAvailable) { setError("当前业务档位尚未配置可用的视频生成功能，请联系管理员"); return; }
    if (images.length + files.length > (profile?.maxImages ?? 0)) { setError(`最多添加 ${profile?.maxImages ?? 0} 张参考图片`); return; }
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
      if (live.current) { setPlan(null); setImages(current => [...current, ...next]); }
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
      <label>时长<select value={seconds} disabled={!modelAvailable} onChange={e => { setPlan(null); setSeconds(Number(e.target.value)); }}>{(profile?.seconds[resolution] ?? []).map(n => <option key={n} value={n}>{n} 秒</option>)}</select></label>
      <label>清晰度<select value={resolution} disabled={!modelAvailable} onChange={e => { setPlan(null); const next = e.target.value as VideoResolution; const durations = profile?.seconds[next] ?? []; setResolution(next); setSeconds(current => durations.includes(current) ? current : durations.at(-1) ?? current); }}>{profile?.resolutions.map(r => <option key={r}>{r}</option>)}</select></label>
      <label>画幅<select value={aspectRatio} onChange={e => { setPlan(null); setAspectRatio(e.target.value as typeof aspectRatio); }}><option value="16:9">横屏 16:9</option><option value="9:16">竖屏 9:16</option></select></label>
    </div>
    <input ref={input} type="file" hidden multiple accept={AI_IMAGE_ACCEPT} onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ""; void addImages(files); }} />
    <button type="button" disabled={!modelAvailable || images.length >= (profile?.maxImages ?? 0)} onClick={() => input.current?.click()}>拖入或添加参考图片（{images.length}/{profile?.maxImages ?? 0}）</button>
    <div className="tp-ai-video-reference-grid">{images.map((image, index) => <figure key={`${index}-${image.name}`}><img src={image.dataUrl} alt={`参考图 ${index + 1}`} /><figcaption>{image.name}<button type="button" aria-label={`移除参考图 ${index + 1}`} onClick={() => { setPlan(null); setImages(current => current.filter((_, i) => i !== index)); }}><X size={12} /></button></figcaption></figure>)}</div>
    {plan ? <section className="tp-ai-tool-plan" aria-label="同频 AI 整理的视频任务"><strong>同频 AI 已整理任务</strong><p>{plan.summary}</p><label>生成提示词<textarea value={plan.prompt} readOnly /></label><small>如需修改，请直接改上方任务描述，再让同频 AI 重新整理。</small></section> : <p className="tp-ai-tool-plan-hint">先由同频 AI 整理任务，再由你确认生成。</p>}
    <button type="button" className="tp-ai-tool-confirm" disabled={busy || !modelAvailable} onClick={() => void submit()}>{plan ? "确认生成" : "让同频 AI 整理"}</button>
    {!data ? <p role="status">正在检查视频服务…</p> : unavailable ? <p role="status">请管理员启用视频服务并配置密钥。</p> : null}
    {data && !unavailable && !profile ? <p role="status" className="tp-ai-video-error">当前业务档位尚未配置可用的视频能力，请联系管理员。</p> : null}
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
