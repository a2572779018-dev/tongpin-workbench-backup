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
import { afterEach, describe, expect, it } from "vitest";

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
    now?: () => Date;
  }): {
    list(): Promise<{
      state: "ready" | "unavailable";
      accounts: Array<{ email: string; lastUsedAt: string }>;
    }>;
    save(value: { email: string }): Promise<boolean>;
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

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "tongpin-credential-vault-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("account-only credential history", () => {
  it("stores only normalized account identifiers and never exposes a password field", async () => {
    const directory = await temporaryDirectory();
    const vault = createCredentialVault({
      userDataPath: directory,
      now: () => new Date("2026-08-27T01:02:03.000Z"),
    });

    await vault.save({ email: " Boss@Example.com " });

    const result = await vault.list();
    expect(result).toEqual({
      state: "ready",
      accounts: [
        {
          email: "boss@example.com",
          lastUsedAt: "2026-08-27T01:02:03.000Z",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("password");
    const index = await readFile(
      join(directory, CREDENTIAL_INDEX_FILE_NAME),
      "utf8",
    );
    expect(index).toContain("boss@example.com");
    expect(index).not.toContain("password");
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
    const vault = createCredentialVault({ userDataPath: directory });

    await expect(vault.list()).resolves.toEqual({
      state: "ready",
      accounts: [
        {
          email: "member@example.com",
          lastUsedAt: "2026-08-26T10:00:00.000Z",
        },
      ],
    });
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
