import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import {
  normalizeQuickTaskTitle,
  shanghaiDateKey,
  sortQuickTasks,
} from "./quickTaskPanel";

function task(
  id: string,
  priority: Task["priority"],
  status: Task["status"],
  createdAt: string,
): Task {
  return {
    id,
    userId: "user-1",
    date: "2026-08-23",
    title: id,
    details: "",
    status,
    priority,
    origin: "self",
    assignedBy: null,
    assignmentId: null,
    sourceTaskId: null,
    assignmentDeliveredAt: null,
    assignmentViewedAt: null,
    completedAt: status === "done" ? createdAt : null,
    createdAt,
    updatedAt: createdAt,
  };
}

describe("quick task panel policy", () => {
  it("orders unfinished tasks by P0-P4 and keeps completed tasks last", () => {
    const ordered = sortQuickTasks([
      task("done-p0", "p0", "done", "2026-08-23T09:00:00Z"),
      task("todo-p3", "p3", "todo", "2026-08-23T09:00:00Z"),
      task("todo-p0", "p0", "todo", "2026-08-23T09:00:00Z"),
      task("doing-p1", "p1", "doing", "2026-08-23T09:00:00Z"),
      task("todo-p1", "p1", "todo", "2026-08-23T10:00:00Z"),
    ]);

    expect(ordered.map((item) => item.id)).toEqual([
      "todo-p0",
      "doing-p1",
      "todo-p1",
      "todo-p3",
      "done-p0",
    ]);
  });

  it("uses creation time as the final newest-first tie breaker", () => {
    const ordered = sortQuickTasks([
      task("older", "p2", "todo", "2026-08-23T08:00:00Z"),
      task("newer", "p2", "todo", "2026-08-23T09:00:00Z"),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("uses Asia/Shanghai across the UTC date boundary", () => {
    expect(shanghaiDateKey(new Date("2026-08-22T15:59:59.999Z"))).toBe(
      "2026-08-22",
    );
    expect(shanghaiDateKey(new Date("2026-08-22T16:00:00.000Z"))).toBe(
      "2026-08-23",
    );
  });

  it("trims and caps quick task titles", () => {
    expect(normalizeQuickTaskTitle("  今天完成原型  ")).toBe("今天完成原型");
    expect(normalizeQuickTaskTitle("a".repeat(140))).toHaveLength(120);
  });
});
