import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialGraphState,
  readableRelationshipStorageError,
} from "./RelationshipMapApp.jsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relationship map secure loading UI", () => {
  it("starts production with only a blank center instead of preview customers", () => {
    const state = initialGraphState("production-key", false);

    expect(state.storage).toBeNull();
    expect(state.graph.connections).toEqual([]);
    expect(state.graph.people).toHaveLength(1);
    expect(state.graph.people[0]).toMatchObject({ id: "self", level: "self" });
    expect(JSON.stringify(state.graph)).not.toContain("lin-lan");
    expect(JSON.stringify(state.graph)).not.toContain("林澜");
  });

  it("keeps demo customers available only for local preview", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
      },
    });

    const state = initialGraphState("preview-key", true);

    expect(state.graph.people.some((person) => person.id === "lin-lan")).toBe(true);
    expect(state.graph.connections.length).toBeGreaterThan(0);
  });

  it("removes Electron IPC prefixes and never exposes English-only failures", () => {
    expect(readableRelationshipStorageError(
      new Error("Error invoking remote method 'relationship-graph:open': Error: 系统安全存储不可用，请稍后重试"),
    )).toBe("系统安全存储不可用，请稍后重试");

    expect(readableRelationshipStorageError(new Error("Unexpected native failure"))).toBe(
      "暂时无法打开本机加密客户脉络图，请稍后重新尝试。",
    );
  });
});
