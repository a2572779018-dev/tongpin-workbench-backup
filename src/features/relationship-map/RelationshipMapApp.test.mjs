import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initialGraphState,
  readableRelationshipStorageError,
  relationshipStorageRecoveryHint,
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

  it("offers Mac restart guidance only for a temporary system-storage failure", () => {
    const error = new Error(
      "Error invoking remote method 'relationship-graph:open': Error: 系统安全存储暂时不可用，请稍后重新尝试",
    );
    expect(relationshipStorageRecoveryHint(error, "darwin")).toBe(
      "若系统弹出同频的钥匙串访问提示，请确认后允许访问；随后完整退出并重新打开同频。",
    );
    expect(relationshipStorageRecoveryHint(error, "win32")).toBe("");
    expect(relationshipStorageRecoveryHint(error, "linux")).toBe("");
    expect(relationshipStorageRecoveryHint(error, undefined)).toBe("");
  });

  it.each([
    "请先登录后再打开客户脉络图",
    "无法连接服务器",
    "系统安全存储无法解密本机客户脉络图，原加密文件已保留",
    "本机加密客户脉络图内容损坏",
    "Unexpected native failure",
    "",
  ])("does not attribute unrelated errors to Keychain: %s", (error) => {
    expect(relationshipStorageRecoveryHint(error, "darwin")).toBe("");
  });
});
