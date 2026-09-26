import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  CREDENTIAL_INDEX_FILE_NAME,
  CREDENTIAL_SECRET_FILE_NAME,
  CREDENTIAL_VAULT_BACKUP_FILE_NAME,
  CREDENTIAL_VAULT_FILE_NAME,
  MAX_CREDENTIAL_ACCOUNTS,
  atomicWritePrivateFileWithBackup,
  createCredentialVault,
} = require("../../electron/credential-vault.cjs") as {
  CREDENTIAL_INDEX_FILE_NAME: string;
  CREDENTIAL_SECRET_FILE_NAME: string;
  CREDENTIAL_VAULT_BACKUP_FILE_NAME: string;
  CREDENTIAL_VAULT_FILE_NAME: string;
  MAX_CREDENTIAL_ACCOUNTS: number;
  atomicWritePrivateFileWithBackup(
    target: string,
    content: Buffer,
  ): Promise<void>;
  createCredentialVault(options: {
    userDataPath: string;
    safeStorageAdapter?: unknown;
    allowPasswordStorage?: boolean;
    now?: () => Date;
  }): Vault;
};
const {
  createSafeStorageAdapter,
} = require("../../electron/safe-storage-adapter.cjs") as {
  createSafeStorageAdapter(
    safeStorage: Record<string, unknown>,
    options?: { platform: string },
  ): unknown;
};

interface Vault {
  list(): Promise<{
    state: "ready" | "unavailable";
    accounts: Array<{ email: string; lastUsedAt: string; passwordRemembered: boolean }>;
  }>;
  save(value: { email: string; password?: string; rememberPassword?: boolean }): Promise<{ saved: true; password: "stored" | "cleared" | "unavailable" }>;
  touch(email: string): Promise<boolean>;
  remove(email: string): Promise<boolean>;
  revealPassword(email: string): Promise<
    | { state: "ready"; password: string }
    | { state: "missing" }
    | { state: "unavailable"; reason: "locked" | "unreadable" }
  >;
}

const SECRET = "Fixture-Pass-9x!";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tongpin-credential-vault-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Reversible stand-in for an OS keystore key; `key` models Keychain/DPAPI rotation. */
function fakeCipher(key = "k1") {
  return {
    encrypt: (value: string) => Buffer.from(`${key}:${Buffer.from(value).toString("base64")}`),
    decrypt: (value: Buffer) => {
      const serialized = value.toString();
      if (!serialized.startsWith(`${key}:`)) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return Buffer.from(serialized.slice(key.length + 1), "base64").toString();
    },
  };
}

/** Electron >= 43 macOS/Windows shape: async API backed by Keychain or DPAPI. */
function asyncSafeStorage(key = "k1") {
  const cipher = fakeCipher(key);
  return {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async (value: string) => cipher.encrypt(value)),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({ result: cipher.decrypt(value), shouldReEncrypt: false })),
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => cipher.encrypt(value)),
    decryptString: vi.fn((value: Buffer) => cipher.decrypt(value)),
  };
}

async function vaultWith(safeStorage: Record<string, unknown>, platform = "darwin", allowPasswordStorage = true) {
  const directory = await temporaryDirectory();
  let tick = 0;
  const vault = createCredentialVault({
    userDataPath: directory,
    safeStorageAdapter: createSafeStorageAdapter(safeStorage, { platform }),
    allowPasswordStorage,
    now: () => new Date(Date.UTC(2026, 8, 26, 1, 0, tick++)),
  });
  return { directory, vault };
}

