import type { MicrophoneAccessStatus, MicrophoneBridge } from "../../../../shared/aiVoice";
import type { VoiceIssue } from "./recorderState";

/**
 * Microphone access for the recorder. In the desktop app the main process is
 * asked first (macOS shows its system prompt only on the first press of the
 * microphone button); getUserMedia then goes through the session permission
 * handler. Every refusal becomes plain Chinese guidance for the member.
 */
export type MicrophoneIssueReason = "denied" | "restricted" | "no-device" | "busy" | "unsupported" | "unknown";

export type MicrophoneAccessResult = { ok: true } | { ok: false; reason: MicrophoneIssueReason };

const MAC_SETTINGS = "系统设置 → 隐私与安全性 → 麦克风";
const WINDOWS_SETTINGS = "Windows 设置 → 隐私和安全性（Windows 10 为「隐私」）→ 麦克风";

export function microphoneGuidance(reason: MicrophoneIssueReason, platform: string): string {
  if (reason === "denied") {
    if (platform === "darwin") return `同频没有麦克风权限。请打开 ${MAC_SETTINGS}，勾选「同频」后重试；如果列表里已勾选仍无效，请退出并重新打开同频。`;
    if (platform === "win32") return `麦克风被系统禁止访问。请打开 ${WINDOWS_SETTINGS}，开启「麦克风访问」和「允许桌面应用访问你的麦克风」后重试。`;
    return "麦克风权限被拒绝。请在浏览器或系统设置中允许同频使用麦克风后重试。";
  }
  if (reason === "restricted") return "麦克风访问被系统策略限制（例如家长控制或设备管理），请联系电脑管理员。";
  if (reason === "no-device") return "没有检测到可用的麦克风。请连接或开启麦克风后重试。";
  if (reason === "busy") return "麦克风正被其他应用占用或无法启动。请关闭正在使用麦克风的应用后重试。";
  if (reason === "unsupported") return "当前环境不支持录音，请更新到最新版同频后重试。";
  return "无法启动麦克风，请稍后重试。";
}

export function microphoneIssue(reason: MicrophoneIssueReason, platform: string, desktop: boolean): VoiceIssue {
  return {
    message: microphoneGuidance(reason, platform),
    canOpenSettings: desktop && reason === "denied" && (platform === "darwin" || platform === "win32"),
  };
}

/** Asks the desktop bridge before touching getUserMedia. A plain browser (no
 * bridge) lets getUserMedia show its own prompt. */
export async function ensureMicrophoneAccess(bridge: MicrophoneBridge | undefined): Promise<MicrophoneAccessResult> {
  if (!bridge) return { ok: true };
  let status: MicrophoneAccessStatus;
  try {
    status = await bridge.status();
    if (status === "not-determined") status = await bridge.request();
  } catch {
    return { ok: true };
  }
  if (status === "denied") return { ok: false, reason: "denied" };
  if (status === "restricted") return { ok: false, reason: "restricted" };
  // "granted", or "unknown" (e.g. Linux): let getUserMedia decide.
  return { ok: true };
}

/** Maps DOMException names from getUserMedia/MediaRecorder to a reason. */
export function classifyMicrophoneError(error: unknown): MicrophoneIssueReason {
  const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError" || name === "SecurityError") return "denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return "no-device";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  if (name === "NotSupportedError" || name === "TypeError") return "unsupported";
  return "unknown";
}
