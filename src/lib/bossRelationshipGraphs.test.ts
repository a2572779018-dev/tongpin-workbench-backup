import { describe, expect, it } from "vitest";
import type { RelationshipGraphSnapshotMeta } from "../../shared/relationshipGraphMirror";
import type { User } from "../types";
import { ApiRequestError } from "./api";
import {
  bossRelationshipGraphErrorMessage,
  bossRelationshipGraphNote,
  formatRelationshipGraphSyncedAt,
  sortBossRelationshipGraphMembers,
  summarizeBossRelationshipGraphs,
  type BossRelationshipGraphMember,
} from "./bossRelationshipGraphs";

function member(name: string, snapshot: Partial<RelationshipGraphSnapshotMeta> | null): BossRelationshipGraphMember {
  return {
    user: { id: name, name, role: "member" } as User,
    snapshot: snapshot && {
      localVersion: 1,
      contentHash: "a".repeat(64),
      updatedAt: "2026-09-26T08:00:00.000Z",
      syncedAt: "2026-09-26T08:00:00.000Z",
      contactCount: 0,
      connectionCount: 0,
      avatarsOmitted: 0,
      bytes: 1,
      ...snapshot,
    },
  };
}

describe("boss 成员客户脉络图 list helpers", () => {
  it("puts recently synced members first and 未同步 members last", () => {
    const sorted = sortBossRelationshipGraphMembers([
      member("丙", null),
      member("甲", { syncedAt: "2026-09-25T08:00:00.000Z" }),
      member("乙", { syncedAt: "2026-09-26T08:00:00.000Z" }),
      member("丁", null),
    ]);
    expect(sorted.map((item) => item.user.name)).toEqual(["乙", "甲", "丙", "丁"]);
  });

  it("summarizes synced members and their customers", () => {
    expect(
      summarizeBossRelationshipGraphs([
        member("甲", { contactCount: 12 }),
        member("乙", { contactCount: 3 }),
        member("丙", null),
      ]),
    ).toEqual({ people: 3, synced: 2, unsynced: 1, contacts: 15 });
  });

  it("formats sync times relative to today", () => {
    const now = new Date(2026, 8, 26, 18, 0).getTime();
    expect(formatRelationshipGraphSyncedAt(new Date(2026, 8, 26, 9, 5).toISOString(), now)).toBe("今天 09:05");
    expect(formatRelationshipGraphSyncedAt(new Date(2026, 8, 20, 21, 30).toISOString(), now)).toBe("9月20日 21:30");
    expect(formatRelationshipGraphSyncedAt(new Date(2025, 0, 2, 8, 0).toISOString(), now)).toBe("2025年1月2日 08:00");
    expect(formatRelationshipGraphSyncedAt("broken", now)).toBe("时间未知");
  });

  it("says in the viewer when avatars were left on the member's computer", () => {
    const now = new Date(2026, 8, 26, 18, 0).getTime();
    const syncedAt = new Date(2026, 8, 26, 9, 5).toISOString();
    expect(bossRelationshipGraphNote(member("甲", { syncedAt })!.snapshot!, now)).toBe("同步于 今天 09:05");
    expect(bossRelationshipGraphNote(member("甲", { syncedAt, avatarsOmitted: 3 })!.snapshot!, now)).toBe(
      "同步于 今天 09:05 · 3 个头像未同步，以姓名首字显示",
    );
  });

  it("explains a backend that does not offer the page yet", () => {
    expect(bossRelationshipGraphErrorMessage(new ApiRequestError(404, "NOT_FOUND", "请求的接口不存在"), "x")).toBe(
      "服务器暂未开放成员客户脉络图，请更新后端后再试",
    );
    expect(
      bossRelationshipGraphErrorMessage(new ApiRequestError(404, "RELATIONSHIP_GRAPH_NOT_SYNCED", "该成员尚未同步客户脉络图"), "x"),
    ).toBe("该成员尚未同步客户脉络图");
    expect(bossRelationshipGraphErrorMessage(null, "加载失败")).toBe("加载失败");
  });
});
