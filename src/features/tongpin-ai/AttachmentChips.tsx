import { FileText, X } from "lucide-react";
import type { AiTextAttachment } from "./attachments";
import "./generated-content.css";

export function AttachmentChips({ attachments, onRemove, onSelectVideoFrame, disabled = false }: {
  attachments: readonly (AiTextAttachment & { warnings?: string[] })[];
  onRemove: (index: number) => void;
  onSelectVideoFrame?: (attachmentIndex: number, frameIndex: number) => void;
  disabled?: boolean;
}) {
  if (!attachments.length) return null;
  return <ul className="tp-ai-file-chips" aria-label="本次消息附件">
    {attachments.map((attachment, index) => <li key={`${attachment.name}-${index}`}>
      {attachment.media ? <img className="tp-ai-file-thumbnail" src={attachment.media.frames[0].dataUrl} alt={`${attachment.name} 预览`} /> : <FileText size={16} aria-hidden="true" />}
      <span><strong>{attachment.name}</strong><small>{attachment.media ? attachment.media.kind === "video" ? `${attachment.media.frames.length} 个采样画面 · 不含音频` : "图片 · 已压缩" : `${attachment.text.length.toLocaleString("zh-CN")} 字符`}</small>
        {attachment.warnings?.map(warning => <small className="tp-ai-file-warning" key={warning}>{warning}</small>)}
      </span>
      {attachment.media?.kind === "video" && onSelectVideoFrame ? <fieldset className="tp-ai-video-frame-picker" disabled={disabled}>
        <legend>选择参考画面 · 仅采样，不含音频</legend>
        <div>{attachment.media.frames.map((frame, frameIndex) => <button type="button" key={frameIndex}
          aria-label={`${attachment.name} ${frame.timeSeconds!.toFixed(2)} 秒参考画面`} aria-pressed={attachment.media!.selectedFrameIndex === frameIndex}
          onClick={() => onSelectVideoFrame(index, frameIndex)}>
          <img src={frame.dataUrl} alt={`${frame.timeSeconds!.toFixed(2)} 秒采样`} />
          <small>{frame.timeSeconds!.toFixed(2)} 秒{attachment.media!.selectedFrameIndex === frameIndex ? " · 已选" : ""}</small>
        </button>)}</div>
      </fieldset> : null}
      <button type="button" disabled={disabled} onClick={() => onRemove(index)} aria-label={`移除附件 ${attachment.name}`}><X size={15} /></button>
    </li>)}
  </ul>;
}
