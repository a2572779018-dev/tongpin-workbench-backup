import { describe, expect, it } from "vitest";
import type { AppNotification } from "../types";
import {
  REALTIME_STABLE_CONNECTION_MS,
  getRealtimeReconnectDelayMs,
  mergeNotificationsById,
  notificationsNeedingDelivery,
  shouldRecoverRealtimeSession,
} from "./realtimeReliability";

function notification(
  id: string,
  overrides: Partial<AppNotification> = {},
): AppNotification {
  return {
    id,
    dispatchId: `dispatch-${id}`,
    senderId: "boss",
    recipientId: "member",
    title: `提醒 ${id}`,
    body: "请确认收到",
    requiresAcknowledgement: true,
    deliveredAt: null,
    acknowledgedAt: null,
    dingCount: 0,
    lastDingAt: null,
    readAt: null,
    createdAt: "2026-08-12T01:00:00.000Z",
    ...overrides,
  };
}

describe("realtime reliability", () => {
  it("uses one minute as the stable-connection threshold", () => {
    expect(REALTIME_STABLE_CONNECTION_MS).toBe(60_000);
  });

  it("merges repeated catch-up results by id without regressing receipts", () => {
    const current = notification("one", {
      deliveredAt: "2026-08-12T01:01:00.000Z",
      dingCount: 2,
      lastDingAt: "2026-08-12T01:02:00.000Z",
    });
    const staleFetch = notification("one");

    const merged = mergeNotificationsById([current], [staleFetch]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: "one",
      deliveredAt: "2026-08-12T01:01:00.000Z",
      dingCount: 2,
      lastDingAt: "2026-08-12T01:02:00.000Z",
    });
  });

  it("keeps every undelivered strong reminder eligible for retry", () => {
    expect(
      notificationsNeedingDelivery([
        notification("pending"),
        notification("delivered", { deliveredAt: "2026-08-12T01:01:00Z" }),
        notification("acknowledged", {
          acknowledgedAt: "2026-08-12T01:02:00Z",
        }),
        notification("ordinary", { requiresAcknowledgement: false }),
      ]).map((item) => item.id),
    ).toEqual(["pending"]);
  });

  it("uses bounded reconnect backoff with jitter", () => {
    expect([0, 1, 2, 3, 8].map((attempt) => getRealtimeReconnectDelayMs(attempt, 0))).toEqual([
      2_000,
      5_000,
      10_000,
      30_000,
      30_000,
    ]);
    expect(getRealtimeReconnectDelayMs(0, 1)).toBe(2_400);
    expect(getRealtimeReconnectDelayMs(3, 1)).toBe(31_000);
  });

  it("detects handshake and authentication closes that need session recovery", () => {
    expect(shouldRecoverRealtimeSession(false, 1006)).toBe(true);
    expect(shouldRecoverRealtimeSession(true, 4000)).toBe(true);
    expect(shouldRecoverRealtimeSession(true, 4001)).toBe(true);
    expect(shouldRecoverRealtimeSession(true, 4401)).toBe(true);
    expect(shouldRecoverRealtimeSession(true, 1006)).toBe(false);
    expect(shouldRecoverRealtimeSession(true, 1000)).toBe(false);
  });
});
