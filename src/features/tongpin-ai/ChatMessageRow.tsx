import { Check, CheckCircle2, Circle, Copy, FileText, LoaderCircle, Paperclip, TriangleAlert } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import type { AiHarnessTrace } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { AnalysisSummary } from "./AnalysisSummary";
import { AiSourceLink } from "./AiSourceLink";
import { MarkdownReply } from "./MarkdownReply";
import { ReplyWaiting } from "./ReplyWaiting";
import { memberVisibleHarnessSteps } from "./tracePresentation";
import { AiVideoReply } from "./AiVideoReply";
import { MediaTaskReply } from "./MediaTaskReply";
import { GeneratedImageSelectionCard } from "./GeneratedImageSelectionCard";
import { readGeneratedImageSelection } from "./generatedImageSelection";
import type { MediaTaskRun } from "./mediaTaskClient";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";
import type { VideoChatRequest } from "./videoChat";
import { harnessTraceRefresh, harnessTraceRequestId, sameHarnessTrace } from "./runTracePolling";

interface ChatMessageRowProps {
  message: TongpinAIMessage;
  artifact?: TongpinAIArtifact;
  assistantName: string;
  copied: boolean;
  retryable: boolean;
  retryDisabled: boolean;
  onCopy: (message: TongpinAIMessage) => void;
  onOpenArtifact: (artifactId: string) => void;
  onRetry: (messageId: string, mode?: "continue" | "regenerate") => void;
  onVideoSettled?: () => void;
  onMediaTask?: (task: MediaTaskRun) => void;
  onEditVideo?: (request: VideoChatRequest) => void;
  onTraceChange?: (messageId: string, trace: AiHarnessTrace) => void;
  videoEditDisabled?: boolean;
  onSelectGeneratedImage?: (artifactId: string, assetId: string) => Promise<boolean>;
  onCancelGeneratedImageSelection?: (artifactId: string) => Promise<void>;
}

/** Fetches application-owned lifecycle state only. The API never returns raw
 * model reasoning, prompts, provider IDs or credentials. */
function RunTrace({ requestId, initial, onChange }: { requestId?: string; initial: AiHarnessTrace; onChange?: (trace: AiHarnessTrace) => void }) {
  const { api } = useAuth();
  const [trace, setTrace] = useState(initial);
  const [open, setOpen] = useState(initial.status === "running");
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  useEffect(() => { setTrace(current => sameHarnessTrace(current, initial) ? current : initial); }, [initial]);
  useEffect(() => {
    const refreshRequest = harnessTraceRefresh(trace);
    if (!requestId || !refreshRequest) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await api<{ trace: AiHarnessTrace }>(`/api/ai/runs/${encodeURIComponent(requestId)}${refreshRequest.suffix}`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted && !sameHarnessTrace(trace, result.trace)) {
          setTrace(result.trace);
          changeRef.current?.(result.trace);
        }
      } catch {
        // The chat result remains usable when a background status refresh fails.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(refresh, 4_000);
      }
    };
    void refresh();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [api, requestId, trace]);

  const visibleSteps = memberVisibleHarnessSteps(trace);
  if (!visibleSteps.length) return null;
  const label = visibleSteps.some(step => step.kind === "tool" || step.kind === "approval" || step.kind === "result") ? "工具进度" : "任务进度";
  return <details className="tp-ai-run-trace" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    <ol>{visibleSteps.map(step => <li key={step.id} className={`is-${step.status}`}>
      {step.status === "succeeded" ? <CheckCircle2 size={15} aria-hidden="true" /> : step.status === "running" ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : step.status === "failed" ? <TriangleAlert size={15} aria-hidden="true" /> : <Circle size={15} aria-hidden="true" />}
      <span><strong>{step.title}</strong><small>{step.summary}</small></span>
    </li>)}</ol>
  </details>;
}

