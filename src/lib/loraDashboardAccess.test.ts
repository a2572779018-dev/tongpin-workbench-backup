import { describe, expect, it } from "vitest";
import {
  canAccessLoraDashboard,
  roleAllowsAppView,
  visibleAppViews,
} from "./loraDashboardAccess";

describe("LORA dashboard client access", () => {
  it("shows the entry to the boss only", () => {
    expect(canAccessLoraDashboard("boss")).toBe(true);
    expect(canAccessLoraDashboard("admin")).toBe(false);
    expect(canAccessLoraDashboard("member")).toBe(false);
  });

  it("keeps the exact navigation order for every role", () => {
    expect(visibleAppViews("member")).toEqual(["home", "relations", "ai"]);
    expect(visibleAppViews("boss")).toEqual(["home", "boss", "member-graphs", "lora-chain", "ai"]);
    expect(visibleAppViews("admin")).toEqual(["admin", "admin-ai"]);
  });

  it("shows members' relationship graphs to the boss only (read-only view)", () => {
    expect(roleAllowsAppView("boss", "member-graphs")).toBe(true);
    expect(roleAllowsAppView("member", "member-graphs")).toBe(false);
    expect(roleAllowsAppView("admin", "member-graphs")).toBe(false);
  });

  it("allows the relationship map for members only", () => {
    expect(roleAllowsAppView("member", "relations")).toBe(true);
    expect(roleAllowsAppView("boss", "relations")).toBe(false);
    expect(roleAllowsAppView("admin", "relations")).toBe(false);
  });

  it("rejects a member-selected dashboard view", () => {
    expect(roleAllowsAppView("member", "lora-chain")).toBe(false);
    expect(roleAllowsAppView("boss", "lora-chain")).toBe(true);
    expect(roleAllowsAppView("admin", "lora-chain")).toBe(false);
  });

  it("keeps the AI workbench and quota console behind separate role gates", () => {
    expect(roleAllowsAppView("member", "ai")).toBe(true);
    expect(roleAllowsAppView("boss", "ai")).toBe(true);
    expect(roleAllowsAppView("admin", "ai")).toBe(false);

    expect(roleAllowsAppView("admin", "admin-ai")).toBe(true);
    expect(roleAllowsAppView("member", "admin-ai")).toBe(false);
    expect(roleAllowsAppView("boss", "admin-ai")).toBe(false);
  });
});
