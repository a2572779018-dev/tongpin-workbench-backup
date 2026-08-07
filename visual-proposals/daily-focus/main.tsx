import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Flag,
  ListChecks,
  Plus,
  Timer,
} from "lucide-react";
import "./styles.css";

type Variant = "a" | "b" | "c";
type TaskStatus = "todo" | "doing" | "done";
type TaskPriority = "p0" | "p1" | "p2" | "p3";

type Task = {
  id: number;
  title: string;
  details: string;
  priority: TaskPriority;
  status: TaskStatus;
  assigned?: boolean;
};

const INITIAL_TASKS: Task[] = [
  {
    id: 1,
    title: "整理客户回访清单",
    details: "12:00 前提交给销售组",
    priority: "p0",
    status: "todo",
    assigned: true,
  },
  {
    id: 2,
    title: "完成同频登录页验收",
    details: "核对邮箱登录与账号记忆",
    priority: "p1",
    status: "doing",
  },
  {
    id: 3,
    title: "回复渠道合作方案",
    details: "补充报价与排期",
    priority: "p1",
    status: "todo",
  },
  {
    id: 4,
    title: "整理 8 月内容排期",
    details: "完成第一版框架",
    priority: "p2",
    status: "todo",
  },
  {
    id: 5,
    title: "补充周会纪要",
    details: "已同步给项目组",
    priority: "p3",
    status: "done",
  },
];

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  p0: "P0 加急",
  p1: "P1 今日完成",
  p2: "P2 重要推进",
  p3: "P3 一般事项",
};

const VARIANTS: { id: Variant; label: string; name: string }[] = [
  { id: "a", label: "方案 A", name: "任务主场" },
  { id: "b", label: "方案 B", name: "状态跑道" },
  { id: "c", label: "方案 C", name: "极简清单" },
];

function Logo() {
  return (
    <div className="brand" aria-label="同频">
      <span className="brand__mark">Ⅱ</span>
      <span>
        <b>同频</b>
        <small>TONGPIN</small>
      </span>
    </div>
  );
}

