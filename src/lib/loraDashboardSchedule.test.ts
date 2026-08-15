import { describe, expect, it } from "vitest";
import {
  millisecondsUntilNextShanghaiEight,
  nextShanghaiEightAt,
  shanghaiReportDate,
  shouldAutoOpenLoraDashboard,
} from "./loraDashboardSchedule";

describe("LORA dashboard Asia/Shanghai schedule", () => {
  it("uses the Shanghai natural date on both sides of midnight", () => {
    expect(shanghaiReportDate(new Date("2026-08-13T15:59:59.999Z"))).toBe(
      "2026-08-13",
    );
    expect(shanghaiReportDate(new Date("2026-08-13T16:00:00.000Z"))).toBe(
      "2026-08-14",
    );
  });

  it("targets today's 08:00 before the boundary", () => {
    const now = new Date("2026-08-13T23:59:59.000Z");
    expect(nextShanghaiEightAt(now).toISOString()).toBe(
      "2026-08-14T00:00:00.000Z",
    );
    expect(millisecondsUntilNextShanghaiEight(now)).toBe(1_000);
  });

  it("targets the next day after the 08:00 boundary", () => {
    expect(
      nextShanghaiEightAt(new Date("2026-08-14T00:00:00.000Z")).toISOString(),
    ).toBe("2026-08-15T00:00:00.000Z");
  });

  it("auto-opens only for a boss account", () => {
    expect(shouldAutoOpenLoraDashboard("boss")).toBe(true);
    expect(shouldAutoOpenLoraDashboard("admin")).toBe(false);
    expect(shouldAutoOpenLoraDashboard("member")).toBe(false);
  });

  it("keeps reconnect as a supported automatic claim trigger", () => {
    const trigger: import("./loraDashboardSchedule").LoraDashboardClaimTrigger =
      "reconnect";
    expect(trigger).toBe("reconnect");
  });
});
