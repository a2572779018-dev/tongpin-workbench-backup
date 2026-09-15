import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import type { AiVideoJob } from "../../../shared/aiVideo";
import "./ai-video.css";
import { restoreVideoRequest } from "./videoRetry";
import type { VideoChatRequest } from "./videoChat";

const labels: Record<AiVideoJob["status"], string> = { submitting: "正在提交", queued: "排队中", processing: "正在生成视频", completed: "视频已生成", failed: "视频未生成", uncertain: "提交结果待核对，请勿重复生成" };
/** A durable message holds only the job ID. Media and status are fetched with the current account. */
export function AiVideoReply({ jobId, onSettled, savedRequest, onEdit, editDisabled }: { jobId: string; onSettled?: () => void; savedRequest?: unknown; onEdit?: (request: VideoChatRequest) => void; editDisabled?: boolean }) {
  const { api, session } = useAuth();
  const element = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false), [retry, setRetry] = useState(0);
  const [job, setJob] = useState<AiVideoJob | null>(null), [error, setError] = useState("");
  const [url, setUrl] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const restoreLock = useRef(false), restoreAbort = useRef<AbortController | null>(null);
  const editTarget = useRef({ onEdit, editDisabled }); editTarget.current = { onEdit, editDisabled };
  useEffect(() => () => restoreAbort.current?.abort(), [jobId, session?.user.id]);
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
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof ApiRequestError && e.status === 404 ? "旧参考图已过期，无法自动恢复；请重新选择。新版保存的参考图将随对话保留。" : e instanceof Error ? e.message : "无法恢复视频设置"); }
    finally { restoreLock.current = false; if (!abort.signal.aborted) setRestoring(false); }
  }
  const settled = useRef(onSettled); settled.current = onSettled;
  useEffect(() => {
    if (!element.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)), { rootMargin: "100px" });
    observer.observe(element.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, objectUrl = "";
    const controller = new AbortController();
    const started = Date.now();
    setJob(null); setError(""); setUrl("");
    const headers = { "X-Tongpin-Account": session?.user.id ?? "" };
    async function poll() {
      if (!live) return;
      if (document.hidden) { timer = setTimeout(poll, 15000); return; }
      try {
        const { job: next } = await api<{ job: AiVideoJob }>(`/api/ai/videos/${encodeURIComponent(jobId)}`, { headers, signal: controller.signal }, 30000);
        if (!live) return;
        setJob(next); setError("");
        if (["completed", "failed", "uncertain"].includes(next.status)) settled.current?.();
        if (next.status === "completed") {
          const blob = await api<Blob>(`/api/ai/videos/${encodeURIComponent(jobId)}/content`, { headers, signal: controller.signal }, 130000, "blob");
          if (!live) return;
          objectUrl = URL.createObjectURL(blob); setUrl(objectUrl);
          return;
        }
        if (["failed", "uncertain"].includes(next.status)) return;
        timer = setTimeout(poll, 15000);
      } catch (e) {
        if (!live) return;
        // A newly persisted message may precede the one and only POST. Reads never resubmit it.
        if (e instanceof ApiRequestError && e.status === 404 && Date.now() - started < 120000) { timer = setTimeout(poll, 15000); return; }
        setError(e instanceof ApiRequestError && e.status === 404 ? "暂未查到提交记录。请核对原任务，不会自动重复生成。" : e instanceof Error ? e.message : "暂时无法读取视频");
      }
    }
    void poll();
    return () => { live = false; controller.abort(); clearTimeout(timer); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [api, session?.user.id, jobId, retry, visible]);
  useEffect(() => {
    if (!visible || !job || !["submitting", "queued", "processing"].includes(job.status)) return;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(job.createdAt)) / 1000)));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [visible, job?.status, job?.createdAt]);
  const active = job && ["submitting", "queued", "processing"].includes(job.status);
  return <div ref={element} className="tp-ai-video-reply" data-native-cursor>
    <strong role="status">{job ? labels[job.status] : "正在读取视频任务…"}</strong>
    {active ? <><p>已等待 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒</p><progress max={100} value={job.progress} aria-label="视频生成进度" /></> : null}
    {job ? <small>{job.seconds} 秒 · {job.resolution} · {job.aspectRatio}</small> : null}
    {job?.error ? <p role="alert">{job.error}</p> : null}
    {onEdit && job && !job.reserved && ["failed", "completed"].includes(job.status) ? <button type="button" disabled={editDisabled || restoring} onClick={() => void edit()}>{restoring ? "正在恢复参考图片…" : "重新编辑并生成"}</button> : null}
    {url && visible ? <><video src={url} controls playsInline preload="metadata" aria-label="同频 AI 生成的视频" /><a href={url} download={`同频视频-${jobId}.mp4`}>下载视频</a></> : job?.status === "completed" && !error ? <p>正在加载播放器…</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {error || job?.status === "uncertain" ? <button type="button" onClick={() => setRetry(value => value + 1)}>重新查询原任务</button> : null}
  </div>;
}
