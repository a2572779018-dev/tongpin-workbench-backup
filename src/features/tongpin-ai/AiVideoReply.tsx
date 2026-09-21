import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import type { AiVideoJob } from "../../../shared/aiVideo";
import "./ai-video.css";
import { failedVideoSubmission, restoreVideoRequest } from "./videoRetry";
import type { VideoChatRequest } from "./videoChat";
import { videoBlobCache } from "./mediaCache";
import { saveBlobWithFeedback } from "./downloadFeedback";

const labels: Record<AiVideoJob["status"], string> = { submitting: "正在提交", queued: "排队中", processing: "正在生成视频", completed: "视频已生成", failed: "视频未生成", uncertain: "提交结果待核对，请勿重复生成" };
interface PlaybackState { identity: string; job: AiVideoJob | null; url: string; duration?: number }
function cachedPlayback(account: string, jobId: string): PlaybackState {
  const cached = videoBlobCache.snapshot(account, jobId);
  return { identity: JSON.stringify([account, jobId]), job: cached?.job ?? null, url: cached?.url ?? "", duration: cached?.duration };
}
/** A durable message holds only the job ID. Media and status are fetched with the current account. */
export function AiVideoReply({ jobId, onSettled, savedRequest, submissionError, onEdit, editDisabled }: { jobId: string; onSettled?: () => void; savedRequest?: unknown; submissionError?: string; onEdit?: (request: VideoChatRequest) => void; editDisabled?: boolean }) {
  const { api, session } = useAuth();
  const account = session?.user.id ?? "";
  const identity = JSON.stringify([account, jobId]);
  const element = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLVideoElement>(null);
  const [playback, setPlayback] = useState<PlaybackState>(() => cachedPlayback(account, jobId));
  const shown = playback.identity === identity ? playback : cachedPlayback(account, jobId);
  const { job: serverJob, url, duration } = shown;
  const [missingSubmissionError, setMissingSubmissionError] = useState("");
  const job: AiVideoJob | null = serverJob ?? failedVideoSubmission(savedRequest, submissionError || missingSubmissionError) ?? null;
  const [visible, setVisible] = useState(Boolean(playback.url)), [retry, setRetry] = useState(0);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const restoreLock = useRef(false), restoreAbort = useRef<AbortController | null>(null);
  const editTarget = useRef({ onEdit, editDisabled }); editTarget.current = { onEdit, editDisabled };
  useEffect(() => () => restoreAbort.current?.abort(), [jobId, session?.user.id]);
  useEffect(() => () => {
    if (player.current) videoBlobCache.putCurrentTime(account, jobId, player.current.currentTime);
  }, [account, jobId]);
  async function edit() {
    if (!job || !onEdit || editDisabled || restoreLock.current) return;
    restoreLock.current = true; setRestoring(true); setError("");
    const abort = new AbortController(); restoreAbort.current = abort;
    try {
      const request = await restoreVideoRequest(job, savedRequest, async id => {
        const blob = await api<Blob>(`/api/video-reference/${id}`, { signal: abort.signal }, 30000, "image");
        if (blob.size > 300000) throw Error("参考图大小超出限制");
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
        return `data:image/jpeg;base64,${btoa(binary)}`;
      });
      if (!abort.signal.aborted && !editTarget.current.editDisabled) editTarget.current.onEdit?.(request);
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof ApiRequestError && e.status === 404 ? "旧参考图已过期，无法自动恢复；请重新选择。" : e instanceof Error ? e.message : "无法恢复视频设置"); }
    finally { restoreLock.current = false; if (!abort.signal.aborted) setRestoring(false); }
  }
  const settled = useRef(onSettled); settled.current = onSettled;
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "100px" });
    observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => visible ? videoBlobCache.retain(account, jobId) : undefined, [account, jobId, visible]);
  useEffect(() => {
    if (!visible || submissionError) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const started = Date.now();
    const cached = videoBlobCache.snapshot(account, jobId);
    setPlayback({ identity, job: cached?.job ?? null, url: cached?.url ?? "", duration: cached?.duration }); setError(""); setMissingSubmissionError("");
    const headers = { "X-Tongpin-Account": account };
    const update = (patch: Partial<Omit<PlaybackState, "identity">>) => setPlayback(current => ({ ...(current.identity === identity ? current : cachedPlayback(account, jobId)), ...patch, identity }));
    async function show(next: AiVideoJob) {
      if (!live) return;
      update({ job: next }); setError("");
      if (["completed", "failed", "uncertain"].includes(next.status)) settled.current?.();
      if (next.status === "completed") {
        await videoBlobCache.loadBlob(account, jobId,
          sharedSignal => api<Blob>(`/api/ai/videos/${encodeURIComponent(jobId)}/content`, { headers, signal: sharedSignal }, 130000, "blob"), controller.signal);
        if (!live) return;
        update({ url: videoBlobCache.objectUrl(account, jobId) ?? "", duration: videoBlobCache.snapshot(account, jobId)?.duration });
      }
    }
    async function poll(useWarmTerminal = false) {
      if (!live) return;
      try {
        let next = useWarmTerminal ? videoBlobCache.snapshot(account, jobId)?.job : undefined;
        if (!next) {
          if (document.hidden) { timer = setTimeout(() => void poll(), 15000); return; }
          next = await videoBlobCache.loadJob(account, jobId, async sharedSignal => {
            const result = await api<{ job: AiVideoJob }>(`/api/ai/videos/${encodeURIComponent(jobId)}`, { headers, signal: sharedSignal }, 30000);
            return result.job;
          }, controller.signal, retry > 0 ? 0 : 2000);
        }
        await show(next);
        if (!live || next.status === "completed") return;
        if (["failed", "uncertain"].includes(next.status)) return;
        timer = setTimeout(() => void poll(), 15000);
      } catch (e) {
        if (!live) return;
        // A newly persisted message may precede the one and only POST. Reads never resubmit it.
        if (e instanceof ApiRequestError && e.status === 404 && Date.now() - started < 10000) { timer = setTimeout(() => void poll(), 2000); return; }
        if (e instanceof ApiRequestError && e.status === 404 && savedRequest) {
          setMissingSubmissionError("未查到视频提交记录。原设置和参考图片已保留，可重新编辑并生成。");
          setError("");
          return;
        }
        setError(e instanceof ApiRequestError && e.status === 404 ? "暂未查到提交记录。请核对原任务，不会自动重复生成。" : e instanceof Error ? e.message : "暂时无法读取视频");
      }
    }
    const terminal = cached?.job && ["completed", "failed", "uncertain"].includes(cached.job.status);
    void poll(Boolean(terminal && retry === 0));
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [api, account, identity, jobId, retry, visible, submissionError]);
  useEffect(() => {
    if (!visible || !job || !["submitting", "queued", "processing"].includes(job.status)) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 1000)));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [visible, job?.status, job?.createdAt]);
  const active = job && ["submitting", "queued", "processing"].includes(job.status);
  return <div ref={element} className="tp-ai-video-reply" data-native-cursor>
    <strong role="status">{job ? labels[job.status] : "正在读取视频任务…"}</strong>
    {active ? <><p>已等待 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</p><progress max={100} value={job.progress} aria-label="视频生成进度" /></> : null}
    {job ? <small>{duration ? `实际 ${Number(duration.toFixed(2))}` : job.status === "completed" ? `请求 ${job.seconds}` : job.seconds} 秒 · {job.resolution} · {job.aspectRatio}</small> : null}
    {job && duration && Math.abs(duration - job.seconds) > 1 ? <p role="status">请求 {job.seconds} 秒，服务商实际返回 {Number(duration.toFixed(2))} 秒；不会自动重新生成。</p> : null}
    {job?.error ? <p role="alert">{job.error}</p> : null}
    {onEdit && job && !job.reserved && ["failed", "completed"].includes(job.status) ? <button type="button" disabled={editDisabled || restoring} onClick={() => void edit()}>{restoring ? "正在恢复参考图片…" : "重新编辑并生成"}</button> : null}
    {url && visible ? <><video ref={player} src={url} controls playsInline preload="metadata" onLoadedMetadata={event => {
      const value = event.currentTarget.duration;
      const resumeAt = videoBlobCache.snapshot(account, jobId)?.currentTime ?? 0;
      if (resumeAt > 0 && resumeAt < value - 0.25) event.currentTarget.currentTime = resumeAt;
      if (Number.isFinite(value) && value > 0) { videoBlobCache.putDuration(account, jobId, value); setPlayback(current => ({ ...(current.identity === identity ? current : cachedPlayback(account, jobId)), identity, duration: value })); }
    }} onTimeUpdate={event => videoBlobCache.putCurrentTime(account, jobId, event.currentTarget.currentTime)} aria-label="同频 AI 生成的视频" /><button type="button" onClick={() => {
      const blob = videoBlobCache.get(account, jobId);
      if (blob) void saveBlobWithFeedback(blob, `同频视频-${jobId}.mp4`);
    }}>下载视频</button></> : job?.status === "completed" && !error ? <p>正在读取视频…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {error || job?.status === "uncertain" ? <button type="button" onClick={() => setRetry(value => value + 1)}>重新查询原任务</button> : null}
  </div>;
}
