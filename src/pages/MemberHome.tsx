import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  Flag,
  ListChecks,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNoticeCenter } from "../components/NoticeCenter";
import {
  addDays,
  fromDateKey,
  formatDateLabel,
  formatFullDate,
  getWeek,
  greetingByHour,
  isSameDate,
  isToday,
  startOfWeek,
  toDateKey,
} from "../lib/date";
import { TASK_PRIORITY_META } from "../lib/taskPriority";
import { TaskBacklog } from "../components/TaskBacklog";
import { syncPastTaskGroups } from "../lib/taskCarryoverClient";
import {
  isLaneHomeLayout,
  type HomeLayout,
} from "../lib/homeLayout";
import {
  formatCountdownUnit,
  getWorkdayCountdown,
} from "../lib/workday";
import type { Task, TaskPriority, TaskStatus } from "../types";

interface DailySummary {
  total: number;
  done: number;
  doing: number;
}

type TaskCreateScope = "day" | "rest_of_week";

const PRIORITY_RANK: Record<TaskPriority, number> = {
  p0: 0,
  p1: 1,
  p2: 2,
  p3: 3,
  p4: 4,
};

const TASK_PRIORITY_OPTIONS: TaskPriority[] = ["p0", "p1", "p2", "p3", "p4"];

const STATUS_RANK: Record<TaskStatus, number> = {
  doing: 0,
  todo: 1,
  done: 2,
};

function sortTasks(tasks: Task[]) {
  return [...tasks].sort(
    (left, right) =>
      Number(left.status === "done") - Number(right.status === "done") ||
      PRIORITY_RANK[left.priority] - PRIORITY_RANK[right.priority] ||
      STATUS_RANK[left.status] - STATUS_RANK[right.status] ||
      right.createdAt.localeCompare(left.createdAt),
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: "待处理",
  doing: "进行中",
  done: "已完成",
};

function WorkdayCountdownPanel() {
  const [now, setNow] = useState(() => new Date());
  const countdown = getWorkdayCountdown(now);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div
      className={`workday-countdown is-${countdown.status}`}
      role="timer"
      aria-label={
        countdown.status === "off-work"
          ? "今日已经下班"
          : `距离下班还有 ${countdown.hours} 小时 ${countdown.minutes} 分钟 ${countdown.seconds} 秒`
      }
    >
      <span>
        <Clock3 size={15} />
        {countdown.status === "off-work" ? "今日已下班" : "距离下班还有"}
      </span>
      <strong>
        <b>{formatCountdownUnit(countdown.hours)}</b>
        <i>时</i>
        <b>{formatCountdownUnit(countdown.minutes)}</b>
        <i>分</i>
        <b>{formatCountdownUnit(countdown.seconds)}</b>
        <i>秒</i>
      </strong>
    </div>
  );
}

