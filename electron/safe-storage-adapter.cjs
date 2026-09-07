const SAFE_STORAGE_ERROR_CODES = Object.freeze({
  UNAVAILABLE: "SAFE_STORAGE_UNAVAILABLE",
  TEMPORARILY_UNAVAILABLE: "SAFE_STORAGE_TEMPORARILY_UNAVAILABLE",
  ENCRYPT_FAILED: "SAFE_STORAGE_ENCRYPT_FAILED",
  DECRYPT_FAILED: "SAFE_STORAGE_DECRYPT_FAILED",
});

class SafeStorageAdapterError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SafeStorageAdapterError";
    this.code = code;
  }
}

function hasCompleteAsyncApi(safeStorage) {
  return Boolean(
    safeStorage &&
      typeof safeStorage.isAsyncEncryptionAvailable === "function" &&
      typeof safeStorage.encryptStringAsync === "function" &&
      typeof safeStorage.decryptStringAsync === "function",
  );
}

function errorText(error) {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "";
}

function isTemporaryUnavailableCause(error) {
  return /temporar(?:ily|y) unavailable|暂时不可用|keychain.*(?:locked|unavailable)/i.test(
    errorText(error),
  );
}

function unavailableError(cause, temporary = false) {
  return new SafeStorageAdapterError(
    temporary
      ? SAFE_STORAGE_ERROR_CODES.TEMPORARILY_UNAVAILABLE
      : SAFE_STORAGE_ERROR_CODES.UNAVAILABLE,
    temporary
      ? "系统安全存储暂时不可用，请稍后重新尝试"
      : "系统安全存储不可用，请解锁系统安全存储后重试",
    cause,
  );
}

function operationError(operation, cause) {
  if (isTemporaryUnavailableCause(cause)) {
    return unavailableError(cause, true);
  }
  const isEncryption = operation === "encrypt";
  return new SafeStorageAdapterError(
    isEncryption
      ? SAFE_STORAGE_ERROR_CODES.ENCRYPT_FAILED
      : SAFE_STORAGE_ERROR_CODES.DECRYPT_FAILED,
    isEncryption
      ? "系统安全存储加密失败，原加密数据已保留"
      : "系统安全存储解密失败，原加密数据已保留",
    cause,
  );
}

function isSafeStorageUnavailableError(error) {
  return Boolean(
    error &&
      (error.code === SAFE_STORAGE_ERROR_CODES.UNAVAILABLE ||
        error.code === SAFE_STORAGE_ERROR_CODES.TEMPORARILY_UNAVAILABLE),
  );
}

function isSafeStorageAdapterError(error) {
  return Boolean(
    error &&
      typeof error.code === "string" &&
      error.code.startsWith("SAFE_STORAGE_"),
  );
}

function createSafeStorageAdapter(safeStorage, { platform = process.platform } = {}) {
  if (!safeStorage || typeof safeStorage !== "object") {
    throw new TypeError("系统安全存储配置无效");
  }
  const useAsyncApi = hasCompleteAsyncApi(safeStorage);
  // On macOS even the sync availability probe can block on Keychain access.
  // Once async APIs exist, an async failure must not re-enter that sync path.
  // Electron versions without async APIs keep their legacy encrypted codec.
  const allowSyncFallback = platform !== "darwin";

  function isSyncEncryptionAvailable() {
    try {
      return Boolean(
        typeof safeStorage.isEncryptionAvailable === "function" &&
          safeStorage.isEncryptionAvailable(),
      );
    } catch {
      return false;
    }
  }

  async function ensureAvailable() {
    if (useAsyncApi) {
      let available;
      try {
        available = await safeStorage.isAsyncEncryptionAvailable();
      } catch (error) {
        if (allowSyncFallback && isSyncEncryptionAvailable()) return "sync";
        throw unavailableError(error, isTemporaryUnavailableCause(error));
      }
      if (!available) {
        if (allowSyncFallback && isSyncEncryptionAvailable()) return "sync";
        throw unavailableError();
      }
      return "async";
    }

    if (!isSyncEncryptionAvailable()) {
      throw unavailableError();
    }
    return "sync";
  }

  async function isEncryptionAvailable() {
    try {
      await ensureAvailable();
      return true;
    } catch {
      return false;
    }
  }

  async function encryptString(plainText) {
    const mode = await ensureAvailable();
    try {
      const encrypted =
        mode === "async"
          ? await safeStorage.encryptStringAsync(plainText)
          : safeStorage.encryptString(plainText);
      if (!Buffer.isBuffer(encrypted)) {
        throw new TypeError("系统安全存储未返回加密数据");
      }
      return encrypted;
    } catch (error) {
      if (error instanceof SafeStorageAdapterError) throw error;
      throw operationError("encrypt", error);
    }
  }

  async function decryptString(encrypted) {
    if (!Buffer.isBuffer(encrypted)) {
      throw new TypeError("待解密内容必须是 Buffer");
    }
    const mode = await ensureAvailable();
    try {
      if (mode === "async") {
        const decrypted = await safeStorage.decryptStringAsync(encrypted);
        if (!decrypted || typeof decrypted.result !== "string") {
          throw new TypeError("系统安全存储未返回解密内容");
        }
        return {
          result: decrypted.result,
          shouldReEncrypt: decrypted.shouldReEncrypt === true,
          mode,
        };
      }

      const result = safeStorage.decryptString(encrypted);
      if (typeof result !== "string") {
        throw new TypeError("系统安全存储未返回解密内容");
      }
      return { result, shouldReEncrypt: false, mode };
    } catch (error) {
      if (error instanceof SafeStorageAdapterError) throw error;
      throw operationError("decrypt", error);
    }
  }

  return {
    mode: useAsyncApi ? "async" : "sync",
    decryptString,
    encryptString,
    ensureAvailable,
    isEncryptionAvailable,
  };
}

module.exports = {
  SAFE_STORAGE_ERROR_CODES,
  SafeStorageAdapterError,
  createSafeStorageAdapter,
  hasCompleteAsyncApi,
  isSafeStorageAdapterError,
  isSafeStorageUnavailableError,
  isTemporaryUnavailableCause,
};
