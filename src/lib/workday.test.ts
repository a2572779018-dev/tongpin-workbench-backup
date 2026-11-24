import { describe, expect, it } from "vitest";

import { formatPaydayCountdown, getWorkdayCountdown } from "./workday";

describe("workday countdown", () => {
  it("counts down to 19:00 from the 09:30 start time", () => {
    expect(getWorkdayCountdown(new Date(2026, 6, 28, 9, 30, 0))).toEqual({
      status: "working",
      hours: 9,
      minutes: 30,
      seconds: 0,
    });
  });

  it("keeps counting before work and reaches zero at 19:00", () => {
    expect(getWorkdayCountdown(new Date(2026, 6, 28, 8, 0, 0))).toEqual({
      status: "before-work",
      hours: 11,
      minutes: 0,
      seconds: 0,
    });
    expect(getWorkdayCountdown(new Date(2026, 6, 28, 18, 59, 58))).toEqual({
      status: "working",
      hours: 0,
      minutes: 0,
      seconds: 2,
    });
    expect(getWorkdayCountdown(new Date(2026, 6, 28, 19, 0, 0))).toEqual({
      status: "off-work",
      hours: 0,
      minutes: 0,
      seconds: 0,
    });
  });
});


describe("monthly payday in Beijing time", () => {
  it.each([
    ["2026-11-01T00:00:00+08:00", "14 天"],
    ["2026-11-14T19:18:30+08:00", "4 小时 41 分钟"],
    ["2026-11-14T15:59:59.999Z", "不足 1 分钟"],
    ["2026-11-14T16:00:00Z", "今天"],
    ["2026-11-15T15:59:59.999Z", "今天"],
    ["2026-11-15T16:00:00Z", "29 天"],
    ["2026-12-31T23:00:00+08:00", "14 天 1 小时"],
    ["2028-02-29T00:00:00+08:00", "15 天"],
  ])("displays the remaining interval at %s", (instant, expected) => {
    expect(formatPaydayCountdown(new Date(instant))).toBe(expected);
  });
});
