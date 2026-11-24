import type { Task } from "../types";
import { ApiRequestError, isNetworkUnavailable } from "./api";
import type { TaskReconcileGate } from "./taskReconcile";

type TaskApi = <T>(path: string, init?: RequestInit) => Promise<T>;

export function taskReadIssue(error: unknown, operation: string) {
  const transient = isNetworkUnavailable(error) ||
    (error instanceof ApiRequestError && [408, 429, 502, 503, 504].includes(error.status));
  const detail = !transient && error instanceof Error ? error.message : "";
  return { message: detail ? `${operation}：${detail}` : operation, transient };
}

export async function readTaskDay(
  api: TaskApi,
  gate: TaskReconcileGate,
  accountId: string,
  date: string,
  today: string,
) {
  const headers = { "X-Tongpin-Account": accountId };
  const key = `${accountId}/${date}`;
  // Capture the verification state before starting the read. An overlapping
  // correction can commit while this request still holds an older snapshot.
  const revisionBeforeRead = gate.revision;
  const read = () => api<{ tasks: Task[] }>(`/api/tasks?date=${date}`, { headers });
  const { tasks } = await read();
  if (date !== today || !tasks.some(task => task.sourceTaskId && task.status !== "done")) {
    return { tasks, issue: null };
  }
  try {
    await gate.ensure(key, async () => {
      const result = await api<{ tasks: Task[] }>("/api/tasks/reconcile-carryover", { method: "POST", headers, body: "{}" });
      return result.tasks.length > 0;
    });
    const currentTasks = gate.revision === revisionBeforeRead ? tasks : (await read()).tasks;
    return { tasks: currentTasks, issue: null };
  } catch (error) {
    return { tasks, issue: taskReadIssue(error, "历史任务承接状态待核实") };
  }
}
