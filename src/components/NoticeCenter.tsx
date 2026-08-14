import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  CheckCircle2,
  Download,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  RELEASE_ANNOUNCEMENT_STORAGE_KEY,
  formatReleaseAnnouncementBody,
  getReleaseAnnouncement,
  shouldShowReleaseAnnouncement,
} from "../lib/releaseAnnouncement";

export type NoticeTone = "info" | "success" | "warning" | "error" | "update";

export interface NoticeAction {
  label: string;
  emphasis?: "primary" | "secondary" | "danger";
  closeOnSelect?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface NoticeInput {
  id?: string;
  title: string;
  body: string;
  tone?: NoticeTone;
  progress?: number;
  duration?: number;
  dismissible?: boolean;
  activate?: boolean;
  autoExpand?: boolean;
  actions?: NoticeAction[];
  onDismiss?: () => void;
}

interface NoticeRecord extends Omit<NoticeInput, "id"> {
  id: string;
  createdAt: number;
}

interface ConfirmNoticeInput {
  title: string;
  body: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: NoticeTone;
}

interface NoticeCenterValue {
  notify(input: NoticeInput): string;
  dismiss(id: string): void;
  confirm(input: ConfirmNoticeInput): Promise<boolean>;
}

const NoticeCenterContext = createContext<NoticeCenterValue | null>(null);
const NOTICE_EVENT = "tongpin:notice";
export const INSTALL_UPDATE_ERROR_MESSAGE =
  "更新安装未能启动，请稍后重试。";
const SILENT_UPDATER_ERROR_KINDS = new Set<UpdaterErrorKind>([
  "channel-missing",
  "check-network",
  "check",
]);
const UPDATER_ERROR_COPY = {
  "channel-missing": {
    title: "更新通道暂未就绪",
    body: "软件会按正常周期自动重试。",
    tone: "warning",
  },
  "check-network": {
    title: "暂时无法检查更新",
    body: "软件会自动重试。",
    tone: "warning",
  },
  check: {
    title: "暂时无法检查更新",
    body: "软件会自动重试。",
    tone: "warning",
  },
  download: {
    title: "更新下载失败",
    body: "更新下载未完成，软件会自动重试。",
    tone: "error",
  },
  validation: {
    title: "更新校验失败",
    body: "更新文件校验未通过，已停止安装。",
    tone: "error",
  },
  signature: {
    title: "更新签名校验失败",
    body: "更新签名校验未通过，已停止安装。",
    tone: "error",
  },
  install: {
    title: "更新安装未完成",
    body: "更新安装未完成，请稍后重试。",
    tone: "error",
  },
  update: {
    title: "软件更新暂时失败",
    body: "软件更新未完成，请稍后重试。",
    tone: "error",
  },
} as const satisfies Record<
  UpdaterErrorKind,
  { title: string; body: string; tone: NoticeTone }
>;
let noticeSequence = 0;

export async function requestImmediateUpdateInstall(
  installUpdate: () => Promise<boolean>,
) {
  try {
    const started = await installUpdate();
    if (!started) throw new Error(INSTALL_UPDATE_ERROR_MESSAGE);
  } catch {
    throw new Error(INSTALL_UPDATE_ERROR_MESSAGE);
  }
}

function createNoticeId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  noticeSequence += 1;
  return `notice-${Date.now()}-${noticeSequence}`;
}

function normalizeProgress(progress: number | undefined) {
  if (progress === undefined || !Number.isFinite(progress)) return undefined;
  return Math.max(0, Math.min(100, progress));
}

export function publishNotice(input: NoticeInput) {
  window.dispatchEvent(
    new CustomEvent<NoticeInput>(NOTICE_EVENT, { detail: input }),
  );
}

export function useNoticeCenter() {
  const value = useContext(NoticeCenterContext);
  if (!value) {
    throw new Error("useNoticeCenter 必须在 NoticeCenterProvider 内使用");
  }
  return value;
}

