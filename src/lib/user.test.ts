import { describe, expect, it } from "vitest";
import type { Session, User } from "../types";
import { normalizeSession, normalizeUser } from "./user";

function legacyUser(overrides: Partial<User> = {}): User {
  return {
    id: "legacy-user",
    email: "Legacy.User@Example.com",
    name: "  ",
    role: "admin",
    status: "active",
    jobTitle: undefined as unknown as string,
    avatarSeed: undefined as unknown as number,
    avatarVersion: undefined as unknown as number,
    hasCustomAvatar: undefined as unknown as boolean,
    emailVerifiedAt: null,
    lastLoginAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("normalizeUser", () => {
  it("fills profile fields missing from legacy accounts", () => {
    const result = normalizeUser(legacyUser());

    expect(result.email).toBe("legacy.user@example.com");
    expect(result.name).toBe("legacy.user");
    expect(result.jobTitle).toBe("");
    expect(result.avatarSeed).toBeGreaterThanOrEqual(0);
    expect(result.avatarSeed).toBeLessThan(6);
    expect(result.avatarVersion).toBe(0);
    expect(result.hasCustomAvatar).toBe(false);
  });

  it("normalizes the user attached to a persisted session", () => {
    const session: Session = {
      accessToken: "access",
      refreshToken: "refresh",
      user: legacyUser({ name: " 小秋 ", jobTitle: " 产品 " }),
    };

    expect(normalizeSession(session).user).toMatchObject({
      name: "小秋",
      jobTitle: "产品",
    });
  });
});

