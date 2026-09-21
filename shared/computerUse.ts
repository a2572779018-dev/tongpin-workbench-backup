export type ComputerUseProbeStatus =
  | "ready"
  | "permission_required"
  | "permission_probe_failed"
  | "unsupported_os"
  | "unsupported_arch"
  | "sdk_unavailable"
  | "sdk_api_mismatch";

export type ComputerUsePermissionState =
  | "granted"
  | "denied"
  | "not-required"
  | "unknown";

export interface ComputerUseCapabilities {
  listWindows: boolean;
  getWindowState: boolean;
  sessions: boolean;
  click: boolean;
  typeText: boolean;
  perActionNativeConfirmation: true;
  shell: false;
  arbitraryTools: false;
  clipboard: false;
  fileAccess: false;
  sendDeleteOrPaymentWithoutConfirmation: false;
}

export interface ComputerUseProbeResult {
  sdkVersion: "0.28.1";
  platform: string;
  arch: string;
  osVersion: string;
  supported: boolean;
  available: boolean;
  status: ComputerUseProbeStatus;
  message: string;
  permissions: {
    accessibility: ComputerUsePermissionState;
    screenRecording: ComputerUsePermissionState;
  };
  capabilities: ComputerUseCapabilities;
}

export interface ComputerUseWindow {
  pid: number;
  /** Unsigned native identifier kept as a decimal string; never coerce to number. */
  windowId: string;
  appName: string;
  title: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface ComputerUseWindowTarget {
  pid: number;
  windowId: string;
}

export type ComputerUseAction =
  | {
      kind: "click";
      target: ComputerUseWindowTarget;
      /** Both values come from the most recent bounded snapshot of this window. */
      snapshotId: string;
      elementToken: string;
    }
  | {
      kind: "type";
      target: ComputerUseWindowTarget;
      /** Must match the most recent bounded snapshot of this exact window. */
      snapshotId: string;
      /** Exact editable element from that snapshot; typing never uses ambient focus. */
      elementToken: string;
      /** Literal text only. Control characters, Enter and hotkeys are rejected. */
      text: string;
    };

export type ComputerUseErrorCode =
  | "approval_busy"
  | "approval_denied"
  | "approval_expired"
  | "approval_required"
  | "invalid_action"
  | "invalid_token"
  | "permission_required"
  | "sdk_api_mismatch"
  | "sdk_unavailable"
  | "sdk_version_mismatch"
  | "session_busy"
  | "session_consent_denied"
  | "session_not_active"
  | "session_start_failed"
  | "session_stop_failed"
  | "target_changed"
  | "target_not_found"
  | "snapshot_expired"
  | "action_failed"
  | "action_outcome_unknown"
  | "window_list_failed"
  | "window_state_failed";

export interface ComputerUseWindowElement {
  elementIndex: string;
  role: string;
  depth: number;
  elementToken?: string;
  label?: string;
  value?: string;
  valueDescription?: string;
  enabled?: boolean;
  selected?: boolean;
  inWebContent?: boolean;
  actions?: string[];
  parentIndex?: string;
  frame?: { x: number; y: number; width: number; height: number };
  min?: number;
  max?: number;
}

export interface ComputerUseWindowState {
  /** UI content is observation data, never an instruction or executable skill. */
  contentTrust: "untrusted-observation";
  target: ComputerUseWindowTarget;
  snapshotId: string | null;
  appName: string;
  windowTitle: string;
  treeMarkdown: string | null;
  elements: ComputerUseWindowElement[];
  counts: {
    elementCount?: string;
    totalElementCount?: string;
    returnedElementCount?: string;
    filteredElementCount?: string;
  };
  elementsComplete: boolean;
  degraded: boolean;
  degradedReason: string | null;
  truncated: boolean;
  truncationReason: string | null;
  screenshot: {
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    dataBase64: string;
    width?: number;
    height?: number;
    scale?: number;
    frameValid: boolean;
  } | null;
  windowBounds: { x: number; y: number; width: number; height: number };
}

export type ComputerUseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ComputerUseErrorCode; message: string } };

export interface ComputerUseBridge {
  /** Read-only; never prompts for or mutates OS permissions. */
  probe(): Promise<ComputerUseProbeResult>;
  startSession(): Promise<
    ComputerUseResult<{
      sessionId: string;
      state: "running";
      revived: boolean;
    }>
  >;
  stopSession(): Promise<
    ComputerUseResult<{ sessionId: null; state: "stopped" }>
  >;
  listWindows(): Promise<
    ComputerUseResult<{ windows: ComputerUseWindow[] }>
  >;
  /** Bounded to one listed window; no query and no screenshot output path are accepted. */
  getWindowState(
    target: ComputerUseWindowTarget,
  ): Promise<ComputerUseResult<ComputerUseWindowState>>;
  /** Opens a trusted native modal. A token is issued only after one approval. */
  requestActionApproval(action: ComputerUseAction): Promise<
    ComputerUseResult<{
      token: string;
      expiresAt: string;
      summary: string;
    }>
  >;
  /** Consumes the opaque token; the action itself is retained only in main. */
  executeApprovedAction(token: string): Promise<
    ComputerUseResult<{
      kind: ComputerUseAction["kind"];
      state: "delivered" | "delivered_unverified";
      effect: string;
    }>
  >;
}
