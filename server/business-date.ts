export function businessDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

export type TaskCreateScope = "day" | "rest_of_week";

export function taskDatesForScope(
  date: string,
  scope: TaskCreateScope,
): string[] {
  if (scope === "day") return [date];

  const start = new Date(`${date}T00:00:00Z`);
  const weekday = start.getUTCDay();
  const daysThroughSunday = weekday === 0 ? 1 : 8 - weekday;

  return Array.from({ length: daysThroughSunday }, (_, index) => {
    const current = new Date(start);
    current.setUTCDate(current.getUTCDate() + index);
    return current.toISOString().slice(0, 10);
  });
}
