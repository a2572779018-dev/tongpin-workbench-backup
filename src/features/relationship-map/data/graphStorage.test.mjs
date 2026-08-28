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

  it("persists each customer's cooperation status", () => {
    const storage = memoryStorage();
    const storageKey = graphStorageKeyForMember("member-status");
    const peopleWithStatus = people.map((person) => person.id === "lin-lan"
      ? { ...person, cooperationStatus: "pending" }
      : person);

    expect(saveGraph(storage, { title: "客户状态", people: peopleWithStatus, connections }, storageKey).ok).toBe(true);
    const loaded = loadGraph(storage, storageKey);
    expect(loaded.ok).toBe(true);
    expect(loaded.graph.people.find((person) => person.id === "lin-lan")?.cooperationStatus).toBe("pending");
  });

  it("persists each person's color and the member's global color meanings", () => {
    const storage = memoryStorage();
    const storageKey = graphStorageKeyForMember("member-identity-colors");
    const peopleWithColors = people.map((person) => person.id === "song-qing"
      ? { ...person, colorKey: "yellow" }
      : person);
    const colorSemantics = {
      yellow: "合伙人",
      blue: "客户",
      pink: "渠道",
      green: "其他",
    };

    expect(saveGraph(storage, {
      title: "客户身份",
      colorSemantics,
      people: peopleWithColors,
      connections,
    }, storageKey).ok).toBe(true);

    const loaded = loadGraph(storage, storageKey);
    expect(loaded.ok).toBe(true);
    expect(loaded.graph.colorSemantics).toEqual(colorSemantics);
    expect(loaded.graph.people.find((person) => person.id === "song-qing")?.colorKey).toBe("yellow");
  });

  it("persists only normalized customer gender data", () => {
    const storage = memoryStorage();
    const storageKey = graphStorageKeyForMember("member-gender");
    const peopleWithGender = people.map((person) => person.id === "lin-lan"
      ? { ...person, gender: "女" }
      : person);

    expect(saveGraph(storage, {
      title: "客户性别",
      people: peopleWithGender,
      connections,
    }, storageKey).ok).toBe(true);
    const loaded = loadGraph(storage, storageKey);
    expect(loaded.ok).toBe(true);
    expect(loaded.graph.people.find((person) => person.id === "lin-lan")?.gender).toBe("女");
    expect(loaded.graph.people.find((person) => person.id === "chen-yi")?.gender).toBe("");
  });
});
