export interface WorkdayCountdown {
  status: "before-work" | "working" | "off-work";
  hours: number;
  minutes: number;
  seconds: number;
}

const WORK_START_HOUR = 9;
const WORK_START_MINUTE = 30;
const WORK_END_HOUR = 19;

export function getWorkdayCountdown(now: Date): WorkdayCountdown {
  const start = new Date(now);
  start.setHours(WORK_START_HOUR, WORK_START_MINUTE, 0, 0);

  const end = new Date(now);
  end.setHours(WORK_END_HOUR, 0, 0, 0);

  if (now.getTime() >= end.getTime()) {
    return {
      status: "off-work",
      hours: 0,
      minutes: 0,
      seconds: 0,
    };
  }

  const remainingSeconds = Math.max(
    0,
    Math.floor((end.getTime() - now.getTime()) / 1000),
  );

  return {
    status: now.getTime() < start.getTime() ? "before-work" : "working",
    hours: Math.floor(remainingSeconds / 3600),
    minutes: Math.floor((remainingSeconds % 3600) / 60),
    seconds: remainingSeconds % 60,
  };
}

export function formatCountdownUnit(value: number): string {
  return String(value).padStart(2, "0");
}

const PAYDAY = 15;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export function formatPaydayCountdown(now: Date): string {
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const day = beijing.getUTCDate();
  if (day === PAYDAY) return "今天";

  const month = beijing.getUTCMonth() + (day > PAYDAY ? 1 : 0);
  const payday = Date.UTC(beijing.getUTCFullYear(), month, PAYDAY) - BEIJING_OFFSET_MS;
  const remainingMinutes = Math.floor((payday - now.getTime()) / 60_000);
  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor(remainingMinutes / 60) % 24;
  const minutes = remainingMinutes % 60;
  return [
    days && `${days} 天`,
    hours && `${hours} 小时`,
    minutes && `${minutes} 分钟`,
  ].filter(Boolean).join(" ") || "不足 1 分钟";
}
