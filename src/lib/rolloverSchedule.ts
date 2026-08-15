import { toDateKey } from "./date";

export const ROLLOVER_CHECK_HOUR = 9;
export const ROLLOVER_CHECK_MINUTE = 30;

export function rolloverCheckKey(userId: string, now: Date): string {
  return `${userId}:${toDateKey(now)}`;
}

export function shouldCheckRollover(
  userId: string,
  now: Date,
  lastCheckedKey: string,
): boolean {
  if (!userId || Number.isNaN(now.getTime())) return false;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const threshold = ROLLOVER_CHECK_HOUR * 60 + ROLLOVER_CHECK_MINUTE;
  if (minutes < threshold) return false;
  return rolloverCheckKey(userId, now) !== lastCheckedKey;
}

