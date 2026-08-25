import { describe, expect, it } from "vitest";
import {
  canAccessLoraDashboard,
  roleAllowsAppView,
  visibleAppViews,
} from "./loraDashboardAccess";

describe("LORA dashboard client access", () => {
  it("shows the entry to boss and admin only", () => {
    expect(canAccessLoraDashboard("boss")).toBe(true);
    expect(canAccessLoraDashboard("admin")).toBe(true);
    expect(canAccessLoraDashboard("member")).toBe(false);
    expect(visibleAppViews("member")).toEqual(["home", "relations"]);
  });

  it("allows the relationship map for members only", () => {
    expect(roleAllowsAppView("member", "relations")).toBe(true);
    expect(roleAllowsAppView("boss", "relations")).toBe(false);
    expect(roleAllowsAppView("admin", "relations")).toBe(false);
  });

  it("rejects a member-selected dashboard view", () => {
    expect(roleAllowsAppView("member", "lora-chain")).toBe(false);
    expect(roleAllowsAppView("boss", "lora-chain")).toBe(true);
    expect(roleAllowsAppView("admin", "lora-chain")).toBe(true);
  });
});
