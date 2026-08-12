import type { AppNotification } from "../types";

export const REALTIME_READY_TIMEOUT_MS = 10_000;
export const REALTIME_HEARTBEAT_INTERVAL_MS = 25_000;
export const REALTIME_HEARTBEAT_TIMEOUT_MS = 10_000;
export const REALTIME_STABLE_CONNECTION_MS = 60_000;

const REALTIME_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];
const REALTIME_SESSION_RECOVERY_CLOSE_CODES = new Set([4000, 4001, 4401]);

function latestTimestamp(
  left: string | null,
  right: string | null,
): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function mergeNotification(
  current: AppNotification,
  incoming: AppNotification,
): AppNotification {
  return {
    ...current,
    ...incoming,
    deliveredAt: latestTimestamp(current.deliveredAt, incoming.deliveredAt),
    acknowledgedAt: latestTimestamp(
      current.acknowledgedAt,
      incoming.acknowledgedAt,
    ),
    readAt: latestTimestamp(current.readAt, incoming.readAt),
    dingCount: Math.max(current.dingCount, incoming.dingCount),
    lastDingAt: latestTimestamp(current.lastDingAt, incoming.lastDingAt),
  };
}

export function mergeNotificationsById(
  current: AppNotification[],
  incoming: AppNotification[],
): AppNotification[] {
  const byId = new Map(current.map((notification) => [notification.id, notification]));
  for (const notification of incoming) {
    const existing = byId.get(notification.id);
    byId.set(
      notification.id,
      existing ? mergeNotification(existing, notification) : notification,
    );
  }
  return [...byId.values()].sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export function notificationsNeedingDelivery(
  notifications: AppNotification[],
): AppNotification[] {
  return notifications.filter(
    (notification) =>
      notification.requiresAcknowledgement &&
      !notification.deliveredAt &&
      !notification.acknowledgedAt,
  );
}

export function getRealtimeReconnectDelayMs(
  attempt: number,
  randomValue = Math.random(),
): number {
  const normalizedAttempt = Math.max(0, Math.floor(attempt));
  const base =
    REALTIME_RECONNECT_DELAYS_MS[
      Math.min(normalizedAttempt, REALTIME_RECONNECT_DELAYS_MS.length - 1)
    ];
  const boundedRandom = Math.max(0, Math.min(1, randomValue));
  return base + Math.round(Math.min(1_000, base * 0.2) * boundedRandom);
}

export function shouldRecoverRealtimeSession(
  reachedReady: boolean,
  closeCode: number,
): boolean {
  return (
    !reachedReady || REALTIME_SESSION_RECOVERY_CLOSE_CODES.has(closeCode)
  );
}