export function NoticeCenterProvider({ children }: PropsWithChildren) {
  const [notices, setNotices] = useState<NoticeRecord[]>([]);
  const [activeId, setActiveId] = useState("");
  const timers = useRef(new Map<string, number>());
  const dismissCallbacks = useRef(new Map<string, () => void>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    const onDismiss = dismissCallbacks.current.get(id);
    dismissCallbacks.current.delete(id);
    onDismiss?.();
    setNotices((current) => current.filter((notice) => notice.id !== id));
    setActiveId((current) => (current === id ? "" : current));
  }, []);

  const notify = useCallback(
    (input: NoticeInput) => {
      const id = input.id ?? createNoticeId();
      const record: NoticeRecord = {
        ...input,
        id,
        title: input.title.slice(0, 80),
        body: input.body.slice(0, 500),
        tone: input.tone ?? "info",
        progress: normalizeProgress(input.progress),
        dismissible: input.dismissible ?? true,
        createdAt: Date.now(),
      };

      const previousTimer = timers.current.get(id);
      if (previousTimer !== undefined) {
        window.clearTimeout(previousTimer);
        timers.current.delete(id);
      }
      if (input.onDismiss) {
        dismissCallbacks.current.set(id, input.onDismiss);
      } else {
        dismissCallbacks.current.delete(id);
      }
      setNotices((current) => [
        record,
        ...current.filter((notice) => notice.id !== id),
      ]);
      setActiveId((current) => (input.activate === false && current ? current : id));

      if (input.duration && input.duration > 0) {
        const timer = window.setTimeout(() => dismiss(id), input.duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const confirm = useCallback(
    (input: ConfirmNoticeInput) =>
      new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (answer: boolean) => {
          if (settled) return;
          settled = true;
          resolve(answer);
        };
        notify({
          title: input.title,
          body: input.body,
          tone: input.tone ?? "warning",
          onDismiss: () => settle(false),
          actions: [
            {
              label: input.cancelLabel ?? "取消",
              emphasis: "secondary",
              onSelect: () => settle(false),
            },
            {
              label: input.confirmLabel ?? "确认",
              emphasis: "danger",
              onSelect: () => settle(true),
            },
          ],
        });
      }),
    [notify],
  );

  useEffect(() => {
    const handleNotice = (event: Event) => {
      const detail = (event as CustomEvent<NoticeInput>).detail;
      if (
        detail &&
        typeof detail.title === "string" &&
        typeof detail.body === "string"
      ) {
        notify(detail);
      }
    };
    window.addEventListener(NOTICE_EVENT, handleNotice);
    return () => window.removeEventListener(NOTICE_EVENT, handleNotice);
  }, [notify]);

  useEffect(() => {
    const currentVersion = window.tongpin?.versions.app?.trim();
    if (!currentVersion) return;
    let lastAnnouncedVersion: string | null = null;
    try {
      lastAnnouncedVersion = window.localStorage.getItem(
        RELEASE_ANNOUNCEMENT_STORAGE_KEY,
      );
    } catch {
      // A locked-down storage policy must not hide the release announcement.
    }
    if (
      !shouldShowReleaseAnnouncement({
        currentVersion,
        lastAnnouncedVersion,
      })
    ) {
      return;
    }
    const announcement = getReleaseAnnouncement(currentVersion);
    if (!announcement) return;
    try {
      window.localStorage.setItem(
        RELEASE_ANNOUNCEMENT_STORAGE_KEY,
        currentVersion,
      );
    } catch {
      // The announcement still appears when the marker cannot persist.
    }
    notify({
      id: `release-announcement-${currentVersion}`,
      title: `同频已更新至 v${currentVersion}`,
      body: formatReleaseAnnouncementBody(announcement),
      tone: "update",
      dismissible: true,
      autoExpand: true,
    });
  }, [notify]);

  useEffect(() => {
    const desktop = window.tongpin;
    if (!desktop) return;
    return desktop.onUpdaterStatus((status) => {
      if (status.state === "not-available" || status.state === "checking") {
        dismiss("online-updater");
        return;
      }
      if (status.state === "available") {
        notify({
          id: "online-updater",
          title: "发现同频新版本",
          body:
            (status.releaseNotes
              ? `版本 ${status.version ?? ""}：${status.releaseNotes}`
              : status.message) ||
            `版本 ${status.version ?? ""} 正在后台下载，完成后可以立即安装。`,
          tone: "update",
          dismissible: false,
          autoExpand: true,
        });
        return;
      }
      if (status.state === "downloading") {
        notify({
          id: "online-updater",
          title: "正在下载同频更新",
          body: status.message || "更新正在后台下载，可以继续使用同频。",
          tone: "update",
          progress: status.percent,
          dismissible: false,
          activate: false,
        });
        return;
      }
      if (status.state === "downloaded") {
        notify({
          id: "online-updater",
          title: `同频 ${status.version ?? "新版本"} 已准备好`,
          body:
            (status.releaseNotes
              ? `本次更新：${status.releaseNotes}`
              : status.message) ||
            "现在安装会重新启动同频；选择稍后安装时，退出软件后仍会自动完成更新。",
          tone: "update",
          dismissible: true,
          autoExpand: true,
          actions: [
            {
              label: "稍后安装",
              emphasis: "secondary",
              onSelect: () => undefined,
            },
            {
              label: "立即安装",
              emphasis: "primary",
              closeOnSelect: false,
              onSelect: () =>
                requestImmediateUpdateInstall(() => desktop.installUpdate()),
            },
          ],
        });
        return;
      }
      if (
        status.errorKind &&
        SILENT_UPDATER_ERROR_KINDS.has(status.errorKind)
      ) {
        dismiss("online-updater");
        return;
      }
      const errorCopy =
        UPDATER_ERROR_COPY[status.errorKind ?? "update"];
      if (status.errorKind !== "install") dismiss("online-updater");
      notify({
        id: "online-updater-error",
        title: errorCopy.title,
        body: errorCopy.body,
        tone: errorCopy.tone,
        duration: 12_000,
      });
    });
  }, [dismiss, notify]);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) {
        window.clearTimeout(timer);
      }
      timers.current.clear();
      dismissCallbacks.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (notices.length === 0) {
      setActiveId("");
      return;
    }
    if (!notices.some((notice) => notice.id === activeId)) {
      setActiveId(notices[0].id);
    }
  }, [activeId, notices]);

  const value = useMemo(
    () => ({ notify, dismiss, confirm }),
    [confirm, dismiss, notify],
  );
  const activeNotice =
    notices.find((notice) => notice.id === activeId) ?? notices[0] ?? null;

  return (
    <NoticeCenterContext.Provider value={value}>
      {children}
      <NoticeOrb
        notice={activeNotice}
        count={notices.length}
        onDismiss={dismiss}
        onActionError={(message) =>
          notify({
            title: "操作没有完成",
            body: message,
            tone: "error",
            duration: 9_000,
          })
        }
      />
    </NoticeCenterContext.Provider>
  );
}

