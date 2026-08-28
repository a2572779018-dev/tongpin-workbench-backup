import { describe, expect, it } from "vitest";
import { parseGraphDocument, serializeGraphDocument } from "./importGraph.js";

const MAX_GRAPH_BYTES = 25 * 1024 * 1024;

function poisonArray(length, message) {
  const values = new Array(length);
  Object.defineProperty(values, 0, {
    get() {
      throw new Error(message);
    },
  });
  return values;
}

describe("Murmur graph import budgets", () => {
  it("rejects an under-25-MB document with too many nodes", () => {
    const content = JSON.stringify({
      nodes: Array.from({ length: 5001 }, (_, index) =>
        index === 0 ? { id: "self", is_self: true } : {},
      ),
      edges: [],
    });

    expect(Buffer.byteLength(content, "utf8")).toBeLessThan(MAX_GRAPH_BYTES);
    expect(() => parseGraphDocument(content)).toThrow("人物数量不能超过 5000");
  });

  it("rejects oversized node arrays before reading a node", () => {
    expect(() =>
      parseGraphDocument({
        nodes: poisonArray(5001, "nodes were traversed"),
        edges: [],
      }),
    ).toThrow("人物数量不能超过 5000");
  });

  it("rejects oversized edge arrays before reading nodes or edges", () => {
    expect(() =>
      parseGraphDocument({
        nodes: poisonArray(1, "nodes were traversed"),
        edges: poisonArray(20001, "edges were traversed"),
      }),
    ).toThrow("连接数量不能超过 20000");
  });

  it("rejects oversized cluster arrays before reading graph entries", () => {
    expect(() =>
      parseGraphDocument({
        nodes: poisonArray(1, "nodes were traversed"),
        edges: [],
        clusters: poisonArray(5001, "clusters were traversed"),
      }),
    ).toThrow("分组数量不能超过 5000");
  });

  it("continues to normalize a valid Murmur graph", () => {
    const graph = parseGraphDocument({
      nodes: [
        { id: "owner", is_self: true, combined_score: 2 },
        { id: "alice", name: "Alice", tier: "A", combined_score: 8 },
      ],
      edges: [{ source: "owner", target: "alice", type: "private", weight: 0.75 }],
      clusters: [],
    });

    expect(graph.people.map((person) => person.id)).toEqual(["self", "alice"]);
    expect(graph.people[1].cooperationStatus).toBe("collaborated");
    expect(graph.connections).toEqual([
      {
        source: "self",
        target: "alice",
        relationship: "朋友",
        strength: 0.75,
      },
    ]);
  });

  it("preserves a pending customer status and migrates a missing status to collaborated", () => {
    const graph = parseGraphDocument({
      schemaVersion: "1.0",
      title: "客户状态",
      people: [
        { id: "self", name: "我", level: "self", relationship: "自己" },
        { id: "pending", name: "待合作", level: "close", relationship: "朋友", cooperationStatus: "pending" },
        { id: "legacy", name: "旧客户", level: "close", relationship: "朋友" },
      ],
      connections: [
        { source: "self", target: "pending", relationship: "客户引荐", strength: 0.7 },
        { source: "self", target: "legacy", relationship: "客户引荐", strength: 0.7 },
      ],
    });

    expect(graph.people.find((person) => person.id === "pending")?.cooperationStatus).toBe("pending");
    expect(graph.people.find((person) => person.id === "legacy")?.cooperationStatus).toBe("collaborated");
  });

  it("migrates old depth colors with neutral meanings instead of declaring partners", () => {
    const graph = parseGraphDocument({
      schemaVersion: "1.0",
      title: "旧客户图",
      people: [
        { id: "self", name: "我", level: "self", relationship: "自己" },
        { id: "first", name: "一级客户", level: "close", relationship: "朋友" },
        { id: "second", name: "二级客户", level: "core", relationship: "朋友" },
      ],
      connections: [
        { source: "self", target: "first", relationship: "客户引荐" },
        { source: "first", target: "second", relationship: "客户引荐" },
      ],
    });

    expect(graph.colorSemantics).toEqual({
      yellow: "一级关系",
      blue: "二级关系",
      pink: "三级关系",
      green: "四级及以上",
    });
    expect(graph.people.find((person) => person.id === "first")?.colorKey).toBe("yellow");
    expect(graph.people.find((person) => person.id === "second")?.colorKey).toBe("blue");
  });

  it("round-trips person colors and the graph-level color meanings", () => {
    const serialized = serializeGraphDocument({
      title: "身份颜色",
      colorSemantics: {
        yellow: "合伙人",
        blue: "普通客户",
        pink: "渠道伙伴",
        green: "其他",
      },
      people: [
        { id: "self", name: "我", level: "self", relationship: "自己", colorKey: "yellow" },
        { id: "partner", name: "二级合伙人", level: "close", relationship: "朋友", colorKey: "yellow" },
      ],
      connections: [
        { source: "self", target: "partner", relationship: "客户引荐", strength: 0.7 },
      ],
    });
    const graph = parseGraphDocument(serialized);

    expect(graph.colorSemantics.yellow).toBe("合伙人");
    expect(graph.colorSemantics.blue).toBe("普通客户");
    expect(graph.people.find((person) => person.id === "partner")?.colorKey).toBe("yellow");
  });

  it("normalizes the fixed gender fixture while keeping legacy people compatible", () => {
    const graph = parseGraphDocument({
      schemaVersion: "1.0",
      title: "性别字段",
      people: [
        { id: "self", name: "我", level: "self", relationship: "自己" },
        { id: "male", name: "男客户", level: "close", relationship: "朋友", gender: "男" },
        { id: "female", name: "女客户", level: "close", relationship: "朋友", gender: "女" },
        { id: "legacy", name: "旧客户", level: "close", relationship: "朋友" },
        { id: "invalid", name: "无效值", level: "close", relationship: "朋友", gender: "其他" },
      ],
      connections: [
        { source: "self", target: "male", relationship: "客户引荐" },
        { source: "self", target: "female", relationship: "客户引荐" },
        { source: "self", target: "legacy", relationship: "客户引荐" },
        { source: "self", target: "invalid", relationship: "客户引荐" },
      ],
    });

    expect(Object.fromEntries(graph.people.map((person) => [person.id, person.gender]))).toEqual({
      self: "",
      male: "男",
      female: "女",
      legacy: "",
      invalid: "",
    });
  });
});