export function MemberHome({ layout }: { layout: HomeLayout }) {
  const { session, api } = useAuth();
  const { confirm: confirmNotice, notify } = useNoticeCenter();
  const [selectedDate, setSelectedDate] = useState(toDateKey(new Date()));
  const [tasks, setTasks] = useState<Task[]>([]);
  const [summary, setSummary] = useState<Record<string, DailySummary>>({});
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("p2");
  const [createScope, setCreateScope] = useState<TaskCreateScope>("day");
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [highlightTaskId, setHighlightTaskId] = useState("");
  const [pastSyncSelection, setPastSyncSelection] = useState<string[]>([]);
  const [syncedSourceTaskIds, setSyncedSourceTaskIds] = useState<string[]>([]);
  const [pastSyncLoading, setPastSyncLoading] = useState(false);
  const [pastSyncBusy, setPastSyncBusy] = useState(false);
  const selectedDateRef = useRef(selectedDate);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const activeDateRef = useRef(toDateKey(new Date()));

  const week = useMemo(() => getWeek(selectedDate), [selectedDate]);
  const from = toDateKey(week[0]);
  const to = toDateKey(week[6]);
  const isPastDate = selectedDate < toDateKey(new Date());
  const usesLaneLayout = isLaneHomeLayout(layout);

  const loadTasks = useCallback(async ({ showLoading = true } = {}) => {
    if (showLoading) setLoading(true);
    if (showLoading) setError("");
    try {
      const result = await api<{ tasks: Task[] }>(
        `/api/tasks?date=${selectedDate}`,
      );
      if (alive.current && selectedDateRef.current === selectedDate) setTasks(sortTasks(result.tasks));
    } catch (caught) {
      if (alive.current && selectedDateRef.current === selectedDate) setError(caught instanceof Error ? caught.message : "任务加载失败");
    } finally {
      if (alive.current && selectedDateRef.current === selectedDate) {
        if (showLoading) setLoading(false);
      }
    }
  }, [api, selectedDate]);

  const loadSummary = useCallback(async () => {
    try {
      const result = await api<{ summary: Record<string, DailySummary> }>(
        `/api/tasks/summary?from=${from}&to=${to}`,
      );
      setSummary(result.summary);
    } catch {
      // 日期卡片没有摘要时仍可继续管理当天任务。
    }
  }, [api, from, to]);

  useEffect(() => {
    void loadTasks({ showLoading: true });
    void loadSummary();
  }, [loadSummary, loadTasks]);

  useEffect(() => {
    setPastSyncSelection([]);
    setSyncedSourceTaskIds([]);
    if (!isPastDate) return;
    let cancelled = false;
    setPastSyncLoading(true);
    void api<{
      syncedTaskIds: string[];
      unavailableTaskIds?: string[];
    }>(
      `/api/tasks/sync-to-today?sourceDate=${selectedDate}`,
    )
      .then((result) => {
        if (!cancelled) setSyncedSourceTaskIds([...result.syncedTaskIds, ...(result.unavailableTaskIds ?? [])]);
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(
            caught instanceof Error ? caught.message : "同步状态加载失败",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setPastSyncLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, isPastDate, selectedDate]);

  useEffect(() => {
    setPastSyncSelection((current) =>
      current.filter((taskId) =>
        tasks.some(
          (task) =>
            task.id === taskId &&
            task.status !== "done" &&
            !syncedSourceTaskIds.includes(task.id),
        ),
      ),
    );
  }, [syncedSourceTaskIds, tasks]);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  useEffect(() => {
    const checkDay = () => {
      const today = toDateKey(new Date()), previous = activeDateRef.current;
      if (previous === today) return;
      activeDateRef.current = today;
      if (selectedDateRef.current === previous) {
        selectedDateRef.current = today; setSelectedDate(today);
      }
    };
    const timer = window.setInterval(checkDay, 30000);
    window.addEventListener("focus", checkDay);
    return () => { clearInterval(timer); window.removeEventListener("focus", checkDay); };
  }, []);

  useEffect(() => {
    const openTask = (event: Event) => {
      const detail = (
        event as CustomEvent<{ taskId?: string; date?: string }>
      ).detail;
      if (!detail?.taskId || !detail.date) return;
      setSelectedDate(detail.date);
      setHighlightTaskId(detail.taskId);
      if (detail.date === selectedDate) void loadTasks({ showLoading: false });
    };
    window.addEventListener("tongpin:open-task", openTask);
    return () => window.removeEventListener("tongpin:open-task", openTask);
  }, [loadTasks, selectedDate]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const refreshTasks = () => {
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void loadTasks({ showLoading: false });
        void loadSummary();
      }, 120);
    };

    window.addEventListener("tongpin:task-sync", refreshTasks);
    return () => {
      window.removeEventListener("tongpin:task-sync", refreshTasks);
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [loadSummary, loadTasks]);

  useEffect(() => {
    if (!highlightTaskId || loading) return;
    const row = document.querySelector<HTMLElement>(
      `[data-task-id="${CSS.escape(highlightTaskId)}"]`,
    );
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => setHighlightTaskId(""), 6_000);
    return () => window.clearTimeout(timer);
  }, [highlightTaskId, loading, tasks]);

  const doneCount = tasks.filter((task) => task.status === "done").length;
  const doingCount = tasks.filter((task) => task.status === "doing").length;
  const urgentCount = tasks.filter(
    (task) =>
      (task.priority === "p0" || task.priority === "p1") &&
      task.status !== "done",
  ).length;
  const progress = tasks.length
    ? Math.round((doneCount / tasks.length) * 100)
    : 0;

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError("");
    try {
      const result = await api<{ task: Task; tasks: Task[] }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          details: "",
          date: selectedDate,
          priority,
          scope: createScope,
        }),
      });
      const visibleCreated = result.tasks.filter(
        (task) => task.date === selectedDateRef.current,
      );
      if (visibleCreated.length > 0) {
        const createdIds = new Set(visibleCreated.map((task) => task.id));
        setTasks((current) =>
          sortTasks([
            ...visibleCreated,
            ...current.filter((task) => !createdIds.has(task.id)),
          ]),
        );
      }
      setTitle("");
      setPriority("p2");
      setCreateScope("day");
      await loadSummary();
      if (createScope === "rest_of_week") {
        notify({
          title: "本周任务已创建",
          body: `已从当天到本周日创建 ${result.tasks.length} 项任务。`,
          tone: "success",
          duration: 6_000,
        });
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务创建失败");
    } finally {
      setSaving(false);
    }
  }

  async function updateTask(
    taskId: string,
    patch: Partial<
      Pick<Task, "status" | "title" | "details" | "date" | "priority">
    >,
  ) {
    setError("");
    try {
      const result = await api<{ task: Task }>(`/api/tasks/${taskId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (result.task.date !== selectedDate) {
        setTasks((current) => current.filter((task) => task.id !== taskId));
      } else {
        setTasks((current) =>
          sortTasks(
            current.map((task) => (task.id === taskId ? result.task : task)),
          ),
        );
      }
      await loadSummary();
      return result.task;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务更新失败");
      throw caught;
    }
  }

  async function moveTask(taskId: string, status: TaskStatus) {
    const previousTask = tasks.find((task) => task.id === taskId);
    if (!previousTask || previousTask.status === status) return;
    setTasks((current) =>
      sortTasks(
        current.map((task) =>
          task.id === taskId ? { ...task, status } : task,
        ),
      ),
    );
    try {
      await updateTask(taskId, { status });
    } catch {
      setTasks((current) =>
        sortTasks(
          current.map((task) =>
            task.id === taskId ? previousTask : task,
          ),
        ),
      );
    }
  }

  async function deleteTask(taskId: string) {
    const approved = await confirmNotice({
      title: "删除这条任务？",
      body: "删除后无法恢复。",
      confirmLabel: "确认删除",
      tone: "warning",
    });
    if (!approved) return;
    try {
      await api(`/api/tasks/${taskId}`, { method: "DELETE" });
      setTasks((current) => current.filter((task) => task.id !== taskId));
      await loadSummary();
      notify({
        title: "任务已删除",
        body: "这条任务已从当天清单移除。",
        tone: "success",
        duration: 5_000,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务删除失败");
    }
  }

  function togglePastSyncTask(taskId: string) {
    if (syncedSourceTaskIds.includes(taskId)) return;
    setPastSyncSelection((current) =>
      current.includes(taskId)
        ? current.filter((candidate) => candidate !== taskId)
        : [...current, taskId],
    );
  }

  async function syncPastTasks(taskIds = pastSyncSelection) {
    if (pastSyncBusy || taskIds.length === 0) return;
    setPastSyncBusy(true); setError("");
    try {
      const result = await syncPastTaskGroups(api, tasks.filter(task => taskIds.includes(task.id)), session!.user.id);
      if (!alive.current) return;
      setSyncedSourceTaskIds(previous => [...new Set([...previous, ...result.handledIds])]);
      setPastSyncSelection(previous => previous.filter(id => !result.handledIds.includes(id)));
      await loadSummary();
      window.dispatchEvent(new Event("tongpin:task-sync"));
      if (result.errors.length) setError(result.errors.join("；"));
      if (result.handledIds.length) notify({
        title: result.createdCount ? "已加入今日 " + result.createdCount + " 项" : "任务已在今日清单",
        body: "", tone: "success", duration: 5000,
        actions: [{ label: "查看今日", onSelect: () => setSelectedDate(result.targetDate) }],
      });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "往日任务同步失败"); }
    finally { setPastSyncBusy(false); }
  }

  function moveWeek(amount: number) {
    setSelectedDate(toDateKey(addDays(startOfWeek(selectedDate), amount * 7)));
  }

  return (
    <div
      className={[
        "member-page",
        usesLaneLayout ? "member-page--lanes" : "member-page--classic",
        `member-page--${layout}`,
      ].join(" ")}
    >
      <TaskBacklog onViewToday={date => { if (date) setSelectedDate(date); }} />
      {usesLaneLayout ? (
        <LaneTaskBoard
          tasks={tasks}
          selectedDate={selectedDate}
          title={title}
          priority={priority}
          createScope={createScope}
          loading={loading}
          saving={saving}
          error={error}
          highlightTaskId={highlightTaskId}
          progress={progress}
          doneCount={doneCount}
          userRole={session!.user.role}
          isPastDate={isPastDate}
          pastSyncSelection={pastSyncSelection}
          syncedSourceTaskIds={syncedSourceTaskIds}
          pastSyncLoading={pastSyncLoading}
          pastSyncBusy={pastSyncBusy}
          onSelectedDateChange={setSelectedDate}
          onTitleChange={setTitle}
          onPriorityChange={setPriority}
          onCreateScopeChange={setCreateScope}
          onCreateTask={createTask}
          onMoveTask={moveTask}
          onEditTask={setEditingTask}
          onDeleteTask={deleteTask}
          onTogglePastSync={togglePastSyncTask}
          onSyncPastTasks={syncPastTasks}
        />
      ) : (
        <>
      <section className="member-intro">
        <div className="member-intro__main">
          <div className="member-intro__top">
            <div className="member-intro__heading">
              <span className="eyebrow">
                <Sparkles size={14} />
                {greetingByHour()}，{session!.user.name}
              </span>
              <h2>
                {isToday(selectedDate)
                  ? "把今天做清楚。"
                  : formatFullDate(selectedDate)}
              </h2>
            </div>
            {session!.user.role === "member" && <WorkdayCountdownPanel />}
          </div>

          <div className="member-date-picker">
            <header className="date-rail-card__header">
              <div>
                <CalendarDays size={17} />
                <span>
                  {week[0].getFullYear()} 年 {week[0].getMonth() + 1} 月
                </span>
              </div>
              <div className="segmented-arrows">
                <button
                  type="button"
                  aria-label="上一周"
                  onClick={() => moveWeek(-1)}
                >
                  <ArrowLeft size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedDate(toDateKey(new Date()))}
                >
                  今天
                </button>
                <button
                  type="button"
                  aria-label="下一周"
                  onClick={() => moveWeek(1)}
                >
                  <ArrowRight size={16} />
                </button>
              </div>
            </header>
            <div className="date-rail" data-testid="date-rail">
              {week.map((date) => {
                const key = toDateKey(date);
                const label = formatDateLabel(date);
                const item = summary[key] ?? {
                  total: 0,
                  done: 0,
                  doing: 0,
                };
                const ratio = item.total ? (item.done / item.total) * 100 : 0;
                return (
                  <button
                    key={key}
                    type="button"
                    className={[
                      isSameDate(date, selectedDate) ? "is-selected" : "",
                      isToday(date) ? "is-today" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => setSelectedDate(key)}
                  >
                    <span className="date-card__weekday">
                      周{label.weekday}
                      {isToday(date) && <i>今日</i>}
                    </span>
                    <strong>{label.day}</strong>
                    <span className="date-card__month">{label.month}</span>
                    <span className="date-card__bar">
                      <i style={{ width: `${ratio}%` }} />
                    </span>
                    <small>
                      {item.total
                        ? `${item.done}/${item.total} 完成`
                        : "暂无任务"}
                    </small>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <aside className="daily-score">
          <div
            className="progress-ring"
            style={
              { "--progress": `${progress * 3.6}deg` } as React.CSSProperties
            }
          >
            <span>
              <b>{progress}%</b>
              <small>今日完成</small>
            </span>
          </div>
          <div className="daily-score__copy">
            <span>{doneCount} 项已完成</span>
            <b>
              {tasks.length === 0
                ? "先添加第一项任务"
                : progress === 100
                  ? "今天已经清账"
                  : `还剩 ${tasks.length - doneCount} 项`}
            </b>
          </div>
        </aside>
      </section>

      <div className="task-workspace">
        <section className="task-board">
          <header className="task-board__header">
            <div>
              <h3>{formatFullDate(selectedDate)}</h3>
            </div>
            <span className="task-count">
              {tasks.length} 项任务 · {doneCount} 项完成
            </span>
          </header>

          {isPastDate ? (
            <PastTaskSyncBar
              availableCount={
                tasks.filter(
                  (task) =>
                    task.status !== "done" &&
                    !syncedSourceTaskIds.includes(task.id),
                ).length
              }
              selectedCount={pastSyncSelection.length}
              loading={pastSyncLoading}
              busy={pastSyncBusy}
              onSync={() => void syncPastTasks()}
            />
          ) : (
          <form className="quick-add" onSubmit={createTask}>
            <span className="quick-add__plus">
              <Plus size={18} />
            </span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="写下一件要完成的事…"
              aria-label="新任务标题"
              maxLength={120}
            />
            <label className="task-scope-toggle">
              <CalendarDays size={15} />
              <select
                value={createScope}
                aria-label="新任务创建范围"
                onChange={(event) =>
                  setCreateScope(event.target.value as TaskCreateScope)
                }
              >
                <option value="day">仅当天（默认）</option>
                <option value="rest_of_week">当天至本周日（每天）</option>
              </select>
              <ChevronDown size={13} />
            </label>
            <QuickAddPriorityMenu
              value={priority}
              onChange={setPriority}
            />
            <button
              className="quick-add__submit"
              type="submit"
              disabled={!title.trim() || saving}
            >
              {saving ? "添加中" : "添加任务"}
            </button>
          </form>
          )}

          {error && <div className="inline-error">{error}</div>}

          <div className="task-list" data-testid="task-list">
            {loading ? (
              <>
                <div className="task-skeleton" />
                <div className="task-skeleton" />
                <div className="task-skeleton" />
              </>
            ) : tasks.length === 0 ? (
              <div className="task-empty">
                <span>
                  <ListChecks size={27} />
                </span>
                <h4>这一天还没有任务</h4>
              </div>
            ) : (
              tasks.map((task) => (
                <article
                  key={task.id}
                  data-task-id={task.id}
                  className={[
                    "task-row",
                    `task-row--priority-${task.priority}`,
                    `task-row--${task.status}`,
                    highlightTaskId === task.id ? "is-highlighted" : "",
                  ].join(" ")}
                  onClick={() => setEditingTask(task)}
                >
                  {isPastDate && task.status !== "done" ? (
                    <button
                      className={[
                        "past-task-check",
                        pastSyncSelection.includes(task.id)
                          ? "is-selected"
                          : "",
                        syncedSourceTaskIds.includes(task.id)
                          ? "is-synced"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      type="button"
                      disabled={pastSyncLoading || pastSyncBusy || syncedSourceTaskIds.includes(task.id)}
                      aria-label={
                        syncedSourceTaskIds.includes(task.id)
                          ? `${task.title} 已有承接记录`
                          : `${pastSyncSelection.includes(task.id) ? "取消选择" : "选择"} ${task.title}`
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        togglePastSyncTask(task.id);
                      }}
                    >
                      {syncedSourceTaskIds.includes(task.id) ||
                      pastSyncSelection.includes(task.id) ? (
                        <Check size={15} />
                      ) : (
                        <span />
                      )}
                    </button>
                  ) : (
                    <span className={`task-row__state state-${task.status}`}>
                      {task.status === "done" ? (
                        <Check size={15} />
                      ) : task.status === "doing" ? (
                        <Clock3 size={15} />
                      ) : (
                        <Circle size={15} />
                      )}
                    </span>
                  )}
                  <button
                    className="task-row__copy"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setEditingTask(task);
                    }}
                  >
                    <span>
                      <b>{task.title}</b>
                      <i className={`priority-badge priority-${task.priority}`}>
                        {TASK_PRIORITY_META[task.priority].label}
                      </i>
                      {task.assignedBy && (
                        <i className="assignment-badge">老板派发</i>
                      )}
                    </span>
                    {task.details && <small>{task.details}</small>}
                  </button>
                  <label
                    className={`status-select status-${task.status}`}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <select
                      value={task.status}
                      aria-label={`${task.title}的状态`}
                      onChange={(event) =>
                        void updateTask(task.id, {
                          status: event.target.value as TaskStatus,
                        })
                      }
                    >
                      {Object.entries(STATUS_LABEL).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={14} />
                  </label>
                  {isPastDate &&
                    task.status !== "done" &&
                    !syncedSourceTaskIds.includes(task.id) && (
                      <button
                        className="task-action task-action--today"
                        type="button"
                        title="将该任务放到今天"
                        aria-label="将该任务放到今天"
                        disabled={pastSyncBusy || pastSyncLoading}
                        onClick={(event) => {
                          event.stopPropagation();
                          void syncPastTasks([task.id]);
                        }}
                      >
                        今
                      </button>
                    )}
                  {!task.assignedBy && (
                    <button
                      className="task-action task-action--danger"
                      type="button"
                      aria-label={`删除 ${task.title}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void deleteTask(task.id);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  )}
                </article>
              ))
            )}
          </div>
        </section>

        <aside className="day-ledger">
          <h3>任务分布</h3>
          <div className="ledger-metric">
            <span className="ledger-metric__icon is-blue">
              <ListChecks size={18} />
            </span>
            <span>
              <small>总任务</small>
              <b>{tasks.length}</b>
            </span>
          </div>
          <div className="ledger-metric">
            <span className="ledger-metric__icon is-amber">
              <Clock3 size={18} />
            </span>
            <span>
              <small>进行中</small>
              <b>{doingCount}</b>
            </span>
          </div>
          <div className="ledger-metric">
            <span className="ledger-metric__icon is-red">
              <Flag size={18} />
            </span>
            <span>
              <small>P0 / P1 待办</small>
              <b>{urgentCount}</b>
            </span>
          </div>
        </aside>
      </div>
        </>
      )}

      {editingTask && (
        <TaskEditor
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={async (patch) => {
            await updateTask(
              editingTask.id,
              editingTask.assignedBy ? { details: patch.details } : patch,
            );
            setEditingTask(null);
          }}
        />
      )}

    </div>
  );
}

