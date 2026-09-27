import { businessDateKey } from "./business-date";
import type {
  BossWorkReportStatus,
  PublicUser,
  Task,
  TaskAuditEvent,
} from "./types";

export type WorkReportPeriodKind = "daily" | "weekly" | "monthly";

export interface WorkReportPeriod {
  kind: WorkReportPeriodKind;
  startDate: string;
  endDate: string;
}

export interface BossWorkReportMember {
  user: PublicUser;
  selfCreated: number;
  carriedOver: number;
  assigned: number;
  completed: number;
  scheduled: number;
  scheduledDone: number;
  doing: number;
  /** Tasks planned for the period whose date was later moved out of it. */
  postponed: number;
  /** Tasks planned for the period: dated in it now, plus the postponed ones. */
  planned: number;
  /** Tasks created in the period but dated after it (e.g. 当天至本周日 copies). */
  createdForLater: number;
  /** scheduledDone / planned, in percent. */
  completionRate: number;
}

export interface BossWorkReportSummary {
  people: number;
  activePeople: number;
  selfCreated: number;
  carriedOver: number;
  assigned: number;
  completed: number;
  scheduled: number;
  scheduledDone: number;
  doing: number;
  postponed: number;
  planned: number;
  createdForLater: number;
  completionRate: number;
}

export interface BossWorkReportSection {
  period: WorkReportPeriod;
  summary: BossWorkReportSummary;
  members: BossWorkReportMember[];
}

export interface BossWorkReportBundle {
  reportDate: string;
  generatedAt: string;
  status: BossWorkReportStatus | null;
  daily: BossWorkReportSection;
  weekly: BossWorkReportSection;
  monthly: BossWorkReportSection;
}

function addDays(date: string, amount: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + amount);
  return value.toISOString().slice(0, 10);
}

function previousCompletedWeek(reportDate: string): WorkReportPeriod {
  const current = new Date(`${reportDate}T00:00:00Z`);
  const weekday = current.getUTCDay();
  const daysSinceMonday = weekday === 0 ? 6 : weekday - 1;
  const currentMonday = addDays(reportDate, -daysSinceMonday);
  const startDate = addDays(currentMonday, -7);
  return {
    kind: "weekly",
    startDate,
    endDate: addDays(startDate, 6),
  };
}

function previousCompletedMonth(reportDate: string): WorkReportPeriod {
  const [year, month] = reportDate.split("-").map(Number);
  const currentMonthStart = new Date(Date.UTC(year, month - 1, 1));
  const previousMonthEnd = new Date(currentMonthStart);
  previousMonthEnd.setUTCDate(0);
  const previousMonthStart = new Date(
    Date.UTC(previousMonthEnd.getUTCFullYear(), previousMonthEnd.getUTCMonth(), 1),
  );
  return {
    kind: "monthly",
    startDate: previousMonthStart.toISOString().slice(0, 10),
    endDate: previousMonthEnd.toISOString().slice(0, 10),
  };
}

export function workReportPeriods(reportDate: string): Record<
  WorkReportPeriodKind,
  WorkReportPeriod
> {
  const yesterday = addDays(reportDate, -1);
  return {
    daily: { kind: "daily", startDate: yesterday, endDate: yesterday },
    weekly: previousCompletedWeek(reportDate),
    monthly: previousCompletedMonth(reportDate),
  };
}

function shanghaiStart(date: string): number {
  return Date.parse(`${date}T00:00:00+08:00`);
}

function timestampInPeriod(value: string | null, period: WorkReportPeriod) {
  if (!value) return false;
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    timestamp >= shanghaiStart(period.startDate) &&
    timestamp < shanghaiStart(addDays(period.endDate, 1))
  );
}

function dateInPeriod(value: string, period: WorkReportPeriod) {
  return value >= period.startDate && value <= period.endDate;
}

function countUnique(values: Iterable<string>) {
  return new Set(values).size;
}

