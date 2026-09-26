import type { AgentOfficeStatus } from "./types";

export type WorkerPose = "idle" | "typing" | "searching" | "done" | "failed" | "cancelled";
export type OverlayGlyph = "none" | "check" | "cross";

export interface VisualState {
  pose: WorkerPose;
  /** Desk monitor lit + the screen's scanline/cursor animation running. */
  monitorOn: boolean;
  overlay: OverlayGlyph;
  /** Desaturated + dimmed — cancelled work, out of the run. */
  greyed: boolean;
  /** Whether this state shows the small tool/status bubble above the desk;
   *  the caller supplies the text (see bubbleTextForWorker). */
  showsBubble: boolean;
}

/** Pure status → visual mapping, shared by the coordinator and every worker
 *  (both use AgentOfficeStatus). "thinking" and "working" read identically —
 *  typing at the desk with the monitor lit — matching the product spec. */
export function visualStateForStatus(status: AgentOfficeStatus): VisualState {
  switch (status) {
    case "queued":
      return { pose: "idle", monitorOn: false, overlay: "none", greyed: false, showsBubble: false };
    case "thinking":
    case "working":
      return { pose: "typing", monitorOn: true, overlay: "none", greyed: false, showsBubble: false };
    case "searching":
      return { pose: "searching", monitorOn: true, overlay: "none", greyed: false, showsBubble: true };
    case "done":
      return { pose: "done", monitorOn: false, overlay: "check", greyed: false, showsBubble: true };
    case "failed":
      return { pose: "failed", monitorOn: false, overlay: "cross", greyed: false, showsBubble: false };
    case "cancelled":
      return { pose: "cancelled", monitorOn: false, overlay: "none", greyed: true, showsBubble: false };
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export interface WorkerBubbleText {
  kind: "search" | "result";
  text: string;
}

/** What the little bubble above a worker's desk says, if anything — derived
 *  from the full worker record (not just its status), since "searching" wants
 *  the live activity text and "done" wants the result summary. Pure so the
 *  mapping from data → copy is unit-testable without touching Pixi. */
export function bubbleTextForWorker(status: AgentOfficeStatus, activity?: string, resultSummary?: string): WorkerBubbleText | null {
  if (status === "searching") {
    return { kind: "search", text: activity?.trim() || "联网搜索" };
  }
  if (status === "done" && resultSummary?.trim()) {
    return { kind: "result", text: resultSummary.trim() };
  }
  return null;
}
