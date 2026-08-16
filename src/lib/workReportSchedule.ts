import type { UserRole } from "../types";
import type { WorkReportPeriodKind } from "../types";

export type WorkReportClaimTrigger =
  | "startup"
  | "login"
  | "resume"
  | "reconnect"
  | "day-change";

export function shanghaiReportDate(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function canOpenBossWorkReport(role: UserRole) {
  return role === "boss";
}

export function automaticWorkReportKind(
  reportDate: string,
): WorkReportPeriodKind {
  const [, , day] = reportDate.split("-").map(Number);
  if (day === 1) return "monthly";
  const weekday = new Date(`${reportDate}T00:00:00Z`).getUTCDay();
  return weekday === 1 ? "weekly" : "daily";
}

export function automaticWorkReportLabel(reportDate: string) {
  const kind = automaticWorkReportKind(reportDate);
  return kind === "monthly"
    ? "上月工作总结"
    : kind === "weekly"
      ? "上周工作总结"
      : "昨日工作进度汇报";
}

export function shouldClaimAfterDateCheck(
  role: UserRole,
  lastReportDate: string,
  now = new Date(),
) {
  return canOpenBossWorkReport(role) && shanghaiReportDate(now) !== lastReportDate;
}