describe("account-only credential history", () => {
  it("stores only normalized account identifiers when the password is not opted in", async () => {
    const directory = await temporaryDirectory();
    const vault = createCredentialVault({
      userDataPath: directory,
      now: () => new Date("2026-08-27T01:02:03.000Z"),
    });

    await expect(vault.save({ email: " Boss@Example.com ", password: SECRET })).resolves.toEqual({ saved: true, password: "cleared" });

    const result = await vault.list();
    expect(result).toEqual({
      state: "ready",
      accounts: [
        {
          email: "boss@example.com",
          lastUsedAt: "2026-08-27T01:02:03.000Z",
          passwordRemembered: false,
        },
      ],
    });
    expect(result.accounts[0]).not.toHaveProperty("password");
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const index = await readFile(
      join(directory, CREDENTIAL_INDEX_FILE_NAME),
      "utf8",
    );
    expect(index).toContain("boss@example.com");
    expect(index).not.toContain("password");
    await expect(stat(join(directory, CREDENTIAL_SECRET_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves legacy encrypted password files without decrypting or returning them", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      join(directory, CREDENTIAL_INDEX_FILE_NAME),
      JSON.stringify({
        version: 1,
        accounts: [
          {
            email: "member@example.com",
            lastUsedAt: "2026-08-26T10:00:00.000Z",
          },
        ],
      }),
    );
    await writeFile(
      join(directory, CREDENTIAL_VAULT_FILE_NAME),
      "legacy-encrypted-passwords",
    );
    await writeFile(
      join(directory, CREDENTIAL_VAULT_BACKUP_FILE_NAME),
      "legacy-encrypted-passwords-backup",
    );
    const safeStorage = asyncSafeStorage();
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorageAdapter: createSafeStorageAdapter(safeStorage, { platform: "darwin" }),
      allowPasswordStorage: true,
    });

    await expect(vault.list()).resolves.toEqual({
      state: "ready",
      accounts: [
        {
          email: "member@example.com",
          lastUsedAt: "2026-08-26T10:00:00.000Z",
          passwordRemembered: false,
        },
      ],
    });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "missing" });
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });
    await vault.remove("member@example.com");
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
    expect(
      await readFile(join(directory, CREDENTIAL_VAULT_FILE_NAME), "utf8"),
    ).toBe("legacy-encrypted-passwords");
    expect(
      await readFile(
        join(directory, CREDENTIAL_VAULT_BACKUP_FILE_NAME),
        "utf8",
      ),
    ).toBe("legacy-encrypted-passwords-backup");
  });

  it("updates only an already remembered account and never recreates an opted-out account", async () => {
    const directory = await temporaryDirectory();
    let tick = 2;
    const vault = createCredentialVault({
      userDataPath: directory,
      now: () => new Date(`2026-08-27T01:02:0${tick++}.000Z`),
    });

    await expect(vault.touch("unknown@example.com")).resolves.toBe(false);
    await vault.save({ email: "member@example.com" });
    await expect(vault.touch("member@example.com")).resolves.toBe(true);
    await expect(vault.list()).resolves.toMatchObject({
      accounts: [
        {
          email: "member@example.com",
          lastUsedAt: "2026-08-27T01:02:03.000Z",
        },
      ],
    });
    await vault.remove("member@example.com");
    await expect(vault.touch("member@example.com")).resolves.toBe(false);
    await expect(vault.list()).resolves.toEqual({
      state: "ready",
      accounts: [],
    });
  });

  it("keeps the account index private on POSIX", async () => {
    const directory = await temporaryDirectory();
    const vault = createCredentialVault({ userDataPath: directory });
    await vault.save({ email: "member@example.com" });

    if (process.platform !== "win32") {
      expect(
        (await stat(join(directory, CREDENTIAL_INDEX_FILE_NAME))).mode & 0o777,
      ).toBe(0o600);
    }
  });

  it("backs up a private file before an atomic replacement", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "secure-session.bin");
    await writeFile(target, Buffer.from("old-session-ciphertext"));

    await atomicWritePrivateFileWithBackup(
      target,
      Buffer.from("new-session-ciphertext"),
    );

    expect(await readFile(target, "utf8")).toBe("new-session-ciphertext");
    expect(await readFile(`${target}.bak`, "utf8")).toBe(
      "old-session-ciphertext",
    );
  });
});

