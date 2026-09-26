const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  atomicWritePrivateFile,
} = require("./relationship-graph-vault.cjs");
const {
  isSafeStorageUnavailableError,
} = require("./safe-storage-adapter.cjs");

// Legacy (pre account-only) password vault: never read, rewritten or removed.
const CREDENTIAL_VAULT_FILE_NAME = "secure-accounts.bin";
const CREDENTIAL_VAULT_BACKUP_FILE_NAME = "secure-accounts.bin.bak";
const CREDENTIAL_INDEX_FILE_NAME = "remembered-accounts.json";
const CREDENTIAL_INDEX_VERSION = 1;
const MAX_CREDENTIAL_ACCOUNTS = 20;
// Opt-in remembered passwords. Each value is an Electron safeStorage
// ciphertext (macOS Keychain / Windows DPAPI key) of {v, email, password};
// the file itself never contains plaintext and is written 0600.
const CREDENTIAL_SECRET_FILE_NAME = "secure-account-passwords.json";
const CREDENTIAL_SECRET_VERSION = 1;
const MAX_REMEMBERED_PASSWORD_LENGTH = 256;
const MAX_SECRET_CIPHERTEXT_LENGTH = 16_384;

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

function isRememberablePassword(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_REMEMBERED_PASSWORD_LENGTH &&
    !value.includes("\0")
  );
}

