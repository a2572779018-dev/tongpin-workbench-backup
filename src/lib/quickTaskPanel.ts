import type { Task, TaskPriority, TaskStatus } from "../types";

export const QUICK_TASK_PRIORITIES: TaskPriority[] = [
  "p0",
  "p1",
  "p2",
  "p3",
  "p4",
];

const PRIORITY_RANK: Record<TaskPriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
};

const STATUS_RANK: Record<TaskStatus, number> = {
  doing: 0,
  todo: 1,
  done: 2,
};

export function sortQuickTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) =>
      Number(left.status === "done") - Number(right.status === "done") ||
      PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      right.createdAt.localeCompare(left.createdAt),
  );
}

export function shanghaiDateKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export function formatQuickTaskDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 4));
  const weekday = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
  }).format(date);
  return `${month}月${day}日 · ${weekday}`;
}

export function normalizeQuickTaskTitle(value: string): string {
  return value.trim().slice(0, 120);
}