describe("opt-in remembered password", () => {
  it("encrypts the password with safeStorage only on explicit opt-in and never writes plaintext", async () => {
    const safeStorage = asyncSafeStorage();
    const { directory, vault } = await vaultWith(safeStorage);

    await expect(vault.save({ email: "Member@Example.com", password: SECRET, rememberPassword: true }))
      .resolves.toEqual({ saved: true, password: "stored" });

    const secretFile = await readFile(join(directory, CREDENTIAL_SECRET_FILE_NAME), "utf8");
    const index = await readFile(join(directory, CREDENTIAL_INDEX_FILE_NAME), "utf8");
    for (const content of [secretFile, index]) {
      expect(content).not.toContain(SECRET);
      expect(content).not.toContain(Buffer.from(SECRET).toString("base64"));
    }
    expect(JSON.parse(secretFile)).toMatchObject({ version: 1, entries: { "member@example.com": expect.any(String) } });
    if (process.platform !== "win32") {
      expect((await stat(join(directory, CREDENTIAL_SECRET_FILE_NAME))).mode & 0o777).toBe(0o600);
    }
    expect(safeStorage.encryptStringAsync).toHaveBeenCalledOnce();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("lists which accounts have a remembered password without decrypting anything", async () => {
    const safeStorage = asyncSafeStorage();
    const { vault } = await vaultWith(safeStorage);
    await vault.save({ email: "a@example.com", password: SECRET, rememberPassword: true });
    await vault.save({ email: "b@example.com" });

    const listed = await vault.list();
    expect(listed.accounts.map(({ email, passwordRemembered }) => [email, passwordRemembered])).toEqual([
      ["b@example.com", false],
      ["a@example.com", true],
    ]);
    expect(JSON.stringify(listed)).not.toContain(SECRET);
    expect(safeStorage.decryptStringAsync).not.toHaveBeenCalled();
  });

  it("returns the password only on an explicit reveal of a remembered account", async () => {
    const { vault } = await vaultWith(asyncSafeStorage());
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });

    await expect(vault.revealPassword(" MEMBER@example.com ")).resolves.toEqual({ state: "ready", password: SECRET });
    await expect(vault.revealPassword("other@example.com")).resolves.toEqual({ state: "missing" });
    await expect(vault.revealPassword("not-an-email")).resolves.toEqual({ state: "missing" });
  });

  it("deletes the password when the box is unchecked at login, on reset and on 移除", async () => {
    const { directory, vault } = await vaultWith(asyncSafeStorage());
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });

    // Unchecked "记住密码" at the next login: account kept, password deleted.
    await expect(vault.save({ email: "member@example.com", rememberPassword: false })).resolves.toEqual({ saved: true, password: "cleared" });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "missing" });
    expect((await vault.list()).accounts).toMatchObject([{ email: "member@example.com", passwordRemembered: false }]);
    await expect(stat(join(directory, CREDENTIAL_SECRET_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });

    // Reset-password flow saves the account without a password.
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });
    await vault.save({ email: "member@example.com" });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "missing" });

    // 移除 deletes the account and its password.
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });
    await vault.save({ email: "other@example.com", password: "Other-Pass-1", rememberPassword: true });
    await vault.remove("member@example.com");
    expect((await vault.list()).accounts.map((account) => account.email)).toEqual(["other@example.com"]);
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "missing" });
    const secretFile = JSON.parse(await readFile(join(directory, CREDENTIAL_SECRET_FILE_NAME), "utf8"));
    expect(Object.keys(secretFile.entries)).toEqual(["other@example.com"]);
  });

  it("keeps secrets only for the bounded remembered-account list", async () => {
    const { directory, vault } = await vaultWith(asyncSafeStorage());
    for (let index = 0; index <= MAX_CREDENTIAL_ACCOUNTS; index += 1) {
      await vault.save({ email: `member${index}@example.com`, password: `Pass-${index}`, rememberPassword: true });
    }
    const listed = await vault.list();
    expect(listed.accounts).toHaveLength(MAX_CREDENTIAL_ACCOUNTS);
    expect(listed.accounts.some((account) => account.email === "member0@example.com")).toBe(false);
    const secretFile = JSON.parse(await readFile(join(directory, CREDENTIAL_SECRET_FILE_NAME), "utf8"));
    expect(Object.keys(secretFile.entries)).toHaveLength(MAX_CREDENTIAL_ACCOUNTS);
    expect(secretFile.entries).not.toHaveProperty("member0@example.com");
  });

  it("never stores a password when the platform has no OS keystore or the value is invalid", async () => {
    const safeStorage = asyncSafeStorage();
    const linux = await vaultWith(safeStorage, "linux", false);
    await expect(linux.vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true }))
      .resolves.toEqual({ saved: true, password: "unavailable" });
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    await expect(stat(join(linux.directory, CREDENTIAL_SECRET_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });

    const { vault } = await vaultWith(asyncSafeStorage());
    for (const password of ["", "x".repeat(257), "a\0b"]) {
      await expect(vault.save({ email: "member@example.com", password, rememberPassword: true }))
        .resolves.toEqual({ saved: true, password: "unavailable" });
    }
    expect((await vault.list()).accounts).toMatchObject([{ email: "member@example.com", passwordRemembered: false }]);
  });
});

