import { Check, Copy, FileText, Paperclip } from "lucide-react";
import { memo, useMemo } from "react";
import type { AiHarnessTrace } from "../../../shared/ai";
import { AiSourceList } from "./AiSourceLink";
import { MarkdownReply } from "./MarkdownReply";
import { ReplyWaiting } from "./ReplyWaiting";
import { ReplyProcess } from "./ReplyProcess";
import { hasReplyProcess } from "./replyProcessModel";
import { AiVideoReply } from "./AiVideoReply";
import { MediaTaskReply } from "./MediaTaskReply";
import { savedVideoChoice } from "./naturalVideoRequest";
import { GeneratedImageSelectionCard } from "./GeneratedImageSelectionCard";
import { readGeneratedImageSelection } from "./generatedImageSelection";
import type { MediaTaskRun } from "./mediaTaskClient";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";
import type { VideoChatRequest } from "./videoChat";
import { aiLiveMotionRef } from "./motion";
import { ReplyCitationScope } from "./ReplyCitation";
import { replyCitations } from "./replyCitations";
import { ReadAloudButton } from "./voice/ReadAloudButton";
import { MemoryUpdateIndicator } from "./MemoryUpdateIndicator";

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
  onMediaTask?: (conversationId: string, requestId: string, task: MediaTaskRun) => void;
  onEditVideo?: (request: VideoChatRequest) => void;
  onTraceChange?: (messageId: string, trace: AiHarnessTrace) => void;
  videoEditDisabled?: boolean;
  onSelectGeneratedImage?: (artifactId: string, assetId: string) => Promise<boolean>;
  onCancelGeneratedImageSelection?: (artifactId: string) => Promise<void>;
}

/** "recover" re-reads a task the server may still hold; without a disposition the
 * record was never saved, so the model was not called and retry just fetches the reply. */
export function retryButtonLabel(disposition: TongpinAIMessage["retryDisposition"]): string {
  return disposition === "regenerate" ? "重新生成" : disposition === "recover" ? "查询原任务" : "重新获取回复";
}

/** Shallow prop equality: with ChatWorkspace's ref-stable callbacks, a
 * streamed delta changes only the in-flight row's `message`, so every settled
 * row bails out. Exported for tests. */
export function chatMessageRowPropsEqual(previous: ChatMessageRowProps, next: ChatMessageRowProps): boolean {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)] as (keyof ChatMessageRowProps)[]);
  for (const key of keys) if (!Object.is(previous[key], next[key])) return false;
  return true;
}

