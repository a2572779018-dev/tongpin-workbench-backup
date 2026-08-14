import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  Bell,
  BriefcaseBusiness,
  Camera,
  CheckCheck,
  ChevronRight,
  ClipboardCheck,
  LogOut,
  MessageCircle,
  RotateCcw,
  ShieldCheck,
  Shirt,
  UsersRound,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { UserAvatar } from "./UserAvatar";
import { ContactCenter } from "./ContactCenter";
import { ProfileCard } from "./ProfileCard";
import { useNoticeCenter } from "./NoticeCenter";
import { StrongReminder } from "./StrongReminder";
import { API_URL, ApiRequestError } from "../lib/api";
import { formatTime } from "../lib/date";
import {
  STRONG_REMINDER_REPEAT_MS,
  isPendingStrongReminder,
  selectLatestStrongReminder,
} from "../lib/strongReminder";
import {
  REALTIME_HEARTBEAT_INTERVAL_MS,
  REALTIME_HEARTBEAT_TIMEOUT_MS,
  REALTIME_READY_TIMEOUT_MS,
  REALTIME_STABLE_CONNECTION_MS,
  getRealtimeReconnectDelayMs,
  mergeNotificationsById,
  notificationsNeedingDelivery,
  shouldRecoverRealtimeSession,
} from "../lib/realtimeReliability";
import {
  HOME_LAYOUT_DESCRIPTIONS,
  HOME_LAYOUT_LABELS,
  HOME_LAYOUT_OPTIONS,
  isLaneHomeLayout,
  type HomeLayout,
} from "../lib/homeLayout";
import type {
  AppNotification,
  DirectMessage,
  DirectMessageRealtimeEvent,
  NotificationReceipt,
  TaskAssignmentEvent,
  User,
} from "../types";

export type AppView = "home" | "boss" | "admin";

const PAGE_TITLES: Record<AppView, string> = {
  home: "我的任务",
  boss: "全员进度",
  admin: "账号与权限",
};

const MAX_AVATAR_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_AVATAR_RESULT_BYTES = 512 * 1024;

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("图片处理失败，请换一张图片")),
      "image/webp",
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("无法读取图片"));
    reader.readAsDataURL(blob);
  });
}

async function prepareAvatar(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("只支持 PNG、JPG 或 WebP 图片");
  }
  if (file.size > MAX_AVATAR_SOURCE_BYTES) {
    throw new Error("原图不能超过 8MB");
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("图片无法解析，请换一张正常图片");
  }
  try {
    const sourceSide = Math.min(bitmap.width, bitmap.height);
    const outputSide = Math.min(512, sourceSide);
    const canvas = document.createElement("canvas");
    canvas.width = outputSide;
    canvas.height = outputSide;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前设备无法处理头像");
    context.drawImage(
      bitmap,
      (bitmap.width - sourceSide) / 2,
      (bitmap.height - sourceSide) / 2,
      sourceSide,
      sourceSide,
      0,
      0,
      outputSide,
      outputSide,
    );

    let result = await canvasToBlob(canvas, 0.84);
    if (result.size > MAX_AVATAR_RESULT_BYTES) {
      result = await canvasToBlob(canvas, 0.66);
    }
    if (result.size > MAX_AVATAR_RESULT_BYTES) {
      throw new Error("头像压缩后仍超过 512KB，请换一张图片");
    }
    return await blobToDataUrl(result);
  } finally {
    bitmap.close();
  }
}

