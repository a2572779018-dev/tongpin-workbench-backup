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
  computerUse?: import("../shared/computerUse").ComputerUseBridge;
  session: {
    load(): Promise<string | null>;
    save(payload: string): Promise<void>;
    clear(): Promise<void>;
  };
  credentials: {
    list(): Promise<{
      state: "ready" | "unavailable";
      accounts: Array<{
        email: string;
        lastUsedAt: string;
        /** An encrypted password is stored; its value is never listed. */
        passwordRemembered?: boolean;
      }>;
    }>;
    /** The password is sent only with rememberPassword: true; any other save
     * forgets a previously remembered password for this account. */
    save(payload: {
      email: string;
      password?: string;
      rememberPassword?: boolean;
    }): Promise<
      | boolean
      | { saved: true; password: "stored" | "cleared" | "unavailable" }
    >;
    remove(email: string): Promise<boolean>;
    /** Explicit remembered-account selection on the sign-in screen only. */
    reveal?(email: string): Promise<
      | { state: "ready"; password: string }
      | { state: "missing" }
      | { state: "unavailable"; reason: "locked" | "unreadable" | "session-active" }
    >;
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
    } | {
      type: "open-admin-ai-monitoring";
    };
  }): Promise<boolean>;
  dismissNotification(notificationId?: string): Promise<boolean>;
  openLoraExplorer(target: {
    kind: "address" | "tx";
    value: string;
  }): Promise<boolean>;
  openAiSource(url: string): Promise<"opened" | "cancelled" | "blocked" | "failed" | "busy">;
  saveAiFile(input: { filename: string; bytes: ArrayBuffer }): Promise<
    { state: "saved"; filePath: string } | { state: "cancelled" } | { state: "busy" }
  >;
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
        }
      | {
          type: "open-admin-ai-monitoring";
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
