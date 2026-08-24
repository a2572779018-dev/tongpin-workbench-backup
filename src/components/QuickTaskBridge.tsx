import { useEffect } from "react";
import { useAuth } from "../auth/AuthContext";
import { shanghaiDateKey } from "../lib/quickTaskPanel";
import type { Task } from "../types";

export function QuickTaskBridge() {
  const { api, loading, session, startupError } = useAuth();
  const quickTasks = window.tongpin?.quickTasks;

  useEffect(() => {
    if (!quickTasks) return;
    const enabled = Boolean(
      !loading &&
        !startupError &&
        session &&
        session.user.status === "active" &&
        session.user.role !== "admin",
    );
    quickTasks.setAvailability(enabled);
    return () => quickTasks.setAvailability(false);
  }, [loading, quickTasks, session, startupError]);

  useEffect(() => {
    if (!quickTasks) return;
    return quickTasks.onRequest(async ({ requestId, command }) => {
      if (
        !session ||
        session.user.status !== "active" ||
        session.user.role === "admin"
      ) {
        quickTasks.respond(requestId, {
          ok: false,
          error: "登录状态已失效，请打开同频重新登录。",
        });
        return;
      }

      try {
        let data: unknown;
        if (command.type === "list-today") {
          data = await api<{ tasks: Task[] }>(
            `/api/tasks?date=${shanghaiDateKey()}`,
          );
        } else if (command.type === "create") {
          data = await api<{ task: Task; tasks: Task[] }>("/api/tasks", {
            method: "POST",
            body: JSON.stringify({
              title: command.title,
              details: "",
              date: shanghaiDateKey(),
              priority: command.priority,
              scope: "day",
            }),
          });
          window.dispatchEvent(new CustomEvent("tongpin:task-sync"));
        } else {
          data = await api<{ task: Task }>(`/api/tasks/${command.taskId}`, {
            method: "PATCH",
            body: JSON.stringify({ status: command.status }),
          });
          window.dispatchEvent(new CustomEvent("tongpin:task-sync"));
        }
        quickTasks.respond(requestId, { ok: true, data });
      } catch (error) {
        quickTasks.respond(requestId, {
          ok: false,
          error: error instanceof Error ? error.message : "快捷待办操作失败",
        });
      }
    });
  }, [api, quickTasks, session]);

  useEffect(() => {
    if (!quickTasks) return;
    const notify = () => quickTasks.notifyChanged();
    window.addEventListener("tongpin:task-sync", notify);
    return () => window.removeEventListener("tongpin:task-sync", notify);
  }, [quickTasks]);

  return null;
}
