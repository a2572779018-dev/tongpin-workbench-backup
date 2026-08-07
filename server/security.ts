import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { AppConfig } from "./config";
import type { DatabaseShape, RefreshSession, User } from "./types";

export interface AccessClaims {
  sub: string;
  role: User["role"];
  type: "access";
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashOpaque(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function generateCode(): string {
  return String(randomInt(100_000, 1_000_000));
}

export function issueAccessToken(user: User, config: AppConfig): string {
  return jwt.sign(
    {
      sub: user.id,
      role: user.role,
      type: "access",
    } satisfies AccessClaims,
    config.jwtSecret,
    {
      algorithm: "HS256",
      expiresIn: "15m",
    },
  );
}

export function verifyAccessToken(
  token: string,
  config: AppConfig,
): AccessClaims {
  const claims = jwt.verify(token, config.jwtSecret, {
    algorithms: ["HS256"],
  }) as jwt.JwtPayload & AccessClaims;

  if (claims.type !== "access" || !claims.sub) {
    throw new Error("无效的访问令牌");
  }
  return claims;
}

export function issueRefreshSession(
  database: DatabaseShape,
  user: User,
  userAgent = "",
): string {
  const rawToken = randomBytes(48).toString("base64url");
  const now = new Date();
  const session: RefreshSession = {
    id: randomUUID(),
    userId: user.id,
    tokenHash: hashOpaque(rawToken),
    createdAt: now.toISOString(),
    lastUsedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    userAgent: userAgent.slice(0, 300),
  };

  database.refreshSessions.push(session);
  return rawToken;
}

export function removeExpiredSecurityRecords(database: DatabaseShape): void {
  const now = Date.now();
  database.refreshSessions = database.refreshSessions.filter(
    (session) => Date.parse(session.expiresAt) > now,
  );
  database.verificationCodes = database.verificationCodes.filter(
    (code) =>
      Date.parse(code.expiresAt) > now - 24 * 60 * 60 * 1000 &&
      (!code.consumedAt || Date.parse(code.consumedAt) > now - 24 * 60 * 60 * 1000),
  );
}
