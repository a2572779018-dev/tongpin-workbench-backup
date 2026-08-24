import {
  FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Check,
  Circle,
  ListTodo,
  LoaderCircle,
  Plus,
  X,
} from "lucide-react";
import {
  formatQuickTaskDate,
  normalizeQuickTaskTitle,
  QUICK_TASK_PRIORITIES,
  shanghaiDateKey,
  sortQuickTasks,
} from "../lib/quickTaskPanel";
import { TASK_PRIORITY_META } from "../lib/taskPriority";
import type { Task, TaskPriority, TaskStatus } from "../types";

type QuickTaskCommand =
  | { type: "list-today" }
  | { type: "create"; title: string; priority: TaskPriority }
  | { type: "update-status"; taskId: string; status: TaskStatus };

interface QuickTaskBridge {
  request(command: QuickTaskCommand): Promise<unknown>;
  closePanel(): Promise<unknown>;
  openMain(): Promise<unknown>;
  onPanelVisibility?(callback: (visible: boolean) => void): () => void;
  onTasksChanged?(callback: () => void): () => void;
}

const PREVIEW_USER_ID = "preview-member";

function getBridge(): QuickTaskBridge | undefined {
  return (
    window as unknown as {
      tongpinQuick?: QuickTaskBridge;
    }
  ).tongpinQuick;
}

