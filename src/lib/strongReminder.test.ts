import { describe, expect, it } from "vitest";
import type { AppNotification } from "../types";
import {
  STRONG_REMINDER_REPEAT_MS,
  selectLatestStrongReminder,
} from "./strongReminder";

function notification(
  value: Partial<AppNotification> & Pick<AppNotification, "id">,
): AppNotification {
  const { id, ...overrides } = value;
  return {
    id,
    dispatchId: "dispatch-1",
    senderId: "boss-1",
    recipientId: "member-1",
    title: "强提醒",
    body: "请确认",
    readAt: null,
    requiresAcknowledgement: true,
    deliveredAt: null,
    acknowledgedAt: null,
    dingCount: 0,
    lastDingAt: null,
    createdAt: "2026-07-29T01:00:00.000Z",
    ...overrides,
  };
}

describe("strong reminder lifecycle", () => {
  it("keeps the three minute server re-alert interval", () => {
    expect(STRONG_REMINDER_REPEAT_MS).toBe(180_000);
  });

  it("shows a new Ding before older pending reminders", () => {
    const selected = selectLatestStrongReminder([
      notification({
        id: "new-message",
        createdAt: "2026-07-29T02:00:00.000Z",
      }),
      notification({
        id: "dinged-message",
        createdAt: "2026-07-29T01:00:00.000Z",
        dingCount: 1,
        lastDingAt: "2026-07-29T03:00:00.000Z",
      }),
      notification({
        id: "acknowledged-message",
        acknowledgedAt: "2026-07-29T03:01:00.000Z",
      }),
    ]);

    expect(selected?.id).toBe("dinged-message");
  });
});
