import type { UserRole } from "../types";

export function canAccessLoraDashboard(role: UserRole): boolean {
  return role === "boss";
}

export function visibleAppViews(role: UserRole): string[] {
  if (role === "admin") return ["admin"];
  if (role === "boss") return ["home", "boss", "lora-chain"];
  return ["home", "relations"];
}

export function roleAllowsAppView(role: UserRole, view: string): boolean {
  return visibleAppViews(role).includes(view);
}
