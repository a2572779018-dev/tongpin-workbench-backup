import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { matchesAccountFilter } from "./AdminConsole";

describe("账号与权限", () => {
  it("counts each filter chip with the same rule that picks its rows", () => {
    const users = [
      { status: "active" as const }, { status: "active" as const }, { status: "pending_approval" as const },
      { status: "disabled" as const }, { status: "pending_email" as const },
    ];
    expect(users.filter(user => matchesAccountFilter(user, "all"))).toHaveLength(5);
    expect(users.filter(user => matchesAccountFilter(user, "pending"))).toHaveLength(1);
    expect(users.filter(user => matchesAccountFilter(user, "active"))).toHaveLength(2);
    expect(users.filter(user => matchesAccountFilter(user, "disabled"))).toHaveLength(1);
  });

  it("changes a role or locks an account out only after a second, explicit confirmation", () => {
    const source = readFileSync(new URL("./AdminConsole.tsx", import.meta.url), "utf8");
    // Picking a role in the list only stages it; the request is sent from 确认修改.
    const select = source.slice(source.indexOf("<select"), source.indexOf("</select>"));
    expect(select).not.toContain("changeRole(");
    expect(source).toContain("onClick={() => void changeRole(user, pendingRoles[user.id])}>确认修改</button>");
    expect(source).toContain('confirmingBlock === user.id ? void changeAccess(user, "disabled") : setConfirmingBlock(user.id)');
    // Each row is busy on its own.
    expect(source).not.toMatch(/\bworkingId\b|setWorkingId\(/);
    expect(source).toContain("disabled={working(user.id)}");
    // The decorative banner is gone.
    expect(source).not.toMatch(/admin-hero|准入要严格/);
  });
});
