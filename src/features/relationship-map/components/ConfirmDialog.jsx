import { Trash, Warning, X } from "@phosphor-icons/react";

export function ConfirmDialog({ title, description, onClose, onConfirm }) {
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-description">
        <div className="confirm-dialog__header">
          <span className="confirm-dialog__icon"><Warning size={24} weight="duotone" /></span>
          <button className="icon-button icon-button--small" type="button" onClick={onClose} aria-label="关闭删除确认">
            <X size={18} weight="bold" />
          </button>
        </div>
        <h2 id="confirm-title">{title}</h2>
        <p id="confirm-description">{description}</p>
        <div className="confirm-dialog__actions">
          <button className="secondary-button" type="button" onClick={onClose} autoFocus>取消</button>
          <button className="danger-button" type="button" onClick={onConfirm}>
            <Trash size={18} weight="bold" />确认删除
          </button>
        </div>
      </section>
    </div>
  );
}
