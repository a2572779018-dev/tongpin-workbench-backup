import { createRoot } from "react-dom/client";
import { ComputerUsePanel } from "../src/features/tongpin-ai/ComputerUsePanel";
import type { ComputerUseBridge, ComputerUseProbeResult } from "../shared/computerUse";

// A real React component test in Electron's Chromium renderer. The bridge is
// deliberately synthetic for UI rejection/retry; the separate probe mode uses
// the actual preload and actual native runtime, never this adapter.
let probes = 0;
const ready: ComputerUseProbeResult = {
  sdkVersion: "0.28.1", platform: "darwin", arch: "arm64", osVersion: "26.0",
  available: true, supported: true, status: "ready", message: "ready",
  permissions: { accessibility: "granted", screenRecording: "granted" },
  capabilities: { listWindows: true, getWindowState: true, sessions: true,
    click: true, typeText: true, perActionNativeConfirmation: true, shell: false,
    arbitraryTools: false, clipboard: false, fileAccess: false,
    sendDeleteOrPaymentWithoutConfirmation: false },
};
const bridge = {
  probe: async () => { probes += 1; if (probes === 1) throw new Error("isolated probe rejection"); return ready; },
  stopSession: async () => ({ ok: true, value: { sessionId: null, state: "stopped" } }),
} as ComputerUseBridge;
// Use a separate, non-preloaded browser window for this fixture: production's
// contextBridge is read-only and must not be patched/replaced.
Object.defineProperty(window, "tongpin", { value: { computerUse: bridge } });
createRoot(document.getElementById("root")!).render(<ComputerUsePanel requestId="fixture" originalPrompt="测试" onPlan={async () => { throw new Error("No model calls allowed"); }} onClose={() => undefined} onResult={() => undefined} />);

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("component did not reach expected state");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
async function verify() {
  await waitFor(() => Boolean(document.querySelector('[role="alert"]')));
  if (document.querySelector('[aria-busy="true"]') || document.body.textContent?.includes("正在检查本机能力") || document.querySelector(".tp-ai-computer__loading")) {
    throw new Error("probe rejection still displays checking/spinner");
  }
  const retry = [...document.querySelectorAll("button")].find(button => button.textContent?.includes("重新检查"));
  if (!retry) throw new Error("probe rejection has no retry button");
  retry.click();
  await waitFor(() => document.body.textContent?.includes("在系统弹窗中开启本次会话") === true);
  if (document.querySelector('[role="alert"]')) throw new Error("retry did not clear the prior error");
  return { rejectedProbeStoppedChecking: true, retryRecovered: true, probes, adapter: "synthetic-ui-only" };
}
(window as unknown as { fixtureResult: Promise<unknown> }).fixtureResult = verify();