describe("remembered password under an unavailable or changed keystore", () => {
  it("macOS: a denied Keychain stores nothing, keeps the email and removes a stale password", async () => {
    const safeStorage = asyncSafeStorage();
    const { directory, vault } = await vaultWith(safeStorage, "darwin");
    await vault.save({ email: "member@example.com", password: "Old-Pass-1", rememberPassword: true });

    safeStorage.isAsyncEncryptionAvailable.mockResolvedValue(false);
    await expect(vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true }))
      .resolves.toEqual({ saved: true, password: "unavailable" });
    // No synchronous Keychain fallback on macOS (it can block the main thread).
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    expect(safeStorage.isEncryptionAvailable).not.toHaveBeenCalled();
    expect((await vault.list()).accounts).toMatchObject([{ email: "member@example.com", passwordRemembered: false }]);
    await expect(stat(join(directory, CREDENTIAL_SECRET_FILE_NAME))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("macOS: a locked Keychain on reveal keeps the ciphertext for a later retry", async () => {
    const safeStorage = asyncSafeStorage();
    const { vault } = await vaultWith(safeStorage, "darwin");
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });

    safeStorage.isAsyncEncryptionAvailable.mockRejectedValueOnce(new Error("Keychain temporarily unavailable"));
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "unavailable", reason: "locked" });
    expect((await vault.list()).accounts).toMatchObject([{ passwordRemembered: true }]);

    // After the user chooses "始终允许" the same ciphertext is readable again.
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "ready", password: SECRET });
  });

  it("drops only the unreadable secret after an update changed the key, keeping the account", async () => {
    const before = asyncSafeStorage("old-key");
    const directory = await temporaryDirectory();
    const first = createCredentialVault({
      userDataPath: directory,
      safeStorageAdapter: createSafeStorageAdapter(before, { platform: "darwin" }),
      allowPasswordStorage: true,
    });
    await first.save({ email: "member@example.com", password: SECRET, rememberPassword: true });
    await first.save({ email: "other@example.com", password: "Other-Pass-1", rememberPassword: true });

    const after = createCredentialVault({
      userDataPath: directory,
      safeStorageAdapter: createSafeStorageAdapter(asyncSafeStorage("new-key"), { platform: "darwin" }),
      allowPasswordStorage: true,
    });
    await expect(after.revealPassword("member@example.com")).resolves.toEqual({ state: "unavailable", reason: "unreadable" });
    const listed = await after.list();
    expect(listed.accounts.map(({ email, passwordRemembered }) => [email, passwordRemembered])).toEqual([
      ["other@example.com", true],
      ["member@example.com", false],
    ]);
    // Saving again with the new key works as usual.
    await expect(after.save({ email: "member@example.com", password: SECRET, rememberPassword: true })).resolves.toMatchObject({ password: "stored" });
    await expect(after.revealPassword("member@example.com")).resolves.toEqual({ state: "ready", password: SECRET });
  });

  it("rejects a ciphertext moved to another account instead of autofilling it", async () => {
    const { directory, vault } = await vaultWith(asyncSafeStorage());
    await vault.save({ email: "a@example.com", password: SECRET, rememberPassword: true });
    await vault.save({ email: "b@example.com" });
    const path = join(directory, CREDENTIAL_SECRET_FILE_NAME);
    const file = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ version: 1, entries: { ...file.entries, "b@example.com": file.entries["a@example.com"] } }));

    await expect(vault.revealPassword("b@example.com")).resolves.toEqual({ state: "unavailable", reason: "unreadable" });
    await expect(vault.revealPassword("a@example.com")).resolves.toEqual({ state: "ready", password: SECRET });
  });

  it("ignores a damaged secret file instead of failing sign-in", async () => {
    const { directory, vault } = await vaultWith(asyncSafeStorage());
    await vault.save({ email: "member@example.com" });
    await writeFile(join(directory, CREDENTIAL_SECRET_FILE_NAME), "{not json");
    await expect(vault.list()).resolves.toMatchObject({ state: "ready", accounts: [{ passwordRemembered: false }] });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "missing" });
    await expect(vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true })).resolves.toMatchObject({ password: "stored" });
  });
});

