/// <reference types="vite/client" />

type UpdaterErrorKind =
  | "channel-missing"
  | "check-network"
  | "check"
  | "download"
  | "validation"
  | "signature"
  | "install"
  | "update";

interface DesktopSessionBridge {
  apiUrl: string;
  platform: string;
  versions: {
    app: string;
    electron: string;
  };
  session: {
    load(): Promise<string | null>;
    save(payload: string): Promise<void>;
    clear(): Promise<void>;
  };
  credentials: {
    list(): Promise<
      Array<{
        email: string;
        hasPassword: boolean;
        lastUsedAt: string;
      }>
    >;
    load(email: string): Promise<{
      email: string;
      password: string | null;
      rememberPassword: boolean;
    } | null>;
    save(payload: {
      email: string;
      password: string;
      rememberPassword: boolean;
    }): Promise<boolean>;
    remove(email: string): Promise<boolean>;
  };
  relationshipGraph: {
    open(): Promise<{
      scopeToken: string;
      content: string | null;
      revision: number;
    }>;
    save(payload: {
      scopeToken: string;
      content: string;
      revision: number;
    }): Promise<{ revision: number }>;
    flushCurrent(): Promise<boolean>;
    release(scopeToken: string): Promise<boolean>;
    onFlushRequest(callback: () => Promise<boolean>): () => void;
  };
  notify(payload: {
    notificationId?: string;
    title: string;
    body: string;
    requireAcknowledgement?: boolean;
    playSound?: boolean;
    soundKey?: string;
    actionLabel?: string;
    action?: {
      type: "open-task";
      taskId: string;
      date: string;
    } | {
      type: "open-lora-dashboard";
      reportDate: string;
    };
  }): Promise<boolean>;
  dismissNotification(notificationId?: string): Promise<boolean>;
  openLoraExplorer(target: {
    kind: "address" | "tx";
    value: string;
  }): Promise<boolean>;
  onDesktopNoticeAcknowledge(
    callback: (notificationId: string) => void,
  ): () => void;
  onDesktopNoticeDismiss(
    callback: (notificationId: string) => void,
  ): () => void;
  onDesktopNoticeAction(
    callback: (action:
      | {
          type: "open-task";
          taskId: string;
          date: string;
        }
      | {
          type: "open-lora-dashboard";
          reportDate: string;
        },
    ) => void,
  ): () => void;
  onSystemResume(callback: () => void): () => void;
  quickTasks: {
    setAvailability(enabled: boolean): void;
    onRequest(
      callback: (payload: {
        requestId: string;
        command: QuickTaskCommand;
      }) => void,
    ): () => void;
    respond(requestId: string, response: QuickTaskResponse): void;
    notifyChanged(): void;
  };
  installUpdate(): Promise<boolean>;
  windowControls: {
    minimize(): Promise<void>;
    toggleMaximize(): Promise<boolean>;
    close(): Promise<void>;
    isMaximized(): Promise<boolean>;
    onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  };
  onUpdaterStatus(
    callback: (status: {
      state:
        | "checking"
        | "available"
        | "not-available"
        | "downloading"
        | "downloaded"
        | "error";
      percent?: number;
      version?: string;
      releaseNotes?: string;
      message?: string;
      errorKind?: UpdaterErrorKind;
    }) => void,
  ): () => void;
}

type QuickTaskPriority = "p0" | "p1" | "p2" | "p3" | "p4";
type QuickTaskStatus = "todo" | "doing" | "done";

type QuickTaskCommand =
  | { type: "list-today" }
  | { type: "create"; title: string; priority: QuickTaskPriority }
  | { type: "update-status"; taskId: string; status: QuickTaskStatus };

type QuickTaskResponse =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

interface QuickTaskSurfaceBridge {
  request<T = unknown>(command: QuickTaskCommand): Promise<T>;
  openPanel(): Promise<boolean>;
  closePanel(): Promise<boolean>;
  openMain(): Promise<boolean>;
  onCornerVisibility(callback: (visible: boolean) => void): () => void;
  onPanelVisibility(callback: (visible: boolean) => void): () => void;
  onTasksChanged(callback: () => void): () => void;
}

interface Window {
  tongpin?: DesktopSessionBridge;
  tongpinQuick?: QuickTaskSurfaceBridge;
}
