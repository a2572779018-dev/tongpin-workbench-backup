import type { TaskPriority } from "../types";

export const TASK_PRIORITY_META: Record<
  TaskPriority,
  { label: string }
> = {
  p0: { label: "P0 加急" },
  p1: { label: "P1 当日须完成" },
  p2: { label: "P2 重要推进" },
  p3: { label: "P3 一般事项" },
  p4: { label: "P4 有空处理" },
};
