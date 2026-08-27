const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  atomicWritePrivateFile,
} = require("./relationship-graph-vault.cjs");

const CREDENTIAL_VAULT_FILE_NAME = "secure-accounts.bin";
const CREDENTIAL_VAULT_BACKUP_FILE_NAME = "secure-accounts.bin.bak";
const CREDENTIAL_INDEX_FILE_NAME = "remembered-accounts.json";
const CREDENTIAL_INDEX_VERSION = 1;
const MAX_CREDENTIAL_ACCOUNTS = 20;
const MAX_CREDENTIAL_PAYLOAD_LENGTH = 100_000;

class CredentialVaultError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CredentialVaultError";
    this.code = code;
  }
}

function normalizeCredentialEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeLastUsedAt(value) {
  return typeof value === "string" ? value : "";
}

function isCredentialEmail(value) {
  return normalizeCredentialEmail(value).includes("@");
}

function sortAndLimitAccounts(accounts) {
  return accounts
    .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
    .slice(0, MAX_CREDENTIAL_ACCOUNTS);
}

function normalizeEncryptedAccounts(value) {
  if (!Array.isArray(value)) {
    throw new CredentialVaultError(
      "CREDENTIAL_VAULT_INVALID",
      "本机登录记录无法读取，原加密文件已保留",
    );
  }
  const accounts = [];
  const seen = new Set();
  for (const entry of value) {
    const email = normalizeCredentialEmail(entry?.email);
    if (!isCredentialEmail(email) || seen.has(email)) continue;
    seen.add(email);
    accounts.push({
      email,
      password: typeof entry?.password === "string" ? entry.password : null,
      rememberPassword: entry?.rememberPassword !== false,
      lastUsedAt: normalizeLastUsedAt(entry?.lastUsedAt),
    });
  }
  return sortAndLimitAccounts(accounts);
}

function normalizeEmailIndex(value) {
  if (
    !value ||
    Array.isArray(value) ||
    value.version !== CREDENTIAL_INDEX_VERSION ||
    !Array.isArray(value.accounts)
  ) {
    return [];
  }
  const accounts = [];
  const seen = new Set();
  for (const entry of value.accounts) {
    const email = normalizeCredentialEmail(entry?.email);
    if (!isCredentialEmail(email) || seen.has(email)) continue;
    seen.add(email);
    accounts.push({
      email,
      lastUsedAt: normalizeLastUsedAt(entry?.lastUsedAt),
    });
  }
  return sortAndLimitAccounts(accounts);
}

function mergeEmailIndex(primary, fallback = []) {
  const merged = [];
  const seen = new Set();
  for (const entry of [...primary, ...fallback]) {
    const email = normalizeCredentialEmail(entry?.email);
    if (!isCredentialEmail(email) || seen.has(email)) continue;
    seen.add(email);
    merged.push({
      email,
      lastUsedAt: normalizeLastUsedAt(entry?.lastUsedAt),
    });
  }
  return sortAndLimitAccounts(merged);
}

