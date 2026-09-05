import {
  FolderKanban,
  MessageSquare,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Trash2,
  Paperclip,
  Save,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TongpinAIConversation, TongpinAIProject } from "./types";
import { TongpinAINotificationButton } from "./TongpinAINotificationButton";
import type { AiWorkspaceDocument } from "../../../shared/aiWorkspace";
import { ATTACHMENT_ACCEPT, extractAttachment, validateAttachments } from "./attachments";
import { AttachmentChips } from "./AttachmentChips";

interface ProjectWorkspaceEmptyProps {
  conversationCount: number;
  conversations: TongpinAIConversation[];
  notificationUnread: number;
  project: TongpinAIProject;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onRenameProject: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onOpenNotifications?: () => void;
  onUpdateContext?: (instructions: string, documents: AiWorkspaceDocument[]) => void | Promise<void>;
}

export function ProjectWorkspaceEmpty({
  conversations,
  notificationUnread,
  project,
  sidebarCollapsed,
  onToggleSidebar,
  onNewConversation,
  onSelectConversation,
  onRenameProject,
  onDeleteProject,
  onOpenNotifications,
  onUpdateContext,
}: ProjectWorkspaceEmptyProps) {
  const projectConversations = conversations.filter(
    (item) => item.projectId === project.id,
  );
  return (
    <section
      className="tp-ai-project-workspace"
      aria-labelledby="tp-ai-project-title"
    >
      <header>
        <span className="tp-ai-project-workspace__title">
          {onToggleSidebar ? (
            <button
              type="button"
              className="tp-ai-sidebar-toggle"
              aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              onClick={onToggleSidebar}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen size={18} />
              ) : (
                <PanelLeftClose size={18} />
              )}
            </button>
          ) : null}
          <strong id="tp-ai-project-title" tabIndex={-1}>
            {project.title}
          </strong>
        </span>
        <div className="tp-ai-project-workspace__actions">
          <button
            type="button"
            aria-label="重命名项目"
            title="重命名项目"
            onClick={() => onRenameProject(project.id)}
          >
            <Pencil size={16} />
          </button>
          <button
            type="button"
            aria-label="删除项目"
            title="删除项目"
            onClick={() => onDeleteProject(project.id)}
          >
            <Trash2 size={16} />
          </button>
          <TongpinAINotificationButton
            unread={notificationUnread}
            onClick={onOpenNotifications}
          />
        </div>
      </header>
      {onUpdateContext ? <ProjectContextEditor key={project.id} project={project} onUpdateContext={onUpdateContext} /> : null}
      {projectConversations.length === 0 ? (
        <div className="tp-ai-project-workspace__empty">
          <span className="tp-ai-project-workspace__icon" aria-hidden="true">
            <FolderKanban size={34} strokeWidth={2.2} />
          </span>
          <h2>这个项目还是空的</h2>
          <button type="button" onClick={onNewConversation}>
            <MessageSquarePlus size={18} />
            在项目内新建对话
          </button>
        </div>
      ) : (
        <div className="tp-ai-project-workspace__content">
          <div className="tp-ai-project-workspace__list-heading">
            <h2>
              项目对话 <small>{projectConversations.length}</small>
            </h2>
            <button type="button" onClick={onNewConversation}>
              <MessageSquarePlus size={17} />
              新建对话
            </button>
          </div>
          <div className="tp-ai-project-workspace__conversation-list">
            {projectConversations.map((conversation) => {
              const latestMessage = conversation.messages.at(-1)?.content;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => onSelectConversation(conversation.id)}
                >
                  <MessageSquare size={19} aria-hidden="true" />
                  <span>
                    <strong>{conversation.title}</strong>
                    <small>{latestMessage || "暂无消息"}</small>
                  </span>
                  <time>{conversation.timeLabel}</time>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

function ProjectContextEditor({ project, onUpdateContext }: {
  project: TongpinAIProject;
  onUpdateContext: (instructions: string, documents: AiWorkspaceDocument[]) => void | Promise<void>;
}) {
  const [instructions, setInstructions] = useState(project.instructions ?? "");
  const [documents, setDocuments] = useState<AiWorkspaceDocument[]>(project.contextDocuments ?? []);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!dirty) { setInstructions(project.instructions ?? ""); setDocuments(project.contextDocuments ?? []); }
  }, [project.instructions, project.contextDocuments, dirty]);
  async function addDocuments(files: File[]) {
    if (busyRef.current || !files.length) return;
    if (files.length + documents.length > 5) { setError("项目最多添加 5 份共享资料"); return; }
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const extracted: Awaited<ReturnType<typeof extractAttachment>>[] = [];
      for (const file of files) extracted.push(await extractAttachment(file));
      validateAttachments([...documents.map(file => ({ name: file.name, text: file.content, mediaType: file.mimeType })), ...extracted]);
      setDocuments(current => [...current, ...extracted.map(file => ({ id: crypto.randomUUID(), name: file.name, mimeType: file.mediaType, content: file.text, createdAt: new Date().toISOString() }))]);
      setDirty(true);
      const warnings = extracted.flatMap(file => file.warnings.map(warning => `${file.name}：${warning}`));
      if (warnings.length) setNotice(warnings.join("；"));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "读取项目资料失败"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  async function save() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await onUpdateContext(instructions.trim(), documents);
      setDirty(false); setNotice("项目资料已应用");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存失败，请重试"); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <details className="tp-ai-project-context">
    <summary>项目资料{documents.length ? ` · ${documents.length} 份文件` : ""}{dirty ? " · 未保存" : ""}</summary>
    <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label>项目说明<textarea value={instructions} rows={4} maxLength={12000} disabled={busy} placeholder="填写项目背景、目标或统一要求，供项目内的对话参考。" onChange={event => { setInstructions(event.target.value); setDirty(true); setNotice(""); }} /></label>
      <AttachmentChips attachments={documents.map(file => ({ name: file.name, text: file.content, mediaType: file.mimeType }))} disabled={busy} onRemove={index => { setDocuments(current => current.filter((_, item) => item !== index)); setDirty(true); setNotice(""); }} />
      <input ref={fileInput} hidden type="file" multiple accept={ATTACHMENT_ACCEPT} onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void addDocuments(files); }} />
      {error ? <p role="alert" className="tp-ai-generated-error">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <footer><button type="button" disabled={busy || documents.length >= 5} onClick={() => fileInput.current?.click()}><Paperclip size={16} />添加资料</button>
        <button type="submit" disabled={busy || !dirty}><Save size={16} />{busy ? "处理中…" : "保存项目资料"}</button>
      </footer>
    </form>
  </details>;
}
