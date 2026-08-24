import { BellRing, CheckCheck, Clock3 } from "lucide-react";
import { formatTime } from "../lib/date";
import type { AppNotification } from "../types";

export function StrongReminder({
  notification,
  busy,
  error,
  onAcknowledge,
}: {
  notification: AppNotification;
  busy: boolean;
  error: string;
  onAcknowledge: () => void;
}) {
  return (
    <div className="strong-reminder-layer">
      <section
        className="strong-reminder"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="strong-reminder-title"
        aria-describedby="strong-reminder-body"
      >
        <div className="strong-reminder__signal" aria-hidden="true">
          <span />
          <span />
          <BellRing size={42} strokeWidth={2.4} />
        </div>

        <div className="strong-reminder__content">
          <header>
            <strong>老板强提醒</strong>
            <div className="strong-reminder__meta">
              <span>
                <Clock3 size={14} />
                {formatTime(notification.createdAt)}
              </span>
            </div>
          </header>
          <h2 id="strong-reminder-title">{notification.title}</h2>
          <p id="strong-reminder-body">{notification.body}</p>

          <div className="strong-reminder__status">
            {notification.dingCount > 0 && (
              <span>已 Ding {notification.dingCount} 次</span>
            )}
          </div>

          {error && <div className="inline-error">{error}</div>}

          <button
            className="strong-reminder__confirm"
            type="button"
            disabled={busy}
            onClick={onAcknowledge}
          >
            <CheckCheck size={20} />
            {busy ? "正在同步…" : "确认收到"}
          </button>
        </div>
      </section>
    </div>
  );
}
