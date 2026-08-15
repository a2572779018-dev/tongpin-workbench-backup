import { LORA_BUSINESS_TIME_ZONE } from "./constants";

function dateParts(now: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: LORA_BUSINESS_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
}

export function shanghaiDateKey(now = new Date()): string {
  const parts = dateParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiHour(now = new Date()): number {
  return Number(dateParts(now).hour);
}

export function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function shanghaiDayStart(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("invalid date");
  return new Date(`${date}T00:00:00+08:00`);
}

export function shanghaiDayBounds(now = new Date()): {
  reportDate: string;
  todayStart: Date;
  yesterdayStart: Date;
  yesterdayEnd: Date;
} {
  const reportDate = shanghaiDateKey(now);
  const todayStart = shanghaiDayStart(reportDate);
  const yesterdayStart = shanghaiDayStart(addCalendarDays(reportDate, -1));
  return {
    reportDate,
    todayStart,
    yesterdayStart,
    yesterdayEnd: todayStart,
  };
}

export function nextShanghaiClock(
  now: Date,
  hour: number,
  minute = 0,
): Date {
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    throw new Error("invalid clock");
  }
  let date = shanghaiDateKey(now);
  let timestamp = Date.parse(
    `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
  );
  if (timestamp <= now.getTime()) {
    date = addCalendarDays(date, 1);
    timestamp = Date.parse(
      `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
    );
  }
  return new Date(timestamp);
}

export function timestampInRange(
  timestamp: string,
  start: Date,
  end: Date,
): boolean {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) && value >= start.getTime() && value < end.getTime();
}

