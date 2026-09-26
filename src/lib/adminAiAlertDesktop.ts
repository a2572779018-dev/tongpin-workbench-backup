/**
 * Platform adapters for the admin AI alert watch: per-account dedupe storage and
 * the existing Electron desktop-notice bridge. Kept outside the AI feature folder
 * so AI renderer code never touches browser persistence or the bridge directly.
 * Only alert ids, titles and plain-Chinese summaries pass through here — no
 * session, provider secret or quota data.
 */

export interface AdminAiAlertDesktopNotice {
  notificationId: string;
  title: string;
  body: string;
}

type AdminAiNoticeBridge = Pick<DesktopSessionBridge, "notify"> & Partial<Pick<DesktopSessionBridge, "onDesktopNoticeAction">>;

const desktopBridge = (): AdminAiNoticeBridge | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.tongpin;
  } catch {
    return undefined;
  }
};

/** Account-scoped alert-id storage; null in private mode or when storage is blocked. */
export function adminAiAlertStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Shows a native notice through the existing Electron bridge. In a plain browser it
 * only uses Web Notifications when permission was granted earlier — a background poll
 * never prompts for permission.
 */
export async function showAdminAiAlertDesktopNotice(
  notice: AdminAiAlertDesktopNotice,
  onOpen: () => void,
  bridge: AdminAiNoticeBridge | undefined = desktopBridge(),
): Promise<boolean> {
  if (bridge?.notify) {
    try {
      return await bridge.notify({
        notificationId: notice.notificationId.slice(0, 80),
        title: notice.title,
        body: notice.body,
        actionLabel: "查看运行监控",
        action: { type: "open-admin-ai-monitoring" },
      });
    } catch {
      return false;
    }
  }
  try {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
    const shown = new Notification(notice.title, { body: notice.body, tag: notice.notificationId });
    shown.onclick = () => {
      window.focus();
      onOpen();
      shown.close();
    };
    return true;
  } catch {
    return false;
  }
}

/** Subscribes to clicks on the admin-monitoring desktop notice button. */
export function onAdminAiMonitoringNoticeAction(
  callback: () => void,
  bridge: AdminAiNoticeBridge | undefined = desktopBridge(),
): () => void {
  const stop = bridge?.onDesktopNoticeAction?.(action => {
    if (action.type === "open-admin-ai-monitoring") callback();
  });
  return () => stop?.();
}
