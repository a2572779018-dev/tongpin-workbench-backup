import { useEffect, useRef, useState, type FormEvent } from "react";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import { AiVideoReply } from "./AiVideoReply";
import { ImageArtifact } from "./ImageArtifact";
import { mediaCacheScope, videoBlobCache } from "./mediaCache";
import { mediaTaskReadInvalidatesSnapshot, mediaTaskSnapshotCache } from "./mediaTaskSnapshotCache";
import {
  mediaTaskAnswerPath,
  mediaTaskAuthorizationAmount,
  mediaTaskAuthorizePath,
  mediaTaskCancelPath,
  mediaTaskImageIds,
  mediaTaskIsSettled,
  mediaTaskNeedsPolling,
  mediaTaskReadPath,
  mediaTaskStatusText,
  parseMediaTaskResponse,
  type MediaTaskIntent,
  type MediaTaskRun,
} from "./mediaTaskClient";
import "./media-task-reply.css";

export interface MediaTaskReplyProps {
  requestId: string;
  conversationId: string;
  runId?: string;
  intent: MediaTaskIntent;
  /** Only definite non-submission, never a timeout or unknown POST outcome. */
  submissionError?: string;
  onTask?: (task: MediaTaskRun) => void;
  onSettled?: () => void;
  onError?: (message: string) => void;
}

interface TaskView {
  identity: string;
  task: MediaTaskRun | null;
  error: string;
  loading: boolean;
}

function FreeQuestionForm({ question, busy, onAnswer }: {
  question: NonNullable<MediaTaskRun["freeQuestion"]>;
  busy: boolean;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const expired = Date.now() >= question.deadlineAt;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && !expired && answer.trim() && answer.trim().length <= 2000) void onAnswer(answer.trim());
  };
  return <form className="tp-ai-media-task-question" onSubmit={submit}>
    <label htmlFor={`media-task-answer-${question.questionId}`}>{question.prompt}</label>
    <textarea id={`media-task-answer-${question.questionId}`} value={answer} onChange={event => setAnswer(event.target.value)} maxLength={2000} disabled={busy || expired} rows={3} />
    {expired ? <small role="status">回答期限已过，正在核对原任务。</small> : null}
    <button type="submit" disabled={busy || expired || !answer.trim()}>{busy ? "正在提交回答…" : "发送补充信息"}</button>
  </form>;
}

/** Rehydrate by the original idempotent request ID. Polls are GET-only and
 * never create a second billable media request after a refresh or timeout. */
