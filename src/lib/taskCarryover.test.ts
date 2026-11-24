import { describe, expect, it } from "vitest";
import { classifyTaskCarryover, completedCarryoverCopies, dayCarryoverStatus, indexTaskCarryover, taskBacklogPage, type CarryoverRef } from "../../shared/taskCarryover";

const task = (id: string, date = "2026-10-30", sourceTaskId: string | null = null, status = "todo", userId = "me"): CarryoverRef => ({ id, date, sourceTaskId, status, userId });
const today = "2026-11-02";
describe("effective history carryover", () => {
  it("finds Friday on Monday without a weekend task or a clock threshold", () => {
    expect(taskBacklogPage(indexTaskCarryover([task("a")], [], "me"), today, 50).tasks.map(t => t.id)).toEqual(["a"]);
  });
  it("handles a long break and keeps independent same-title daily tasks", () => {
    const result = taskBacklogPage(indexTaskCarryover([task("old", "2026-09-01"), task("daily1"), task("daily2")], [], "me"), today, 50);
    expect(result.tasks.map(t => t.id)).toEqual(["daily1", "daily2", "old"]);
  });
  it("suppresses ancestors when a later copy is completed or already today", () => {
    for (const status of ["done", "todo"]) {
      const index = indexTaskCarryover([task("a"), task("b", "2026-10-31", "a"), task("c", today, "b", status)], [], "me");
      expect(taskBacklogPage(index, today, 50).tasks).toEqual([]);
      expect(classifyTaskCarryover(index, ["a"], "2026-10-30", today)).toMatchObject({ eligible: [], skippedTaskIds: ["a"] });
    }
  });
  it("shows only the latest unfinished leaf and rejects stale source ids", () => {
    const index = indexTaskCarryover([task("a"), task("b", "2026-11-01", "a")], [], "me");
    expect(taskBacklogPage(index, today, 50).tasks.map(t => t.id)).toEqual(["b"]);
    expect(classifyTaskCarryover(index, ["a"], "2026-10-30", today).rejectedTaskIds).toEqual(["a"]);
  });
  it("does not resurrect a deleted continuation, or expose it as a candidate", () => {
    const index = indexTaskCarryover([task("a")], [task("b", "2026-10-31", "a")], "me");
    expect(taskBacklogPage(index, today, 50).tasks).toEqual([]);
    expect(classifyTaskCarryover(index, ["a"], "2026-10-30", today).rejectedTaskIds).toEqual(["a"]);
  });
  it("keeps lineage through a deleted intermediate node", () => {
    const index = indexTaskCarryover([task("a"), task("c", today, "b")], [task("b", "2026-10-31", "a")], "me");
    expect(index.rootOf("c")).toBe("a");
    expect(taskBacklogPage(index, today, 50).total).toBe(0);
  });
  it("isolates other accounts and handles cyclic or missing legacy links without hanging", () => {
    const index = indexTaskCarryover([task("a", "2026-10-30", "b"), task("b", "2026-10-31", "a"), task("foreign", "2026-10-30", null, "todo", "other"), task("orphan", "2026-10-30", "missing")], [], "me");
    expect(taskBacklogPage(index, today, 50).tasks.map(t => t.id)).toEqual(["orphan"]);
    expect(classifyTaskCarryover(index, ["foreign"], "2026-10-30", today).rejectedTaskIds).toEqual(["foreign"]);
  });
  it("uses stable date/id pagination when earlier items disappear after syncing", () => {
    const items = [task("a"), task("b"), task("c", "2026-10-29")];
    const first = taskBacklogPage(indexTaskCarryover(items, [], "me"), today, 1);
    expect(first.nextCursor).toBe("me/2026-11-02/2026-10-30/a");
    const next = taskBacklogPage(indexTaskCarryover(items.slice(1), [], "me"), today, 1, first.nextCursor!);
    expect(next.tasks.map(t => t.id)).toEqual(["b"]);
  });
  it("keeps an active branch when a sibling is deleted, and excludes future descendants", () => {
    const active = indexTaskCarryover([task("a"), task("c", "2026-11-01", "a")], [task("b", "2026-10-31", "a")], "me");
    expect(taskBacklogPage(active, today, 50).tasks.map(t => t.id)).toEqual(["c"]);
    const future = indexTaskCarryover([task("a"), task("b", "2026-11-03", "a")], [], "me");
    expect(taskBacklogPage(future, today, 50).tasks).toEqual([]);
  });
  it("uses actual update time, not random id order, for old same-day branches", () => {
    const index = indexTaskCarryover([task("parent", "2026-10-28"),
      { ...task("z-old", "2026-10-30", "parent"), createdAt: "2026-10-30T01:00:00Z", updatedAt: "2026-10-30T01:00:00Z" },
      { ...task("a-new", "2026-10-30", "parent", "done"), createdAt: "2026-10-30T02:00:00Z", updatedAt: "2026-10-30T02:05:00Z" },
    ], [], "me");
    expect(taskBacklogPage(index, today, 50).tasks).toEqual([]);
  });
  it("ignores malformed deleted snapshots without losing an unrelated task", () => {
    const index = indexTaskCarryover([task("a")], [null, {}, { id: "x", userId: "me", date: "", sourceTaskId: 3 }] as unknown as CarryoverRef[], "me");
    expect(taskBacklogPage(index, today, 50).tasks.map(t => t.id)).toEqual(["a"]);
  });
  it("does not carry completed/future tasks, duplicates or a different date", () => {
    const index = indexTaskCarryover([task("a"), task("done", "2026-10-30", null, "done"), task("future", "2026-11-03")], [], "me");
    expect(classifyTaskCarryover(index, ["a", "a", "done", "future", "missing"], "2026-10-30", today)).toMatchObject({ eligible: [{ id: "a" }], rejectedTaskIds: ["done", "future", "missing"] });
  });
  it("does not revive an old todo copy after an ancestor or sibling is completed", () => {
    for (const completed of [task("a", "2026-10-29", null, "done"), task("sibling", "2026-10-30", "a", "done")]) {
      const records = [task("a", "2026-10-29"), task("old-copy", "2026-10-31", "a"), completed];
      const index = indexTaskCarryover([...new Map(records.map(t => [t.id, t])).values()], [], "me");
      expect(taskBacklogPage(index, today, 50).tasks).toEqual([]);
      expect(classifyTaskCarryover(index, ["old-copy"], "2026-10-31", today).eligible).toEqual([]);
    }
  });
  it("only an explicit reopening starts a new carryover generation, never a title edit", () => {
    const completed = { ...task("a", "2026-10-29", null, "done"), completedAt: "2026-10-31T10:00:00Z" };
    const oldCopy = { ...task("b", "2026-10-30", "a"), createdAt: "2026-10-30T08:00:00Z", updatedAt: "2026-11-01T12:00:00Z" };
    expect(taskBacklogPage(indexTaskCarryover([completed, oldCopy], [], "me"), today, 50).tasks).toEqual([]);
    const events = [{ taskId: "a", userId: "me", action: "completed", createdAt: "2026-10-31T10:00:00Z" }, { taskId: "a", userId: "me", action: "reopened", createdAt: "2026-11-01T10:00:00Z" }];
    for (const status of ["todo", "doing"]) {
      const reopened = { ...completed, status, completedAt: null };
      const index = indexTaskCarryover([reopened, oldCopy], [], "me", events);
      expect(taskBacklogPage(index, today, 50).tasks.map(t => t.id)).toEqual(["a"]);
      const newCopy = { ...task("new", "2026-11-01", "a"), createdAt: "2026-11-01T11:00:00Z" };
      expect(taskBacklogPage(indexTaskCarryover([reopened, oldCopy, newCopy], [], "me", events), today, 50).tasks.map(t => t.id)).toEqual(["new"]);
    }
  });
  it("keeps real status-event order in the same millisecond and ignores foreign events", () => {
    const row = task("a");
    const done = { taskId: "a", userId: "me", action: "completed", createdAt: "2026-11-01T10:00:00Z" };
    const reopen = { ...done, action: "reopened" };
    expect(taskBacklogPage(indexTaskCarryover([row], [], "me", [done, reopen]), today, 50).total).toBe(1);
    expect(taskBacklogPage(indexTaskCarryover([row], [], "me", [reopen, done]), today, 50).total).toBe(0);
    expect(taskBacklogPage(indexTaskCarryover([row], [], "me", [{ ...done, userId: "other" }]), today, 50).total).toBe(1);
  });
  it("uses creation audit order when old and new copies share the reopen millisecond", () => {
    const stamp = "2026-11-01T10:00:00Z";
    const parent = task("parent", "2026-10-29"), old = { ...task("old", "2026-11-01", "parent"), createdAt: stamp };
    const fresh = { ...task("fresh", "2026-11-01", "parent"), createdAt: stamp };
    const event = (taskId: string, action: string) => ({ taskId, action, userId: "me", createdAt: stamp });
    const index = indexTaskCarryover([parent, old, fresh], [], "me", [event("parent", "completed"), event("old", "carried_over"), event("parent", "reopened"), event("fresh", "carried_over")]);
    expect(taskBacklogPage(index, today, 50).tasks.map(t => t.id)).toEqual(["fresh"]);
    expect(index.isCurrent(old)).toBe(false);
  });
  it("never lets a legacy done row's title-edit timestamp override reliable state history", () => {
    const parent = { ...task("parent", "2026-10-29", null, "done"), completedAt: null, updatedAt: "2026-11-02T12:00:00Z" };
    const reopened = task("reopened", "2026-10-30", "parent");
    const fresh = { ...task("fresh", today, "reopened"), createdAt: "2026-11-02T09:00:00Z" };
    const index = indexTaskCarryover([parent, reopened, fresh], [], "me", [{ taskId: "parent", userId: "me", action: "completed", createdAt: "2026-10-31T10:00:00Z" }, { taskId: "reopened", userId: "me", action: "reopened", createdAt: "2026-11-01T10:00:00Z" }]);
    expect(index.isCurrent(fresh)).toBe(true);
    expect(completedCarryoverCopies(index, today)).toEqual([]);
  });
});

describe("historical day source resolution", () => {
  const original = task("old", "2026-09-01"), child = task("child", "2026-10-31", "old");
  it("resolves a still-open historical card older than thirty days to its current source", () => {
    const result = dayCarryoverStatus(indexTaskCarryover([original, child], [], "me"), [original], original.date, today);
    expect(result.continuationSources.old).toEqual({ id: child.id, date: child.date });
    expect(result.unavailableTaskIds).toEqual(["old"]);
  });
  it("never resolves a closed, deleted, future or foreign continuation", () => {
    for (const index of [
      indexTaskCarryover([original, { ...child, status: "done" }], [], "me"),
      indexTaskCarryover([original], [child], "me"),
      indexTaskCarryover([original, { ...child, date: "2027-01-01" }], [], "me"),
      indexTaskCarryover([original, { ...child, userId: "other" }], [], "me"),
    ]) expect(dayCarryoverStatus(index, [original], original.date, today).continuationSources).toEqual({});
  });
});