export function AppShell({
  children,
  view,
  onViewChange,
  homeLayout,
  onHomeLayoutChange,
}: PropsWithChildren<{
  view: AppView;
  onViewChange: (view: AppView) => void;
  homeLayout: HomeLayout;
  onHomeLayoutChange: (layout: HomeLayout) => void;
}>) {
  const { session, logout, api, updateUser } = useAuth();
  const { notify } = useNoticeCenter();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"notifications" | "contacts">(
    "notifications",
  );
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [messageUnread, setMessageUnread] = useState(0);
  const [chatEvent, setChatEvent] =
    useState<DirectMessageRealtimeEvent | null>(null);
  const [realtimeReady, setRealtimeReady] = useState(false);
  const [avatarDialog, setAvatarDialog] = useState<"editor" | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [avatarDraft, setAvatarDraft] = useState<
    string | null | undefined
  >(undefined);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState("");
  const [acknowledgingId, setAcknowledgingId] = useState("");
  const [acknowledgeError, setAcknowledgeError] = useState("");
  const [visibleStrongNotificationId, setVisibleStrongNotificationId] =
    useState<string | null>(null);
  const notificationsRef = useRef<AppNotification[]>([]);
  const deliveryInFlight = useRef(new Set<string>());
  const handledAssignments = useRef(new Set<string>());

  const user = session!.user;
  const isLaneHome = view === "home" && isLaneHomeLayout(homeLayout);
  const notificationUnread = notifications.filter(
    (item) => !item.readAt,
  ).length;
  const unread = notificationUnread + messageUnread;
  const pendingStrongNotification = useMemo(
    () => selectLatestStrongReminder(notifications),
    [notifications],
  );
  const visibleStrongNotification = useMemo(
    () =>
      notifications.find(
        (notification) =>
          notification.id === visibleStrongNotificationId &&
          isPendingStrongReminder(notification),
      ) ?? null,
    [notifications, visibleStrongNotificationId],
  );

  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);

  useEffect(() => {
    setLayoutMenuOpen(false);
  }, [view]);

  const deliverNotifications = useCallback(
    (incoming: AppNotification[]) => {
      for (const notification of notificationsNeedingDelivery(incoming)) {
        if (deliveryInFlight.current.has(notification.id)) continue;
        deliveryInFlight.current.add(notification.id);
        void api<{ notification: AppNotification }>(
          `/api/notifications/${notification.id}/delivered`,
          { method: "PATCH" },
        )
          .then((result) => {
            setNotifications((current) =>
              mergeNotificationsById(current, [result.notification]),
            );
          })
          .catch(() => undefined)
          .finally(() => {
            deliveryInFlight.current.delete(notification.id);
          });
      }
    },
    [api],
  );

  const syncNotifications = useCallback(async () => {
    const result = await api<{ notifications: AppNotification[] }>(
      "/api/notifications",
    );
    setNotifications((current) =>
      mergeNotificationsById(current, result.notifications),
    );
    deliverNotifications(result.notifications);
  }, [api, deliverNotifications]);

  useEffect(() => {
    if (user.role === "admin") return;
    void syncNotifications().catch(() => undefined);
  }, [syncNotifications, user.role]);

  useEffect(() => {
    if (user.role === "admin") return;
    void api<{ unread: number }>("/api/contacts")
      .then((result) => setMessageUnread(result.unread))
      .catch(() => undefined);
  }, [api, user.role]);

  const showDesktopStrong = useCallback(
    (notification: AppNotification) => {
      if (!window.tongpin) return;
      void window.tongpin.notify({
        notificationId: notification.id,
        title: notification.title,
        body: notification.body,
        requireAcknowledgement: true,
        playSound: true,
        soundKey: `boss-notification:${notification.id}:${notification.dingCount}`,
      });
    },
    [],
  );

  const acknowledgeStrong = useCallback(
    async (notification: AppNotification) => {
      if (acknowledgingId) return;
      setAcknowledgingId(notification.id);
      setAcknowledgeError("");
      try {
        const result = await api<{ notification: AppNotification }>(
          `/api/notifications/${notification.id}/acknowledge`,
          { method: "PATCH" },
        );
        setNotifications((current) =>
          current.map((item) =>
            item.id === notification.id ? result.notification : item,
          ),
        );
        await window.tongpin?.dismissNotification(notification.id);
      } catch (caught) {
        setAcknowledgeError(
          caught instanceof Error ? caught.message : "确认没有同步，请重试",
        );
      } finally {
        setAcknowledgingId("");
      }
    },
    [acknowledgingId, api],
  );

  const dismissStrong = useCallback((notificationId: string) => {
    setVisibleStrongNotificationId((current) =>
      current === notificationId ? null : current,
    );
    setAcknowledgeError("");
    void window.tongpin?.dismissNotification(notificationId);
  }, []);

  const openAssignedTask = useCallback(
    (assignment: TaskAssignmentEvent) => {
      setDrawerOpen(false);
      onViewChange("home");
      void api(`/api/tasks/${assignment.task.id}/assignment-viewed`, {
        method: "PATCH",
      }).catch(() => undefined);
      window.dispatchEvent(
        new CustomEvent("tongpin:open-task", {
          detail: {
            taskId: assignment.task.id,
            date: assignment.task.date,
          },
        }),
      );
    },
    [api, onViewChange],
  );

  const showTaskAssignment = useCallback(
    (assignment: TaskAssignmentEvent) => {
      if (handledAssignments.current.has(assignment.task.id)) return;
      handledAssignments.current.add(assignment.task.id);
      void api(`/api/tasks/${assignment.task.id}/assignment-delivered`, {
        method: "PATCH",
      }).catch(() => undefined);
      notify({
        id: `assigned-task-${assignment.task.id}`,
        title: "老板给你添加了任务",
        body: assignment.task.title,
        tone: "warning",
        actions: [
          {
            label: "去查看",
            emphasis: "primary",
            onSelect: () => openAssignedTask(assignment),
          },
        ],
      });
      void window.tongpin?.notify({
        notificationId: `task:${assignment.task.id}`,
        title: "老板给你添加了任务",
        body: assignment.task.title,
        actionLabel: "去查看",
        action: {
          type: "open-task",
          taskId: assignment.task.id,
          date: assignment.task.date,
        },
      });
    },
    [api, notify, openAssignedTask],
  );

  useEffect(() => {
    if (user.role === "admin") return;
    deliverNotifications(notificationsRef.current);
    const timer = window.setInterval(
      () => deliverNotifications(notificationsRef.current),
      15_000,
    );
    return () => window.clearInterval(timer);
  }, [deliverNotifications, user.role]);

  useEffect(() => {
    if (!pendingStrongNotification || user.role === "admin") {
      setVisibleStrongNotificationId(null);
      return;
    }
    setAcknowledgeError("");
    setVisibleStrongNotificationId(pendingStrongNotification.id);
    showDesktopStrong(pendingStrongNotification);
    const timer = window.setInterval(
      () => {
        setVisibleStrongNotificationId(pendingStrongNotification.id);
        showDesktopStrong(pendingStrongNotification);
      },
      STRONG_REMINDER_REPEAT_MS,
    );
    return () => window.clearInterval(timer);
  }, [
    pendingStrongNotification?.id,
    pendingStrongNotification?.dingCount,
    showDesktopStrong,
    user.role,
  ]);

  useEffect(() => {
    if (!window.tongpin?.onDesktopNoticeAcknowledge) return;
    const stopAcknowledge = window.tongpin.onDesktopNoticeAcknowledge(
      (notificationId) => {
        const notification = notificationsRef.current.find(
          (item) =>
            item.id === notificationId &&
            item.requiresAcknowledgement &&
            !item.acknowledgedAt,
        );
        if (notification) void acknowledgeStrong(notification);
      },
    );
    const stopDismiss = window.tongpin.onDesktopNoticeDismiss(
      (notificationId) => {
        dismissStrong(notificationId);
      },
    );
    return () => {
      stopAcknowledge();
      stopDismiss();
    };
  }, [acknowledgeStrong, dismissStrong]);

  useEffect(() => {
    if (user.role === "admin") return;
    void api<{ assignments: TaskAssignmentEvent[] }>(
      "/api/tasks/assignments/pending",
    )
      .then((result) => {
        for (const assignment of result.assignments) {
          showTaskAssignment(assignment);
        }
      })
      .catch(() => undefined);
  }, [api, showTaskAssignment, user.role]);

  useEffect(() => {
    if (!window.tongpin?.onDesktopNoticeAction) return;
    return window.tongpin.onDesktopNoticeAction((action) => {
      if (action.type !== "open-task") return;
      const taskId = action.taskId;
      const date = action.date;
      if (!taskId || !date) return;
      setDrawerOpen(false);
      onViewChange("home");
      void api(`/api/tasks/${taskId}/assignment-viewed`, {
        method: "PATCH",
      }).catch(() => undefined);
      window.dispatchEvent(
        new CustomEvent("tongpin:open-task", {
          detail: { taskId, date },
        }),
      );
    });
  }, [api, onViewChange]);

  useEffect(() => {
    if (user.role === "admin") return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let readyTimer: number | null = null;
    let heartbeatInterval: number | null = null;
    let heartbeatTimeout: number | null = null;
    let stabilityTimer: number | null = null;
    let reconnectAttempt = 0;
    let sessionRecoveryInFlight: Promise<void> | null = null;

    function clearSocketTimers() {
      if (readyTimer !== null) window.clearTimeout(readyTimer);
      if (heartbeatInterval !== null) window.clearInterval(heartbeatInterval);
      if (heartbeatTimeout !== null) window.clearTimeout(heartbeatTimeout);
      if (stabilityTimer !== null) window.clearTimeout(stabilityTimer);
      readyTimer = null;
      heartbeatInterval = null;
      heartbeatTimeout = null;
      stabilityTimer = null;
    }

    function scheduleReconnect() {
      if (
        disposed ||
        reconnectTimer !== null ||
        socket?.readyState === WebSocket.CONNECTING ||
        socket?.readyState === WebSocket.OPEN ||
        navigator.onLine === false
      ) {
        return;
      }
      const delay = getRealtimeReconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    }

    function recoverSessionThenReconnect() {
      if (disposed || sessionRecoveryInFlight) return;
      sessionRecoveryInFlight = api("/api/auth/me")
        .then(() => undefined)
        .catch(() => undefined)
        .finally(() => {
          sessionRecoveryInFlight = null;
          scheduleReconnect();
        });
    }

    function synchronizeAfterReady() {
      void syncNotifications().catch(() => undefined);
      void api<{ unread: number }>("/api/contacts")
        .then((result) => setMessageUnread(result.unread))
        .catch(() => undefined);
      void api<{ assignments: TaskAssignmentEvent[] }>(
        "/api/tasks/assignments/pending",
      )
        .then((result) => {
          for (const assignment of result.assignments) {
            showTaskAssignment(assignment);
          }
        })
        .catch(() => undefined);
      window.dispatchEvent(new CustomEvent("tongpin:task-sync"));
      window.dispatchEvent(new CustomEvent("tongpin:realtime-ready"));
    }

    function startHeartbeat(activeSocket: WebSocket) {
      heartbeatInterval = window.setInterval(() => {
        if (activeSocket !== socket || activeSocket.readyState !== WebSocket.OPEN) {
          activeSocket.close();
          return;
        }
        activeSocket.send(JSON.stringify({ type: "ping" }));
        if (heartbeatTimeout !== null) window.clearTimeout(heartbeatTimeout);
        heartbeatTimeout = window.setTimeout(() => {
          activeSocket.close(4000, "heartbeat timeout");
        }, REALTIME_HEARTBEAT_TIMEOUT_MS);
      }, REALTIME_HEARTBEAT_INTERVAL_MS);
    }

    function showNotification(notification: AppNotification) {
      setNotifications((current) =>
        mergeNotificationsById(current, [notification]),
      );
      deliverNotifications([notification]);
      if (notification.requiresAcknowledgement) return;
      notify({
        id: `boss-push-${notification.id}`,
        title: notification.title,
        body: notification.body,
        tone: "info",
        duration: 15_000,
      });
      if (
        window.tongpin &&
        (document.visibilityState !== "visible" || !document.hasFocus())
      ) {
        void window.tongpin.notify({
          notificationId: notification.id,
          title: notification.title,
          body: notification.body,
          playSound: true,
          soundKey: `boss-notification:${notification.id}:${notification.dingCount}`,
        });
      }
    }

    function showDirectMessage(message: {
      message: DirectMessage;
      sender: User;
    }) {
      setChatEvent({ type: "message:new", ...message });
      setMessageUnread((current) => current + 1);
      notify({
        id: `chat-${message.message.id}`,
        title: message.sender.name,
        body:
          message.message.mode === "flash"
            ? "发来一条同频闪信"
            : message.message.body,
        tone: "info",
        duration: 10_000,
      });
      if (
        window.tongpin &&
        (document.visibilityState !== "visible" || !document.hasFocus())
      ) {
        void window.tongpin.notify({
          title: message.sender.name,
          body:
            message.message.mode === "flash"
              ? "发来一条同频闪信"
              : message.message.body,
        });
      }
    }

    function connect() {
      if (
        disposed ||
        socket?.readyState === WebSocket.CONNECTING ||
        socket?.readyState === WebSocket.OPEN
      ) {
        return;
      }
      const url = new URL(
        `${API_URL.replace(/\/$/, "")}/api/realtime`,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const activeSocket = new WebSocket(url);
      let reachedReady = false;
      socket = activeSocket;
      readyTimer = window.setTimeout(() => {
        activeSocket.close(4000, "ready timeout");
      }, REALTIME_READY_TIMEOUT_MS);
      activeSocket.addEventListener("open", () => {
        activeSocket.send(
          JSON.stringify({
            type: "auth",
            token: session!.accessToken,
          }),
        );
      });
      activeSocket.addEventListener("message", (event) => {
        if (activeSocket !== socket) return;
        try {
          const message = JSON.parse(String(event.data)) as {
            type?: string;
            data?: unknown;
          };
          if (message.type === "realtime:ready") {
            if (readyTimer !== null) window.clearTimeout(readyTimer);
            readyTimer = null;
            reachedReady = true;
            setRealtimeReady(true);
            stabilityTimer = window.setTimeout(() => {
              reconnectAttempt = 0;
              stabilityTimer = null;
            }, REALTIME_STABLE_CONNECTION_MS);
            if (
              (message.data as { heartbeat?: unknown } | undefined)?.heartbeat ===
              true
            ) {
              startHeartbeat(activeSocket);
            }
            synchronizeAfterReady();
          } else if (message.type === "pong") {
            if (heartbeatTimeout !== null) {
              window.clearTimeout(heartbeatTimeout);
              heartbeatTimeout = null;
            }
          } else if (
            message.type === "notification:new" ||
            message.type === "notification:ding"
          ) {
            showNotification(message.data as AppNotification);
          } else if (message.type === "notification:receipt") {
            window.dispatchEvent(
              new CustomEvent<NotificationReceipt>(
                "tongpin:notification-receipt",
                { detail: message.data as NotificationReceipt },
              ),
            );
          } else if (message.type === "message:new") {
            showDirectMessage(
              message.data as { message: DirectMessage; sender: User },
            );
          } else if (
            message.type === "message:read" ||
            message.type === "message:expired"
          ) {
            const data = message.data as { message: DirectMessage };
            setChatEvent({
              type: message.type,
              message: data.message,
            });
          } else if (message.type === "task:assigned") {
            showTaskAssignment(message.data as TaskAssignmentEvent);
            window.dispatchEvent(
              new CustomEvent("tongpin:task-sync", {
                detail: message.data,
              }),
            );
          } else if (
            message.type === "task:assignment-receipt" ||
            message.type === "task:status" ||
            message.type === "task:changed" ||
            message.type === "task:deleted" ||
            message.type === "task:batch-changed"
          ) {
            window.dispatchEvent(
              new CustomEvent("tongpin:task-sync", {
                detail: message.data,
              }),
            );
          }
        } catch {
          // Ignore malformed real-time frames and keep the connection alive.
        }
      });
      activeSocket.addEventListener("close", (event) => {
        if (disposed || activeSocket !== socket) return;
        clearSocketTimers();
        setRealtimeReady(false);
        if (navigator.onLine === false) return;
        if (shouldRecoverRealtimeSession(reachedReady, event.code)) {
          recoverSessionThenReconnect();
        } else {
          scheduleReconnect();
        }
      });
      activeSocket.addEventListener("error", () => {
        if (activeSocket !== socket) return;
        setRealtimeReady(false);
        activeSocket.close();
      });
    }

    const handleOnline = () => {
      reconnectAttempt = 0;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        socket.close(4003, "network restored");
      } else {
        connect();
      }
    };

    const handleOffline = () => {
      setRealtimeReady(false);
      socket?.close(4003, "network offline");
    };

    const connectTimer = window.setTimeout(connect, 80);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      disposed = true;
      window.clearTimeout(connectTimer);
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      clearSocketTimers();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      socket?.close();
    };
  }, [
    api,
    deliverNotifications,
    notify,
    session,
    showTaskAssignment,
    syncNotifications,
    user.role,
  ]);

  const roleLabel = {
    member: "成员",
    boss: "老板",
    admin: "管理员",
  }[user.role];

  const navItems = useMemo(() => {
    if (user.role === "admin") {
      return [
        {
          view: "admin" as const,
          label: "账号与权限",
          icon: ShieldCheck,
        },
      ];
    }
    return [
      {
        view: "home" as const,
        label: "我的任务",
        icon: ClipboardCheck,
      },
      ...(user.role === "boss"
        ? [
            {
              view: "boss" as const,
              label: "全员进度",
              icon: UsersRound,
            },
          ]
        : []),
    ];
  }, [user.role]);

  async function markRead(notification: AppNotification) {
    if (notification.readAt) return;
    try {
      const result = await api<{ notification: AppNotification }>(
        `/api/notifications/${notification.id}/read`,
        { method: "PATCH" },
      );
      setNotifications((current) =>
        current.map((item) =>
          item.id === notification.id ? result.notification : item,
        ),
      );
    } catch {
      // 抽屉仍可查看，下一次打开时再次同步。
    }
  }

  function openAvatarDialog() {
    setAvatarError("");
    setAvatarDraft(undefined);
    if (user.role === "boss") {
      notify({
        id: "boss-avatar-locked",
        title: "老板专属头像",
        body: "不好意思，您无权限更换自己的头像。",
        tone: "warning",
        duration: 10_000,
      });
      return;
    }
    if (user.role === "member") setAvatarDialog("editor");
  }

  async function selectAvatar(file: File | undefined) {
    if (!file) return;
    setAvatarBusy(true);
    setAvatarError("");
    try {
      setAvatarDraft(await prepareAvatar(file));
    } catch (caught) {
      setAvatarError(
        caught instanceof Error ? caught.message : "头像处理失败",
      );
    } finally {
      setAvatarBusy(false);
    }
  }

  async function saveAvatar() {
    if (avatarDraft === undefined) return;
    setAvatarBusy(true);
    setAvatarError("");
    try {
      const result = await api<{ user: User }>("/api/auth/me/avatar", {
        method: "PATCH",
        body: JSON.stringify({ dataUrl: avatarDraft }),
      });
      await updateUser(result.user);
      setAvatarDialog(null);
      setAvatarDraft(undefined);
      notify({
        title: "头像已更新",
        body: result.user.hasCustomAvatar
          ? "新的头像已在所有设备同步。"
          : "已恢复系统默认头像。",
        tone: "success",
        duration: 6_000,
      });
    } catch (caught) {
      if (
        caught instanceof ApiRequestError &&
        caught.code === "BOSS_AVATAR_LOCKED"
      ) {
        setAvatarDialog(null);
        setAvatarError("");
        notify({
          id: "boss-avatar-locked",
          title: "老板专属头像",
          body: "不好意思，您无权限更换自己的头像。",
          tone: "warning",
          duration: 10_000,
        });
      } else {
        setAvatarError(
          caught instanceof Error ? caught.message : "头像更新失败",
        );
      }
    } finally {
      setAvatarBusy(false);
    }
  }

  return (
    <div
      className={[
        "app-frame",
        isLaneHome ? "app-frame--lane-home" : "",
        view === "home" ? `home-layout-${homeLayout}` : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <aside className="sidebar">
        <nav className="side-nav" aria-label="主导航">
          {navItems.map(({ view: itemView, label, icon: Icon }) => (
            <button
              key={itemView}
              type="button"
              className={view === itemView ? "is-active" : ""}
              onClick={() => onViewChange(itemView)}
            >
              <Icon size={18} />
              <span>{label}</span>
              <ChevronRight size={14} className="nav-chevron" />
            </button>
          ))}
        </nav>

        <div className="sidebar-spacer" />

        <div className="sync-status">
          {realtimeReady || user.role === "admin" ? (
            <Wifi size={15} />
          ) : (
            <WifiOff size={15} />
          )}
          <span>
            {user.role === "admin"
              ? "管理通道已连接"
              : realtimeReady
                ? "即时通知已连接"
                : "正在连接通知"}
          </span>
        </div>

        <div className="user-chip">
          {user.role === "admin" ? (
            <UserAvatar user={user} className="avatar" />
          ) : (
            <button
              className="avatar-trigger"
              type="button"
              aria-label="查看我的资料"
              title="查看我的资料"
              onClick={() => setProfileOpen(true)}
            >
              <UserAvatar user={user} className="avatar" />
            </button>
          )}
          <span className="user-chip__copy">
            <b>{user.name}</b>
            <small>{roleLabel}</small>
          </span>
          <button
            type="button"
            aria-label="退出登录"
            onClick={() => void logout()}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>

      <section className="app-content">
        <header
          className={[
            "topbar",
            isLaneHome ? "topbar--lane-home" : "",
            isLaneHome && window.tongpin ? "is-desktop" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        >
          <div>
            <h1>{isLaneHome ? "今日待办" : PAGE_TITLES[view]}</h1>
          </div>
          <div className="topbar__actions">
            {view === "home" && (
              <div className="layout-switcher">
                <button
                  className="icon-button layout-switcher__trigger"
                  type="button"
                  aria-label="切换任务界面"
                  aria-expanded={layoutMenuOpen}
                  title="切换任务界面"
                  onClick={() => setLayoutMenuOpen((current) => !current)}
                >
                  <Shirt size={19} />
                </button>
                {layoutMenuOpen && (
                  <div
                    className="layout-switcher__menu"
                    role="menu"
                    aria-label="任务界面"
                  >
                    {HOME_LAYOUT_OPTIONS.map((layout) => (
                      <button
                        key={layout}
                        type="button"
                        data-layout-option={layout}
                        role="menuitemradio"
                        aria-checked={homeLayout === layout}
                        className={homeLayout === layout ? "is-active" : ""}
                        onClick={() => {
                          onHomeLayoutChange(layout);
                          setLayoutMenuOpen(false);
                        }}
                      >
                        <i
                          className={`layout-option__swatch swatch-${layout}`}
                          aria-hidden="true"
                        />
                        <span className="layout-option__copy">
                          <b>{HOME_LAYOUT_LABELS[layout]}</b>
                          <small>{HOME_LAYOUT_DESCRIPTIONS[layout]}</small>
                        </span>
                        {homeLayout === layout && <CheckCheck size={16} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {user.role !== "admin" && (
              <button
                className="icon-button notification-button"
                type="button"
                aria-label={`通知${unread ? `，${unread} 条未读` : ""}`}
                onClick={() => setDrawerOpen(true)}
              >
                <Bell size={19} />
                {unread > 0 && <span>{unread > 9 ? "9+" : unread}</span>}
              </button>
            )}
          </div>
        </header>

        <div className="page-canvas">
          {children}
        </div>
      </section>

      {drawerOpen && (
        <>
          <button
            className="drawer-backdrop"
            type="button"
            aria-label="关闭通知"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="notification-drawer" aria-label="消息中心">
            <header>
              <div>
                <h2>消息中心</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="关闭"
                onClick={() => setDrawerOpen(false)}
              >
                <X size={19} />
              </button>
            </header>

            <div className="drawer-tabs" role="tablist" aria-label="消息类型">
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "notifications"}
                className={drawerTab === "notifications" ? "is-active" : ""}
                onClick={() => setDrawerTab("notifications")}
              >
                <Bell size={16} />
                通知
                {notificationUnread > 0 && <i>{notificationUnread}</i>}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={drawerTab === "contacts"}
                className={drawerTab === "contacts" ? "is-active" : ""}
                onClick={() => setDrawerTab("contacts")}
              >
                <MessageCircle size={16} />
                联系人
                {messageUnread > 0 && <i>{messageUnread}</i>}
              </button>
            </div>

            <div className="drawer-body">
              {drawerTab === "notifications" ? (
                notifications.length === 0 ? (
                  <div className="drawer-empty">
                    <span>
                      <Bell size={25} />
                    </span>
                    <h3>暂时没有通知</h3>
                  </div>
                ) : (
                  <div className="notification-list">
                    {notifications.map((notification) => (
                      <button
                        key={notification.id}
                        className={[
                          notification.readAt ? "" : "is-unread",
                          notification.requiresAcknowledgement
                            ? "is-strong"
                            : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        type="button"
                        onClick={() => void markRead(notification)}
                      >
                        <span className="notification-list__icon">
                          {notification.readAt ? (
                            <CheckCheck size={17} />
                          ) : (
                            <BriefcaseBusiness size={17} />
                          )}
                        </span>
                        <span className="notification-list__copy">
                          <b>{notification.title}</b>
                          <p>{notification.body}</p>
                          <small>
                            {notification.requiresAcknowledgement
                              ? notification.acknowledgedAt
                                ? "已确认"
                                : "待确认"
                              : formatTime(notification.createdAt)}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <ContactCenter
                  api={api}
                  currentUser={user}
                  realtimeEvent={chatEvent}
                  onUnreadChange={setMessageUnread}
                />
              )}
            </div>
          </aside>
        </>
      )}

      {visibleStrongNotification && (
        <StrongReminder
          notification={visibleStrongNotification}
          busy={acknowledgingId === visibleStrongNotification.id}
          error={acknowledgeError}
          onAcknowledge={() =>
            void acknowledgeStrong(visibleStrongNotification)
          }
          onDismiss={dismissStrong}
        />
      )}

      {profileOpen && (
        <ProfileCard
          user={user}
          onClose={() => setProfileOpen(false)}
          onChangeAvatar={() => {
            setProfileOpen(false);
            openAvatarDialog();
          }}
        />
      )}

      {avatarDialog && (
        <div className="modal-layer">
          <button
            className="modal-backdrop"
            type="button"
            aria-label="关闭头像窗口"
            onClick={() => setAvatarDialog(null)}
          />
          <section
            className="avatar-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="avatar-editor-title"
          >
              <header>
                <div>
                  <h2 id="avatar-editor-title">更换头像</h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭"
                  onClick={() => setAvatarDialog(null)}
                >
                  <X size={19} />
                </button>
              </header>

              <div className="avatar-dialog__preview">
                <UserAvatar
                  user={user}
                  className="avatar-preview"
                  customSourceOverride={avatarDraft}
                />
                <div>
                  <b>{user.name}</b>
                  <span>
                    {avatarDraft === null
                      ? "系统默认头像"
                      : avatarDraft
                        ? "新头像预览"
                        : user.hasCustomAvatar
                          ? "当前自定义头像"
                          : "系统默认头像"}
                  </span>
                </div>
              </div>

              <div className="avatar-dialog__tools">
                <label className="secondary-button">
                  <Camera size={17} />
                  {avatarBusy ? "正在处理…" : "选择图片"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    disabled={avatarBusy}
                    onChange={(event) => {
                      void selectAvatar(event.target.files?.[0]);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <button
                  className="text-button"
                  type="button"
                  disabled={avatarBusy}
                  onClick={() => setAvatarDraft(null)}
                >
                  <RotateCcw size={16} />
                  恢复系统头像
                </button>
              </div>
              <small className="avatar-dialog__hint">
                图片会自动居中裁成正方形。支持 PNG、JPG、WebP，原图不超过
                8MB。
              </small>
              {avatarError && (
                <div className="form-message is-error">{avatarError}</div>
              )}
              <footer>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={avatarBusy}
                  onClick={() => setAvatarDialog(null)}
                >
                  取消
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={avatarBusy || avatarDraft === undefined}
                  onClick={() => void saveAvatar()}
                >
                  {avatarBusy ? "正在保存…" : "保存头像"}
                </button>
              </footer>
          </section>
        </div>
      )}
    </div>
  );
}