export function MediaTaskReply({ requestId, conversationId, runId, intent, submissionError, onTask, onSettled, onError }: MediaTaskReplyProps) {
  const { api, session } = useAuth();
  const accountId = session?.user.id ?? "";
  const scope = mediaCacheScope(session);
  const identity = JSON.stringify([scope, conversationId, requestId, intent, runId ?? "", submissionError ?? ""]);
  const expected = { requestId, runId, conversationId, accountId, intent };
  // A prior task is not authorization for this mount. Its media remains hidden
  // until the current session's GET confirms access to the original request.
  const [view, setView] = useState<TaskView>({ identity, task: null, error: "", loading: true });
  const [busy, setBusy] = useState(false);
  const [authorizationUncertain, setAuthorizationUncertain] = useState(false);
  const [retry, setRetry] = useState(0);
  const shown = view.identity === identity ? view : { identity, task: null, error: "", loading: true };
  const latest = useRef<{ identity: string; task: MediaTaskRun | null }>({ identity, task: null });
  const lastNotified = useRef("");
  const settledNotified = useRef("");
  const callbacks = useRef({ onTask, onSettled, onError });
  callbacks.current = { onTask, onSettled, onError };
  const activeIdentity = useRef(identity);
  activeIdentity.current = identity;
  const mounted = useRef(false);
  const updateAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; updateAbort.current?.abort(); };
  }, [identity]);

  function acceptTask(task: MediaTaskRun) {
    if (!mounted.current || activeIdentity.current !== identity) return;
    if (latest.current.identity !== identity) latest.current = { identity, task: null };
    if (latest.current.task && task.version < latest.current.task.version) return;
    latest.current.task = task;
    setView({ identity, task, error: "", loading: false });
    if (task.status !== "awaiting_authorization") setAuthorizationUncertain(false);
    const signature = `${identity}:${task.runId}:${task.version}:${task.status}`;
    if (lastNotified.current !== signature) {
      lastNotified.current = signature;
      callbacks.current.onTask?.(task);
    }
    if (mediaTaskIsSettled(task.status) && settledNotified.current !== `${identity}:${task.runId}:${task.status}`) {
      settledNotified.current = `${identity}:${task.runId}:${task.status}`;
      callbacks.current.onSettled?.();
    }
  }

  useEffect(() => {
    if (latest.current.identity !== identity) {
      latest.current = { identity, task: null };
      setAuthorizationUncertain(false);
    }
    setView(current => current.identity === identity && current.task
      ? { ...current, error: "" }
      : { identity, task: null, error: submissionError ?? "", loading: !submissionError });
    if (latest.current.task === null) setBusy(false);
    if (submissionError) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const headers = { "X-Tongpin-Account": accountId };
    async function poll() {
      if (controller.signal.aborted || !accountId) return;
      try {
        const response = await api<unknown>(mediaTaskReadPath(requestId), { headers, signal: controller.signal }, 30_000);
        if (controller.signal.aborted || activeIdentity.current !== identity) return;
        const task = parseMediaTaskResponse(response, expected);
        acceptTask(task);
        if (mediaTaskNeedsPolling(task.status)) timer = setTimeout(() => void poll(), document.hidden ? 15_000 : 4_000);
      } catch (caught) {
        if (controller.signal.aborted || activeIdentity.current !== identity) return;
        if (caught instanceof ApiRequestError && caught.status === 404 && !latest.current.task && Date.now() - started < 12_000) {
          timer = setTimeout(() => void poll(), 2_000);
          return;
        }
        const invalid = mediaTaskReadInvalidatesSnapshot(caught);
        if (invalid) {
          mediaTaskSnapshotCache.clear();
          videoBlobCache.clear();
          latest.current = { identity, task: null };
        }
        const message = caught instanceof ApiRequestError && caught.status === 404
          ? "暂未查到原任务。请核对提交状态，不会自动重复生成。"
          : caught instanceof Error ? caught.message : "暂时无法读取原任务";
        setView(current => ({ identity, task: invalid ? null : current.identity === identity ? current.task : null, error: message, loading: false }));
        callbacks.current.onError?.(message);
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [accountId, api, conversationId, identity, intent, requestId, retry, runId, submissionError]);

  async function updateTask(path: string, body: Record<string, unknown>, paidConfirmation = false, method: "POST" | "DELETE" = "POST") {
    if (!accountId || busy || !shown.task) return;
    setBusy(true);
    setView(current => ({ ...current, error: "" }));
    const controller = new AbortController(); updateAbort.current = controller;
    try {
      const response = await api<unknown>(path, {
        method,
        headers: { "X-Tongpin-Account": accountId },
        body: JSON.stringify(body),
        signal: controller.signal,
      }, 30_000);
      if (controller.signal.aborted || !mounted.current || activeIdentity.current !== identity) return;
      const task = parseMediaTaskResponse(response, { requestId, runId: shown.task.runId, conversationId, accountId, intent });
      acceptTask(task);
      // The server's scheduler owns subsequent execution. A GET merely
      // observes it; a second POST could bill twice.
      setRetry(current => current + 1);
    } catch (caught) {
      if (controller.signal.aborted || !mounted.current || activeIdentity.current !== identity) return;
      if (mediaTaskReadInvalidatesSnapshot(caught)) {
        mediaTaskSnapshotCache.clear(); videoBlobCache.clear();
        latest.current = { identity, task: null };
        setView(current => ({ ...current, task: null }));
      }
      if (paidConfirmation && (!(caught instanceof ApiRequestError) || ![400, 401, 402, 403, 404, 409, 413, 429].includes(caught.status))) setAuthorizationUncertain(true);
      const message = caught instanceof Error ? caught.message : "暂时无法更新原任务";
      setView(current => ({ ...current, error: message }));
      callbacks.current.onError?.(message);
    } finally {
      if (updateAbort.current === controller) updateAbort.current = null;
      if (mounted.current && activeIdentity.current === identity) setBusy(false);
    }
  }

  const task = shown.task;
  const amount = task ? mediaTaskAuthorizationAmount(task) : null;
  const imageIds = task ? mediaTaskImageIds(task) : [];
  const videoJobId = task?.status === "completed" && intent === "video" ? task.tool?.serviceRequestId : undefined;
  const freeQuestion = task?.status === "awaiting_input" ? task.freeQuestion : undefined;
  if (submissionError) return <section className="tp-ai-media-task-reply" aria-label="媒体生成任务" data-native-cursor>
    <strong role="status">任务未提交</strong><p role="alert">{submissionError}</p>
  </section>;
  return <section className="tp-ai-media-task-reply" aria-label="媒体生成任务" data-native-cursor>
    <strong role="status">{!accountId ? "请登录后查询原任务" : task ? mediaTaskStatusText(task.status, intent) : shown.loading ? "正在查询原任务…" : "原任务暂时无法核对"}</strong>
    {task?.status === "planning" ? <p>正在核对方案和参考素材，尚未开始生成。</p> : null}
    {freeQuestion && freeQuestion.answer === undefined && task
      ? <FreeQuestionForm key={freeQuestion.questionId} question={freeQuestion} busy={busy} onAnswer={answer => updateTask(mediaTaskAnswerPath(task.runId), { questionId: freeQuestion.questionId, answer })} />
      : null}
    {task?.status === "awaiting_authorization" ? <div className="tp-ai-media-task-authorization">
      <p>{task.authorization ? "额度已确认，服务端正在接续原任务；不会重复确认。" : authorizationUncertain ? "确认结果待核对，请只查询原任务，不要再次确认生成。" : amount === null ? "无法核对预计额度，请重新查询原任务。" : `本次预计最多使用 ${amount} 点；确认后才会开始生成，最终扣费由服务端核对。`}</p>
      <button type="button" disabled={busy || amount === null || authorizationUncertain} onClick={() => {
        if (amount !== null) void updateTask(mediaTaskAuthorizePath(task.runId), { confirmed: true, maxPointsPerTool: amount }, true);
      }}>{busy ? "正在确认…" : "确认额度并生成"}</button>
    </div> : null}
    {task?.status === "partial" && imageIds.length ? <p>以下是目前可读取的部分图片，任务尚未完成。</p> : null}
    {imageIds.map((assetId, index) => <ImageArtifact key={assetId} assetId={assetId} title={task?.status === "partial" ? `部分结果 ${index + 1}` : `生成图片 ${index + 1}`} />)}
    {videoJobId ? <AiVideoReply key={videoJobId} jobId={videoJobId} /> : null}
    {task?.status === "completed" && !videoJobId && !imageIds.length ? <p role="alert">任务已标记完成，但未返回可显示的成果；请核对原任务。</p> : null}
    {task?.status === "failed" ? <p>本次任务未完成，不会自动重新生成。</p> : null}
    {task?.status === "unknown" ? <p>服务端尚无法确认结果。请只查询原任务，不要重新发送生成请求。</p> : null}
    {task?.cancelRequested && !["completed", "failed", "cancelled"].includes(task.status) ? <p role="status">已请求停止，服务商结果与费用仍需核对；不会自动重新生成。</p> : null}
    {task?.status === "cancelled" ? <p>此任务已取消，未开始新的生成请求。</p> : null}
    {task && !["completed", "failed", "cancelled"].includes(task.status) && !task.cancelRequested
      ? <button type="button" disabled={busy} onClick={() => void updateTask(mediaTaskCancelPath(task.runId), {}, false, "DELETE")}>{busy ? "正在请求停止…" : "请求停止任务"}</button> : null}
    {shown.error ? <p role="alert">{shown.error}</p> : null}
    {shown.error || task?.status === "unknown" ? <button type="button" disabled={busy} onClick={() => setRetry(current => current + 1)}>重新查询原任务</button> : null}
  </section>;
}
