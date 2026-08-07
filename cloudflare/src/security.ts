import type { UserRole } from "../../server/types";
import type { WorkerEnv } from "./platform";

const encoder = new TextEncoder();
// Cloudflare Workers Web Crypto currently rejects PBKDF2 iteration counts above
// 100,000. Keep the stored iteration count explicit so hashes remain versioned.
const PASSWORD_ITERATIONS = 100_000;
const MAX_PASSWORD_ITERATIONS = 100_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(
    normalized.length + ((4 - (normalized.length % 4)) % 4),
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

async function derivePassword(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const result = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    material,
    256,
  );
  return new Uint8Array(result);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const derived = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return [
    "pbkdf2_sha256",
    String(PASSWORD_ITERATIONS),
    bytesToBase64Url(salt),
    bytesToBase64Url(derived),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [algorithm, rawIterations, rawSalt, rawExpected] =
    storedHash.split("$");
  const parsedIterations = Number(rawIterations);
  const invalidFormat =
    algorithm !== "pbkdf2_sha256" ||
    !Number.isInteger(parsedIterations) ||
    parsedIterations < 100_000 ||
    parsedIterations > MAX_PASSWORD_ITERATIONS ||
    !rawSalt ||
    !rawExpected;
  try {
    const iterations = invalidFormat
      ? PASSWORD_ITERATIONS
      : parsedIterations;
    const salt = invalidFormat
      ? new Uint8Array(16)
      : base64UrlToBytes(rawSalt);
    const expected = invalidFormat
      ? new Uint8Array(32)
      : base64UrlToBytes(rawExpected);
    const actual = await derivePassword(password, salt, iterations);
    return !invalidFormat && constantTimeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function hashOpaque(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function randomToken(length = 48): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

export function randomAvatarSeed(): number {
  return crypto.getRandomValues(new Uint8Array(1))[0] % 6;
}

export function generateCode(): string {
  const range = 900_000;
  const maximum = Math.floor(0x1_0000_0000 / range) * range;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= maximum);
  return String(100_000 + (buffer[0] % range));
}

function jwtKey(env: WorkerEnv): Uint8Array {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET 必须至少 32 个字符");
  }
  return encoder.encode(env.JWT_SECRET);
}

function base64UrlJson(value: unknown): string {
  return bytesToBase64Url(encoder.encode(JSON.stringify(value)));
}

async function importJwtKey(
  env: WorkerEnv,
  usage: "sign" | "verify",
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    jwtKey(env),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function issueAccessToken(
  userId: string,
  role: UserRole,
  env: WorkerEnv,
): Promise<string> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: "HS256", typ: "JWT" });
  const payload = base64UrlJson({
    sub: userId,
    role,
    type: "access",
    iat: issuedAt,
    exp: issuedAt + 15 * 60,
  });
  const unsigned = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importJwtKey(env, "sign"),
    encoder.encode(unsigned),
  );
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyAccessToken(
  token: string,
  env: WorkerEnv,
): Promise<{ sub: string; role: UserRole }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const [rawHeader, rawPayload, rawSignature] = parts;
  const header = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(rawHeader)),
  ) as { alg?: unknown; typ?: unknown };
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw new Error("invalid token");
  }
  const validSignature = await crypto.subtle.verify(
    "HMAC",
    await importJwtKey(env, "verify"),
    base64UrlToBytes(rawSignature),
    encoder.encode(`${rawHeader}.${rawPayload}`),
  );
  if (!validSignature) throw new Error("invalid token");
  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlToBytes(rawPayload)),
  ) as {
    sub?: unknown;
    role?: unknown;
    type?: unknown;
    exp?: unknown;
    iat?: unknown;
  };
  if (
    payload.type !== "access" ||
    typeof payload.sub !== "string" ||
    !["member", "boss", "admin"].includes(String(payload.role)) ||
    typeof payload.exp !== "number" ||
    payload.exp <= Math.floor(Date.now() / 1000) ||
    typeof payload.iat !== "number"
  ) {
    throw new Error("invalid token");
  }
  return {
    sub: payload.sub,
    role: payload.role as UserRole,
  };
}
