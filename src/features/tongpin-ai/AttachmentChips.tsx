import { FileText, X } from "lucide-react";
import type { AiTextAttachment } from "./attachments";
import "./generated-content.css";

export function AttachmentChips({ attachments, onRemove, disabled = false }: {
  attachments: readonly (AiTextAttachment & { warnings?: string[] })[];
  onRemove: (index: number) => void;
  disabled?: boolean;
}) {
  if (!attachments.length) return null;
  return <ul className="tp-ai-file-chips" aria-label="本次消息附件">
    {attachments.map((attachment, index) => <li key={`${attachment.name}-${index}`}>
      <FileText size={16} aria-hidden="true" />
      <span><strong>{attachment.name}</strong><small>{attachment.text.length.toLocaleString("zh-CN")} 字符</small>
        {attachment.warnings?.map(warning => <small className="tp-ai-file-warning" key={warning}>{warning}</small>)}
      </span>
      <button type="button" disabled={disabled} onClick={() => onRemove(index)} aria-label={`移除附件 ${attachment.name}`}><X size={15} /></button>
    </li>)}
  </ul>;
}
