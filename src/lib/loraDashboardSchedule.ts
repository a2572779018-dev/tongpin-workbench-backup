export type LoraDashboardClaimTrigger =
  | "startup"
  | "08:00"
  | "reconnect"
  | "manual";

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

function shiftedShanghaiDate(now: Date): Date {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS);
}

export function shanghaiReportDate(now = new Date()): string {
  return shiftedShanghaiDate(now).toISOString().slice(0, 10);
}

export function nextShanghaiEightAt(now = new Date()): Date {
  const shifted = shiftedShanghaiDate(now);
  const localMidnightAsUtc = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  let target = localMidnightAsUtc + 8 * 60 * 60 * 1_000 - SHANGHAI_OFFSET_MS;
  if (target <= now.getTime()) target += ONE_DAY_MS;
  return new Date(target);
}

export function millisecondsUntilNextShanghaiEight(now = new Date()): number {
  return Math.max(1, nextShanghaiEightAt(now).getTime() - now.getTime());
}

export function shouldAutoOpenLoraDashboard(role: string): boolean {
  return role === "boss";
}
