import { describe, expect, it, vi } from "vitest";
import type { ComputerUseBridge, ComputerUseWindowState } from "../../../shared/computerUse";
import { runComputerUseTask } from "./computerUseTask";

const observation = (phase: "start" | "input" | "done", suffix = "1"): ComputerUseWindowState => ({
  contentTrust: "untrusted-observation", target: { pid: 42, windowId: "9" }, snapshotId: `snapshot-${phase}-${suffix}`,
  appName: "Test Editor", windowTitle: "Isolated document", treeMarkdown: null, counts: {},
  elementsComplete: true, degraded: false, degradedReason: null, truncated: false, truncationReason: null,
  screenshot: null, windowBounds: { x: 0, y: 0, width: 400, height: 300 },
  elements: phase === "start" ? [{ elementIndex: "1", role: "button", depth: 1, label: "Open editor", elementToken: `open-${suffix}` }]
    : [{ elementIndex: "2", role: "AXTextArea", depth: 1, label: "Document", elementToken: `body-${suffix}`, value: phase === "done" ? "Tongpin test" : "" }],
});
const goal = '打开编辑器，输入“Tongpin test”';
const click = { kind: "computer" as const, summary: "打开编辑器", action: { kind: "click" as const, elementToken: "open-1" } };
const type = { kind: "computer" as const, summary: "输入测试文字", action: { kind: "type" as const, elementToken: "body-1", text: "Tongpin test" } };

function fixture() {
  let index = 0;
  const states = [observation("input"), observation("done")];
  const bridge = {
    requestActionApproval: vi.fn(async () => ({ ok: true, value: { token: "only-use-once", expiresAt: "", summary: "" } })),
    executeApprovedAction: vi.fn(async () => ({ ok: true, value: { kind: "click", state: "delivered", effect: "Confirmed" } })),
    getWindowState: vi.fn(async () => ({ ok: true, value: states[Math.min(index++, states.length - 1)] })),
    stopSession: vi.fn(async () => ({ ok: true, value: { sessionId: null, state: "stopped" } })),
  } as unknown as ComputerUseBridge;
  return { bridge, states, planNext: vi.fn(async () => type), initialState: observation("start"), initialPlan: click, goal };
}

describe("bounded supervised computer task", () => {
  it("observes, approves, executes and verifies a two-step task without replay", async () => {
    const f = fixture();
    const result = await runComputerUseTask(f);
    expect(result).toMatchObject({ status: "completed", steps: 2 });
    expect(f.bridge.requestActionApproval).toHaveBeenCalledTimes(2);
    expect(f.bridge.executeApprovedAction).toHaveBeenCalledTimes(2);
    expect(f.bridge.getWindowState).toHaveBeenCalledTimes(2);
    expect(f.planNext).toHaveBeenCalledTimes(1);
    expect(f.bridge.requestActionApproval).toHaveBeenLastCalledWith(expect.objectContaining({ snapshotId: "snapshot-input-1", elementToken: "body-1" }));
  });
  it("does not execute a denied approval or retry an unknown result", async () => {
    const denied = fixture();
    vi.mocked(denied.bridge.requestActionApproval).mockResolvedValue({ ok: false, error: { code: "approval_denied", message: "已取消" } });
    expect(await runComputerUseTask(denied)).toMatchObject({ status: "paused", steps: 0 });
    expect(denied.bridge.executeApprovedAction).not.toHaveBeenCalled();
    const uncertain = fixture();
    vi.mocked(uncertain.bridge.executeApprovedAction).mockResolvedValue({ ok: false, error: { code: "action_outcome_unknown", message: "未知结果" } });
    expect(await runComputerUseTask(uncertain)).toMatchObject({ status: "unknown", steps: 1 });
    expect(uncertain.bridge.executeApprovedAction).toHaveBeenCalledTimes(1);
    expect(uncertain.planNext).not.toHaveBeenCalled();
  });
  it("stops if the observed window changes and never plans across windows", async () => {
    const f = fixture();
    f.states[0].target.windowId = "other";
    expect(await runComputerUseTask(f)).toMatchObject({ status: "paused", steps: 1 });
    expect(f.planNext).not.toHaveBeenCalled();
  });
  it("stops no-progress and repeated actions even if native tokens rotate", async () => {
    const f = fixture();
    f.states[0] = observation("start", "fresh");
    f.states[1] = observation("start", "latest");
    expect(await runComputerUseTask(f)).toMatchObject({ status: "paused", steps: 1 });
    expect(f.planNext).not.toHaveBeenCalled();
  });
  it("enforces a hard step budget before a second model call", async () => {
    const f = fixture();
    expect(await runComputerUseTask({ ...f, maxSteps: 1 })).toMatchObject({ status: "paused", steps: 1 });
    expect(f.planNext).not.toHaveBeenCalled();
  });
  it("refuses a repeated semantic action despite new tokens and an unrelated counter repaint", async () => {
    const f = fixture();
    f.states[0] = observation("start", "fresh");
    f.states[0].elements.push({ role: "text", label: "Counter", value: "1", elementIndex: "3", depth: 1 });
    const next = vi.fn(async () => ({ ...click, action: { kind: "click" as const, elementToken: "open-fresh" } }));
    expect(await runComputerUseTask({ ...f, planNext: next })).toMatchObject({ status: "paused", steps: 1 });
    expect(f.bridge.requestActionApproval).toHaveBeenCalledTimes(1);
  });
  it("verifies actual state after unverified delivery without resubmitting the action", async () => {
    const f = fixture();
    vi.mocked(f.bridge.executeApprovedAction).mockResolvedValue({ ok: true, value: { kind: "click", state: "delivered_unverified", effect: "Unverifiable" } });
    expect(await runComputerUseTask(f)).toMatchObject({ status: "completed", steps: 2 });
    expect(f.bridge.executeApprovedAction).toHaveBeenCalledTimes(2);
    expect(f.bridge.getWindowState).toHaveBeenCalledTimes(2);
  });
  it("stops while awaiting a model and never uses its late result", async () => {
    const f = fixture();
    const abort = new AbortController();
    const pending = new Promise<never>(() => undefined);
    f.planNext.mockImplementation(() => pending);
    const result = runComputerUseTask({ ...f, signal: abort.signal, onProgress: progress => { if (progress.phase === "planning") abort.abort(); } });
    expect(await result).toMatchObject({ status: "paused", steps: 1 });
    expect(f.bridge.executeApprovedAction).toHaveBeenCalledTimes(1);
  });
  it("does not execute after a task deadline expires during confirmation", async () => {
    const f = fixture();
    let now = 0;
    vi.mocked(f.bridge.requestActionApproval).mockImplementation(async () => {
      now = 1001;
      return { ok: true, value: { token: "once", expiresAt: "", summary: "" } };
    });
    expect(await runComputerUseTask({ ...f, maxDurationMs: 1000, now: () => now })).toMatchObject({ status: "paused", steps: 0 });
    expect(f.bridge.executeApprovedAction).not.toHaveBeenCalled();
  });
});
