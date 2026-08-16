import { describe, expect, it } from "vitest";
import {
  automaticWorkReportKind,
  canOpenBossWorkReport,
  shanghaiReportDate,
  shouldClaimAfterDateCheck,
} from "./workReportSchedule";

describe("boss work report schedule", () => {
  it("switches at Asia/Shanghai midnight", () => {
    expect(shanghaiReportDate(new Date("2026-08-15T15:59:59.999Z"))).toBe(
      "2026-08-15",
    );
    expect(shanghaiReportDate(new Date("2026-08-15T16:00:00.000Z"))).toBe(
      "2026-08-16",
    );
  });

  it("only lets boss claim reports", () => {
    expect(canOpenBossWorkReport("boss")).toBe(true);
    expect(canOpenBossWorkReport("member")).toBe(false);
    expect(canOpenBossWorkReport("admin")).toBe(false);
  });

  it("claims when a running app crosses into a new Shanghai day", () => {
    expect(
      shouldClaimAfterDateCheck(
        "boss",
        "2026-08-15",
        new Date("2026-08-15T16:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("shows weekly and monthly summaries automatically without tabs", () => {
    expect(automaticWorkReportKind("2026-08-17")).toBe("weekly");
    expect(automaticWorkReportKind("2026-09-01")).toBe("monthly");
    expect(automaticWorkReportKind("2026-08-18")).toBe("daily");
  });

  it("prioritizes the monthly summary when the first is also Monday", () => {
    expect(automaticWorkReportKind("2026-06-01")).toBe("monthly");
  });
});
