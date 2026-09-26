import { describe, expect, it } from "vitest";
import { bubbleTextForWorker, visualStateForStatus } from "./visualState";
import type { AgentOfficeStatus } from "./types";

const ALL_STATUSES: AgentOfficeStatus[] = ["queued", "thinking", "working", "searching", "done", "failed", "cancelled"];

describe("visualStateForStatus", () => {
  it("maps every status to exactly one visual state, with no gaps", () => {
    for (const status of ALL_STATUSES) {
      expect(() => visualStateForStatus(status)).not.toThrow();
    }
  });

  it("thinking and working read identically — typing at the desk with the monitor lit", () => {
    expect(visualStateForStatus("thinking")).toEqual(visualStateForStatus("working"));
    expect(visualStateForStatus("working").pose).toBe("typing");
    expect(visualStateForStatus("working").monitorOn).toBe(true);
  });

  it("queued is idle, monitor off, no overlay", () => {
    expect(visualStateForStatus("queued")).toEqual({
      pose: "idle", monitorOn: false, overlay: "none", greyed: false, showsBubble: false,
    });
  });

  it("searching lights the monitor and shows the tool bubble", () => {
    const state = visualStateForStatus("searching");
    expect(state.monitorOn).toBe(true);
    expect(state.showsBubble).toBe(true);
    expect(state.overlay).toBe("none");
  });

  it("done shows a check overlay and the result bubble, monitor off", () => {
    const state = visualStateForStatus("done");
    expect(state.overlay).toBe("check");
    expect(state.monitorOn).toBe(false);
    expect(state.showsBubble).toBe(true);
  });

  it("failed shows a cross overlay, no bubble", () => {
    const state = visualStateForStatus("failed");
    expect(state.overlay).toBe("cross");
    expect(state.showsBubble).toBe(false);
  });

  it("cancelled is greyed out with no overlay or bubble", () => {
    expect(visualStateForStatus("cancelled")).toEqual({
      pose: "cancelled", monitorOn: false, overlay: "none", greyed: true, showsBubble: false,
    });
  });

  it("only cancelled is greyed", () => {
    for (const status of ALL_STATUSES) {
      expect(visualStateForStatus(status).greyed).toBe(status === "cancelled");
    }
  });
});

describe("bubbleTextForWorker", () => {
  it("shows a search bubble with the live activity when searching", () => {
    expect(bubbleTextForWorker("searching", "查找 2026 年报", undefined)).toEqual({ kind: "search", text: "查找 2026 年报" });
  });

  it("falls back to a generic search caption when no activity is given", () => {
    expect(bubbleTextForWorker("searching", undefined, undefined)).toEqual({ kind: "search", text: "联网搜索" });
  });

  it("shows the result summary once done", () => {
    expect(bubbleTextForWorker("done", undefined, "已整理 12 条要点")).toEqual({ kind: "result", text: "已整理 12 条要点" });
  });

  it("shows nothing when done without a result summary", () => {
    expect(bubbleTextForWorker("done", undefined, undefined)).toBeNull();
    expect(bubbleTextForWorker("done", undefined, "   ")).toBeNull();
  });

  it("shows nothing for statuses with no bubble", () => {
    for (const status of ["queued", "thinking", "working", "failed", "cancelled"] as const) {
      expect(bubbleTextForWorker(status, "some activity", "some result")).toBeNull();
    }
  });
});
