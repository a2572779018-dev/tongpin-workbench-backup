import type { AiWorkspaceStorageUsage } from "../../../shared/aiWorkspace";
import {
  formatWorkspaceMegabytes,
  workspaceStorageHint,
  workspaceStorageLabel,
  workspaceStorageLevel,
  workspaceStoragePercent,
  type WorkspaceConversationSize,
} from "./workspaceStorage";

/** Small sidebar meter for the V1 whole-account snapshot. Informational only. */
export function WorkspaceStorageMeter({ storage }: { storage: AiWorkspaceStorageUsage | null }) {
  if (!storage) return null;
  const level = workspaceStorageLevel(storage);
  const percent = workspaceStoragePercent(storage);
  const label = workspaceStorageLabel(storage);
  const hint = workspaceStorageHint(level);
  return (
    <div className={`tp-ai-storage-meter is-${level}`} title={hint}
      role={level === "normal" ? undefined : "status"} data-level={level}>
      <div className="tp-ai-storage-meter__row">
        <span>{label}</span>
        <small>{percent}%</small>
      </div>
      <div className="tp-ai-storage-meter__bar" role="meter" aria-label="云端资料空间"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={label}>
        <span style={{ width: `${percent}%` }} />
      </div>
      {level !== "normal" ? <p className="tp-ai-storage-meter__hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Lists the largest conversations when a save is (or would be) rejected for space.
 * Both actions only open the existing delete confirmation; nothing is deleted automatically.
 */
export function WorkspaceStorageRelief({ items, onDelete, onExportThenDelete }: {
  items: readonly WorkspaceConversationSize[];
  onDelete: (conversationId: string) => void;
  onExportThenDelete: (conversationId: string) => void;
}) {
  if (!items.length) return null;
  return (
    <div className="tp-ai-storage-relief">
      <p>占用最多的对话（删除前会再次确认，建议先导出备份）：</p>
      <ul>
        {items.map(item => (
          <li key={item.id}>
            <span className="tp-ai-storage-relief__title" title={item.title}>{item.title || "未命名对话"}</span>
            <small>约 {formatWorkspaceMegabytes(item.bytes)} MB · {item.messageCount} 条消息{item.attachmentCount ? ` · ${item.attachmentCount} 个附件` : ""}</small>
            <span className="tp-ai-storage-relief__actions">
              <button type="button" onClick={() => onExportThenDelete(item.id)} aria-label={`导出后删除 ${item.title}`}>导出后删除</button>
              <button type="button" onClick={() => onDelete(item.id)} aria-label={`删除 ${item.title}`}>删除</button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
