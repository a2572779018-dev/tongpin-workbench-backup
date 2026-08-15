import type { AppNotification } from "../types";

export interface BossStrongReminderDesktopPayload {
  notificationId: string;
  title: string;
  body: string;
  requireAcknowledgement: true;
  playSound: true;
  soundKey: string;
}

export function bossStrongReminderDesktopPayload(
  notification: AppNotification,
): BossStrongReminderDesktopPayload {
  return {
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    requireAcknowledgement: true,
    playSound: true,
    soundKey: `boss-notification:${notification.id}:${notification.dingCount}`,
  };
}

export function showBossStrongReminderDesktop(
  bridge: { notify(payload: BossStrongReminderDesktopPayload): Promise<boolean> } | undefined,
  notification: AppNotification,
): Promise<boolean> {
  if (!bridge) return Promise.resolve(false);
  return bridge
    .notify(bossStrongReminderDesktopPayload(notification))
    .catch(() => false);
}
