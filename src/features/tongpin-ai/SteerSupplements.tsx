import { X } from "lucide-react";
import { STEER_STATUS_LABELS, type SteerBubble } from "./composerSteer";
import "./steer.css";

/** Supplements typed while a reply runs, shown after that reply as the
 * member's own bubbles. They carry no data-ai-message-id: they are not
 * conversation messages until delivered. */
export function SteerSupplements({ items, onCancel }: { items: readonly SteerBubble[]; onCancel?: (id: string) => void }) {
  return <>{items.map(item => <article key={item.id} data-steer-id={item.id}
    className={`tp-ai-message is-user tp-ai-steer is-${item.status}`} aria-label="你的补充消息">
    <div className="tp-ai-message__body">
      <header className="tp-ai-steer__meta">
        <span className="tp-ai-steer__tag">补充</span>
        <small className="tp-ai-steer__status" role="status">{STEER_STATUS_LABELS[item.status]}</small>
        {onCancel && item.cancellable ? <button type="button" className="tp-ai-steer__cancel" aria-label="撤回这条补充" title="撤回"
          onClick={() => onCancel(item.id)}><X size={13} aria-hidden="true" /></button> : null}
      </header>
      <p>{item.text}</p>
    </div>
  </article>)}</>;
}
