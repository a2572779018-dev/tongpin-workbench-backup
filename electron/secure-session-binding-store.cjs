const fsp = require("node:fs/promises");
const path = require("node:path");
const {
  atomicWritePrivateFile,
} = require("./relationship-graph-vault.cjs");
const {
  atomicWritePrivateFileWithBackup,
} = require("./credential-vault.cjs");
const {
  createSafeStorageAdapter,
  isSafeStorageAdapterError,
} = require("./safe-storage-adapter.cjs");

const SECURE_SESSION_FILE_NAME = "secure-session.bin";
const RELATIONSHIP_BINDING_FILE_NAME = "secure-relationship-binding.bin";

class SecureLocalStoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "SecureLocalStoreError";
    this.code = code;
  }
}

function validateUserDataPath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new Error("本机安全存储目录无效");
  }
  return userDataPath;
}

function resolveSecureStorage({ safeStorage, safeStorageAdapter }) {
  return safeStorageAdapter ?? createSafeStorageAdapter(safeStorage);
}

function createSecureSessionStore({
  userDataPath,
  safeStorage,
  safeStorageAdapter,
  fileSystem = fsp,
  atomicWriteWithBackup = atomicWritePrivateFileWithBackup,
}) {
  const root = validateUserDataPath(userDataPath);
  const filePath = path.join(root, SECURE_SESSION_FILE_NAME);
  const secureStorage = resolveSecureStorage({
    safeStorage,
    safeStorageAdapter,
  });

  async function read() {
    let encrypted;
    try {
      encrypted = await fileSystem.readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new SecureLocalStoreError(
        "SECURE_SESSION_READ_FAILED",
        "本机安全登录状态无法读取，原加密文件已保留",
        error,
      );
    }

    try {
      const { result } = await secureStorage.decryptString(encrypted);
      const session = JSON.parse(result);
      if (!session || typeof session !== "object" || Array.isArray(session)) {
        throw new TypeError("本机安全登录状态格式无效");
      }
      return { payload: result, session };
    } catch (error) {
      if (error?.code?.startsWith?.("SAFE_STORAGE_")) throw error;
      throw new SecureLocalStoreError(
        "SECURE_SESSION_UNREADABLE",
        "本机安全登录状态无法解密或已损坏，原加密文件已保留",
        error,
      );
    }
  }

  async function write(payload) {
    if (typeof payload !== "string") {
      throw new TypeError("安全登录状态必须是 JSON 文本");
    }
    let session;
    try {
      session = JSON.parse(payload);
    } catch (error) {
      throw new SecureLocalStoreError(
        "SECURE_SESSION_INVALID",
        "安全登录状态格式无效",
        error,
      );
    }
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      throw new SecureLocalStoreError(
        "SECURE_SESSION_INVALID",
        "安全登录状态格式无效",
      );
    }

    const encrypted = await secureStorage.encryptString(payload);
    await atomicWriteWithBackup(filePath, encrypted);
    return true;
  }

  return { filePath, read, write };
}

function createRelationshipBindingStore({
  userDataPath,
  safeStorage,
  safeStorageAdapter,
  fileSystem = fsp,
  atomicWrite = atomicWritePrivateFile,
  now = () => new Date(),
}) {
  const root = validateUserDataPath(userDataPath);
  const filePath = path.join(root, RELATIONSHIP_BINDING_FILE_NAME);
  const secureStorage = resolveSecureStorage({
    safeStorage,
    safeStorageAdapter,
  });

  async function read() {
    let encrypted;
    try {
      encrypted = await fileSystem.readFile(filePath);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new SecureLocalStoreError(
        "RELATIONSHIP_BINDING_READ_FAILED",
        "本机安全验证状态无法读取",
        error,
      );
    }

    try {
      const { result } = await secureStorage.decryptString(encrypted);
      const binding = JSON.parse(result);
      if (
        binding?.version !== 1 ||
        binding.role !== "member" ||
        typeof binding.userId !== "string" ||
        typeof binding.sessionFingerprint !== "string"
      ) {
        return null;
      }
      return binding;
    } catch (error) {
      if (error?.code?.startsWith?.("SAFE_STORAGE_")) throw error;
      throw new SecureLocalStoreError(
        "RELATIONSHIP_BINDING_UNREADABLE",
        "本机安全验证状态无法读取",
        error,
      );
    }
  }

  async function write(binding) {
    if (
      !binding ||
      typeof binding.userId !== "string" ||
      typeof binding.fingerprint !== "string"
    ) {
      throw new TypeError("本机安全验证状态无效");
    }
    const encrypted = await secureStorage.encryptString(
      JSON.stringify({
        version: 1,
        userId: binding.userId,
        role: "member",
        sessionFingerprint: binding.fingerprint,
        verifiedAt: now().toISOString(),
      }),
    );
    await atomicWrite(filePath, encrypted);
    return true;
  }

  return { filePath, read, write };
}

async function persistSecureSessionWithMemoryFallback({
  secureSessionStore,
  payload,
  writeMemoryOnlyMarker,
  clearMemoryOnlyMarker,
}) {
  if (
    !secureSessionStore ||
    typeof secureSessionStore.write !== "function" ||
    typeof writeMemoryOnlyMarker !== "function" ||
    typeof clearMemoryOnlyMarker !== "function"
  ) {
    throw new TypeError("安全登录持久化配置无效");
  }

  try {
    await secureSessionStore.write(payload);
    await clearMemoryOnlyMarker();
    return { mode: "encrypted", errorCode: null };
  } catch (error) {
    if (!isSafeStorageAdapterError(error)) throw error;
    await writeMemoryOnlyMarker();
    return { mode: "memory-only", errorCode: error.code };
  }
}

module.exports = {
  RELATIONSHIP_BINDING_FILE_NAME,
  SECURE_SESSION_FILE_NAME,
  SecureLocalStoreError,
  createRelationshipBindingStore,
  createSecureSessionStore,
  persistSecureSessionWithMemoryFallback,
};
