import type { AppNotification } from "../types";

export const STRONG_REMINDER_REPEAT_MS = 3 * 60 * 1_000;
export const STRONG_REMINDER_AUTO_DISMISS_MS = 30 * 1_000;

export function isPendingStrongReminder(
  notification: AppNotification,
): boolean {
  return (
    notification.requiresAcknowledgement &&
    !notification.acknowledgedAt
  );
}

export function selectLatestStrongReminder(
  notifications: AppNotification[],
): AppNotification | null {
  return (
    notifications
      .filter(isPendingStrongReminder)
      .sort((left, right) => {
        const leftActivity = left.lastDingAt ?? left.createdAt;
        const rightActivity = right.lastDingAt ?? right.createdAt;
        return rightActivity.localeCompare(leftActivity);
      })[0] ?? null
  );
}

