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
  notify(payload: {
    notificationId?: string;
    title: string;
    body: string;
    requireAcknowledgement?: boolean;
    actionLabel?: string;
    action?: {
      type: "open-task";
      taskId: string;
      date: string;
    };
  }): Promise<boolean>;
  dismissNotification(notificationId?: string): Promise<boolean>;
  onDesktopNoticeAcknowledge(
    callback: (notificationId: string) => void,
  ): () => void;
  onDesktopNoticeDismiss(
    callback: (notificationId: string) => void,
  ): () => void;
  onDesktopNoticeAction(
    callback: (action: {
      type: "open-task";
      taskId: string;
      date: string;
    }) => void,
  ): () => void;
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
      message?: string;
      errorKind?: UpdaterErrorKind;
    }) => void,
  ): () => void;
}

interface Window {
  tongpin?: DesktopSessionBridge;
}
