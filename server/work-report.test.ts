import { describe, expect, it } from "vitest";
import { buildBossWorkReport, workReportPeriods } from "./work-report";
import type { PublicUser, Task, TaskAuditEvent } from "./types";

const member: PublicUser = {
  id: "member-1",
  email: "member@example.com",
  name: "小林",
  role: "member",
  status: "active",
  jobTitle: "成员",
  avatarSeed: 1,
  avatarVersion: 0,
  hasCustomAvatar: false,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function task(
  id: string,
  origin: Task["origin"],
  createdAt: string,
  completedAt: string | null = null,
): Task {
  return {
    id,
    userId: member.id,
    date: "2026-08-15",
    title: id,
    details: "",
    status: completedAt ? "done" : "todo",
    priority: "p2",
    origin,
    assignedBy: origin === "assigned" ? "boss-1" : null,
    assignmentId: null,
    sourceTaskId: origin === "carryover" ? "old-task" : null,
    assignmentDeliveredAt: null,
    assignmentViewedAt: null,
    completedAt,
    createdAt,
    updatedAt: completedAt ?? createdAt,
  };
}

describe("boss work report", () => {
  it("uses the previous complete day, week and month", () => {
    expect(workReportPeriods("2026-08-16")).toEqual({
      daily: { kind: "daily", startDate: "2026-08-15", endDate: "2026-08-15" },
      weekly: { kind: "weekly", startDate: "2026-08-03", endDate: "2026-08-09" },
      monthly: { kind: "monthly", startDate: "2026-07-01", endDate: "2026-07-31" },
    });
  });

  it("counts Shanghai-day task activity and deduplicates audit snapshots", () => {
    const tasks = [
      task("self", "self", "2026-08-15T00:10:00.000Z", "2026-08-15T04:00:00.000Z"),
      task("carry", "carryover", "2026-08-15T00:20:00.000Z"),
      task("assigned", "assigned", "2026-08-15T00:30:00.000Z"),
      task("before-midnight", "self", "2026-08-14T15:59:59.000Z"),
    ];
    const audits: TaskAuditEvent[] = [
      {
        id: "audit-1",
        taskId: "self",
        userId: member.id,
        actorId: member.id,
        action: "completed",
        changes: [],
        snapshot: tasks[0],
        createdAt: "2026-08-15T04:00:00.000Z",
      },
    ];
    const report = buildBossWorkReport({
      now: new Date("2026-08-16T01:00:00.000Z"),
      reportDate: "2026-08-16",
      status: null,
      users: [member],
      tasks,
      audits,
    });
    expect(report.daily.summary).toMatchObject({
      people: 1,
      activePeople: 1,
      selfCreated: 1,
      carriedOver: 1,
      assigned: 1,
      completed: 1,
      scheduled: 4,
      scheduledDone: 1,
      completionRate: 25,
    });
  });

  it("rates the plan: tasks dated in the period plus those moved out of it, never later-dated new tasks", () => {
    const at = "2026-08-15T02:00:00.000Z";
    const done = (id: string) => task(id, "self", at, "2026-08-15T08:00:00.000Z");
    const open = (id: string, date: string) => ({ ...task(id, "self", at), date });
    // 6 done on the day; 2 moved from the day to the next day (改期);
    // 3 created that day for later days (当天至本周日 copies); 2 deleted.
    const tasks = [
      ...["d1", "d2", "d3", "d4", "d5", "d6"].map(done),
      open("moved-1", "2026-08-16"),
      open("moved-2", "2026-08-16"),
      open("later-1", "2026-08-16"),
      open("later-2", "2026-08-17"),
      open("later-3", "2026-08-18"),
    ];
    const moved = (taskId: string): TaskAuditEvent => ({
      id: `audit-${taskId}`,
      taskId,
      userId: member.id,
      actorId: member.id,
      action: "updated",
      changes: [{ field: "date", before: "2026-08-15", after: "2026-08-16" }],
      snapshot: tasks.find((item) => item.id === taskId)!,
      createdAt: "2026-08-15T12:00:00.000Z",
    });
    const deleted = (taskId: string): TaskAuditEvent => ({
      id: `audit-${taskId}`,
      taskId,
      userId: member.id,
      actorId: member.id,
      action: "deleted",
      changes: [],
      snapshot: { ...task(taskId, "self", at), date: "2026-08-15" },
      createdAt: "2026-08-15T13:00:00.000Z",
    });
    const report = buildBossWorkReport({
      now: new Date("2026-08-16T01:00:00.000Z"),
      reportDate: "2026-08-16",
      status: null,
      users: [member],
      tasks,
      audits: [moved("moved-1"), moved("moved-2"), deleted("gone-1"), deleted("gone-2")],
    });
    expect(report.daily.members[0]).toMatchObject({
      selfCreated: 11,
      completed: 6,
      scheduled: 6,
      scheduledDone: 6,
      postponed: 2,
      planned: 8,
      createdForLater: 3,
      completionRate: 75,
    });
    expect(report.daily.summary).toMatchObject({ planned: 8, scheduledDone: 6, postponed: 2, createdForLater: 3, completionRate: 75 });
  });

  it("does not count a task moved into the period and back out as postponed twice", () => {
    const at = "2026-08-15T02:00:00.000Z";
    const tasks = [{ ...task("t1", "self", at), date: "2026-08-17" }];
    const change = (id: string, before: string, after: string): TaskAuditEvent => ({
      id, taskId: "t1", userId: member.id, actorId: member.id, action: "updated",
      changes: [{ field: "date", before, after }], snapshot: tasks[0], createdAt: "2026-08-15T12:00:00.000Z",
    });
    const report = buildBossWorkReport({
      now: new Date("2026-08-16T01:00:00.000Z"),
      reportDate: "2026-08-16",
      status: null,
      users: [member],
      tasks,
      audits: [change("a1", "2026-08-15", "2026-08-16"), change("a2", "2026-08-16", "2026-08-15"), change("a3", "2026-08-15", "2026-08-17")],
    });
    expect(report.daily.members[0]).toMatchObject({ scheduled: 0, postponed: 1, planned: 1, completionRate: 0 });
  });

  it("does not include boss or admin accounts in employee totals", () => {
    const report = buildBossWorkReport({
      now: new Date("2026-08-16T01:00:00.000Z"),
      reportDate: "2026-08-16",
      status: null,
      users: [
        member,
        { ...member, id: "boss", name: "老板", role: "boss" },
        { ...member, id: "admin", name: "管理员", role: "admin" },
      ],
      tasks: [],
      audits: [],
    });
    expect(report.daily.summary.people).toBe(1);
  });
});
