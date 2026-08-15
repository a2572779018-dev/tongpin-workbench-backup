import { describe, expect, it } from "vitest";
import {
  rolloverCheckKey,
  shouldCheckRollover,
} from "./rolloverSchedule";

describe("rollover schedule", () => {
  const userId = "member-1";

  it("waits until the 09:30 workday boundary", () => {
    expect(
      shouldCheckRollover(
        userId,
        new Date(2026, 6, 30, 9, 29, 59),
        "",
      ),
    ).toBe(false);
    expect(
      shouldCheckRollover(userId, new Date(2026, 6, 30, 9, 30), ""),
    ).toBe(true);
  });

  it("checks immediately when the app opens after 09:30", () => {
    expect(
      shouldCheckRollover(userId, new Date(2026, 6, 30, 14, 20), ""),
    ).toBe(true);
  });

  it("checks only once per account and date after a successful response", () => {
    const now = new Date(2026, 6, 30, 10, 0);
    expect(
      shouldCheckRollover(userId, now, rolloverCheckKey(userId, now)),
    ).toBe(false);
  });

  it("allows the next workday to be checked", () => {
    const yesterday = new Date(2026, 6, 29, 10, 0);
    const today = new Date(2026, 6, 30, 10, 0);
    expect(
      shouldCheckRollover(
        userId,
        today,
        rolloverCheckKey(userId, yesterday),
      ),
    ).toBe(true);
  });
});

