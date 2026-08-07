import { describe, expect, it } from "vitest";

import { getWorkdayCountdown } from "./workday";

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
