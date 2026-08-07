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