const LANE_COLUMNS: {
  status: TaskStatus;
  label: string;
  tone: "blue" | "yellow" | "green";
}[] = [
  { status: "doing", label: "正在做", tone: "blue" },
  { status: "todo", label: "接下来", tone: "yellow" },
  { status: "done", label: "已完成", tone: "green" },
];

const CALENDAR_WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function calendarDays(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const mondayOffset = (first.getDay() + 6) % 7;
  const start = new Date(
    cursor.getFullYear(),
    cursor.getMonth(),
    1 - mondayOffset,
  );
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  if (status === "done") return <Check size={16} />;
  if (status === "doing") return <Clock3 size={16} />;
  return <Circle size={16} />;
}

function QuickAddPriorityMenu({
  value,
  onChange,
}: {
  value: TaskPriority;
  onChange: (priority: TaskPriority) => void;
}) {
  const [open, setOpen] = useState(false);
  const selectedIndex = TASK_PRIORITY_OPTIONS.indexOf(value);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = useId();
  const triggerId = `${listboxId}-trigger`;

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      optionRefs.current[activeIndex]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;

    function handleOutsidePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", handleOutsidePointerDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointerDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  function openMenu() {
    setActiveIndex(selectedIndex);
    setOpen(true);
  }

  function selectPriority(priority: TaskPriority) {
    onChange(priority);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function moveActiveOption(index: number) {
    const nextIndex =
      (index + TASK_PRIORITY_OPTIONS.length) % TASK_PRIORITY_OPTIONS.length;
    setActiveIndex(nextIndex);
    optionRefs.current[nextIndex]?.focus();
  }

  return (
    <div
      ref={rootRef}
      className={[
        "priority-menu",
        `priority-${value}`,
        open ? "is-open" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        id={triggerId}
        className="priority-menu__trigger"
        type="button"
        aria-label={`新任务优先级，当前${TASK_PRIORITY_META[value].label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => {
          if (open) setOpen(false);
          else openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          if (!open) openMenu();
        }}
      >
        <Flag size={15} />
        <span>{TASK_PRIORITY_META[value].label}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div
          id={listboxId}
          className="priority-menu__panel"
          role="listbox"
          aria-labelledby={triggerId}
        >
          {TASK_PRIORITY_OPTIONS.map((priority, index) => {
            const selected = priority === value;
            return (
              <button
                key={priority}
                ref={(element) => {
                  optionRefs.current[index] = element;
                }}
                className={[
                  "priority-menu__option",
                  `priority-${priority}`,
                  selected ? "is-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={index === activeIndex ? 0 : -1}
                onFocus={() => setActiveIndex(index)}
                onClick={() => selectPriority(priority)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    moveActiveOption(index + 1);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    moveActiveOption(index - 1);
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    moveActiveOption(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    moveActiveOption(TASK_PRIORITY_OPTIONS.length - 1);
                  } else if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    selectPriority(priority);
                  }
                }}
              >
                <span>{TASK_PRIORITY_META[priority].label}</span>
                <Check aria-hidden="true" size={16} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function PastTaskSyncBar({
  availableCount,
  selectedCount,
  loading,
  busy,
  onSync,
}: {
  availableCount: number;
  selectedCount: number;
  loading: boolean;
  busy: boolean;
  onSync: () => void;
}) {
  return (
    <section className="past-sync-bar" aria-label="往日未完成任务同步">
      <span className="past-sync-bar__icon">
        <CalendarDays size={18} />
      </span>
      <span className="past-sync-bar__copy">
        <b>勾选未完成任务，带到今天</b>
        <small>
          {loading
            ? "正在核对同步记录…"
            : availableCount === 0
              ? "没有可同步的任务"
              : `可选 ${availableCount} 项`}
        </small>
      </span>
      <button
        type="button"
        disabled={loading || busy || selectedCount === 0}
        onClick={onSync}
      >
        {busy ? "同步中…" : `同步 ${selectedCount} 项`}
        <ArrowRight size={16} />
      </button>
    </section>
  );
}

function LaneTaskBoard({
  tasks,
  selectedDate,
  title,
  priority,
  createScope,
  loading,
  saving,
  error,
  highlightTaskId,
  progress,
  doneCount,
  userRole,
  isPastDate,
  pastSyncSelection,
  syncedSourceTaskIds,
  pastSyncLoading,
  pastSyncBusy,
  onSelectedDateChange,
  onTitleChange,
  onPriorityChange,
  onCreateScopeChange,
  onCreateTask,
  onMoveTask,
  onEditTask,
  onDeleteTask,
  onTogglePastSync,
  onSyncPastTasks,
}: {
  tasks: Task[];
  selectedDate: string;
  title: string;
  priority: TaskPriority;
  createScope: TaskCreateScope;
  loading: boolean;
  saving: boolean;
  error: string;
  highlightTaskId: string;
  progress: number;
  doneCount: number;
  userRole: "member" | "boss" | "admin";
  isPastDate: boolean;
  pastSyncSelection: string[];
  syncedSourceTaskIds: string[];
  pastSyncLoading: boolean;
  pastSyncBusy: boolean;
  onSelectedDateChange: (date: string) => void;
  onTitleChange: (title: string) => void;
  onPriorityChange: (priority: TaskPriority) => void;
  onCreateScopeChange: (scope: TaskCreateScope) => void;
  onCreateTask: (event: FormEvent) => Promise<void>;
  onMoveTask: (taskId: string, status: TaskStatus) => Promise<void>;
  onEditTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => Promise<void>;
  onTogglePastSync: (taskId: string) => void;
  onSyncPastTasks: (taskIds?: string[]) => Promise<void>;
}) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(() =>
    fromDateKey(selectedDate),
  );
  const [draggingTaskId, setDraggingTaskId] = useState("");
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState("");
  const selected = fromDateKey(selectedDate);
  const monthDays = useMemo(
    () => calendarDays(calendarCursor),
    [calendarCursor],
  );
  const selectedWeekday = new Intl.DateTimeFormat("zh-CN", {
    weekday: "long",
  }).format(selected);

  useEffect(() => {
    setCalendarCursor(fromDateKey(selectedDate));
  }, [selectedDate]);

  function moveCalendarMonth(amount: number) {
    setCalendarCursor(
      (current) =>
        new Date(current.getFullYear(), current.getMonth() + amount, 1),
    );
  }

  async function moveTask(taskId: string, status: TaskStatus) {
    if (!taskId || movingTaskId) return;
    setMovingTaskId(taskId);
    try {
      await onMoveTask(taskId, status);
    } finally {
      setMovingTaskId("");
    }
  }

  return (
    <section className="lane-dashboard">
      <header
        className={[
          "lane-dashboard__summary",
          userRole !== "member" ? "is-without-countdown" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="compact-calendar">
          <button
            className="compact-calendar__trigger"
            type="button"
            aria-expanded={calendarOpen}
            aria-label="选择任务日期"
            onClick={() => setCalendarOpen((current) => !current)}
          >
            <span>
              <CalendarDays size={20} />
            </span>
            <b>
              {selected.getMonth() + 1}月{selected.getDate()}日
            </b>
            <small>{selectedWeekday}</small>
            <ChevronDown
              className={calendarOpen ? "is-open" : ""}
              size={15}
            />
          </button>

          {calendarOpen && (
            <section
              className="compact-calendar__popover"
              aria-label="日期选择"
            >
              <header>
                <button
                  type="button"
                  aria-label="上个月"
                  onClick={() => moveCalendarMonth(-1)}
                >
                  <ArrowLeft size={16} />
                </button>
                <b>
                  {calendarCursor.getFullYear()} 年{" "}
                  {calendarCursor.getMonth() + 1} 月
                </b>
                <button
                  type="button"
                  aria-label="下个月"
                  onClick={() => moveCalendarMonth(1)}
                >
                  <ArrowRight size={16} />
                </button>
              </header>
              <div className="compact-calendar__weekdays">
                {CALENDAR_WEEKDAYS.map((weekday) => (
                  <span key={weekday}>{weekday}</span>
                ))}
              </div>
              <div className="compact-calendar__grid">
                {monthDays.map((date) => {
                  const dateKey = toDateKey(date);
                  return (
                    <button
                      key={dateKey}
                      type="button"
                      className={[
                        date.getMonth() !== calendarCursor.getMonth()
                          ? "is-muted"
                          : "",
                        dateKey === selectedDate ? "is-selected" : "",
                        isToday(date) ? "is-today" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => {
                        onSelectedDateChange(dateKey);
                        setCalendarOpen(false);
                      }}
                    >
                      {date.getDate()}
                    </button>
                  );
                })}
              </div>
              <button
                className="compact-calendar__today"
                type="button"
                onClick={() => {
                  const today = toDateKey(new Date());
                  onSelectedDateChange(today);
                  setCalendarCursor(new Date());
                  setCalendarOpen(false);
                }}
              >
                回到今天
              </button>
            </section>
          )}
        </div>

        {userRole === "member" && (
          <div className="lane-countdown-slot">
            <WorkdayCountdownPanel />
          </div>
        )}

        <aside className="daily-score lane-daily-score">
          <div
            className="progress-ring"
            style={
              { "--progress": `${progress * 3.6}deg` } as React.CSSProperties
            }
          >
            <span>
              <b>{progress}%</b>
              <small>今日完成</small>
            </span>
          </div>
          <div className="daily-score__copy">
            <span>{doneCount} 项已完成</span>
            <b>
              {tasks.length === 0
                ? "先添加第一项任务"
                : progress === 100
                  ? "今天已经清账"
                  : `还剩 ${tasks.length - doneCount} 项`}
            </b>
          </div>
        </aside>
      </header>

      {isPastDate ? (
        <PastTaskSyncBar
          availableCount={
            tasks.filter(
              (task) =>
                task.status !== "done" &&
                !syncedSourceTaskIds.includes(task.id),
            ).length
          }
          selectedCount={pastSyncSelection.length}
          loading={pastSyncLoading}
          busy={pastSyncBusy}
          onSync={() => void onSyncPastTasks()}
        />
      ) : (
      <form
        className="quick-add lane-quick-add"
        onSubmit={(event) => void onCreateTask(event)}
      >
        <span className="quick-add__plus">
          <Plus size={18} />
        </span>
        <input
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder={
            createScope === "rest_of_week"
              ? "添加本周每天都要完成的任务"
              : "添加当天要完成的任务"
          }
          aria-label="新任务标题"
          maxLength={120}
        />
        <label className="task-scope-toggle">
          <CalendarDays size={15} />
          <select
            value={createScope}
            aria-label="新任务创建范围"
            onChange={(event) =>
              onCreateScopeChange(event.target.value as TaskCreateScope)
            }
          >
            <option value="day">仅当天（默认）</option>
            <option value="rest_of_week">当天至本周日（每天）</option>
          </select>
          <ChevronDown size={13} />
        </label>
        <QuickAddPriorityMenu
          value={priority}
          onChange={onPriorityChange}
        />
        <button
          className="quick-add__submit"
          type="submit"
          disabled={!title.trim() || saving}
        >
          {saving ? "添加中" : "添加任务"}
        </button>
      </form>
      )}

      {error && <div className="inline-error lane-dashboard__error">{error}</div>}

      <div className="status-lanes" data-testid="status-lanes">
        {LANE_COLUMNS.map((column) => {
          const items = tasks.filter((task) => task.status === column.status);
          const isDropTarget =
            Boolean(draggingTaskId) && dragOverStatus === column.status;
          return (
            <section
              key={column.status}
              className={[
                "status-lane",
                `tone-${column.tone}`,
                isDropTarget ? "is-drop-target" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              data-status={column.status}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverStatus(column.status);
              }}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  setDragOverStatus(null);
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                const taskId =
                  event.dataTransfer.getData("text/plain") || draggingTaskId;
                setDraggingTaskId("");
                setDragOverStatus(null);
                void moveTask(taskId, column.status);
              }}
            >
              <header>
                <span>
                  <TaskStatusIcon status={column.status} />
                  <b>{column.label}</b>
                </span>
                <strong>{items.length}</strong>
              </header>
              <div className="status-lane__tasks">
                {loading ? (
                  <>
                    <div className="lane-task-skeleton" />
                    <div className="lane-task-skeleton" />
                  </>
                ) : items.length === 0 ? (
                  <p className="lane-empty">
                    {isDropTarget ? "松开即可移动到这里" : "暂无任务"}
                  </p>
                ) : (
                  items.map((task) => (
                    <article
                      key={task.id}
                      draggable={movingTaskId !== task.id}
                      data-task-id={task.id}
                      className={[
                        "lane-task",
                        `lane-task--priority-${task.priority}`,
                        `lane-task--${task.status}`,
                        draggingTaskId === task.id ? "is-dragging" : "",
                        movingTaskId === task.id ? "is-moving" : "",
                        highlightTaskId === task.id ? "is-highlighted" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => onEditTask(task)}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", task.id);
                        setDraggingTaskId(task.id);
                      }}
                      onDragEnd={() => {
                        setDraggingTaskId("");
                        setDragOverStatus(null);
                      }}
                    >
                      {isPastDate && task.status !== "done" ? (
                        <button
                          className={[
                            "past-task-check",
                            pastSyncSelection.includes(task.id)
                              ? "is-selected"
                              : "",
                            syncedSourceTaskIds.includes(task.id)
                              ? "is-synced"
                              : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          type="button"
                          disabled={pastSyncLoading || pastSyncBusy || syncedSourceTaskIds.includes(task.id)}
                          aria-label={
                            syncedSourceTaskIds.includes(task.id)
                              ? `${task.title} 已有承接记录`
                              : `${pastSyncSelection.includes(task.id) ? "取消选择" : "选择"} ${task.title}`
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onTogglePastSync(task.id);
                          }}
                        >
                          {syncedSourceTaskIds.includes(task.id) ||
                          pastSyncSelection.includes(task.id) ? (
                            <Check size={15} />
                          ) : (
                            <span />
                          )}
                        </button>
                      ) : (
                        <button
                          className="lane-task__state"
                          type="button"
                          aria-label={
                            task.status === "done"
                              ? `将 ${task.title} 恢复为待处理`
                              : `完成 ${task.title}`
                          }
                          disabled={movingTaskId === task.id}
                          onClick={(event) => {
                            event.stopPropagation();
                            void moveTask(
                              task.id,
                              task.status === "done" ? "todo" : "done",
                            );
                          }}
                        >
                          <TaskStatusIcon status={task.status} />
                        </button>
                      )}
                      <button
                        className="lane-task__copy"
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onEditTask(task);
                        }}
                      >
                        <b>{task.title}</b>
                        {task.details && <small>{task.details}</small>}
                      </button>
                      <div className="lane-task__meta">
                        <span
                          className={`priority-badge priority-${task.priority}`}
                        >
                          {TASK_PRIORITY_META[task.priority].label}
                        </span>
                        {task.assignedBy && (
                          <span className="assignment-badge">老板派发</span>
                        )}
                      </div>
                      <div className="lane-task__actions">
                        {!task.assignedBy && (
                          <button
                            type="button"
                            aria-label={`删除 ${task.title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void onDeleteTask(task.id);
                            }}
                          >
                            <Trash2 size={15} />
                          </button>
                        )}
                        {isPastDate &&
                          task.status !== "done" &&
                          !syncedSourceTaskIds.includes(task.id) && (
                            <button
                              className="lane-task__today"
                              type="button"
                              title="将该任务放到今天"
                              aria-label="将该任务放到今天"
                              disabled={pastSyncBusy || pastSyncLoading}
                              onClick={(event) => {
                                event.stopPropagation();
                                void onSyncPastTasks([task.id]);
                              }}
                            >
                              今
                            </button>
                          )}
                      </div>
                    </article>
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

function TaskEditor({
  task,
  onClose,
  onSave,
}: {
  task: Task;
  onClose: () => void;
  onSave: (
    patch: Pick<Task, "title" | "details" | "date" | "priority">,
  ) => Promise<void>;
}) {
  const [title, setTitle] = useState(task.title);
  const [details, setDetails] = useState(task.details);
  const [date, setDate] = useState(task.date);
  const [priority, setPriority] = useState(task.priority);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      await onSave({ title, details, date, priority });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-layer" role="presentation">
      <button
        className="modal-backdrop"
        type="button"
        aria-label="关闭编辑器"
        onClick={onClose}
      />
      <form className="task-editor" onSubmit={submit}>
        <header>
          <div>
            <h3>编辑这件事</h3>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={19} />
          </button>
        </header>
        <label className="field">
          <span>任务标题</span>
          <span className="input-shell">
            <ListChecks size={17} />
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
              autoFocus
              readOnly={Boolean(task.assignedBy)}
            />
          </span>
        </label>
        <label className="field">
          <span>任务说明</span>
          <textarea
            value={details}
            onChange={(event) => setDetails(event.target.value)}
            placeholder="补充完成标准、需要的资料或注意事项…"
            maxLength={1000}
            rows={5}
          />
        </label>
        <div className="task-editor__grid">
          <label className="field">
            <span>任务日期</span>
            <span className="input-shell">
              <CalendarDays size={17} />
              <input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                required
                disabled={Boolean(task.assignedBy)}
              />
            </span>
          </label>
          <label className="field">
            <span>优先级</span>
            <span className="input-shell">
              <Flag size={17} />
              <select
                value={priority}
                disabled={Boolean(task.assignedBy)}
                onChange={(event) =>
                  setPriority(event.target.value as TaskPriority)
                }
              >
                {Object.entries(TASK_PRIORITY_META).map(([value, meta]) => (
                  <option key={value} value={value}>
                    {meta.label}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
        {task.assignedBy && (
          <div className="assigned-task-lock">
            老板派发任务只能更新执行说明和完成状态。
          </div>
        )}
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={saving || !title.trim()}
          >
            {saving ? "保存中…" : "保存修改"}
          </button>
        </footer>
      </form>
    </div>
  );
}
