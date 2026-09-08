import { Check, Copy, FileText, Paperclip } from "lucide-react";
import { memo } from "react";
import { AiSourceLink } from "./AiSourceLink";
import { TypewriterText } from "./TypewriterText";
import type { TongpinAIArtifact, TongpinAIMessage } from "./types";

interface ChatMessageRowProps {
  message: TongpinAIMessage;
  artifact?: TongpinAIArtifact;
  assistantName: string;
  copied: boolean;
  retryable: boolean;
  retryDisabled: boolean;
  onCopy: (message: TongpinAIMessage) => void;
  onOpenArtifact: (artifactId: string) => void;
  onRetry: (messageId: string) => void;
}

/** Only the current reply owns its playback updates; older messages remain untouched. */
export const ChatMessageRow = memo(function ChatMessageRow({
  message, artifact, assistantName, copied, retryable, retryDisabled, onCopy, onOpenArtifact, onRetry,
}: ChatMessageRowProps) {
  return <article
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
      {message.status === "thinking" ? <div className="tp-ai-thinking" role="status"><span /><span /><span />正在思考</div> :
        <p className={message.status === "typing" ? "tp-ai-message__typing" : undefined}>
          {message.status === "typing" ? <TypewriterText content={message.content} /> : message.content}
          {message.status === "typing" && <span className="tp-ai-message__typing-caret" aria-hidden="true" />}
        </p>}
      {artifact && <button type="button" className="tp-ai-artifact-card" aria-label={`打开成果：${artifact.title}`} onClick={() => onOpenArtifact(artifact.id)}>
        <span className="tp-ai-artifact-card__icon"><FileText size={20} /></span>
        <span><small>{artifact.kind}</small><strong>{artifact.title}</strong></span>
        <span className="tp-ai-artifact-card__action">打开</span>
      </button>}
      {message.sources?.length ? <ul className="tp-ai-message-sources" aria-label="参考来源">
        {message.sources.map((source, index) => <AiSourceLink key={`${source.url}-${index}`} source={source} />)}
      </ul> : null}
      {message.status === "error" && retryable && <div className="tp-ai-message__controls">
        <button type="button" disabled={retryDisabled} onClick={() => onRetry(message.id)}>重新获取回复</button>
      </div>}
      {message.role === "assistant" && message.content && !["thinking", "typing", "error"].includes(message.status ?? "ready") &&
        <div className="tp-ai-message__controls"><button type="button" aria-label={copied ? "已复制回复" : "复制回复"} onClick={() => onCopy(message)}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button></div>}
    </div>
  </article>;
});