export function buildWorkReportSection(input: {
  period: WorkReportPeriod;
  users: PublicUser[];
  tasks: Task[];
  audits: TaskAuditEvent[];
}): BossWorkReportSection {
  const members = input.users
    .filter((user) => user.role === "member" && user.status === "active")
    .map((user): BossWorkReportMember => {
      const tasks = input.tasks.filter((task) => task.userId === user.id);
      const audits = input.audits.filter((audit) => audit.userId === user.id);
      const selfCreated = countUnique([
        ...tasks
          .filter(
            (task) =>
              task.origin === "self" &&
              timestampInPeriod(task.createdAt, input.period),
          )
          .map((task) => task.id),
        ...audits
          .filter(
            (audit) =>
              audit.action === "created" &&
              audit.snapshot.origin === "self" &&
              audit.actorId === user.id &&
              timestampInPeriod(audit.createdAt, input.period),
          )
          .map((audit) => audit.taskId),
      ]);
      const carriedOver = countUnique([
        ...tasks
          .filter(
            (task) =>
              task.origin === "carryover" &&
              timestampInPeriod(task.createdAt, input.period),
          )
          .map((task) => task.id),
        ...audits
          .filter(
            (audit) =>
              audit.action === "carried_over" &&
              timestampInPeriod(audit.createdAt, input.period),
          )
          .map((audit) => audit.taskId),
      ]);
      const assigned = countUnique([
        ...tasks
          .filter(
            (task) =>
              task.origin === "assigned" &&
              timestampInPeriod(task.createdAt, input.period),
          )
          .map((task) => task.id),
        ...audits
          .filter(
            (audit) =>
              audit.action === "assigned" &&
              timestampInPeriod(audit.createdAt, input.period),
          )
          .map((audit) => audit.taskId),
      ]);
      const completed = countUnique([
        ...tasks
          .filter((task) => timestampInPeriod(task.completedAt, input.period))
          .map((task) => task.id),
        ...audits
          .filter(
            (audit) =>
              audit.action === "completed" &&
              timestampInPeriod(audit.createdAt, input.period),
          )
          .map((audit) => audit.taskId),
      ]);
      const scheduledTasks = tasks.filter((task) =>
        dateInPeriod(task.date, input.period),
      );
      const scheduledDone = scheduledTasks.filter(
        (task) => task.status === "done",
      ).length;
      const doing = scheduledTasks.filter((task) => task.status === "doing").length;
      // Planned for the period but moved to another date since (改期): still
      // part of the plan, and not done in it. Deleted tasks left the plan.
      const postponedIds = new Set(
        audits
          .filter(
            (audit) =>
              audit.action === "updated" &&
              audit.changes.some(
                (change) =>
                  change.field === "date" &&
                  typeof change.before === "string" &&
                  dateInPeriod(change.before, input.period),
              ),
          )
          .map((audit) => audit.taskId)
          .filter((taskId) => {
            const task = tasks.find((item) => item.id === taskId);
            return Boolean(task) && !dateInPeriod(task!.date, input.period);
          }),
      );
      const postponed = postponedIds.size;
      const planned = scheduledTasks.length + postponed;
      const createdForLater = tasks.filter(
        (task) =>
          task.origin === "self" &&
          timestampInPeriod(task.createdAt, input.period) &&
          task.date > input.period.endDate &&
          !postponedIds.has(task.id),
      ).length;
      return {
        user,
        selfCreated,
        carriedOver,
        assigned,
        completed,
        scheduled: scheduledTasks.length,
        scheduledDone,
        doing,
        postponed,
        planned,
        createdForLater,
        completionRate:
          planned === 0 ? 0 : Math.round((scheduledDone / planned) * 100),
      };
    })
    .sort(
      (left, right) =>
        right.completed - left.completed ||
        right.selfCreated + right.carriedOver -
          (left.selfCreated + left.carriedOver) ||
        left.user.name.localeCompare(right.user.name, "zh-CN"),
    );

  const summary = members.reduce<BossWorkReportSummary>(
    (total, member) => ({
      people: total.people,
      activePeople:
        total.activePeople +
        Number(
          member.selfCreated +
            member.carriedOver +
            member.assigned +
            member.completed >
            0,
        ),
      selfCreated: total.selfCreated + member.selfCreated,
      carriedOver: total.carriedOver + member.carriedOver,
      assigned: total.assigned + member.assigned,
      completed: total.completed + member.completed,
      scheduled: total.scheduled + member.scheduled,
      scheduledDone: total.scheduledDone + member.scheduledDone,
      doing: total.doing + member.doing,
      postponed: total.postponed + member.postponed,
      planned: total.planned + member.planned,
      createdForLater: total.createdForLater + member.createdForLater,
      completionRate: 0,
    }),
    {
      people: members.length,
      activePeople: 0,
      selfCreated: 0,
      carriedOver: 0,
      assigned: 0,
      completed: 0,
      scheduled: 0,
      scheduledDone: 0,
      doing: 0,
      postponed: 0,
      planned: 0,
      createdForLater: 0,
      completionRate: 0,
    },
  );
  summary.completionRate =
    summary.planned === 0
      ? 0
      : Math.round((summary.scheduledDone / summary.planned) * 100);

  return { period: input.period, summary, members };
}

export function buildBossWorkReport(input: {
  now?: Date;
  reportDate?: string;
  status: BossWorkReportStatus | null;
  users: PublicUser[];
  tasks: Task[];
  audits: TaskAuditEvent[];
}): BossWorkReportBundle {
  const now = input.now ?? new Date();
  const reportDate = input.reportDate ?? businessDateKey(now);
  const periods = workReportPeriods(reportDate);
  const section = (period: WorkReportPeriod) =>
    buildWorkReportSection({
      period,
      users: input.users,
      tasks: input.tasks,
      audits: input.audits,
    });
  return {
    reportDate,
    generatedAt: now.toISOString(),
    status: input.status,
    daily: section(periods.daily),
    weekly: section(periods.weekly),
    monthly: section(periods.monthly),
  };
}
