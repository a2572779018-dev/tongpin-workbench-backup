import { describe, expect, it } from "vitest";
import { classifyTaskCarryover, indexTaskCarryover, taskBacklogPage, type CarryoverRef } from "../../shared/taskCarryover";

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
});
