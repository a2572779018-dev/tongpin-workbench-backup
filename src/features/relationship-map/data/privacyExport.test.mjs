import { describe, expect, it } from "vitest";
import { parseGraphDocument, serializeGraphDocument } from "./importGraph.js";
import {
  createPrivacySafeGraph,
  createPrivacySafeReportSummary,
  relationshipReportTitle,
} from "./privacyExport.js";

describe("privacy-safe relationship export", () => {
  it("does not reuse a potentially identifying graph title in a privacy report", () => {
    expect(relationshipReportTitle("张老板 13800000000", true)).toBe("关系摘要（隐私副本）");
    expect(relationshipReportTitle("我的关系图", false)).toBe("我的关系图 · 关系摘要");
  });

  it("suppresses small-team counts and the most-active fingerprint in a privacy report", () => {
    expect(createPrivacySafeReportSummary()).toEqual({
      people: "已隐藏",
      connections: "已隐藏",
      corePeople: "已隐藏",
      mostActive: null,
    });
  });

  it("removes identifiers, precise metrics, coordinates, and topology", () => {
    const safeGraph = createPrivacySafeGraph({
      colorSemantics: { yellow: "绝密合伙人" },
      people: [
        {
          id: "owner-secret-id",
          name: "张老板",
          alias: "本人别名",
          initial: "张",
          avatar: "data:image/png;base64,secretavatar",
          level: "self",
          relationship: "自己",
          community: "罗拉数科",
          interactions: 31,
          lastContact: "昨天 18:30",
          activeDays: 12,
          mutual: 8,
          phone: "13800000000",
          wechat: "secret-wechat",
          tags: ["老板"],
          note: "自我备注 secret-self-note",
          position: { x: 620, y: 315 },
        },
        {
          id: "alice-sensitive-id",
          name: "爱丽丝",
          alias: "客户联系人",
          initial: "爱",
          avatar: null,
          level: "core",
          relationship: "同事",
          community: "绝密项目组",
          interactions: 18,
          lastContact: "今天 09:00",
          activeDays: 7,
          mutual: 3,
          phone: "13900000000",
          wechat: "alice-private-wechat",
          tags: ["重点客户"],
          note: "关系备注 secret-relation-note",
          position: { x: 100, y: 200 },
        },
      ],
      connections: [
        {
          source: "owner-secret-id",
          target: "alice-sensitive-id",
          relationship: "同事",
          strength: 0.88,
          note: "连接备注 secret-edge-note",
        },
      ],
    });

    const serialized = serializeGraphDocument(safeGraph);
    for (const sensitiveValue of [
      "owner-secret-id",
      "alice-sensitive-id",
      "张老板",
      "爱丽丝",
      "13800000000",
      "13900000000",
      "secret-wechat",
      "alice-private-wechat",
      "罗拉数科",
      "绝密项目组",
      "secret-self-note",
      "secret-relation-note",
      "secret-edge-note",
      "重点客户",
      "绝密合伙人",
    ]) {
      expect(serialized).not.toContain(sensitiveValue);
    }

    expect(safeGraph.people).toHaveLength(2);
    for (const person of safeGraph.people) {
      expect(person.interactions).toBe(0);
      expect(person.activeDays).toBe(0);
      expect(person.mutual).toBe(0);
      expect(person).not.toHaveProperty("position");
      expect(person.gender).toBe("");
    }
    expect(safeGraph.connections).toEqual([]);
    expect(safeGraph.people.map((person) => person.colorKey)).toEqual(["yellow", "blue"]);
    expect(serialized).not.toContain('"position"');
    expect(serialized).not.toContain('"strength"');

    const parsed = parseGraphDocument(serialized);
    expect(parsed.people.map((person) => person.id)).toEqual(["self", "contact-001"]);
    expect(parsed.people.map(({ interactions, activeDays, mutual }) => ({ interactions, activeDays, mutual }))).toEqual([
      { interactions: 0, activeDays: 0, mutual: 0 },
      { interactions: 0, activeDays: 0, mutual: 0 },
    ]);
    expect(parsed.connections).toEqual([]);
  });
});