describe("Windows DPAPI-backed safeStorage", () => {
  it("still forgets the password when Windows briefly locks the secret file", async () => {
    const directory = await temporaryDirectory();
    const fsp = await import("node:fs/promises");
    const lockedUnlink = { ...fsp, unlink: vi.fn(async () => { throw Object.assign(new Error("locked"), { code: "EPERM" }); }) };
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorageAdapter: createSafeStorageAdapter(asyncSafeStorage("dpapi-user-key"), { platform: "win32" }),
      allowPasswordStorage: true,
      fileSystem: lockedUnlink,
    } as never);
    await vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true });
    await vault.save({ email: "member@example.com", rememberPassword: false });
    expect(lockedUnlink.unlink).toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(directory, CREDENTIAL_SECRET_FILE_NAME), "utf8"))).toEqual({ version: 1, entries: {} });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "missing" });
  });


  it("stores and reveals through the async DPAPI API", async () => {
    const dpapi = asyncSafeStorage("dpapi-user-key");
    const { vault } = await vaultWith(dpapi, "win32");
    await expect(vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true })).resolves.toMatchObject({ password: "stored" });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "ready", password: SECRET });
    expect(dpapi.encryptStringAsync).toHaveBeenCalledOnce();
  });

  it("falls back to the synchronous DPAPI API when async availability is false", async () => {
    const dpapi = asyncSafeStorage("dpapi-user-key");
    dpapi.isAsyncEncryptionAvailable.mockResolvedValue(false);
    const { vault } = await vaultWith(dpapi, "win32");
    await expect(vault.save({ email: "member@example.com", password: SECRET, rememberPassword: true })).resolves.toMatchObject({ password: "stored" });
    await expect(vault.revealPassword("member@example.com")).resolves.toEqual({ state: "ready", password: SECRET });
    expect(dpapi.encryptString).toHaveBeenCalledOnce();
    expect(dpapi.encryptStringAsync).not.toHaveBeenCalled();
  });

  it("drops a secret DPAPI can no longer decrypt (other Windows user or reset profile)", async () => {
    const directory = await temporaryDirectory();
    const first = createCredentialVault({
      userDataPath: directory,
      safeStorageAdapter: createSafeStorageAdapter(asyncSafeStorage("user-a"), { platform: "win32" }),
      allowPasswordStorage: true,
    });
    await first.save({ email: "member@example.com", password: SECRET, rememberPassword: true });
    const otherProfile = createCredentialVault({
      userDataPath: directory,
      safeStorageAdapter: createSafeStorageAdapter(asyncSafeStorage("user-b"), { platform: "win32" }),
      allowPasswordStorage: true,
    });
    await expect(otherProfile.revealPassword("member@example.com")).resolves.toEqual({ state: "unavailable", reason: "unreadable" });
    await expect(otherProfile.list()).resolves.toMatchObject({ accounts: [{ email: "member@example.com", passwordRemembered: false }] });
  });
});