function createCredentialVault({
  userDataPath,
  safeStorageAdapter = null,
  // Only platforms whose safeStorage is backed by the OS keystore (macOS
  // Keychain, Windows DPAPI) may remember passwords.
  allowPasswordStorage = false,
  fileSystem = fsp,
  atomicWrite = atomicWritePrivateFile,
  now = () => new Date(),
}) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new Error("登录记录存储目录无效");
  }
  const indexPath = path.join(userDataPath, CREDENTIAL_INDEX_FILE_NAME);
  const secretPath = path.join(userDataPath, CREDENTIAL_SECRET_FILE_NAME);
  const canStorePasswords = Boolean(
    allowPasswordStorage &&
      safeStorageAdapter &&
      typeof safeStorageAdapter.encryptString === "function" &&
      typeof safeStorageAdapter.decryptString === "function",
  );
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

  async function readSecretEntries() {
    const entries = Object.create(null);
    try {
      const parsed = JSON.parse(await fileSystem.readFile(secretPath, "utf8"));
      if (
        !parsed ||
        parsed.version !== CREDENTIAL_SECRET_VERSION ||
        !parsed.entries ||
        typeof parsed.entries !== "object" ||
        Array.isArray(parsed.entries)
      ) {
        return entries;
      }
      for (const [key, value] of Object.entries(parsed.entries)) {
        const email = normalizeCredentialEmail(key);
        if (
          isCredentialEmail(email) &&
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= MAX_SECRET_CIPHERTEXT_LENGTH &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(value)
        ) {
          entries[email] = value;
        }
      }
    } catch {
      // Missing or damaged: behave as "no remembered passwords".
    }
    return entries;
  }

  async function writeSecretEntries(entries) {
    if (Object.keys(entries).length === 0) {
      try {
        await fileSystem.unlink(secretPath);
        return;
      } catch (error) {
        if (error?.code === "ENOENT") return;
        // Windows may briefly lock the file (antivirus/indexer): overwrite it
        // with an empty list through the retrying atomic writer instead.
        if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code)) throw error;
      }
    }
    await atomicWrite(
      secretPath,
      JSON.stringify({ version: CREDENTIAL_SECRET_VERSION, entries }),
    );
  }

  async function deleteSecrets(shouldDelete) {
    const entries = await readSecretEntries();
    let changed = false;
    for (const email of Object.keys(entries)) {
      if (!shouldDelete(email, entries[email])) continue;
      delete entries[email];
      changed = true;
    }
    if (changed) await writeSecretEntries(entries);
    return changed;
  }

  async function encryptPassword(email, password) {
    const encrypted = await safeStorageAdapter.encryptString(
      JSON.stringify({ v: CREDENTIAL_SECRET_VERSION, email, password }),
    );
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
      throw new TypeError("系统安全存储未返回加密数据");
    }
    return encrypted.toString("base64");
  }

  async function list() {
    await waitForMutations();
    const index = await readEmailIndex();
    // No decryption here: listing must never trigger a Keychain prompt.
    const secrets = canStorePasswords ? await readSecretEntries() : {};
    return {
      state: "ready",
      accounts: index.map((account) => ({
        ...account,
        passwordRemembered: Boolean(secrets[account.email]),
      })),
    };
  }

  /**
   * Remember the account. The password is stored only when the caller opted
   * in (rememberPassword === true) and the OS keystore encrypted it; every
   * other save removes a previously remembered password for this account.
   */
  function save(value) {
    return mutate(async () => {
      const email = normalizeCredentialEmail(value?.email);
      if (!isCredentialEmail(email)) {
        throw new Error("无效的登录账号");
      }
      const timestamp = now().toISOString();
      const index = await readEmailIndex();
      const next = mergeEmailIndex([
        {
          email,
          lastUsedAt: timestamp,
        },
        ...index.filter((account) => account.email !== email),
      ]);
      await writeEmailIndex(next);
      const remembered = new Set(next.map((account) => account.email));

      if (value?.rememberPassword !== true) {
        await deleteSecrets(
          (candidate) => candidate === email || !remembered.has(candidate),
        );
        return { saved: true, password: "cleared" };
      }

      let ciphertext = "";
      if (canStorePasswords && isRememberablePassword(value?.password)) {
        try {
          ciphertext = await encryptPassword(email, value.password);
        } catch {
          // Never fall back to plaintext; the stale secret is removed below.
          ciphertext = "";
        }
      }
      const entries = await readSecretEntries();
      for (const candidate of Object.keys(entries)) {
        if (!remembered.has(candidate)) delete entries[candidate];
      }
      if (ciphertext) entries[email] = ciphertext;
      else delete entries[email];
      await writeSecretEntries(entries);
      return { saved: true, password: ciphertext ? "stored" : "unavailable" };
    });
  }

  /**
   * Decrypt one remembered password for an explicit account selection.
   * A locked/denied keystore keeps the ciphertext (it may work after the
   * user allows access); a ciphertext that can never be read with the
   * current key is dropped while the account itself stays remembered.
   */
  async function revealPassword(emailValue) {
    await waitForMutations();
    const email = normalizeCredentialEmail(emailValue);
    if (!canStorePasswords || !isCredentialEmail(email)) {
      return { state: "missing" };
    }
    const index = await readEmailIndex();
    if (!index.some((account) => account.email === email)) {
      return { state: "missing" };
    }
    const ciphertext = (await readSecretEntries())[email];
    if (!ciphertext) return { state: "missing" };
    try {
      const decrypted = await safeStorageAdapter.decryptString(
        Buffer.from(ciphertext, "base64"),
      );
      const payload = JSON.parse(decrypted.result);
      if (
        payload?.v !== CREDENTIAL_SECRET_VERSION ||
        payload.email !== email ||
        !isRememberablePassword(payload.password)
      ) {
        throw new TypeError("记住的密码与账号不匹配");
      }
      if (decrypted.shouldReEncrypt === true) {
        void mutate(async () => {
          const refreshed = await encryptPassword(email, payload.password);
          const entries = await readSecretEntries();
          if (entries[email] !== ciphertext) return;
          entries[email] = refreshed;
          await writeSecretEntries(entries);
        }).catch(() => undefined);
      }
      return { state: "ready", password: payload.password };
    } catch (error) {
      if (isSafeStorageUnavailableError(error)) {
        return { state: "unavailable", reason: "locked" };
      }
      await mutate(() =>
        deleteSecrets(
          (candidate, value) => candidate === email && value === ciphertext,
        ),
      ).catch(() => undefined);
      return { state: "unavailable", reason: "unreadable" };
    }
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
      await deleteSecrets((candidate) => candidate === email);
      return true;
    });
  }

  return { list, remove, revealPassword, save, touch };
}

module.exports = {
  CREDENTIAL_INDEX_FILE_NAME,
  CREDENTIAL_INDEX_VERSION,
  CREDENTIAL_SECRET_FILE_NAME,
  CREDENTIAL_VAULT_BACKUP_FILE_NAME,
  CREDENTIAL_VAULT_FILE_NAME,
  CredentialVaultError,
  MAX_CREDENTIAL_ACCOUNTS,
  MAX_REMEMBERED_PASSWORD_LENGTH,
  atomicWritePrivateFileWithBackup,
  createCredentialVault,
  mergeEmailIndex,
  normalizeCredentialEmail,
};
