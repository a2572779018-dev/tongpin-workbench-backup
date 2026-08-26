import { describe, expect, it } from "vitest";
import {
  buildCustomerHierarchy,
  hiddenDescendantCount,
  isDescendantOf,
  layoutCustomerTree,
  visibleCustomerIds,
} from "./customerTreeLayout.js";

const people = ["self", "a", "b", "a1", "a2", "a11", "loose"].map((id) => ({ id }));
const connections = [
  ["self", "a", "合作客户"],
  ["self", "b", "合作客户"],
  ["a", "a1", "客户引荐"],
  ["a", "a2", "客户引荐"],
  ["a1", "a11", "客户引荐"],
  ["b", "a2", "交叉合作"],
];

describe("customer tree layout", () => {
  it("builds a deterministic rooted customer hierarchy and keeps cross links secondary", () => {
    const tree = buildCustomerHierarchy(people, connections);
    expect(tree.parentById.get("a")).toBe("self");
    expect(tree.parentById.get("a2")).toBe("a");
    expect(tree.depthById.get("a11")).toBe(3);
    expect(tree.treeEdgeIndexes).toEqual(new Set([0, 1, 2, 3, 4]));
    expect(tree.disconnectedIds).toEqual(["loose"]);
  });

  it("shows direct customers first and reports collapsed descendants", () => {
    const tree = buildCustomerHierarchy(people, connections);
    const visible = visibleCustomerIds(tree, new Set(["self"]));
    expect([...visible]).toEqual(["self", "a", "b", "loose"]);
    expect(hiddenDescendantCount("a", tree, visible)).toBe(3);
    expect(hiddenDescendantCount("b", tree, visible)).toBe(0);
  });

  it("expands one branch without revealing unrelated descendants", () => {
    const tree = buildCustomerHierarchy(people, connections);
    const visible = visibleCustomerIds(tree, new Set(["self", "a"]));
    expect(visible.has("a1")).toBe(true);
    expect(visible.has("a11")).toBe(false);
    expect(isDescendantOf("a11", "a", tree)).toBe(true);
    expect(isDescendantOf("b", "a", tree)).toBe(false);
  });

  it("lays horizontal and pyramid modes on different axes", () => {
    const tree = buildCustomerHierarchy(people, connections);
    const visible = visibleCustomerIds(tree, new Set(["self", "a", "a1"]));
    const horizontal = layoutCustomerTree(tree, visible, "horizontal");
    const pyramid = layoutCustomerTree(tree, visible, "pyramid");
    expect(horizontal.get("a").x).toBeGreaterThan(horizontal.get("self").x);
    expect(pyramid.get("a").y).toBeGreaterThan(pyramid.get("self").y);
    expect(pyramid.get("a11").y).toBeGreaterThan(pyramid.get("a").y);
    expect(pyramid.get("a11").x).toBe(pyramid.get("a1").x);
    expect(pyramid.get("a").x).toBe(
      (pyramid.get("a1").x + pyramid.get("a2").x) / 2,
    );
  });
});
