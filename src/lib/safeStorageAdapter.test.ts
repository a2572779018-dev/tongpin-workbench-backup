import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createSafeStorageAdapter,
} = require("../../electron/safe-storage-adapter.cjs") as {
  createSafeStorageAdapter(
    safeStorage: Record<string, unknown>,
    options?: { platform: string },
  ): {
    mode: "async" | "sync";
    decryptString(encrypted: Buffer): Promise<{
      result: string;
      shouldReEncrypt: boolean;
      mode: "async" | "sync";
    }>;
    encryptString(plainText: string): Promise<Buffer>;
    ensureAvailable(): Promise<"async" | "sync">;
  };
};

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

describe("safeStorage async compatibility adapter", () => {
  it("decrypts legacy sync ciphertext through the async API without rewriting it", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    const adapter = createSafeStorageAdapter(safeStorage);
    const legacyCiphertext = safeStorage.encryptString("legacy-session");
    safeStorage.encryptString.mockClear();

    await expect(adapter.decryptString(legacyCiphertext)).resolves.toEqual({
      result: "legacy-session",
      shouldReEncrypt: false,
      mode: "async",
    });
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledWith(
      legacyCiphertext,
    );
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("writes async ciphertext that remains readable by the sync-compatible codec", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    const adapter = createSafeStorageAdapter(safeStorage);

    const encrypted = await adapter.encryptString("new-secure-value");

    expect(decryptCompat(encrypted)).toBe("new-secure-value");
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledOnce();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("honors shouldReEncrypt without modifying the old ciphertext", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.decryptStringAsync.mockResolvedValue({
      result: "rotated-key-value",
      shouldReEncrypt: true,
    });
    const adapter = createSafeStorageAdapter(safeStorage);
    const oldCiphertext = encryptCompat("rotated-key-value");
    const originalCopy = Buffer.from(oldCiphertext);

    await expect(adapter.decryptString(oldCiphertext)).resolves.toMatchObject({
      result: "rotated-key-value",
      shouldReEncrypt: true,
    });
    expect(oldCiphertext).toEqual(originalCopy);
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("falls back to the synchronous API only when the async API is absent", async () => {
    const safeStorage = {
      isEncryptionAvailable: vi.fn(() => true),
      encryptString: vi.fn((value: string) => encryptCompat(value)),
      decryptString: vi.fn((value: Buffer) => decryptCompat(value)),
    };
    const adapter = createSafeStorageAdapter(safeStorage, { platform: "darwin" });

    expect(adapter.mode).toBe("sync");
    const encrypted = await adapter.encryptString("sync-fallback");
    await expect(adapter.decryptString(encrypted)).resolves.toMatchObject({
      result: "sync-fallback",
      mode: "sync",
    });
  });

  it("preserves Windows sync fallback when async availability is false", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    const adapter = createSafeStorageAdapter(safeStorage, { platform: "win32" });

    const encrypted = await adapter.encryptString("sync-recovery");
    await expect(adapter.decryptString(encrypted)).resolves.toMatchObject({
      result: "sync-recovery",
      mode: "sync",
    });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).toHaveBeenCalledOnce();
  });

  it("preserves Windows sync fallback when async availability probing throws", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.isAsyncEncryptionAvailable.mockRejectedValue(
      new Error("async provider is temporarily unavailable"),
    );
    const adapter = createSafeStorageAdapter(safeStorage, { platform: "win32" });

    await expect(adapter.encryptString("sync-recovery")).resolves.toEqual(
      encryptCompat("sync-recovery"),
    );
    expect(safeStorage.encryptString).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "temporarily unavailable"])(
    "never probes or invokes synchronous Keychain APIs on Mac after async %s",
    async (failure) => {
      const safeStorage = asyncCompatibleSafeStorage();
      if (failure === "unavailable") {
        safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
      } else {
        safeStorage.isAsyncEncryptionAvailable.mockRejectedValue(
          new Error("async provider is temporarily unavailable"),
        );
      }
      const adapter = createSafeStorageAdapter(safeStorage, { platform: "darwin" });
      const expectedCode = failure === "unavailable"
        ? "SAFE_STORAGE_UNAVAILABLE"
        : "SAFE_STORAGE_TEMPORARILY_UNAVAILABLE";
      const ciphertext = encryptCompat("original-encrypted-data");
      const original = Buffer.from(ciphertext);

      await expect(adapter.ensureAvailable()).rejects.toMatchObject({ code: expectedCode });
      await expect(adapter.encryptString("must-not-save")).rejects.toMatchObject({ code: expectedCode });
      await expect(adapter.decryptString(ciphertext)).rejects.toMatchObject({ code: expectedCode });
      expect(ciphertext).toEqual(original);
      expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
      expect(safeStorage.encryptString).not.toHaveBeenCalled();
      expect(safeStorage.decryptString).not.toHaveBeenCalled();
      expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
      expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    },
  );

  it("rejects without plaintext downgrade when both providers are unavailable", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const adapter = createSafeStorageAdapter(safeStorage);

    await expect(adapter.encryptString("must-stay-encrypted")).rejects.toMatchObject({
      code: "SAFE_STORAGE_UNAVAILABLE",
    });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("keeps temporary keychain failures distinct and retryable", async () => {
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.decryptStringAsync.mockRejectedValue(
      new Error(
        "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.",
      ),
    );
    const adapter = createSafeStorageAdapter(safeStorage);

    await expect(
      adapter.decryptString(encryptCompat("retry-later")),
    ).rejects.toMatchObject({
      code: "SAFE_STORAGE_TEMPORARILY_UNAVAILABLE",
      message: "系统安全存储暂时不可用，请稍后重新尝试",
    });
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });
});
