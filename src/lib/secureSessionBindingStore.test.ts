import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  RELATIONSHIP_BINDING_FILE_NAME,
  SECURE_SESSION_FILE_NAME,
  createRelationshipBindingStore,
  createSecureSessionStore,
  persistSecureSessionWithMemoryFallback,
} = require("../../electron/secure-session-binding-store.cjs") as {
  RELATIONSHIP_BINDING_FILE_NAME: string;
  SECURE_SESSION_FILE_NAME: string;
  createSecureSessionStore(options: {
    userDataPath: string;
    safeStorage: ReturnType<typeof asyncCompatibleSafeStorage>;
  }): {
    read(): Promise<{ payload: string; session: Record<string, unknown> } | null>;
    write(payload: string): Promise<boolean>;
  };
  createRelationshipBindingStore(options: {
    userDataPath: string;
    safeStorage: ReturnType<typeof asyncCompatibleSafeStorage>;
    now?: () => Date;
  }): {
    read(): Promise<{
      userId: string;
      sessionFingerprint: string;
      verifiedAt: string;
    } | null>;
    write(binding: { userId: string; fingerprint: string }): Promise<boolean>;
  };
  persistSecureSessionWithMemoryFallback(options: {
    secureSessionStore: { write(payload: string): Promise<boolean> };
    payload: string;
    writeMemoryOnlyMarker(): Promise<void>;
    clearMemoryOnlyMarker(): Promise<void>;
  }): Promise<{ mode: "encrypted" | "memory-only"; errorCode: string | null }>;
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function encryptCompat(value: string): Buffer {
  return Buffer.from(`v10:${Buffer.from(value).toString("base64")}`);
}

function decryptCompat(value: Buffer): string {
  const serialized = value.toString();
  if (!serialized.startsWith("v10:")) throw new Error("invalid ciphertext");
  return Buffer.from(serialized.slice(4), "base64").toString();
}

function asyncCompatibleSafeStorage() {
  return {
    isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
    encryptStringAsync: vi.fn(async (value: string) => encryptCompat(value)),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({
      result: decryptCompat(value),
      shouldReEncrypt: false,
    })),
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => encryptCompat(value)),
    decryptString: vi.fn((value: Buffer) => decryptCompat(value)),
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tongpin-secure-store-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("secure session and relationship binding stores", () => {
  it("reads an old sync-encrypted session through async without rewriting it", async () => {
    const directory = await temporaryDirectory();
    const safeStorage = asyncCompatibleSafeStorage();
    const payload = JSON.stringify({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      user: { id: "member-a", role: "member" },
    });
    const originalCiphertext = encryptCompat(payload);
    const target = join(directory, SECURE_SESSION_FILE_NAME);
    await writeFile(target, originalCiphertext);
    const store = createSecureSessionStore({
      userDataPath: directory,
      safeStorage,
    });

    await expect(store.read()).resolves.toMatchObject({
      payload,
      session: { user: { id: "member-a", role: "member" } },
    });
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledOnce();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(originalCiphertext);
  });

  it("writes new sessions asynchronously while preserving the previous ciphertext backup", async () => {
    const directory = await temporaryDirectory();
    const safeStorage = asyncCompatibleSafeStorage();
    const target = join(directory, SECURE_SESSION_FILE_NAME);
    const oldCiphertext = encryptCompat(JSON.stringify({ old: true }));
    await writeFile(target, oldCiphertext);
    const store = createSecureSessionStore({
      userDataPath: directory,
      safeStorage,
    });
    const payload = JSON.stringify({ user: { id: "member-b" } });

    await store.write(payload);

    expect(decryptCompat(await readFile(target))).toBe(payload);
    expect(await readFile(`${target}.bak`)).toEqual(oldCiphertext);
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledOnce();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("reads an old sync-encrypted member binding and only writes after verification", async () => {
    const directory = await temporaryDirectory();
    const safeStorage = asyncCompatibleSafeStorage();
    const originalBinding = {
      version: 1,
      userId: "member-a",
      role: "member",
      sessionFingerprint: "old-fingerprint",
      verifiedAt: "2026-08-29T01:00:00.000Z",
    };
    const target = join(directory, RELATIONSHIP_BINDING_FILE_NAME);
    const originalCiphertext = encryptCompat(JSON.stringify(originalBinding));
    await writeFile(target, originalCiphertext);
    const store = createRelationshipBindingStore({
      userDataPath: directory,
      safeStorage,
      now: () => new Date("2026-08-31T02:00:00.000Z"),
    });

    await expect(store.read()).resolves.toMatchObject(originalBinding);
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(originalCiphertext);

    await store.write({
      userId: "member-a",
      fingerprint: "verified-fingerprint",
    });
    expect(
      JSON.parse(decryptCompat(await readFile(target))),
    ).toMatchObject({
      version: 1,
      userId: "member-a",
      role: "member",
      sessionFingerprint: "verified-fingerprint",
      verifiedAt: "2026-08-31T02:00:00.000Z",
    });
  });

  it("rejects both secure paths without writing when all providers are unavailable", async () => {
    const directory = await temporaryDirectory();
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const sessionStore = createSecureSessionStore({
      userDataPath: directory,
      safeStorage,
    });
    const bindingStore = createRelationshipBindingStore({
      userDataPath: directory,
      safeStorage,
    });

    await expect(
      sessionStore.write(JSON.stringify({ user: { id: "member-a" } })),
    ).rejects.toMatchObject({ code: "SAFE_STORAGE_UNAVAILABLE" });
    await expect(
      bindingStore.write({ userId: "member-a", fingerprint: "fingerprint" }),
    ).rejects.toMatchObject({ code: "SAFE_STORAGE_UNAVAILABLE" });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("keeps a successful login in memory after any safeStorage write failure", async () => {
    const writeMemoryOnlyMarker = vi.fn().mockResolvedValue(undefined);
    const clearMemoryOnlyMarker = vi.fn().mockResolvedValue(undefined);
    const secureSessionStore = {
      write: vi.fn().mockRejectedValue(
        Object.assign(new Error("系统安全存储加密失败"), {
          code: "SAFE_STORAGE_ENCRYPT_FAILED",
        }),
      ),
    };

    await expect(
      persistSecureSessionWithMemoryFallback({
        secureSessionStore,
        payload: JSON.stringify({ user: { id: "member-a" } }),
        writeMemoryOnlyMarker,
        clearMemoryOnlyMarker,
      }),
    ).resolves.toEqual({
      mode: "memory-only",
      errorCode: "SAFE_STORAGE_ENCRYPT_FAILED",
    });
    expect(writeMemoryOnlyMarker).toHaveBeenCalledOnce();
    expect(clearMemoryOnlyMarker).not.toHaveBeenCalled();
  });
});
