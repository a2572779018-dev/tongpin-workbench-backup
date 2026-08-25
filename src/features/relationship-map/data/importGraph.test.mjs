import { describe, expect, it } from "vitest";
import { parseGraphDocument } from "./importGraph.js";

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
    expect(graph.connections).toEqual([
      {
        source: "self",
        target: "alice",
        relationship: "朋友",
        strength: 0.75,
      },
    ]);
  });
});
