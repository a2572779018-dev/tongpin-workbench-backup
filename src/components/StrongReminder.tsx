import { useEffect } from "react";
import { BellRing, CheckCheck, Clock3, X } from "lucide-react";
import { formatTime } from "../lib/date";
import { STRONG_REMINDER_AUTO_DISMISS_MS } from "../lib/strongReminder";
import type { AppNotification } from "../types";

export function StrongReminder({
  notification,
  busy,
  error,
  onAcknowledge,
  onDismiss,
}: {
  notification: AppNotification;
  busy: boolean;
  error: string;
  onAcknowledge: () => void;
  onDismiss: (notificationId: string) => void;
}) {
  useEffect(() => {
    const dismiss = () => onDismiss(notification.id);
    const timer = window.setTimeout(
      dismiss,
      STRONG_REMINDER_AUTO_DISMISS_MS,
    );
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [notification.id, notification.dingCount, onDismiss]);

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
              <button
                className="strong-reminder__close"
                type="button"
                aria-label="暂时关闭提醒"
                title="暂时关闭"
                onClick={() => onDismiss(notification.id)}
              >
                <X size={19} />
              </button>
            </div>
          </header>
          <h2 id="strong-reminder-title">{notification.title}</h2>
          <p id="strong-reminder-body">{notification.body}</p>

          <div className="strong-reminder__status">
            <b>3 分钟后再提醒</b>
            <span>30 秒后自动关闭</span>
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

