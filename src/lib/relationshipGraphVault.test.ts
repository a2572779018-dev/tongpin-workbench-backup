import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createRelationshipGraphVault,
  graphFileName,
  validateGraphDocument,
} = require("../../electron/relationship-graph-vault.cjs") as {
  createRelationshipGraphVault(options: {
    userDataPath: string;
    safeStorage: {
      isEncryptionAvailable(): boolean;
      encryptString(value: string): Buffer;
      decryptString(value: Buffer): string;
    };
  }): {
    load(userId: string): Promise<{
      content: string;
      revision: number;
      savedAt: string | null;
    } | null>;
    save(userId: string, content: string, revision: number): Promise<number>;
    flush(userId: string): Promise<void>;
  };
  graphFileName(userId: string): string;
  validateGraphDocument(content: string): { bytes: number; document: unknown };
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function graph(title: string): string {
  return JSON.stringify({
    schemaVersion: "1.0",
    title,
    people: [{ id: "self", name: "我", level: "self" }],
    connections: [],
  });
}

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value: Buffer) => {
      const encoded = value.toString().replace(/^encrypted:/, "");
      return Buffer.from(encoded, "base64").toString();
    },
  };
}

function asyncCompatibleSafeStorage() {
  const sync = fakeSafeStorage();
  return {
    isEncryptionAvailable: vi.fn(sync.isEncryptionAvailable),
    encryptString: vi.fn(sync.encryptString),
    decryptString: vi.fn(sync.decryptString),
    isAsyncEncryptionAvailable: vi.fn().mockResolvedValue(true),
    encryptStringAsync: vi.fn(async (value: string) =>
      sync.encryptString(value)),
    decryptStringAsync: vi.fn(async (value: Buffer) => ({
      result: sync.decryptString(value),
      shouldReEncrypt: false,
    })),
  };
}

describe("relationship graph encrypted vault", () => {
  it("stores each account in a hashed encrypted file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const vault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });

    await vault.save("member-a", graph("成员 A 私密关系图"), 1);
    expect((await vault.load("member-a"))?.content).toContain("成员 A 私密关系图");
    expect(await vault.load("member-b")).toBeNull();

    const stored = await readFile(
      join(directory, "relationship-graphs", graphFileName("member-a")),
      "utf8",
    );
    expect(stored).not.toContain("member-a");
    expect(stored).not.toContain("成员 A 私密关系图");
  });

  it("waits for an in-flight save before loading and never allows revision rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const vault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });

    const pending = vault.save("member-a", graph("刚刚编辑的内容"), 3);
    await expect(vault.load("member-a")).resolves.toMatchObject({
      content: graph("刚刚编辑的内容"),
      revision: 3,
    });
    await pending;
    await expect(vault.save("member-a", graph("旧页面内容"), 2))
      .rejects.toThrow("拒绝用旧版本覆盖较新的关系图");
    await expect(vault.load("member-a")).resolves.toMatchObject({
      content: graph("刚刚编辑的内容"),
      revision: 3,
    });
  });

  it("atomically replaces an existing graph and leaves no temporary files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const vault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });

    await vault.save("member-a", graph("第一版"), 1);
    await vault.save("member-a", graph("第二版"), 2);
    await vault.flush("member-a");

    await expect(vault.load("member-a")).resolves.toMatchObject({
      content: graph("第二版"),
      revision: 2,
    });
    const storedFiles = await readdir(join(directory, "relationship-graphs"));
    expect(storedFiles).toEqual([graphFileName("member-a")]);
  });

  it("loads a legacy sync-encrypted graph through the async provider without rewriting it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const legacyVault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });
    await legacyVault.save("member-a", graph("旧版加密客户图"), 1);
    const target = join(
      directory,
      "relationship-graphs",
      graphFileName("member-a"),
    );
    const originalCiphertext = await readFile(target);
    const safeStorage = asyncCompatibleSafeStorage();
    const asyncVault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage,
    });

    await expect(asyncVault.load("member-a")).resolves.toMatchObject({
      content: graph("旧版加密客户图"),
      revision: 1,
    });
    expect(safeStorage.decryptStringAsync).toHaveBeenCalledOnce();
    expect(safeStorage.encryptStringAsync).not.toHaveBeenCalled();
    expect(await readFile(target)).toEqual(originalCiphertext);
  });

  it("writes new graph revisions with the async provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const safeStorage = asyncCompatibleSafeStorage();
    const vault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage,
    });

    await vault.save("member-a", graph("异步加密客户图"), 1);

    expect(safeStorage.encryptStringAsync).toHaveBeenCalledOnce();
    expect(safeStorage.encryptString).not.toHaveBeenCalled();
    await expect(vault.load("member-a")).resolves.toMatchObject({
      content: graph("异步加密客户图"),
      revision: 1,
    });
  });

  it("reports safeStorage decryption failures without calling the graph damaged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const legacyVault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage: fakeSafeStorage(),
    });
    await legacyVault.save("member-a", graph("原加密客户图"), 1);
    const safeStorage = asyncCompatibleSafeStorage();
    safeStorage.decryptStringAsync.mockRejectedValue(
      new Error("Keychain denied access"),
    );
    const vault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage,
    });

    await expect(vault.load("member-a")).rejects.toThrow(
      "系统安全存储无法解密本机客户脉络图，原加密文件已保留",
    );
  });

  it("rejects invalid and oversized graph structures before writing", () => {
    expect(() => validateGraphDocument("{}"))
      .toThrow("关系图内容不符合安全存储格式");
    expect(() =>
      validateGraphDocument(
        JSON.stringify({
          schemaVersion: "1.0",
          people: new Array(5_001).fill({}),
          connections: [],
        }),
      ),
    ).toThrow("关系图内容不符合安全存储格式");
  });

  it("never falls back to plaintext when system encryption is unavailable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tongpin-graph-vault-"));
    temporaryDirectories.push(directory);
    const vault = createRelationshipGraphVault({
      userDataPath: directory,
      safeStorage: {
        ...fakeSafeStorage(),
        isEncryptionAvailable: () => false,
      },
    });

    await expect(vault.save("member-a", graph("私密数据"), 1))
      .rejects.toThrow("拒绝明文保存关系图");
  });
});
