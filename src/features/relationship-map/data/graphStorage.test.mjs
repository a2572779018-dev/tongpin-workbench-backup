import { describe, expect, it } from "vitest";
import { connections, people } from "./graphData.js";
import {
  graphStorageKeyForMember,
  loadGraph,
  saveGraph,
  themeStorageKeyForMember,
} from "./graphStorage.js";

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

describe("Tongpin member relationship storage", () => {
  it("uses independent graph and theme keys for each member", () => {
    expect(graphStorageKeyForMember("member-a")).not.toBe(
      graphStorageKeyForMember("member-b"),
    );
    expect(themeStorageKeyForMember("member-a")).not.toBe(
      themeStorageKeyForMember("member-b"),
    );
    expect(graphStorageKeyForMember("member/a")).not.toContain("/");
  });

  it("never exposes one member's graph through another member's key", () => {
    const storage = memoryStorage();
    const memberAKey = graphStorageKeyForMember("member-a");
    const memberBKey = graphStorageKeyForMember("member-b");

    expect(
      saveGraph(
        storage,
        { title: "成员 A 的关系图", people, connections },
        memberAKey,
      ).ok,
    ).toBe(true);
    expect(loadGraph(storage, memberAKey).graph.title).toBe("成员 A 的关系图");
    expect(loadGraph(storage, memberBKey)).toEqual({
      ok: true,
      found: false,
      graph: null,
    });
  });
});
