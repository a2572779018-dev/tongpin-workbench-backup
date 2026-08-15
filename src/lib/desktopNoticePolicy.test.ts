import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  normalizeDesktopNoticePayload,
  shouldPinAndExpandDesktopNotice,
}: {
  normalizeDesktopNoticePayload(value: unknown): Record<string, unknown> | null;
  shouldPinAndExpandDesktopNotice(value: unknown): boolean;
} = require("../../electron/desktop-notice-policy.cjs");

describe("desktop strong notice regression", () => {
  it("keeps acknowledgement and sound flags through notification:show normalization", () => {
    const normalized = normalizeDesktopNoticePayload({
      notificationId: "boss-notice-1",
      title: "老板强提醒",
      body: "请确认收到",
      requireAcknowledgement: true,
      playSound: true,
      soundKey: "boss-notification:boss-notice-1:2",
    });
    expect(normalized).toMatchObject({
      notificationId: "boss-notice-1",
      requireAcknowledgement: true,
      autoExpand: true,
      playSound: true,
      soundKey: "boss-notification:boss-notice-1:2",
    });
    expect(shouldPinAndExpandDesktopNotice(normalized)).toBe(true);
  });

  it("does not pin an ordinary desktop notice", () => {
    const normalized = normalizeDesktopNoticePayload({ title: "提示", body: "内容" });
    expect(shouldPinAndExpandDesktopNotice(normalized)).toBe(false);
  });

  it("auto-expands the minimized-window LORA action without turning it into a strong reminder", () => {
    const normalized = normalizeDesktopNoticePayload({
      title: "LORA 链数据驾驶舱",
      body: "今日链上报告已就绪",
      action: {
        type: "open-lora-dashboard",
        reportDate: "2026-08-14",
      },
    });
    expect(normalized).toMatchObject({
      requireAcknowledgement: false,
      autoExpand: true,
    });
    expect(shouldPinAndExpandDesktopNotice(normalized)).toBe(false);
  });
});
