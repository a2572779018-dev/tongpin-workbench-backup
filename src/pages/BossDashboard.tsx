import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  BellRing,
  Check,
  CheckCheck,
  ChevronRight,
  Circle,
  Clock3,
  Flag,
  History,
  Plus,
  Radio,
  RotateCw,
  Send,
  UsersRound,
  X,
} from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { useNoticeCenter } from "../components/NoticeCenter";
import { UserAvatar } from "../components/UserAvatar";
import {
  addDays,
  formatDateTime,
  formatFullDate,
  formatTime,
  isToday,
  toDateKey,
} from "../lib/date";
import { TASK_PRIORITY_META } from "../lib/taskPriority";
import type {
  NotificationDispatch,
  Task,
  TaskAuditChange,
  TaskAuditEvent,
  User,
} from "../types";

interface TeamMember {
  user: User;
  total: number;
  done: number;
  doing: number;
  completionRate: number;
}

interface TaskHistoryDetail {
  user: User;
  task: Task;
  history: TaskAuditEvent[];
  auditCoverage: "legacy" | "tracked";
}

type ProgressFilter = "all" | "unfinished" | "complete" | "empty";

export function BossDashboard() {
  const { api, session } = useAuth();
  const { confirm: confirmNotice, notify } = useNoticeCenter();
  const [date, setDate] = useState(toDateKey(new Date()));
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedTasks, setSelectedTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<ProgressFilter>("all");
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [target, setTarget] = useState("all");
  const [messageTitle, setMessageTitle] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [dispatches, setDispatches] = useState<NotificationDispatch[]>([]);
  const [dispatchesLoading, setDispatchesLoading] = useState(true);
  const [dingingId, setDingingId] = useState("");
  const [assignmentMemberId, setAssignmentMemberId] = useState("");
  const [assignmentTitle, setAssignmentTitle] = useState("");
  const [assignmentDetails, setAssignmentDetails] = useState("");
  const [assignmentPriority, setAssignmentPriority] =
    useState<Task["priority"]>("p2");
  const [assigning, setAssigning] = useState(false);
  const [historyTaskId, setHistoryTaskId] = useState("");
  const [taskHistory, setTaskHistory] = useState<TaskHistoryDetail | null>(null);
  const [taskHistoryLoading, setTaskHistoryLoading] = useState(false);
  const [taskHistoryError, setTaskHistoryError] = useState("");

  const loadTeam = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await api<{ members: TeamMember[] }>(
        `/api/boss/team?date=${date}`,
      );
      setMembers(result.members);
      setSelectedId((current) =>
        result.members.some((item) => item.user.id === current)
          ? current
          : result.members[0]?.user.id ?? "",
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "全员进度加载失败");
    } finally {
      setLoading(false);
    }
  }, [api, date]);

  useEffect(() => {
    void loadTeam();
  }, [loadTeam]);

  const loadDispatches = useCallback(async () => {
    setDispatchesLoading(true);
    try {
      const result = await api<{ dispatches: NotificationDispatch[] }>(
        "/api/boss/notification-dispatches",
      );
      setDispatches(result.dispatches);
    } catch {
      // 任务进度仍可使用，下一次回执或发送操作会重试。
    } finally {
      setDispatchesLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadDispatches();
  }, [loadDispatches]);

  useEffect(() => {
    let timer: number | null = null;
    const handleReceipt = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void loadDispatches(), 240);
    };
    window.addEventListener("tongpin:notification-receipt", handleReceipt);
    return () => {
      window.removeEventListener(
        "tongpin:notification-receipt",
        handleReceipt,
      );
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadDispatches]);

  const loadSelectedTasks = useCallback(async () => {
    if (!selectedId) {
      setSelectedTasks([]);
      return;
    }
    setDetailsLoading(true);
    await api<{ tasks: Task[] }>(
      `/api/boss/members/${selectedId}/tasks?date=${date}`,
    )
      .then((result) => setSelectedTasks(result.tasks))
      .catch(() => setSelectedTasks([]))
      .finally(() => setDetailsLoading(false));
  }, [api, date, selectedId]);

  useEffect(() => {
    void loadSelectedTasks();
  }, [loadSelectedTasks]);

  useEffect(() => {
    setHistoryTaskId("");
    setTaskHistory(null);
    setTaskHistoryError("");
  }, [date, selectedId]);

  useEffect(() => {
    const sync = () => {
      void loadTeam();
      void loadSelectedTasks();
    };
    window.addEventListener("tongpin:task-sync", sync);
    return () => window.removeEventListener("tongpin:task-sync", sync);
  }, [loadSelectedTasks, loadTeam]);

  const visibleMembers = members.filter((member) => {
    if (filter === "unfinished") {
      return member.total > 0 && member.done < member.total;
    }
    if (filter === "complete") {
      return member.total > 0 && member.done === member.total;
    }
    if (filter === "empty") return member.total === 0;
    return true;
  });
  const notificationRecipients = useMemo(
    () => members.filter((member) => member.user.id !== session?.user.id),
    [members, session?.user.id],
  );
  useEffect(() => {
    if (
      target !== "all" &&
      !notificationRecipients.some((member) => member.user.id === target)
    ) {
      setTarget("all");
    }
  }, [notificationRecipients, target]);
  const totals = useMemo(() => {
    const tasks = members.reduce((sum, member) => sum + member.total, 0);
    const done = members.reduce((sum, member) => sum + member.done, 0);
    return {
      people: members.length,
      tasks,
      done,
      rate: tasks ? Math.round((done / tasks) * 100) : 0,
      unfinishedPeople: members.filter(
        (member) => member.total > 0 && member.done < member.total,
      ).length,
      emptyPeople: members.filter((member) => member.total === 0).length,
    };
  }, [members]);

  async function sendNotification(event: FormEvent) {
    event.preventDefault();
    setSending(true);
    setError("");
    try {
      const result = await api<{
        targeted: number;
        dispatch: NotificationDispatch;
      }>(
        "/api/boss/notifications",
        {
          method: "POST",
          body: JSON.stringify({
            all: target === "all",
            recipientIds: target === "all" ? [] : [target],
            title: messageTitle,
            body: messageBody,
          }),
        },
      );
      setDispatches((current) => [
        result.dispatch,
        ...current.filter(
          (dispatch) => dispatch.id !== result.dispatch.id,
        ),
      ]);
      notify({
        title: "强提醒已发送",
        body: `已推送给 ${result.targeted} 位成员。`,
        tone: "success",
        duration: 7_000,
      });
      setMessageTitle("");
      setMessageBody("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "通知发送失败");
    } finally {
      setSending(false);
    }
  }

  async function dingDispatch(dispatch: NotificationDispatch) {
    if (dingingId || dispatch.counts.pending === 0) return;
    setDingingId(dispatch.id);
    setError("");
    try {
      const result = await api<{
        targeted: number;
        dispatch: NotificationDispatch;
      }>(
        `/api/boss/notification-dispatches/${dispatch.id}/ding`,
        { method: "POST" },
      );
      setDispatches((current) =>
        current.map((item) =>
          item.id === dispatch.id ? result.dispatch : item,
        ),
      );
      notify({
        title: "Ding 已发出",
        body: `已再次提醒 ${result.targeted} 位未确认成员。`,
        tone: "success",
        duration: 7_000,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ding 发送失败");
    } finally {
      setDingingId("");
    }
  }

  async function assignTask(event: FormEvent, member: TeamMember) {
    event.preventDefault();
    if (!assignmentTitle.trim() || assigning) return;
    const approved = await confirmNotice({
      title: `派发给 ${member.user.name}？`,
      body: `${assignmentTitle.trim()} · ${formatFullDate(date)}`,
      confirmLabel: "确认派发",
      tone: "warning",
    });
    if (!approved) return;
    setAssigning(true);
    setError("");
    try {
      await api(`/api/boss/members/${member.user.id}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          title: assignmentTitle.trim(),
          details: assignmentDetails.trim(),
          date,
          priority: assignmentPriority,
        }),
      });
      setAssignmentTitle("");
      setAssignmentDetails("");
      setAssignmentPriority("p2");
      setAssignmentMemberId("");
      await loadTeam();
      await loadSelectedTasks();
      notify({
        title: "任务已派发",
        body: `${member.user.name} 会收到桌面提醒。`,
        tone: "success",
        duration: 7_000,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "任务派发失败");
    } finally {
      setAssigning(false);
    }
  }

  async function openTaskHistory(task: Task) {
    if (!selectedId) return;
    setHistoryTaskId(task.id);
    setTaskHistory(null);
    setTaskHistoryError("");
    setTaskHistoryLoading(true);
    try {
      const result = await api<TaskHistoryDetail>(
        `/api/boss/members/${selectedId}/tasks/${task.id}/history`,
      );
      setTaskHistory(result);
    } catch (caught) {
      setTaskHistoryError(
        caught instanceof Error ? caught.message : "任务记录加载失败",
      );
    } finally {
      setTaskHistoryLoading(false);
    }
  }

  return (
    <div className="boss-page">
      <section className="team-audit bento-panel">
        <header>
          <div>
            <h2>
              {isToday(date) ? "今天，全员走到哪了？" : formatFullDate(date)}
            </h2>
          </div>
          <div className="date-switcher">
            <button
              type="button"
              aria-label="前一天"
              onClick={() => setDate(toDateKey(addDays(date, -1)))}
            >
              <ArrowLeft size={16} />
            </button>
            <button type="button" onClick={() => setDate(toDateKey(new Date()))}>
              今天
            </button>
            <input
              type="date"
              value={date}
              aria-label="查看日期"
              onChange={(event) => setDate(event.target.value)}
            />
            <button
              type="button"
              aria-label="后一天"
              onClick={() => setDate(toDateKey(addDays(date, 1)))}
            >
              <ArrowRight size={16} />
            </button>
          </div>
        </header>

        <div className="team-audit__score">
          <strong>{totals.rate}%</strong>
          <div>
            <span>全员任务完成率</span>
            <p>
              {totals.tasks === 0
                ? "当前日期还没有成员提交任务。"
                : `${totals.done} / ${totals.tasks} 项已完成，${totals.unfinishedPeople} 人仍有未完成任务。`}
            </p>
          </div>
        </div>
        <div
          className="audit-meter"
          role="progressbar"
          aria-label="全员完成率"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={totals.rate}
        >
          <span style={{ width: `${totals.rate}%` }} />
        </div>
      </section>

      <section className="team-stats">
        <article className="metric-tile tile-yellow">
          <span className="eyebrow">活跃成员</span>
          <strong>{totals.people}</strong>
        </article>
        <article className="metric-tile tile-blue">
          <span className="eyebrow">任务总量</span>
          <strong>{totals.tasks}</strong>
        </article>
        <article className="metric-tile tile-pink">
          <span className="eyebrow">仍在推进</span>
          <strong>{totals.unfinishedPeople}</strong>
        </article>
        <article className="metric-tile tile-green">
          <span className="eyebrow">未建任务</span>
          <strong>{totals.emptyPeople}</strong>
        </article>
      </section>

      <section className="team-registry">
        <header className="section-heading">
          <div>
            <h2>成员进度</h2>
          </div>
          <div className="filter-row">
            {(
              [
                ["all", "全部"],
                ["unfinished", "未完成"],
                ["complete", "已清账"],
                ["empty", "未建任务"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? "is-active" : ""}
                type="button"
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {error && <div className="inline-error">{error}</div>}
        <div className="team-workspace">
          <div className="member-grid">
            {loading ? (
              Array.from({ length: 4 }, (_, index) => (
                <div className="member-card member-card--skeleton" key={index} />
              ))
            ) : visibleMembers.length === 0 ? (
              <div className="team-empty">
                <UsersRound size={28} />
                <b>没有匹配的成员</b>
              </div>
            ) : (
              visibleMembers.map((member, index) => {
                const isSelected = selectedId === member.user.id;

                return (
                  <article
                    key={member.user.id}
                    className={[
                      "member-ledger",
                      isSelected ? "is-expanded" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      className={[
                        "member-card",
                        isSelected ? "is-selected" : "",
                        `member-card--${index % 4}`,
                      ].join(" ")}
                      type="button"
                      aria-expanded={isSelected}
                      onClick={() => setSelectedId(member.user.id)}
                    >
                      <span className="member-card__topline">
                        <span>成员 {String(index + 1).padStart(2, "0")}</span>
                        <i>{member.user.role === "boss" ? "老板" : "成员"}</i>
                      </span>
                      <span className="member-card__name">
                        <UserAvatar
                          user={member.user}
                          className="member-card__avatar"
                        />
                        <span>
                          <b>{member.user.name}</b>
                          <small>
                            {member.user.jobTitle ||
                              (member.user.role === "boss" ? "老板" : "成员")}
                          </small>
                        </span>
                      </span>
                      <span className="member-card__progress">
                        <i style={{ width: `${member.completionRate}%` }} />
                      </span>
                      <span className="member-card__footer">
                        <strong>{member.completionRate}%</strong>
                        <span>
                          {member.done}/{member.total} 完成
                          <ChevronRight size={16} />
                        </span>
                      </span>
                    </button>

                    {isSelected && (
                      <section
                        className="member-inspector member-inspector--inline bento-panel"
                        aria-label={`${member.user.name}的当天任务`}
                      >
                        <div className="member-inspector__topline">
                          <span className="severity-badge">
                            {member.total === 0
                              ? "尚未建任务"
                              : member.completionRate === 100
                                ? "今日已清账"
                                : "任务推进中"}
                          </span>
                          <span>
                            {String(member.completionRate).padStart(2, "0")}%
                          </span>
                          {member.user.role === "member" && (
                            <button
                              className="assign-task-trigger"
                              type="button"
                              onClick={() =>
                                setAssignmentMemberId((current) =>
                                  current === member.user.id
                                    ? ""
                                    : member.user.id,
                                )
                              }
                            >
                              <Plus size={15} />
                              派发任务
                            </button>
                          )}
                        </div>
                        {assignmentMemberId === member.user.id && (
                          <form
                            className="assignment-composer"
                            onSubmit={(event) => void assignTask(event, member)}
                          >
                            <input
                              value={assignmentTitle}
                              onChange={(event) =>
                                setAssignmentTitle(event.target.value)
                              }
                              placeholder="任务标题"
                              maxLength={120}
                              required
                              autoFocus
                            />
                            <textarea
                              value={assignmentDetails}
                              onChange={(event) =>
                                setAssignmentDetails(event.target.value)
                              }
                              placeholder="执行说明（可选）"
                              maxLength={1000}
                              rows={2}
                            />
                            <div>
                              <label>
                                <Flag size={14} />
                                <select
                                  value={assignmentPriority}
                                  onChange={(event) =>
                                    setAssignmentPriority(
                                      event.target.value as Task["priority"],
                                    )
                                  }
                                >
                                  {Object.entries(TASK_PRIORITY_META).map(
                                    ([value, meta]) => (
                                      <option key={value} value={value}>
                                        {meta.label}
                                      </option>
                                    ),
                                  )}
                                </select>
                              </label>
                              <button
                                className="primary-button"
                                type="submit"
                                disabled={assigning || !assignmentTitle.trim()}
                              >
                                {assigning ? "派发中…" : "确认派发"}
                              </button>
                            </div>
                          </form>
                        )}
                        <div className="inspector-task-list">
                          <span>该成员的当天任务</span>
                          {detailsLoading ? (
                            <div className="inspector-skeleton" />
                          ) : selectedTasks.length === 0 ? (
                            <p className="inspector-empty">没有创建任务。</p>
                          ) : (
                            selectedTasks.map((task) => (
                              <button
                                key={task.id}
                                type="button"
                                aria-label={`查看 ${task.title} 的完整记录`}
                                onClick={() => void openTaskHistory(task)}
                                className={[
                                  "inspector-task-card",
                                  `inspector-task--${task.priority}`,
                                  task.status === "done" ? "is-done" : "",
                                ]
                                  .filter(Boolean)
                                  .join(" ")}
                              >
                                <span
                                  className={`mini-state state-${task.status}`}
                                >
                                  {task.status === "done" ? (
                                    <Check size={12} />
                                  ) : task.status === "doing" ? (
                                    <Clock3 size={12} />
                                  ) : (
                                    <Circle size={12} />
                                  )}
                                </span>
                                <span>
                                  <b>{task.title}</b>
                                  <small>
                                    {
                                      TASK_PRIORITY_META[task.priority].label
                                    }{" "}
                                    ·{" "}
                                    {task.status === "done"
                                      ? "已完成"
                                      : task.status === "doing"
                                        ? "进行中"
                                        : "待处理"}
                                    {task.assignedBy && (
                                      <>
                                        {" "}
                                        ·{" "}
                                        {task.assignmentViewedAt
                                          ? "成员已查看"
                                          : task.assignmentDeliveredAt
                                            ? "已送达"
                                            : "等待送达"}
                                      </>
                                    )}
                                  </small>
                                </span>
                                <History
                                  className="inspector-task-card__history"
                                  size={16}
                                />
                              </button>
                            ))
                          )}
                        </div>
                      </section>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </div>
      </section>

      <section className="push-composer bento-panel">
        <div className="push-composer__intro">
          <h2>发一条强提醒</h2>
          <div className="push-wave" aria-hidden="true">
            <span />
            <span />
            <span>
              <BellRing size={24} />
            </span>
          </div>
        </div>
        <form onSubmit={sendNotification}>
          <label className="field">
            <span>接收人</span>
            <select value={target} onChange={(event) => setTarget(event.target.value)}>
              <option value="all">
                {notificationRecipients.length > 0
                  ? "所有成员"
                  : "暂无可通知成员"}
              </option>
              {notificationRecipients.map((member) => (
                <option key={member.user.id} value={member.user.id}>
                  {member.user.name} · {member.user.email}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>通知标题</span>
            <input
              value={messageTitle}
              onChange={(event) => setMessageTitle(event.target.value)}
              placeholder="例如：十分钟后开会"
              maxLength={50}
              required
            />
          </label>
          <label className="field">
            <span>通知内容</span>
            <textarea
              value={messageBody}
              onChange={(event) => setMessageBody(event.target.value)}
              placeholder="直接说清楚时间、动作和需要准备的内容。"
              maxLength={300}
              rows={4}
              required
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={sending || notificationRecipients.length === 0}
          >
            {sending ? "正在发送…" : "发送强提醒"}
            {!sending && <Send size={17} />}
          </button>
        </form>
      </section>

      <section className="receipt-board bento-panel">
        <header className="receipt-board__header">
          <div>
            <h2>提醒回执</h2>
            <span>{dispatches.length} 条最近提醒</span>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={dispatchesLoading}
            onClick={() => void loadDispatches()}
          >
            <RotateCw size={16} />
            刷新
          </button>
        </header>

        {dispatchesLoading && dispatches.length === 0 ? (
          <div className="receipt-board__loading">
            <span />
            <span />
          </div>
        ) : dispatches.length === 0 ? (
          <div className="receipt-board__empty">
            <Radio size={28} />
            <b>还没有发送强提醒</b>
          </div>
        ) : (
          <div className="dispatch-list">
            {dispatches.map((dispatch) => (
              <article className="dispatch-card" key={dispatch.id}>
                <header>
                  <div>
                    <span>{formatTime(dispatch.createdAt)}</span>
                    <h3>{dispatch.title}</h3>
                    <p>{dispatch.body}</p>
                  </div>
                  <button
                    className="dispatch-card__ding"
                    type="button"
                    disabled={
                      Boolean(dingingId) ||
                      dispatch.counts.pending === 0
                    }
                    onClick={() => void dingDispatch(dispatch)}
                  >
                    <BellRing size={17} />
                    {dispatch.counts.pending === 0
                      ? "已全部确认"
                      : dingingId === dispatch.id
                        ? "Ding 中…"
                        : `Ding ${dispatch.counts.pending} 人`}
                  </button>
                </header>

                <div className="dispatch-card__totals">
                  <span>
                    <CheckCheck size={15} />
                    {dispatch.counts.acknowledged}/{dispatch.counts.total} 已确认
                  </span>
                  <span>
                    <Radio size={15} />
                    {dispatch.counts.delivered} 已送达
                  </span>
                  {dispatch.dingCount > 0 && (
                    <span>已 Ding {dispatch.dingCount} 次</span>
                  )}
                </div>

                <div className="receipt-people">
                  {dispatch.recipients.map((recipient) => {
                    const status = recipient.acknowledgedAt
                      ? "acknowledged"
                      : recipient.deliveredAt
                        ? "delivered"
                        : "pending";
                    return (
                      <div
                        className={`receipt-person is-${status}`}
                        key={recipient.notificationId}
                      >
                        <UserAvatar
                          user={recipient.user}
                          className="receipt-person__avatar"
                        />
                        <span>
                          <b>{recipient.user.name}</b>
                          <small>
                            {status === "acknowledged"
                              ? "已确认"
                              : status === "delivered"
                                ? "待确认"
                                : "未送达"}
                          </small>
                        </span>
                      </div>
                    );
                  })}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {historyTaskId && (
        <TaskHistoryDrawer
          detail={taskHistory}
          loading={taskHistoryLoading}
          error={taskHistoryError}
          onClose={() => {
            setHistoryTaskId("");
            setTaskHistory(null);
            setTaskHistoryError("");
          }}
        />
      )}
    </div>
  );
}

const AUDIT_ACTION_LABEL: Record<TaskAuditEvent["action"], string> = {
  created: "创建任务",
  updated: "修改任务",
  completed: "完成任务",
  reopened: "重新打开",
  carried_over: "同步到今天",
  assigned: "老板派发",
  deleted: "删除任务",
};

const AUDIT_FIELD_LABEL: Record<TaskAuditChange["field"], string> = {
  title: "标题",
  details: "说明",
  date: "任务日期",
  priority: "优先级",
  status: "状态",
};

const TASK_STATUS_COPY: Record<Task["status"], string> = {
  todo: "待处理",
  doing: "进行中",
  done: "已完成",
};

function formatAuditValue(
  field: TaskAuditChange["field"],
  value: string | null,
): string {
  if (!value) return "空";
  if (field === "priority") {
    return TASK_PRIORITY_META[value as Task["priority"]]?.label ?? value;
  }
  if (field === "status") {
    return TASK_STATUS_COPY[value as Task["status"]] ?? value;
  }
  return value;
}

function TaskHistoryDrawer({
  detail,
  loading,
  error,
  onClose,
}: {
  detail: TaskHistoryDetail | null;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <div className="task-history-layer">
      <button
        className="task-history-backdrop"
        type="button"
        aria-label="关闭任务记录"
        onClick={onClose}
      />
      <aside
        className="task-history-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-history-title"
      >
        <header className="task-history-drawer__header">
          <div>
            <span>
              <History size={15} />
              任务记录
            </span>
            <h2 id="task-history-title">
              {detail?.task.title ?? "正在读取…"}
            </h2>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>

        {loading ? (
          <div className="task-history-loading">
            <span />
            <span />
            <span />
          </div>
        ) : error ? (
          <div className="inline-error">{error}</div>
        ) : detail ? (
          <>
            <section className="task-history-owner">
              <UserAvatar
                user={detail.user}
                className="task-history-owner__avatar"
              />
              <span>
                <b>{detail.user.name}</b>
                <small>
                  {detail.user.jobTitle ||
                    (detail.user.role === "boss" ? "老板" : "成员")}
                </small>
              </span>
              <i
                className={`priority-badge priority-${detail.task.priority}`}
              >
                {TASK_PRIORITY_META[detail.task.priority].label}
              </i>
            </section>

            <section className="task-history-facts">
              <div>
                <span>创建时间</span>
                <b>{formatDateTime(detail.task.createdAt)}</b>
              </div>
              <div>
                <span>最后修改</span>
                <b>{formatDateTime(detail.task.updatedAt)}</b>
              </div>
              <div>
                <span>完成时间</span>
                <b>
                  {detail.task.completedAt
                    ? formatDateTime(detail.task.completedAt)
                    : "尚未完成"}
                </b>
              </div>
            </section>

            {detail.task.details && (
              <section className="task-history-description">
                <span>当前说明</span>
                <p>{detail.task.details}</p>
              </section>
            )}

            <section className="task-history-timeline">
              <header>
                <h3>变更时间线</h3>
                <span>{detail.history.length} 条记录</span>
              </header>
              {detail.auditCoverage === "legacy" ? (
                <div className="task-history-legacy">
                  这是一条旧版本任务。逐次变更记录从本版本开始保存；创建、最后修改和完成时间仍是真实数据。
                </div>
              ) : (
                detail.history.map((event) => (
                  <article key={event.id}>
                    <i />
                    <div>
                      <header>
                        <b>{AUDIT_ACTION_LABEL[event.action]}</b>
                        <time>{formatDateTime(event.createdAt)}</time>
                      </header>
                      <small>
                        操作人：{event.actor?.name ?? "已移除账号"}
                      </small>
                      {event.changes.length > 0 && (
                        <div className="task-history-changes">
                          {event.changes.map((change, index) => (
                            <div key={`${event.id}-${change.field}-${index}`}>
                              <span>{AUDIT_FIELD_LABEL[change.field]}</span>
                              <p>
                                <del>
                                  {formatAuditValue(
                                    change.field,
                                    change.before,
                                  )}
                                </del>
                                <ArrowRight size={14} />
                                <ins>
                                  {formatAuditValue(
                                    change.field,
                                    change.after,
                                  )}
                                </ins>
                              </p>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </article>
                ))
              )}
            </section>
          </>
        ) : null}
      </aside>
    </div>
  );
}
