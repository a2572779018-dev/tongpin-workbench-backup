import { describe, expect, it } from "vitest";
import { coordinatorCaptionText, diffSnapshots } from "./diff";
import type { AgentOfficeSnapshot } from "./types";

function snap(overrides: Partial<AgentOfficeSnapshot> = {}): AgentOfficeSnapshot {
  return {
    runId: "run-1",
    phase: "working",
    coordinator: { name: "Pro 协调", status: "working" },
    workers: [],
    updatedAt: 1,
    ...overrides,
  };
}

describe("diffSnapshots", () => {
  it("dispatches an envelope to every worker appearing for the first time", () => {
    const next = snap({
      phase: "dispatching",
      workers: [
        { id: "w1", role: "研究员", task: "t", status: "queued" },
        { id: "w2", role: "分析员", task: "t", status: "queued" },
      ],
    });
    const events = diffSnapshots(null, next);
    expect(events).toEqual([
      { type: "dispatch", workerId: "w1" },
      { type: "dispatch", workerId: "w2" },
    ]);
  });

  it("does not re-dispatch a worker already present in the previous snapshot", () => {
    const prev = snap({ workers: [{ id: "w1", role: "研究员", task: "t", status: "working" }] });
    const next = snap({ workers: [{ id: "w1", role: "研究员", task: "t", status: "working", activity: "still going" }] });
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it("fires a success flourish exactly on the transition into done", () => {
    const prev = snap({ workers: [{ id: "w1", role: "研究员", task: "t", status: "working" }] });
    const next = snap({ workers: [{ id: "w1", role: "研究员", task: "t", status: "done" }] });
    expect(diffSnapshots(prev, next)).toEqual([{ type: "workerFlourish", workerId: "w1", kind: "success" }]);
    // Re-applying the same "done" snapshot must not fire the flourish again.
    expect(diffSnapshots(next, next)).toEqual([]);
  });

  it("fires a failure flourish exactly on the transition into failed", () => {
    const prev = snap({ workers: [{ id: "w1", role: "核对员", task: "t", status: "searching" }] });
    const next = snap({ workers: [{ id: "w1", role: "核对员", task: "t", status: "failed" }] });
    expect(diffSnapshots(prev, next)).toEqual([{ type: "workerFlourish", workerId: "w1", kind: "failure" }]);
  });

  it("sends every worker's result back to the coordinator exactly once, entering synthesizing", () => {
    const workers: AgentOfficeSnapshot["workers"] = [
      { id: "w1", role: "研究员", task: "t", status: "done" },
      { id: "w2", role: "撰稿员", task: "t", status: "done" },
    ];
    const prev = snap({ phase: "working", workers });
    const next = snap({ phase: "synthesizing", workers });
    expect(diffSnapshots(prev, next)).toEqual([
      { type: "synthesize", workerId: "w1" },
      { type: "synthesize", workerId: "w2" },
    ]);
    // Staying in synthesizing across another update does not repeat the flight.
    expect(diffSnapshots(next, next)).toEqual([]);
  });

  it("celebrates exactly once on entering the done phase", () => {
    const prev = snap({ phase: "synthesizing" });
    const next = snap({ phase: "done" });
    expect(diffSnapshots(prev, next)).toEqual([{ type: "celebrate" }]);
    expect(diffSnapshots(next, next)).toEqual([]);
  });

  it("is idempotent for a repeated, structurally-identical snapshot", () => {
    const next = snap({
      phase: "synthesizing",
      workers: [{ id: "w1", role: "研究员", task: "t", status: "done", resultSummary: "ok" }],
    });
    const prev = snap({
      phase: "synthesizing",
      workers: [{ id: "w1", role: "研究员", task: "t", status: "done", resultSummary: "ok" }],
    });
    expect(diffSnapshots(prev, next)).toEqual([]);
  });

  it("treats a null previous snapshot as an empty run (everyone is newly dispatched)", () => {
    const next = snap({ workers: [{ id: "w1", role: "研究员", task: "t", status: "queued" }] });
    expect(diffSnapshots(null, next)).toEqual([{ type: "dispatch", workerId: "w1" }]);
  });
});

describe("coordinatorCaptionText", () => {
  it("shows the planning caption while planning, with no activity override", () => {
    expect(coordinatorCaptionText("planning", undefined)).toBe("正在拆解任务…");
  });
  it("shows the synthesizing caption while synthesizing", () => {
    expect(coordinatorCaptionText("synthesizing", undefined)).toBe("正在综合结果…");
  });
  it("prefers a live activity string over the phase default", () => {
    expect(coordinatorCaptionText("planning", "正在评估三个候选方案")).toBe("正在评估三个候选方案");
  });
  it("has no caption for phases with nothing to say", () => {
    expect(coordinatorCaptionText("working", undefined)).toBeNull();
    expect(coordinatorCaptionText("done", undefined)).toBeNull();
    expect(coordinatorCaptionText("dispatching", undefined)).toBeNull();
  });
});