/** Only the current reply owns its playback updates; older messages remain untouched. */
export const ChatMessageRow = memo(function ChatMessageRow({
  message, artifact, assistantName, copied, retryable, retryDisabled, onCopy, onOpenArtifact, onRetry, onVideoSettled, onMediaTask, onEditVideo, onTraceChange, videoEditDisabled,
  onSelectGeneratedImage, onCancelGeneratedImageSelection,
}: ChatMessageRowProps) {
  const imageSelection = readGeneratedImageSelection(artifact);
  // Markers appear only on a settled reply; while text streams it stays plain.
  const settled = message.role === "assistant" && !["thinking", "typing", "error"].includes(message.status ?? "ready");
  const citations = useMemo(() => settled ? replyCitations(message.content, message.citations, message.sources) : undefined,
    [settled, message.content, message.citations, message.sources]);
  // Ordered process parts (plan, public thinking summary, searches, tool call)
  // come only from real run events, the saved process record and linked cards.
  const processShown = message.role === "assistant" && hasReplyProcess(message, artifact);
  return <article
    data-ai-message-id={message.id}
    className={`tp-ai-message is-${message.role}${message.status === "error" ? " is-error" : ""}`}
    aria-label={message.role === "assistant" ? `${assistantName} 消息` : "你的消息"}
  >
    <ReplyCitationScope sources={message.role === "assistant" ? message.sources : undefined}>
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
      {message.role === "assistant" ? <ReplyProcess message={message} artifact={artifact} onTraceChange={onTraceChange} /> : null}
      {message.status === "thinking" ? <>{message.content ? <MarkdownReply content={message.content} streaming /> : null}{!processShown && !message.content ? <ReplyWaiting key={message.id} startedAt={message.startedAt} /> : null}</> :
        message.role === "assistant" && message.status !== "error"
          ? <MarkdownReply content={message.content} typing={message.status === "typing"} citations={citations} />
          : <p>{message.content}</p>}
      {message.artifactId && !artifact ? <button type="button" className="tp-ai-artifact-card" onClick={() => onOpenArtifact(message.artifactId!)}>
        成果暂未加载，点击重试
      </button> : null}
      {message.role === "assistant" ? <div className="tp-ai-message__cards" ref={aiLiveMotionRef}>
      {imageSelection?.status === "awaiting_selection" && artifact && onSelectGeneratedImage && onCancelGeneratedImageSelection
        ? <GeneratedImageSelectionCard key={artifact.id} assetIds={imageSelection.assetIds} onSelect={assetId => onSelectGeneratedImage(artifact.id, assetId)} onCancel={() => onCancelGeneratedImageSelection(artifact.id)} />
        : artifact?.kind === "参考图片选择" ? null
        : artifact && typeof artifact.data?.mediaTaskRequestId === "string" ? <MediaTaskReply key={artifact.data.mediaTaskRequestId} requestId={artifact.data.mediaTaskRequestId} conversationId={artifact.conversationId} runId={typeof artifact.data.mediaTaskRunId === "string" ? artifact.data.mediaTaskRunId : undefined} intent={artifact.kind === "视频" ? "video" : "image"} videoChoice={artifact.kind === "视频" ? savedVideoChoice(artifact.data.videoChoice) : undefined} submissionError={typeof artifact.data.mediaTaskSubmitError === "string" ? artifact.data.mediaTaskSubmitError : undefined} onTask={onMediaTask ? task => onMediaTask(artifact.conversationId, String(artifact.data!.mediaTaskRequestId), task) : undefined} onSettled={onVideoSettled} /> : artifact?.kind === "视频" && typeof artifact.data?.videoJobId === "string" ? <AiVideoReply key={artifact.data.videoJobId} jobId={artifact.data.videoJobId} onSettled={onVideoSettled} savedRequest={artifact.data.videoRequest} submissionError={typeof artifact.data.videoSubmitError === "string" ? artifact.data.videoSubmitError : undefined} onEdit={onEditVideo} editDisabled={videoEditDisabled} /> : artifact && <button type="button" className="tp-ai-artifact-card" aria-label={`打开成果：${artifact.title}`} onClick={() => onOpenArtifact(artifact.id)}>
        <span className="tp-ai-artifact-card__icon"><FileText size={20} /></span>
        <span><small>{artifact.kind}</small><strong>{artifact.title}</strong></span>
        <span className="tp-ai-artifact-card__action">打开</span>
      </button>}
      </div> : null}
      {message.sources?.length ? <AiSourceList sources={message.sources} /> : null}
      {message.status === "error" && retryable && <div className="tp-ai-message__controls">
        <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id, message.retryDisposition === "regenerate" ? "regenerate" : undefined)}>{retryButtonLabel(message.retryDisposition)}</button>
      </div>}
      {message.completion?.state === "partial" ? <div className="tp-ai-message__controls" role="status"><span>回复尚未完成{message.completion.reason === "output_limit" ? "：达到本次输出上限" : "：连接中断"}</span>{message.completion.canContinue ? <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id, "continue")}>继续生成</button> : null}<button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id, "regenerate")}>重新生成</button></div> : null}
      {message.role === "assistant" && message.content && !["thinking", "typing", "error"].includes(message.status ?? "ready") &&
        <div className="tp-ai-message__controls"><button type="button" aria-label={copied ? "已复制回复" : "复制回复"} onClick={() => onCopy(message)}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button><ReadAloudButton messageId={message.id} content={message.content} /></div>}
      {settled && message.requestId ? <MemoryUpdateIndicator requestId={message.requestId} /> : null}
    </div>
    </ReplyCitationScope>
  </article>;
}, chatMessageRowPropsEqual);