function NoticeOrb({
  notice,
  count,
  onDismiss,
  onActionError,
}: {
  notice: NoticeRecord | null;
  count: number;
  onDismiss: (id: string) => void;
  onActionError: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const previousNoticeId = useRef("");

  useEffect(() => {
    setBusyAction("");
    if (!notice) {
      setExpanded(false);
      setPinned(false);
      previousNoticeId.current = "";
      return;
    }
    const changed =
      Boolean(previousNoticeId.current) &&
      previousNoticeId.current !== notice.id;
    if (notice.autoExpand) {
      setExpanded(true);
      setPinned(false);
    } else if (changed) {
      setExpanded(false);
      setPinned(false);
    }
    previousNoticeId.current = notice.id;
  }, [notice?.id, notice]);

  if (!notice) return null;

  const currentNotice = notice;
  const tone = notice.tone ?? "info";
  const ToneIcon = {
    info: Info,
    success: CheckCircle2,
    warning: TriangleAlert,
    error: TriangleAlert,
    update: Download,
  }[tone];

  async function runAction(action: NoticeAction, index: number) {
    const actionKey = `${currentNotice.id}:${index}`;
    setBusyAction(actionKey);
    try {
      await action.onSelect();
      if (action.closeOnSelect !== false) onDismiss(currentNotice.id);
    } catch (caught) {
      onActionError(
        caught instanceof Error ? caught.message : "操作失败，请稍后重试",
      );
    } finally {
      setBusyAction("");
    }
  }

  return (
    <>
      <div
        ref={rootRef}
        className={`notice-center${expanded ? " is-expanded" : ""}`}
        data-tone={tone}
        data-testid="notice-center"
        onPointerEnter={() => setExpanded(true)}
        onPointerLeave={() => {
          if (
            !pinned &&
            !rootRef.current?.contains(document.activeElement)
          ) {
            setExpanded(false);
          }
        }}
        onFocusCapture={() => setExpanded(true)}
        onBlurCapture={(event) => {
          if (
            !pinned &&
            !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            setExpanded(false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setPinned(false);
            setExpanded(false);
            rootRef.current?.querySelector<HTMLButtonElement>(
              ".notice-orb-button",
            )?.focus();
          }
        }}
      >
        <section
          className="notice-card"
          id="global-notice-card"
          aria-label="消息详情"
        >
          <header>
            <span className="notice-card__icon" aria-hidden="true">
              <ToneIcon size={19} />
            </span>
            <div>
              <h2>{notice.title}</h2>
              {count > 1 && <small>{count} 条消息</small>}
            </div>
            {notice.dismissible !== false && (
              <button
                className="notice-card__close"
                type="button"
                aria-label="关闭这条消息"
                onClick={() => onDismiss(notice.id)}
              >
                <X size={17} />
              </button>
            )}
          </header>
          <p>{notice.body}</p>
          {notice.progress !== undefined && (
            <div className="notice-progress">
              <span
                style={{ "--notice-progress": `${notice.progress}%` } as React.CSSProperties}
              />
            </div>
          )}
          {notice.actions && notice.actions.length > 0 && (
            <footer>
              {notice.actions.map((action, index) => {
                const actionKey = `${notice.id}:${index}`;
                return (
                  <button
                    key={`${action.label}-${index}`}
                    className={`notice-action notice-action--${action.emphasis ?? "secondary"}`}
                    type="button"
                    disabled={Boolean(busyAction)}
                    onClick={() => void runAction(action, index)}
                  >
                    {busyAction === actionKey ? "处理中…" : action.label}
                  </button>
                );
              })}
            </footer>
          )}
        </section>

        <button
          className="notice-orb-button"
          type="button"
          aria-label={`${notice.title}，${expanded ? "收起消息" : "展开消息"}`}
          aria-expanded={expanded}
          aria-controls="global-notice-card"
          onClick={() => {
            if (pinned) {
              setPinned(false);
              setExpanded(false);
            } else {
              setPinned(true);
              setExpanded(true);
            }
          }}
        >
          <ToneIcon size={22} />
          {count > 1 && <span className="notice-orb-button__count">{count}</span>}
        </button>
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {notice.title}。{notice.body}
      </div>
    </>
  );
}
