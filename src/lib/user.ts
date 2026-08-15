import type { Session, User } from "../types";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function avatarSeedFor(value: string): number {
  return Array.from(value).reduce(
    (total, character) => (total + character.charCodeAt(0)) % 6,
    0,
  );
}

/**
 * Production still contains accounts created before profile fields were added.
 * Keep those records usable at the renderer boundary instead of letting one
 * missing optional field crash an entire role-specific page.
 */
export function normalizeUser(user: User): User {
  const id = text(user?.id);
  const email = text(user?.email).toLowerCase();
  const name =
    text(user?.name) || text(email.split("@")[0]) || "同频成员";
  const seedSource = id || email || name;

  return {
    ...user,
    id,
    email,
    name,
    jobTitle: text(user?.jobTitle),
    avatarSeed: nonNegativeInteger(
      user?.avatarSeed,
      avatarSeedFor(seedSource),
    ),
    avatarVersion: nonNegativeInteger(user?.avatarVersion),
    hasCustomAvatar: user?.hasCustomAvatar === true,
  };
}

export function normalizeSession(session: Session): Session {
  return {
    ...session,
    user: normalizeUser(session.user),
  };
}

