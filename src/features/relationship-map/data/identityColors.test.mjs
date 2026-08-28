import { describe, expect, it } from "vitest";
import {
  DEFAULT_IDENTITY_COLOR_SEMANTICS,
  IDENTITY_COLOR_KEYS,
  IDENTITY_COLOR_PALETTE,
  LEGACY_IDENTITY_COLOR_SEMANTICS,
  identityColorLabel,
  migrateLegacyPersonColorKeys,
  normalizeIdentityColorSemantics,
  updateIdentityColorSemantic,
} from "./identityColors.js";

describe("customer identity colors", () => {
  it("keeps the four audited color keys and exact Tongpin palette", () => {
    expect(IDENTITY_COLOR_KEYS).toEqual(["yellow", "blue", "pink", "green"]);
    expect(IDENTITY_COLOR_PALETTE).toEqual({
      yellow: "#ffd84d",
      blue: "#8ab8f5",
      pink: "#ffcaca",
      green: "#bfeea5",
    });
    expect(DEFAULT_IDENTITY_COLOR_SEMANTICS.yellow).toBe("合伙人");
  });

  it("normalizes and persists a user-defined meaning without accepting extra colors", () => {
    const semantics = normalizeIdentityColorSemantics({
      yellow: "  城市合伙人  ",
      blue: "",
      violet: "不允许",
    });

    expect(semantics).toEqual({
      yellow: "城市合伙人",
      blue: "客户",
      pink: "渠道",
      green: "其他",
    });
    expect(semantics).not.toHaveProperty("violet");
    expect(identityColorLabel("yellow", semantics)).toBe("城市合伙人");
    expect(updateIdentityColorSemantic(semantics, "yellow", "合伙人").yellow).toBe("合伙人");
    expect(() => updateIdentityColorSemantic(semantics, "violet", "无效")).toThrow("请选择有效的身份颜色");
  });

  it("migrates legacy colors from tree depth before falling back to level", () => {
    const people = [
      { id: "self", level: "self" },
      // A close first-level contact was yellow in the old depth-based UI.
      { id: "first", level: "close" },
      { id: "second", level: "core" },
      { id: "third", level: "weak" },
      { id: "fourth", level: "core" },
      { id: "explicit", level: "core", colorKey: "green" },
      { id: "disconnected", level: "acquaintance" },
    ];
    const connections = [
      ["self", "first", "客户引荐"],
      ["first", "second", "客户引荐"],
      ["second", "third", "客户引荐"],
      ["third", "fourth", "客户引荐"],
      ["self", "explicit", "客户引荐"],
    ];

    const migrated = migrateLegacyPersonColorKeys(people, connections);
    expect(Object.fromEntries(migrated.map((person) => [person.id, person.colorKey]))).toEqual({
      self: "yellow",
      first: "yellow",
      second: "blue",
      third: "pink",
      fourth: "green",
      explicit: "green",
      disconnected: "pink",
    });
    expect(migrated.find((person) => person.id === "explicit")).toBe(people[5]);
  });

  it("provides neutral labels for old depth-based graphs", () => {
    expect(LEGACY_IDENTITY_COLOR_SEMANTICS).toEqual({
      yellow: "一级关系",
      blue: "二级关系",
      pink: "三级关系",
      green: "四级及以上",
    });
  });
});