function CalendarPicker({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  const days = [
    29, 30, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
    18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 1, 2,
  ];

  return (
    <div className="calendar-control">
      <button
        type="button"
        className="date-trigger"
        aria-expanded={open}
        aria-label="打开日期选择"
        onClick={onToggle}
      >
        <span className="date-trigger__icon">
          <CalendarDays size={20} />
        </span>
        <span>
          <b>7 月 29 日</b>
          <small>星期三</small>
        </span>
        <ChevronDown size={16} className={open ? "is-open" : ""} />
      </button>

      {open && (
        <section className="calendar-popover" aria-label="日期选择">
          <header>
            <button type="button" aria-label="上个月">
              <ChevronLeft size={17} />
            </button>
            <b>2026 年 7 月</b>
            <button type="button" aria-label="下个月">
              <ChevronRight size={17} />
            </button>
          </header>
          <div className="calendar-week">
            {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {days.map((day, index) => (
              <button
                type="button"
                className={[
                  index < 2 || index > 32 ? "is-muted" : "",
                  day === 29 && index === 30 ? "is-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                key={`${day}-${index}`}
              >
                {day}
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Countdown() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const copy = useMemo(() => {
    const end = new Date(now);
    end.setHours(19, 0, 0, 0);
    const remaining = Math.max(0, end.getTime() - now.getTime());
    const hours = Math.floor(remaining / 3_600_000);
    const minutes = Math.floor((remaining % 3_600_000) / 60_000);
    const seconds = Math.floor((remaining % 60_000) / 1000);
    return remaining === 0
      ? "今天已下班"
      : `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }, [now]);

  return (
    <div className="countdown">
      <Timer size={17} />
      <span>距离下班</span>
      <b>{copy}</b>
    </div>
  );
}

function ProgressCompact({ tasks }: { tasks: Task[] }) {
  const done = tasks.filter((task) => task.status === "done").length;
  const percent = Math.round((done / tasks.length) * 100);
  return (
    <div className="progress-compact">
      <span
        className="progress-compact__ring"
        style={{ "--progress": `${percent * 3.6}deg` } as React.CSSProperties}
      >
        <b>{percent}%</b>
      </span>
      <span>
        <small>今日完成</small>
        <b>
          {done} / {tasks.length} 项
        </b>
      </span>
    </div>
  );
}

function QuickAdd() {
  return (
    <div className="quick-add-proposal">
      <Plus size={19} />
      <span>添加今天要完成的任务</span>
      <button type="button">添加</button>
    </div>
  );
}

function TaskStateIcon({ status }: { status: TaskStatus }) {
  if (status === "done") return <Check size={17} />;
  if (status === "doing") return <Clock3 size={17} />;
  return <Circle size={17} />;
}

function TaskRow({
  task,
  onToggle,
  compact = false,
}: {
  task: Task;
  onToggle: () => void;
  compact?: boolean;
}) {
  return (
    <article
      className={[
        "proposal-task",
        `is-${task.priority}`,
        `status-${task.status}`,
        compact ? "is-compact" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <button
        type="button"
        className="proposal-task__state"
        aria-label={`切换 ${task.title} 的完成状态`}
        onClick={onToggle}
      >
        <TaskStateIcon status={task.status} />
      </button>
      <span className="proposal-task__copy">
        <b>{task.title}</b>
        {!compact && <small>{task.details}</small>}
      </span>
      {task.assigned && <span className="assignment-tag">老板派发</span>}
      <span className="priority-tag">
        <Flag size={13} />
        {PRIORITY_LABEL[task.priority]}
      </span>
    </article>
  );
}

function SharedHeader({
  calendarOpen,
  onCalendarToggle,
  tasks,
}: {
  calendarOpen: boolean;
  onCalendarToggle: () => void;
  tasks: Task[];
}) {
  return (
    <header className="daily-header">
      <CalendarPicker open={calendarOpen} onToggle={onCalendarToggle} />
      <div className="daily-header__title">
        <h1>今日待办</h1>
        <span>5 项任务，先处理最重要的事</span>
      </div>
      <div className="daily-header__tools">
        <Countdown />
        <ProgressCompact tasks={tasks} />
      </div>
    </header>
  );
}

function VariantA({
  tasks,
  toggleTask,
  calendarOpen,
  onCalendarToggle,
}: VariantProps) {
  const openTasks = tasks.filter((task) => task.status !== "done");
  const doneTasks = tasks.filter((task) => task.status === "done");
  return (
    <main className="proposal proposal-a">
      <SharedHeader
        calendarOpen={calendarOpen}
        onCalendarToggle={onCalendarToggle}
        tasks={tasks}
      />
      <div className="a-workspace">
        <section className="a-list">
          <QuickAdd />
          <div className="task-stack">
            {openTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                onToggle={() => toggleTask(task.id)}
              />
            ))}
          </div>
          <button className="done-disclosure" type="button">
            <Check size={16} />
            已完成 {doneTasks.length} 项
            <ChevronDown size={15} />
          </button>
        </section>
        <aside className="a-focus">
          <span className="a-focus__stamp">先做这件</span>
          <strong>整理客户回访清单</strong>
          <p>来自老板派发，12:00 前完成。</p>
          <div className="focus-clock">
            <Clock3 size={18} />
            <span>
              <small>剩余时间</small>
              <b>01:42:18</b>
            </span>
          </div>
          <button type="button">开始处理</button>
        </aside>
      </div>
    </main>
  );
}

function VariantB({
  tasks,
  toggleTask,
  calendarOpen,
  onCalendarToggle,
}: VariantProps) {
  const columns: { status: TaskStatus; label: string; tone: string }[] = [
    { status: "doing", label: "正在做", tone: "blue" },
    { status: "todo", label: "接下来", tone: "yellow" },
    { status: "done", label: "已完成", tone: "green" },
  ];

  return (
    <main className="proposal proposal-b">
      <SharedHeader
        calendarOpen={calendarOpen}
        onCalendarToggle={onCalendarToggle}
        tasks={tasks}
      />
      <QuickAdd />
      <div className="status-lanes">
        {columns.map((column) => {
          const items = tasks.filter((task) => task.status === column.status);
          return (
            <section className={`status-lane tone-${column.tone}`} key={column.status}>
              <header>
                <span>
                  <TaskStateIcon status={column.status} />
                  <b>{column.label}</b>
                </span>
                <strong>{items.length}</strong>
              </header>
              <div>
                {items.length === 0 ? (
                  <p className="lane-empty">这里暂时没有任务</p>
                ) : (
                  items.map((task) => (
                    <TaskRow
                      compact
                      key={task.id}
                      task={task}
                      onToggle={() => toggleTask(task.id)}
                    />
                  ))
                )}
              </div>
            </section>
          );
        })}
      </div>
    </main>
  );
}

function VariantC({
  tasks,
  toggleTask,
  calendarOpen,
  onCalendarToggle,
}: VariantProps) {
  return (
    <main className="proposal proposal-c">
      <div className="c-date-column">
        <CalendarPicker open={calendarOpen} onToggle={onCalendarToggle} />
        <span className="c-day">29</span>
        <b>星期三</b>
        <Countdown />
      </div>
      <section className="c-list-column">
        <header>
          <div>
            <h1>今天</h1>
            <span>按优先级完成 5 项待办</span>
          </div>
          <ProgressCompact tasks={tasks} />
        </header>
        <QuickAdd />
        <div className="c-task-list">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              onToggle={() => toggleTask(task.id)}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

type VariantProps = {
  tasks: Task[];
  toggleTask: (id: number) => void;
  calendarOpen: boolean;
  onCalendarToggle: () => void;
};

function App() {
  const query = new URLSearchParams(window.location.search);
  const requested = query.get("v");
  const initialVariant: Variant =
    requested === "b" || requested === "c" ? requested : "a";
  const [variant, setVariant] = useState<Variant>(initialVariant);
  const [tasks, setTasks] = useState(INITIAL_TASKS);
  const [calendarOpen, setCalendarOpen] = useState(
    () => query.get("calendar") === "1" || requested === "a-calendar",
  );

  function selectVariant(next: Variant) {
    setVariant(next);
    setCalendarOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set("v", next);
    window.history.replaceState(null, "", url);
  }

  function toggleTask(id: number) {
    setTasks((current) =>
      current.map((task) =>
        task.id === id
          ? {
              ...task,
              status: task.status === "done" ? "todo" : "done",
            }
          : task,
      ),
    );
  }

  const common: VariantProps = {
    tasks,
    toggleTask,
    calendarOpen,
    onCalendarToggle: () => setCalendarOpen((current) => !current),
  };

  return (
    <div className={`proposal-shell variant-${variant}`}>
      <nav className="app-bar">
        <Logo />
        <div className="proposal-tabs" aria-label="视觉方案">
          {VARIANTS.map((item) => (
            <button
              type="button"
              className={variant === item.id ? "is-active" : ""}
              key={item.id}
              onClick={() => selectVariant(item.id)}
            >
              <b>{item.label}</b>
              <span>{item.name}</span>
            </button>
          ))}
        </div>
        <div className="app-bar__account">
          <button type="button" aria-label="通知">
            <Bell size={19} />
            <i>2</i>
          </button>
          <span className="user-avatar">小</span>
          <span>
            <b>小秋</b>
            <small>产品运营</small>
          </span>
        </div>
      </nav>

      {variant === "a" && <VariantA {...common} />}
      {variant === "b" && <VariantB {...common} />}
      {variant === "c" && <VariantC {...common} />}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
