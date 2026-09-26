import { describe, expect, it, vi } from "vitest";
import { onAdminAiMonitoringNoticeAction, showAdminAiAlertDesktopNotice } from "./adminAiAlertDesktop";

type NoticeAction = Parameters<Parameters<DesktopSessionBridge["onDesktopNoticeAction"]>[0]>[0];

describe("admin AI alert desktop adapter", () => {
  it("sends the alert through the existing Electron notice bridge with the monitoring action", async () => {
    const notify = vi.fn(async () => true);
    const shown = await showAdminAiAlertDesktopNotice({ notificationId: "admin-ai-alert:a1", title: "严重告警", body: "服务：主力服务" }, () => undefined, { notify });
    expect(shown).toBe(true);
    expect(notify).toHaveBeenCalledWith({
      notificationId: "admin-ai-alert:a1",
      title: "严重告警",
      body: "服务：主力服务",
      actionLabel: "查看运行监控",
      action: { type: "open-admin-ai-monitoring" },
    });
  });

  it("swallows bridge failures and never asks for browser notification permission", async () => {
    const notify = vi.fn(async () => { throw new Error("ipc closed"); });
    await expect(showAdminAiAlertDesktopNotice({ notificationId: "x", title: "t", body: "b" }, () => undefined, { notify })).resolves.toBe(false);
    const requestPermission = vi.fn();
    vi.stubGlobal("Notification", Object.assign(vi.fn(), { permission: "default", requestPermission }));
    try {
      await expect(showAdminAiAlertDesktopNotice({ notificationId: "x", title: "t", body: "b" }, () => undefined, undefined)).resolves.toBe(false);
      expect(requestPermission).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("only reacts to the admin monitoring desktop action and unsubscribes", () => {
    let listener: ((action: NoticeAction) => void) | undefined;
    const stop = vi.fn();
    const bridge = {
      notify: vi.fn(async () => true),
      onDesktopNoticeAction: vi.fn((callback: (action: NoticeAction) => void) => { listener = callback; return stop; }),
    };
    const open = vi.fn();
    const unsubscribe = onAdminAiMonitoringNoticeAction(open, bridge);
    listener?.({ type: "open-lora-dashboard", reportDate: "2026-09-26" });
    listener?.({ type: "open-task", taskId: "t1", date: "2026-09-26" } as NoticeAction);
    expect(open).not.toHaveBeenCalled();
    listener?.({ type: "open-admin-ai-monitoring" });
    expect(open).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(stop).toHaveBeenCalled();
    expect(() => onAdminAiMonitoringNoticeAction(open, undefined)()).not.toThrow();
  });
});
