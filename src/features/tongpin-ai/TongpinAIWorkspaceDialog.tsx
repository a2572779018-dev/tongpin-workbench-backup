import { AlertTriangle, FolderKanban, MessageSquarePlus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

interface TongpinAINameDialogProps {
  confirmLabel: string;
  description: string;
  initialValue?: string;
  kind: "project" | "conversation";
  label: string;
  title: string;
  unavailableNames?: string[];
  onCancel: () => void;
  onConfirm: (name: string) => void;
}

function trapDialogFocus(
  event: KeyboardEvent,
  dialog: HTMLElement | null,
  onCancel: () => void,
) {
  if (event.key === "Escape") {
    event.preventDefault();
    onCancel();
    return;
  }
  if (event.key !== "Tab" || !dialog) return;

  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function TongpinAINameDialog({
  confirmLabel,
  description,
  initialValue = "",
  kind,
  label,
  title,
  unavailableNames = [],
  onCancel,
  onConfirm,
}: TongpinAINameDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const inputId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const normalizedValue = value.trim();
  const duplicate = unavailableNames.some(
    (name) => name.trim().toLocaleLowerCase("zh-CN") === normalizedValue.toLocaleLowerCase("zh-CN"),
  );
  const error = duplicate ? "这个名称已经存在，请换一个名称。" : "";

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function handleKeyDown(event: KeyboardEvent) {
      trapDialogFocus(event, dialogRef.current, onCancel);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function submitName(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!normalizedValue || duplicate) return;
    onConfirm(normalizedValue);
  }

  const Icon = kind === "project" ? FolderKanban : MessageSquarePlus;

  return (
    <div className="tp-ai-dialog-layer">
      <div
        className="tp-ai-dialog-layer__backdrop"
        aria-hidden="true"
        onClick={onCancel}
      />
      <section
        ref={dialogRef}
        className="tp-ai-workspace-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header>
          <span className="tp-ai-workspace-dialog__icon" aria-hidden="true">
            <Icon size={22} />
          </span>
          <span>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </span>
          <button type="button" aria-label="关闭弹窗" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>

        <form onSubmit={submitName}>
          <label htmlFor={inputId}>{label}</label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={value}
            maxLength={kind === "project" ? 40 : 60}
            aria-invalid={duplicate || undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
            placeholder={kind === "project" ? "例如：九月客户提案" : "例如：整理客户访谈重点"}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) {
                event.preventDefault();
              }
            }}
          />
          {error ? (
            <small id={`${inputId}-error`} role="alert">
              {error}
            </small>
          ) : null}
          <div className="tp-ai-workspace-dialog__actions">
            <button type="button" onClick={onCancel}>
              取消
            </button>
            <button
              type="submit"
              className="is-primary"
              disabled={!normalizedValue || duplicate}
            >
              {confirmLabel}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

interface TongpinAIProjectDeleteDialogProps {
  conversationCount: number;
  projectTitle: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function TongpinAIProjectDeleteDialog({
  conversationCount,
  projectTitle,
  onCancel,
  onConfirm,
}: TongpinAIProjectDeleteDialogProps) {
  return (
    <TongpinAIDeleteDialog
      title={`删除“${projectTitle}”？`}
      description={conversationCount > 0
        ? `项目删除后无法撤销；项目内的 ${conversationCount} 个对话会移入普通对话，对话内容不会删除。`
        : "项目删除后无法撤销。"}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

export function TongpinAIConversationDeleteDialog({
  conversationTitle,
  onCancel,
  onConfirm,
}: {
  conversationTitle: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <TongpinAIDeleteDialog
      title={`删除“${conversationTitle}”？`}
      description="此对话及其中的消息和成果将被删除，无法撤销。"
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function TongpinAIDeleteDialog({ title, description, onCancel, onConfirm }: {
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      trapDialogFocus(event, dialogRef.current, onCancel);
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div className="tp-ai-dialog-layer">
      <div
        className="tp-ai-dialog-layer__backdrop"
        aria-hidden="true"
        onClick={onCancel}
      />
      <section
        ref={dialogRef}
        className="tp-ai-workspace-dialog is-destructive"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <header>
          <span className="tp-ai-workspace-dialog__icon" aria-hidden="true">
            <AlertTriangle size={22} />
          </span>
          <span>
            <h2 id={titleId}>{title}</h2>
            <p id={descriptionId}>{description}</p>
          </span>
          <button type="button" aria-label="关闭弹窗" onClick={onCancel}>
            <X size={18} />
          </button>
        </header>
        <div className="tp-ai-workspace-dialog__actions">
          <button ref={cancelRef} type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" className="is-danger" onClick={onConfirm}>
            确认删除
          </button>
        </div>
      </section>
    </div>
  );
}
