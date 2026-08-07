const WEEKDAYS = [
  "星期日",
  "星期一",
  "星期二",
  "星期三",
  "星期四",
  "星期五",
  "星期六",
];

const SHORT_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function fromDateKey(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function addDays(value: string | Date, amount: number): Date {
  const date = typeof value === "string" ? fromDateKey(value) : new Date(value);
  date.setDate(date.getDate() + amount);
  return date;
}

export function startOfWeek(value: string | Date): Date {
  const date = typeof value === "string" ? fromDateKey(value) : new Date(value);
  const day = date.getDay();
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1));
  return date;
}

export function getWeek(value: string | Date): Date[] {
  const start = startOfWeek(value);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function formatFullDate(value: string): string {
  const date = fromDateKey(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${WEEKDAYS[date.getDay()]}`;
}

export function formatDateLabel(date: Date): {
  weekday: string;
  day: string;
  month: string;
} {
  return {
    weekday: SHORT_WEEKDAYS[date.getDay()],
    day: String(date.getDate()).padStart(2, "0"),
    month: `${date.getMonth() + 1}月`,
  };
}

export function isToday(value: string | Date): boolean {
  const key = typeof value === "string" ? value : toDateKey(value);
  return key === toDateKey(new Date());
}

export function isSameDate(a: string | Date, b: string | Date): boolean {
  const first = typeof a === "string" ? a : toDateKey(a);
  const second = typeof b === "string" ? b : toDateKey(b);
  return first === second;
}

export function greetingByHour(): string {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

export function formatTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