/** Only the current reply owns its playback updates; older messages remain untouched. */
export const ChatMessageRow = memo(function ChatMessageRow({
  message, artifact, assistantName, copied, retryable, retryDisabled, onCopy, onOpenArtifact, onRetry, onVideoSettled, onMediaTask, onEditVideo, onTraceChange, videoEditDisabled,
  onSelectGeneratedImage, onCancelGeneratedImageSelection,
}: ChatMessageRowProps) {
  const imageSelection = readGeneratedImageSelection(artifact);
  return <article
    data-ai-message-id={message.id}
    className={`tp-ai-message is-${message.role}${message.status === "error" ? " is-error" : ""}`}
    aria-label={message.role === "assistant" ? `${assistantName} 消息` : "你的消息"}
  >
    <div className="tp-ai-message__body">
      {message.role === "assistant" && <header><strong>{assistantName}</strong></header>}
      {message.attachments?.length ? <ul className="tp-ai-message-attachments" aria-label="消息中的附件">
        {message.attachments.map(file => <li key={file.id} className={file.media ? "tp-ai-message-attachment-media" : undefined}>
          <span><Paperclip size={13} aria-hidden="true" />{file.name}</span>
          {file.media ? <><div className="tp-ai-message-frames">{file.media.frames.map((frame, index) => <figure key={index}>
            <img src={frame.dataUrl} alt={`${file.name}${frame.timeSeconds === undefined ? "" : ` ${frame.timeSeconds.toFixed(2)} 秒画面`}`} loading="lazy" />
            {frame.timeSeconds !== undefined ? <figcaption>{frame.timeSeconds.toFixed(2)} 秒</figcaption> : null}
          </figure>)}</div>{file.media.kind === "video" ? <small>仅分析采样画面，不含音频</small> : null}</> : null}
        </li>)}
      </ul> : null}
      {message.status === "thinking" ? <>{message.analysisSummary ? <AnalysisSummary>{message.analysisSummary}</AnalysisSummary> : null}{message.content ? <MarkdownReply content={message.content} /> : null}<ReplyWaiting key={message.id} startedAt={message.startedAt} /></> :
        message.role === "assistant" && message.status !== "error"
          ? <>{message.analysisSummary ? <AnalysisSummary>{message.analysisSummary}</AnalysisSummary> : null}<MarkdownReply content={message.content} typing={message.status === "typing"} /></>
          : <p>{message.content}</p>}
      {imageSelection?.status === "awaiting_selection" && artifact && onSelectGeneratedImage && onCancelGeneratedImageSelection
        ? <GeneratedImageSelectionCard key={artifact.id} assetIds={imageSelection.assetIds} onSelect={assetId => onSelectGeneratedImage(artifact.id, assetId)} onCancel={() => onCancelGeneratedImageSelection(artifact.id)} />
        : artifact?.kind === "参考图片选择" ? null
        : artifact && typeof artifact.data?.mediaTaskRequestId === "string" ? <MediaTaskReply key={artifact.data.mediaTaskRequestId} requestId={artifact.data.mediaTaskRequestId} conversationId={artifact.conversationId} runId={typeof artifact.data.mediaTaskRunId === "string" ? artifact.data.mediaTaskRunId : undefined} intent={artifact.kind === "视频" ? "video" : "image"} submissionError={typeof artifact.data.mediaTaskSubmitError === "string" ? artifact.data.mediaTaskSubmitError : undefined} onTask={onMediaTask} onSettled={onVideoSettled} /> : artifact?.kind === "视频" && typeof artifact.data?.videoJobId === "string" ? <AiVideoReply key={artifact.data.videoJobId} jobId={artifact.data.videoJobId} onSettled={onVideoSettled} savedRequest={artifact.data.videoRequest} submissionError={typeof artifact.data.videoSubmitError === "string" ? artifact.data.videoSubmitError : undefined} onEdit={onEditVideo} editDisabled={videoEditDisabled} /> : artifact && <button type="button" className="tp-ai-artifact-card" aria-label={`打开成果：${artifact.title}`} onClick={() => onOpenArtifact(artifact.id)}>
        <span className="tp-ai-artifact-card__icon"><FileText size={20} /></span>
        <span><small>{artifact.kind}</small><strong>{artifact.title}</strong></span>
        <span className="tp-ai-artifact-card__action">打开</span>
      </button>}
      {message.sources?.length ? <ul className="tp-ai-message-sources" aria-label="参考来源">
        {message.sources.map((source, index) => <AiSourceLink key={`${source.url}-${index}`} source={source} />)}
      </ul> : null}
      {message.role === "assistant" && message.trace ? <RunTrace requestId={harnessTraceRequestId(message)} initial={message.trace} onChange={trace => onTraceChange?.(message.id, trace)} /> : null}
      {message.status === "error" && retryable && <div className="tp-ai-message__controls">
        <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id, message.retryDisposition === "regenerate" ? "regenerate" : undefined)}>{message.retryDisposition === "regenerate" ? "重新生成" : "查询原任务"}</button>
      </div>}
      {message.completion?.state === "partial" ? <div className="tp-ai-message__controls" role="status"><span>回复尚未完成{message.completion.reason === "output_limit" ? "：达到本次输出上限" : "：连接中断"}</span>{message.completion.canContinue ? <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id, "continue")}>继续生成</button> : null}<button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id, "regenerate")}>重新生成</button></div> : null}
      {message.role === "assistant" && message.content && !["thinking", "typing", "error"].includes(message.status ?? "ready") &&
        <div className="tp-ai-message__controls"><button type="button" aria-label={copied ? "已复制回复" : "复制回复"} onClick={() => onCopy(message)}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button></div>}
    </div>
  </article>;
});
