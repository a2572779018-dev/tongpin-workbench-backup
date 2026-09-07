import type { UserRole } from "../types";

export function canAccessLoraDashboard(role: UserRole): boolean {
  return role === "boss";
}

export function visibleAppViews(role: UserRole): string[] {
  if (role === "admin") return ["admin", "admin-ai"];
  if (role === "boss") return ["home", "boss", "lora-chain", "ai"];
  return ["home", "relations", "ai"];
}

export function roleAllowsAppView(role: UserRole, view: string): boolean {
  return visibleAppViews(role).includes(view);
}
