import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StrongReminder } from "../components/StrongReminder";
import type { AppNotification } from "../types";
import { showBossStrongReminderDesktop } from "./bossStrongReminderDesktop";
import { selectLatestStrongReminder } from "./strongReminder";

const fixture: AppNotification = {
  id: "notice-boss-1",
  dispatchId: "dispatch-boss-1",
  senderId: "boss-1",
  recipientId: "member-1",
  title: "今日任务提醒",
  body: "请确认收到",
  requiresAcknowledgement: true,
  deliveredAt: null,
  acknowledgedAt: null,
  dingCount: 2,
  lastDingAt: "2026-08-14T02:00:00.000Z",
  readAt: null,
  createdAt: "2026-08-14T01:00:00.000Z",
};

describe("boss strong reminder desktop regression", () => {
  it("routes an incoming strong reminder through notification:show", async () => {
    const notify = vi.fn(async () => true);
    await expect(showBossStrongReminderDesktop({ notify }, fixture)).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith({
      notificationId: fixture.id,
      title: fixture.title,
      body: fixture.body,
      requireAcknowledgement: true,
      playSound: true,
      soundKey: `boss-notification:${fixture.id}:${fixture.dingCount}`,
    });
  });

  it("keeps the in-app reminder stable when desktop notice IPC fails", async () => {
    const notify = vi.fn(async () => {
      throw new Error("fixture notice window failure");
    });
    await expect(showBossStrongReminderDesktop({ notify }, fixture)).resolves.toBe(false);
  });

  it("selects and renders the expanded alert dialog", () => {
    const selected = selectLatestStrongReminder([fixture]);
    expect(selected).toBe(fixture);
    const markup = renderToStaticMarkup(
      createElement(StrongReminder, {
        notification: selected!,
        busy: false,
        error: "",
        onAcknowledge: () => undefined,
      }),
    );
    expect(markup).toContain('role="alertdialog"');
    expect(markup).toContain("老板强提醒");
    expect(markup).toContain(fixture.title);
    expect(markup).not.toContain("30 秒后自动关闭");
    expect(markup).not.toContain("暂时关闭提醒");
  });
});
