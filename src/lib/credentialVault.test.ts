import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  CREDENTIAL_INDEX_FILE_NAME,
  CREDENTIAL_VAULT_BACKUP_FILE_NAME,
  CREDENTIAL_VAULT_FILE_NAME,
  atomicWritePrivateFileWithBackup,
  createCredentialVault,
} = require("../../electron/credential-vault.cjs") as {
  CREDENTIAL_INDEX_FILE_NAME: string;
  CREDENTIAL_VAULT_BACKUP_FILE_NAME: string;
  CREDENTIAL_VAULT_FILE_NAME: string;
  atomicWritePrivateFileWithBackup(
    target: string,
    content: Buffer,
  ): Promise<void>;
  createCredentialVault(options: {
    userDataPath: string;
    safeStorage: ReturnType<typeof fakeSafeStorage>;
    fileSystem?: {
      readFile(path: string, encoding?: string): Promise<Buffer | string>;
    };
    atomicWrite?: (path: string, content: Buffer | string) => Promise<void>;
    now?: () => Date;
  }): {
    list(): Promise<{
      state: "ready" | "unavailable";
      accounts: Array<{
        email: string;
        hasPassword: boolean;
        lastUsedAt: string;
      }>;
    }>;
    load(email: string): Promise<{
      email: string;
      password: string | null;
      rememberPassword: boolean;
    } | null>;
    save(value: {
      email: string;
      password: string;
      rememberPassword: boolean;
    }): Promise<boolean>;
    touch(email: string): Promise<boolean>;
    remove(email: string): Promise<boolean>;
  };
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`encv1:${Buffer.from(value).toString("base64")}`),
    decryptString: (value: Buffer) => {
      const serialized = value.toString();
      if (!serialized.startsWith("encv1:")) {
        throw new Error("ciphertext belongs to another OS user");
      }
      return Buffer.from(serialized.slice(6), "base64").toString();
    },
  };
}

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tongpin-credential-vault-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("credential vault", () => {
  it("keeps passwords encrypted while maintaining a password-free email index", async () => {
    const directory = await temporaryDirectory();
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
      now: () => new Date("2026-08-27T01:02:03.000Z"),
    });

    await expect(vault.list()).resolves.toEqual({
      state: "ready",
      accounts: [],
    });
    await vault.save({
      email: " Boss@Example.com ",
      password: "not-plaintext-on-disk",
      rememberPassword: true,
    });

    await expect(vault.list()).resolves.toEqual({
      state: "ready",
      accounts: [
        {
          email: "boss@example.com",
          hasPassword: true,
          lastUsedAt: "2026-08-27T01:02:03.000Z",
        },
      ],
    });
    await expect(vault.load("boss@example.com")).resolves.toEqual({
      email: "boss@example.com",
      password: "not-plaintext-on-disk",
      rememberPassword: true,
    });

    const encrypted = await readFile(
      join(directory, CREDENTIAL_VAULT_FILE_NAME),
      "utf8",
    );
    expect(encrypted).not.toContain("boss@example.com");
    expect(encrypted).not.toContain("not-plaintext-on-disk");
    const index = await readFile(
      join(directory, CREDENTIAL_INDEX_FILE_NAME),
      "utf8",
    );
    expect(index).toContain("boss@example.com");
    expect(index).not.toContain("not-plaintext-on-disk");
    expect(index).not.toContain("password");
  });

  it("backs up the previous ciphertext before an atomic replacement", async () => {
    const directory = await temporaryDirectory();
    let sequence = 0;
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
      now: () => new Date(`2026-08-27T01:02:0${sequence++}.000Z`),
    });
    await vault.save({
      email: "member@example.com",
      password: "first-password",
      rememberPassword: true,
    });
    const firstCiphertext = await readFile(
      join(directory, CREDENTIAL_VAULT_FILE_NAME),
    );
    await vault.save({
      email: "member@example.com",
      password: "second-password",
      rememberPassword: true,
    });

    expect(
      await readFile(join(directory, CREDENTIAL_VAULT_BACKUP_FILE_NAME)),
    ).toEqual(firstCiphertext);
    await expect(vault.load("member@example.com")).resolves.toMatchObject({
      password: "second-password",
    });
  });

  it("uses the non-secret index when ciphertext is unreadable and never overwrites it", async () => {
    const directory = await temporaryDirectory();
    const vaultPath = join(directory, CREDENTIAL_VAULT_FILE_NAME);
    const originalCiphertext = Buffer.from("dpapi-data-from-another-user");
    await writeFile(vaultPath, originalCiphertext);
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
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });

    await expect(vault.list()).resolves.toEqual({
      state: "unavailable",
      accounts: [
        {
          email: "member@example.com",
          hasPassword: false,
          lastUsedAt: "2026-08-26T10:00:00.000Z",
        },
      ],
    });
    await expect(vault.load("member@example.com")).resolves.toEqual({
      email: "member@example.com",
      password: null,
      rememberPassword: false,
    });
    await expect(
      vault.save({
        email: "new@example.com",
        password: "new-password",
        rememberPassword: true,
      }),
    ).rejects.toThrow("原加密文件已保留");
    await expect(vault.remove("member@example.com")).rejects.toThrow(
      "原加密文件已保留",
    );
    expect(await readFile(vaultPath)).toEqual(originalCiphertext);
    await expect(
      access(join(directory, CREDENTIAL_VAULT_BACKUP_FILE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats only ENOENT as an empty vault", async () => {
    const directory = await temporaryDirectory();
    const writes = vi.fn(async () => undefined);
    const fileSystem = {
      readFile: vi.fn(async (target: string) => {
        if (target.endsWith(CREDENTIAL_INDEX_FILE_NAME)) {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        const error = new Error("access denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }),
    };
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
      fileSystem,
      atomicWrite: writes,
    });

    await expect(vault.list()).resolves.toEqual({
      state: "unavailable",
      accounts: [],
    });
    await expect(
      vault.save({
        email: "member@example.com",
        password: "password",
        rememberPassword: true,
      }),
    ).rejects.toThrow("无法读取");
    expect(writes).not.toHaveBeenCalled();
  });

  it("never downgrades passwords to plaintext when safe storage is unavailable", async () => {
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
    const vault = createCredentialVault({
      userDataPath: directory,
      safeStorage: {
        ...fakeSafeStorage(),
        isEncryptionAvailable: () => false,
      },
    });

    await expect(vault.list()).resolves.toEqual({
      state: "unavailable",
      accounts: [
        {
          email: "member@example.com",
          hasPassword: false,
          lastUsedAt: "2026-08-26T10:00:00.000Z",
        },
      ],
    });
    await expect(
      vault.save({
        email: "member@example.com",
        password: "password",
        rememberPassword: true,
      }),
    ).rejects.toThrow("原加密登录记录已保留");
    await expect(
      access(join(directory, CREDENTIAL_VAULT_FILE_NAME)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("can preserve a previous encrypted session before replacing it", async () => {
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
