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
  fileSystem = fsp,
  atomicWrite = atomicWritePrivateFile,
  now = () => new Date(),
}) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new Error("登录记录存储目录无效");
  }
  const indexPath = path.join(userDataPath, CREDENTIAL_INDEX_FILE_NAME);
  let mutationQueue = Promise.resolve();

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

  async function list() {
    await waitForMutations();
    const index = await readEmailIndex();
    return {
      state: "ready",
      accounts: index,
    };
  }

  function save(value) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(value?.email);
      if (!isCredentialEmail(email)) {
        throw new Error("无效的登录账号");
      }
      const timestamp = now().toISOString();
      const index = await readEmailIndex();
      const next = [
        {
          email,
          lastUsedAt: timestamp,
        },
        ...index.filter((account) => account.email !== email),
      ];
      await writeEmailIndex(next);
      return true;
    });
  }

  function touch(emailValue) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(emailValue);
      if (!isCredentialEmail(email)) return false;
      const index = await readEmailIndex();
      const existing = index.find((account) => account.email === email);
      if (!existing) return false;
      const next = [
        {
          email,
          lastUsedAt: now().toISOString(),
        },
        ...index.filter((account) => account.email !== email),
      ];
      await writeEmailIndex(next);
      return true;
    });
  }

  function remove(emailValue) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(emailValue);
      if (!isCredentialEmail(email)) return false;
      const index = await readEmailIndex();
      await writeEmailIndex(
        index.filter((account) => account.email !== email),
      );
      return true;
    });
  }

  return { list, remove, save, touch };
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