function fixtureTask(
  id: string,
  title: string,
  priority: TaskPriority,
  status: TaskStatus,
  createdOffsetMinutes: number,
): Task {
  const date = shanghaiDateKey();
  const createdAt = new Date(Date.now() - createdOffsetMinutes * 60_000).toISOString();
  return {
    id,
    userId: PREVIEW_USER_ID,
    date,
    title,
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

function createPreviewTasks(): Task[] {
  return [
    fixtureTask("preview-1", "确认新版即时通知到达情况", "p0", "doing", 74),
    fixtureTask("preview-2", "整理今日客户沟通重点", "p1", "todo", 48),
    fixtureTask("preview-3", "复核 LORA 链数据驾驶舱", "p2", "todo", 35),
    fixtureTask("preview-4", "跟进 Windows 安装反馈", "p2", "todo", 26),
    fixtureTask("preview-5", "更新本周素材清单", "p3", "todo", 19),
    fixtureTask("preview-6", "归档已完成文档", "p4", "done", 9),
  ];
}

function readTasks(value: unknown): Task[] | null {
  if (Array.isArray(value)) {
    return value as Task[];
  }
  if (value && typeof value === "object" && "tasks" in value) {
    const tasks = (value as { tasks?: unknown }).tasks;
    return Array.isArray(tasks) ? (tasks as Task[]) : null;
  }
  return null;
}

function readTask(value: unknown): Task | null {
  if (value && typeof value === "object" && "task" in value) {
    const task = (value as { task?: unknown }).task;
    return task && typeof task === "object" ? (task as Task) : null;
  }
  return null;
}

export function QuickTaskPanel() {
  const isPreview = new URLSearchParams(window.location.search).get("preview") === "1";
  const [tasks, setTasks] = useState<Task[]>(() => (isPreview ? createPreviewTasks() : []));
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("p2");
  const [loading, setLoading] = useState(!isPreview);
  const [submitting, setSubmitting] = useState(false);
  const [updatingTaskId, setUpdatingTaskId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const refreshGenerationRef = useRef(0);
  const dateKey = shanghaiDateKey();

  useLayoutEffect(() => {
    document.documentElement.dataset.surface = "quick-panel";
    document.body.classList.add("quick-panel-surface");
    return () => {
      delete document.documentElement.dataset.surface;
      document.body.classList.remove("quick-panel-surface");
    };
  }, []);

  const refreshTasks = useCallback(async () => {
    if (isPreview) {
      return;
    }

    const bridge = getBridge();
    if (!bridge) {
      setError("快捷待办暂不可用");
      setLoading(false);
      return;
    }

    const generation = ++refreshGenerationRef.current;
    setLoading(true);
    setError("");
    try {
      const result = await bridge.request({ type: "list-today" });
      const nextTasks = readTasks(result);
      if (!nextTasks) {
        throw new Error("Invalid quick-task response");
      }
      if (generation === refreshGenerationRef.current) {
        setTasks(nextTasks);
      }
    } catch {
      if (generation === refreshGenerationRef.current) {
        setError("同步失败，请稍后重试");
      }
    } finally {
      if (generation === refreshGenerationRef.current) {
        setLoading(false);
      }
    }
  }, [isPreview]);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  useEffect(() => {
    const bridge = getBridge();
    const removers: Array<() => void> = [];

    if (bridge?.onPanelVisibility) {
      removers.push(
        bridge.onPanelVisibility((visible) => {
          if (!visible) return;
          window.setTimeout(() => titleInputRef.current?.focus(), 80);
          void refreshTasks();
        }),
      );
    }
    if (bridge?.onTasksChanged) {
      removers.push(bridge.onTasksChanged(() => void refreshTasks()));
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        void bridge?.closePanel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => titleInputRef.current?.focus(), 100);

    return () => {
      removers.forEach((remove) => remove());
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [refreshTasks]);

  const sortedTasks = useMemo(() => sortQuickTasks(tasks), [tasks]);
  const pendingCount = tasks.filter((task) => task.status !== "done").length;

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = normalizeQuickTaskTitle(title);
    if (!normalizedTitle || submitting) {
      titleInputRef.current?.focus();
      return;
    }

    setSubmitting(true);
    refreshGenerationRef.current += 1;
    setLoading(false);
    setError("");
    try {
      if (isPreview) {
        const createdAt = new Date().toISOString();
        const task = fixtureTask(
          `preview-${Date.now()}`,
          normalizedTitle,
          priority,
          "todo",
          0,
        );
        task.createdAt = createdAt;
        task.updatedAt = createdAt;
        setTasks((current) => [task, ...current]);
      } else {
        const bridge = getBridge();
        if (!bridge) throw new Error("Missing bridge");
        const result = await bridge.request({
          type: "create",
          title: normalizedTitle,
          priority,
        });
        const resultTasks = readTasks(result);
        const task = readTask(result);
        if (resultTasks) {
          setTasks(resultTasks);
        } else if (task) {
          setTasks((current) => [task, ...current.filter((item) => item.id !== task.id)]);
        } else {
          await refreshTasks();
        }
      }
      setTitle("");
      titleInputRef.current?.focus();
    } catch {
      setError("添加失败，请重试");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleTask(task: Task) {
    if (updatingTaskId) return;
    const nextStatus: TaskStatus = task.status === "done" ? "todo" : "done";
    setUpdatingTaskId(task.id);
    refreshGenerationRef.current += 1;
    setLoading(false);
    setError("");

    try {
      if (isPreview) {
        setTasks((current) =>
          current.map((item) =>
            item.id === task.id
              ? {
                  ...item,
                  status: nextStatus,
                  completedAt: nextStatus === "done" ? new Date().toISOString() : null,
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
        );
      } else {
        const bridge = getBridge();
        if (!bridge) throw new Error("Missing bridge");
        const result = await bridge.request({
          type: "update-status",
          taskId: task.id,
          status: nextStatus,
        });
        const updatedTask = readTask(result);
        if (updatedTask) {
          setTasks((current) =>
            current.map((item) => (item.id === updatedTask.id ? updatedTask : item)),
          );
        } else {
          await refreshTasks();
        }
      }
    } catch {
      setError("任务状态更新失败");
    } finally {
      setUpdatingTaskId(null);
    }
  }

  return (
    <main className="quick-task-stage">
      <section className="quick-task-panel" aria-label="快捷待办">
        <header className="quick-task-header">
          <div className="quick-task-heading">
            <span className="quick-task-mark" aria-hidden="true">
              <ListTodo strokeWidth={2.5} />
            </span>
            <div>
              <h1>今日待办</h1>
              <p>{formatQuickTaskDate(dateKey)}</p>
            </div>
          </div>
          <button
            type="button"
            className="quick-task-icon-button"
            aria-label="关闭快捷待办"
            title="关闭"
            onClick={() => void getBridge()?.closePanel()}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        <form className="quick-task-create" onSubmit={createTask}>
          <label className="sr-only" htmlFor="quick-task-title">
            新建待办
          </label>
          <div className="quick-task-input-row">
            <input
              ref={titleInputRef}
              id="quick-task-title"
              value={title}
              maxLength={120}
              placeholder="新建待办…"
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
            />
            <button
              className="quick-task-add-button"
              type="submit"
              disabled={!normalizeQuickTaskTitle(title) || submitting}
              aria-label="添加待办"
            >
              {submitting ? (
                <LoaderCircle className="is-spinning" aria-hidden="true" />
              ) : (
                <Plus aria-hidden="true" strokeWidth={3} />
              )}
            </button>
          </div>
          <fieldset className="quick-task-priorities" aria-label="任务优先级">
            <legend className="sr-only">任务优先级</legend>
            {QUICK_TASK_PRIORITIES.map((option) => (
              <button
                key={option}
                className={`priority-${option}${priority === option ? " is-selected" : ""}`}
                type="button"
                aria-pressed={priority === option}
                title={TASK_PRIORITY_META[option].label}
                onClick={() => setPriority(option)}
              >
                {option.toUpperCase()}
              </button>
            ))}
          </fieldset>
        </form>

        <div className="quick-task-list-heading">
          <span>{pendingCount} 项待完成</span>
        </div>

        <div className="quick-task-list" role="list" aria-busy={loading}>
          {loading ? (
            <div className="quick-task-state">
              <LoaderCircle className="is-spinning" aria-hidden="true" />
              <span>正在同步</span>
            </div>
          ) : sortedTasks.length === 0 ? (
            <div className="quick-task-state quick-task-state--empty">
              <Check aria-hidden="true" />
              <strong>今天的待办已清空</strong>
            </div>
          ) : (
            sortedTasks.map((task) => {
              const done = task.status === "done";
              const updating = updatingTaskId === task.id;
              return (
                <article
                  key={task.id}
                  className={`quick-task-item priority-${task.priority}${done ? " is-done" : ""}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="quick-task-toggle"
                    aria-label={done ? `恢复待办：${task.title}` : `完成待办：${task.title}`}
                    disabled={updating}
                    onClick={() => void toggleTask(task)}
                  >
                    {updating ? (
                      <LoaderCircle className="is-spinning" aria-hidden="true" />
                    ) : done ? (
                      <Check aria-hidden="true" strokeWidth={3} />
                    ) : (
                      <Circle aria-hidden="true" />
                    )}
                  </button>
                  <div className="quick-task-item-copy">
                    <span className="quick-task-priority-label">
                      {task.priority.toUpperCase()}
                    </span>
                    <strong>{task.title}</strong>
                  </div>
                </article>
              );
            })
          )}
        </div>

        <div className="quick-task-error" aria-live="polite">
          {error}
        </div>

        <footer className="quick-task-footer">
          <span>同频快捷待办</span>
          <button type="button" onClick={() => void getBridge()?.openMain()}>
            打开完整同频
            <ArrowUpRight aria-hidden="true" />
          </button>
        </footer>
      </section>
    </main>
  );
}
