import { createRoot } from "react-dom/client";
import { ComputerUsePanel } from "../src/features/tongpin-ai/ComputerUsePanel";
import type { ComputerUseBridge, ComputerUseProbeResult, ComputerUseWindowState } from "../shared/computerUse";

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
const target = { pid: 991, windowId: "1001" };
let step = 0;
let approvals = 0;
let executions = 0;
const results: string[] = [];
const observation = (): ComputerUseWindowState => ({ target, snapshotId: `snapshot-${step}`,
  contentTrust: "untrusted-observation", appName: "Fixture editor", windowTitle: "Untitled", treeMarkdown: null,
  elements: step === 0 ? [{ elementToken: "open", elementIndex: "1", role: "button", depth: 1, label: "Open editor" }]
    : [{ elementToken: "body", elementIndex: "2", role: "AXTextArea", depth: 1, label: "Document", value: step === 2 ? "Tongpin test" : "" }],
  counts: {}, elementsComplete: true, degraded: false, degradedReason: null, truncated: false,
  truncationReason: null, screenshot: null, windowBounds: { x: 0, y: 0, width: 400, height: 300 } });
const bridge = {
  probe: async () => { probes += 1; if (probes === 1) throw new Error("isolated probe rejection"); return ready; },
  stopSession: async () => ({ ok: true, value: { sessionId: null, state: "stopped" } }),
  startSession: async () => ({ ok: true, value: { sessionId: "fixture", state: "running", revived: false } }),
  listWindows: async () => ({ ok: true, value: { windows: [{ ...target, appName: "Fixture editor", title: "Untitled", bounds: { x: 0, y: 0, width: 400, height: 300 } }] } }),
  getWindowState: async () => ({ ok: true, value: observation() }),
  requestActionApproval: async () => { approvals += 1; return { ok: true, value: { token: `approval-${approvals}`, expiresAt: "", summary: "fixture" } }; },
  executeApprovedAction: async () => { executions += 1; step += 1; return { ok: true, value: { kind: step === 1 ? "click" : "type", state: "delivered", effect: "Confirmed" } }; },
} as ComputerUseBridge;
// Use a separate, non-preloaded browser window for this fixture: production's
// contextBridge is read-only and must not be patched/replaced.
Object.defineProperty(window, "tongpin", { value: { computerUse: bridge } });
createRoot(document.getElementById("root")!).render(<ComputerUsePanel requestId="fixture" originalPrompt={'打开编辑器，输入“Tongpin test”'}
  onPlan={async (_goal, snapshot) => snapshot.elements[0].elementToken === "open"
    ? { kind: "computer", summary: "打开编辑器", action: { kind: "click", elementToken: "open" } }
    : { kind: "computer", summary: "输入测试文字", action: { kind: "type", elementToken: "body", text: "Tongpin test" } }}
  onClose={() => undefined} onResult={message => results.push(message)} />);

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
  const clickButton = (label: string) => {
    const button = [...document.querySelectorAll("button")].find(value => value.textContent?.includes(label));
    if (!button || button.disabled) throw new Error(`button not actionable: ${label}`);
    button.click();
  };
  clickButton("在系统弹窗中开启本次会话");
  await waitFor(() => Boolean(document.querySelector("select")));
  const select = document.querySelector("select")!;
  select.value = `${target.pid}:${target.windowId}`;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => ![...document.querySelectorAll("button")].find(value => value.textContent?.includes("读取此窗口"))?.disabled);
  clickButton("读取此窗口");
  await waitFor(() => document.body.textContent?.includes("开始逐步执行并核验") === true);
  if (document.querySelector("details")?.open) throw new Error("debug controls should be collapsed by default");
  clickButton("开始逐步执行并核验");
  await waitFor(() => results.length === 1);
  if (!results[0].includes("已完成 2 步") || approvals !== 2 || executions !== 2) throw new Error("two-step UI task did not verify exactly two approved actions");
  return { rejectedProbeStoppedChecking: true, retryRecovered: true, probes, supervisedSteps: executions, approvals,
    resultVerified: true, adapter: "synthetic-ui-only" };
}
(window as unknown as { fixtureResult: Promise<unknown> }).fixtureResult = verify();
