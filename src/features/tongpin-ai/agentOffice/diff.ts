import type { AgentOfficeSnapshot } from "./types";

/**
 * One-shot animation triggers derived from two snapshots. Everything that is
 * *persistent* state (is the monitor lit, which overlay glyph shows, what the
 * bubble says) is re-derived fresh from the current snapshot on every update
 * via visualState.ts — it doesn't need diffing, since re-applying identical
 * state is cheap and idempotent by construction.
 *
 * This module covers only the transient effects that must fire exactly once
 * per transition: an envelope flying, a cheer, a success/failure flourish.
 * Comparing field-by-field (rather than a snapshot identity/JSON shortcut)
 * makes "no real change → no events" fall out naturally, which is what makes
 * repeated/idempotent snapshots safe: if nothing in the compared fields
 * differs, no events are produced, however many times it's called.
 */
export type OfficeAnimationEvent =
  | { type: "dispatch"; workerId: string }
  | { type: "synthesize"; workerId: string }
  | { type: "celebrate" }
  | { type: "workerFlourish"; workerId: string; kind: "success" | "failure" };

export function diffSnapshots(
  prev: AgentOfficeSnapshot | null,
  next: AgentOfficeSnapshot,
): OfficeAnimationEvent[] {
  if (prev === next) return [];

  const events: OfficeAnimationEvent[] = [];
  const prevWorkers = new Map((prev?.workers ?? []).map((w) => [w.id, w] as const));

  for (const worker of next.workers) {
    const before = prevWorkers.get(worker.id);
    if (!before) {
      // A worker that wasn't there a moment ago just got the task handed to
      // it — the coordinator's envelope flies out to its desk.
      events.push({ type: "dispatch", workerId: worker.id });
      continue;
    }
    if (before.status !== worker.status) {
      if (worker.status === "done") events.push({ type: "workerFlourish", workerId: worker.id, kind: "success" });
      else if (worker.status === "failed") events.push({ type: "workerFlourish", workerId: worker.id, kind: "failure" });
    }
  }

  const enteredSynthesizing = next.phase === "synthesizing" && prev?.phase !== "synthesizing";
  if (enteredSynthesizing) {
    for (const worker of next.workers) events.push({ type: "synthesize", workerId: worker.id });
  }

  const enteredDone = next.phase === "done" && prev?.phase !== "done";
  if (enteredDone) events.push({ type: "celebrate" });

  return events;
}

/** The coordinator's thought-cloud text for the current (phase, activity) —
 *  applied fresh every update (ThoughtBubble.show() already no-ops a repeat
 *  of the same text), not diffed like the transient events above. */
export function coordinatorCaptionText(
  phase: AgentOfficeSnapshot["phase"],
  activity: string | undefined,
): string | null {
  const trimmed = activity?.trim();
  if (trimmed) return trimmed;
  if (phase === "planning") return "正在拆解任务…";
  if (phase === "synthesizing") return "正在综合结果…";
  return null;
}
