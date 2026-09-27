import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BossWorkReportModal, memberActivityNote } from "./BossWorkReportModal";
import type { BossWorkReportBundle, BossWorkReportSection, User } from "../types";

const user = { id: "m1", name: "小娟", jobTitle: "成员" } as unknown as User;
const member = (overrides: Partial<BossWorkReportSection["members"][number]> = {}) => ({
  user, selfCreated: 17, carriedOver: 0, assigned: 0, completed: 7, scheduled: 7, scheduledDone: 7, doing: 0,
  postponed: 0, planned: 7, createdForLater: 10, completionRate: 100, ...overrides,
});

describe("boss work report modal", () => {
  it("explains what the numbers next to the rate count", () => {
    expect(memberActivityNote(member(), "昨日")).toBe("昨日新建 17 项（10 项排在之后的日期） · 昨日共完成 7 项");
    expect(memberActivityNote(member({ completed: 9, postponed: 2, assigned: 1, createdForLater: 0 }), "昨日"))
      .toBe("昨日新建 17 项 · 老板派发 1 项 · 昨日共完成 9 项（含其他日期的任务） · 改期 2 项");
  });

  it("shows the plan, not the activity, next to the completion rate", () => {
    const section: BossWorkReportSection = {
      period: { kind: "daily", startDate: "2026-09-26", endDate: "2026-09-26" },
      summary: { people: 1, activePeople: 1, selfCreated: 17, carriedOver: 0, assigned: 0, completed: 7, scheduled: 7, scheduledDone: 7, doing: 0, postponed: 0, planned: 7, createdForLater: 10, completionRate: 100 },
      members: [member()],
    };
    const report = { reportDate: "2026-09-27", generatedAt: "", status: null, daily: section, weekly: section, monthly: section } as unknown as BossWorkReportBundle;
    const html = renderToStaticMarkup(createElement(BossWorkReportModal, {
      report, busy: false, error: "", onClose: () => undefined, onRead: () => undefined, onNudge: () => undefined, nudgingMemberId: "", nudgedMemberIds: new Set<string>(),
    }));
    expect(html).toContain("昨日计划 <b>7</b>");
    expect(html).toContain("已完成 <b>7</b>");
    expect(html).toContain("完成率 = 昨日计划的任务中已完成的比例");
    expect(html).toContain("昨日新建 17 项（10 项排在之后的日期）");
    expect(html).toContain("计划完成率：昨日计划的 7 项任务中已完成 7 项。");
    expect(html).toContain("width:100%");
  });

  it("falls back to the scheduled count from an older server", () => {
    const legacy = member({ planned: undefined, postponed: undefined, createdForLater: undefined, scheduled: 4, scheduledDone: 1, completionRate: 25 });
    expect(memberActivityNote(legacy, "昨日")).toBe("昨日新建 17 项 · 昨日共完成 7 项（含其他日期的任务）");
  });
});