async function atomicWritePrivateFileWithBackup(
  target,
  content,
  {
    fileSystem = fsp,
    atomicWrite = atomicWritePrivateFile,
    backupPath = `${target}.bak`,
  } = {},
) {
  let existing = null;
  try {
    existing = await fileSystem.readFile(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing !== null) {
    await atomicWrite(backupPath, existing);
  }
  await atomicWrite(target, content);
}

function createCredentialVault({
  userDataPath,
  safeStorage,
  fileSystem = fsp,
  atomicWrite = atomicWritePrivateFile,
  now = () => new Date(),
}) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new Error("登录记录存储目录无效");
  }
  const vaultPath = path.join(userDataPath, CREDENTIAL_VAULT_FILE_NAME);
  const backupPath = path.join(
    userDataPath,
    CREDENTIAL_VAULT_BACKUP_FILE_NAME,
  );
  const indexPath = path.join(userDataPath, CREDENTIAL_INDEX_FILE_NAME);
  let mutationQueue = Promise.resolve();

  function assertEncryptionAvailable() {
    if (!safeStorage?.isEncryptionAvailable?.()) {
      throw new CredentialVaultError(
        "CREDENTIAL_VAULT_UNAVAILABLE",
        "系统安全存储暂时不可用，原加密登录记录已保留",
      );
    }
  }

  async function waitForMutations() {
    try {
      await mutationQueue;
    } catch {
      // A failed mutation never blocks later read-only recovery attempts.
    }
  }

  function mutate(operation) {
    const pending = mutationQueue.catch(() => undefined).then(operation);
    mutationQueue = pending;
    return pending;
  }

  async function readEmailIndex() {
    try {
      return normalizeEmailIndex(
        JSON.parse(await fileSystem.readFile(indexPath, "utf8")),
      );
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      return [];
    }
  }

  async function writeEmailIndex(accounts) {
    const payload = JSON.stringify({
      version: CREDENTIAL_INDEX_VERSION,
      accounts: mergeEmailIndex(accounts),
    });
    await atomicWrite(indexPath, payload);
  }

  async function readEncryptedVault() {
    assertEncryptionAvailable();
    let encrypted;
    try {
      encrypted = await fileSystem.readFile(vaultPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return { state: "missing", accounts: [] };
      }
      throw new CredentialVaultError(
        "CREDENTIAL_VAULT_READ_FAILED",
        "本机登录记录无法读取，原加密文件已保留",
        error,
      );
    }
    try {
      const decrypted = safeStorage.decryptString(encrypted);
      return {
        state: "ready",
        accounts: normalizeEncryptedAccounts(JSON.parse(decrypted)),
      };
    } catch (error) {
      if (error instanceof CredentialVaultError) throw error;
      throw new CredentialVaultError(
        "CREDENTIAL_VAULT_UNREADABLE",
        "本机登录记录无法解密或已损坏，原加密文件已保留",
        error,
      );
    }
  }

  async function writeEncryptedAccounts(accounts) {
    assertEncryptionAvailable();
    const payload = JSON.stringify(
      normalizeEncryptedAccounts(accounts).slice(0, MAX_CREDENTIAL_ACCOUNTS),
    );
    if (payload.length > MAX_CREDENTIAL_PAYLOAD_LENGTH) {
      throw new Error("记住的账号数量过多");
    }
    const encrypted = safeStorage.encryptString(payload);
    await atomicWritePrivateFileWithBackup(vaultPath, encrypted, {
      fileSystem,
      atomicWrite,
      backupPath,
    });
  }

  async function list() {
    await waitForMutations();
    const index = await readEmailIndex();
    try {
      const stored = await readEncryptedVault();
      if (stored.state === "missing") {
        return {
          state: "ready",
          accounts: index.map((account) => ({
            ...account,
            hasPassword: false,
          })),
        };
      }
      const indexed = mergeEmailIndex(stored.accounts, index);
      try {
        await writeEmailIndex(indexed);
      } catch {
        // A non-secret index failure must not hide decryptable credentials.
      }
      const encryptedByEmail = new Map(
        stored.accounts.map((account) => [account.email, account]),
      );
      return {
        state: "ready",
        accounts: indexed.map((entry) => {
          const account = encryptedByEmail.get(entry.email);
          return {
            email: entry.email,
            hasPassword: Boolean(
              account?.rememberPassword &&
                typeof account.password === "string",
            ),
            lastUsedAt: entry.lastUsedAt,
          };
        }),
      };
    } catch (error) {
      if (!(error instanceof CredentialVaultError)) throw error;
      return {
        state: "unavailable",
        accounts: index.map((account) => ({
          ...account,
          hasPassword: false,
        })),
      };
    }
  }

  async function load(emailValue) {
    await waitForMutations();
    const email = normalizeCredentialEmail(emailValue);
    if (!isCredentialEmail(email)) return null;
    const index = await readEmailIndex();
    const indexed = index.find((account) => account.email === email);
    try {
      const stored = await readEncryptedVault();
      const account = stored.accounts.find((entry) => entry.email === email);
      if (account) {
        return {
          email: account.email,
          password:
            account.rememberPassword && typeof account.password === "string"
              ? account.password
              : null,
          rememberPassword: account.rememberPassword,
        };
      }
      return indexed
        ? { email, password: null, rememberPassword: false }
        : null;
    } catch (error) {
      if (!(error instanceof CredentialVaultError) || !indexed) throw error;
      return { email, password: null, rememberPassword: false };
    }
  }

  function save(value) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(value?.email);
      const password = typeof value?.password === "string" ? value.password : "";
      const rememberPassword = value?.rememberPassword !== false;
      if (
        !isCredentialEmail(email) ||
        password.length < 1 ||
        password.length > 512
      ) {
        throw new Error("无效的登录账号");
      }
      const stored = await readEncryptedVault();
      const timestamp = now().toISOString();
      const next = [
        {
          email,
          password: rememberPassword ? password : null,
          rememberPassword,
          lastUsedAt: timestamp,
        },
        ...stored.accounts.filter((account) => account.email !== email),
      ];
      const index = await readEmailIndex();
      await writeEncryptedAccounts(next);
      await writeEmailIndex(mergeEmailIndex(next, index));
      return true;
    });
  }

  function touch(emailValue) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(emailValue);
      if (!isCredentialEmail(email)) return false;
      const stored = await readEncryptedVault();
      const existing = stored.accounts.find((account) => account.email === email);
      const next = [
        {
          email,
          password: existing?.password ?? null,
          rememberPassword: existing?.rememberPassword ?? false,
          lastUsedAt: now().toISOString(),
        },
        ...stored.accounts.filter((account) => account.email !== email),
      ];
      const index = await readEmailIndex();
      await writeEncryptedAccounts(next);
      await writeEmailIndex(mergeEmailIndex(next, index));
      return true;
    });
  }

  function remove(emailValue) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(emailValue);
      if (!isCredentialEmail(email)) return false;
      const stored = await readEncryptedVault();
      const index = await readEmailIndex();
      if (stored.state === "ready") {
        await writeEncryptedAccounts(
          stored.accounts.filter((account) => account.email !== email),
        );
      }
      await writeEmailIndex(
        index.filter((account) => account.email !== email),
      );
      return true;
    });
  }

  return { list, load, remove, save, touch };
}

module.exports = {
  CREDENTIAL_INDEX_FILE_NAME,
  CREDENTIAL_INDEX_VERSION,
  CREDENTIAL_VAULT_BACKUP_FILE_NAME,
  CREDENTIAL_VAULT_FILE_NAME,
  CredentialVaultError,
  MAX_CREDENTIAL_ACCOUNTS,
  atomicWritePrivateFileWithBackup,
  createCredentialVault,
  mergeEmailIndex,
  normalizeCredentialEmail,
};
