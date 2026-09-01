const fsp = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const {
  createSafeStorageAdapter,
  isSafeStorageUnavailableError,
} = require("./safe-storage-adapter.cjs");

const RELATIONSHIP_GRAPH_VAULT_VERSION = 1;
const RELATIONSHIP_GRAPH_MAX_BYTES = 25 * 1024 * 1024;
const RELATIONSHIP_GRAPH_MAX_PEOPLE = 5_000;
const RELATIONSHIP_GRAPH_MAX_CONNECTIONS = 20_000;

function graphFileName(userId) {
  return `${createHash("sha256").update(userId).digest("hex")}.bin`;
}

function validateUserId(userId) {
  if (
    typeof userId !== "string" ||
    userId.length < 1 ||
    userId.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(userId)
  ) {
    throw new Error("无效的关系图账号");
  }
  return userId;
}

function validateGraphDocument(content) {
  if (typeof content !== "string") {
    throw new Error("关系图内容必须是 JSON 文本");
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > RELATIONSHIP_GRAPH_MAX_BYTES) {
    throw new Error("关系图数据超过 25 MB");
  }

  let document;
  try {
    document = JSON.parse(content);
  } catch {
    throw new Error("关系图内容不是有效 JSON");
  }
  if (
    !document ||
    Array.isArray(document) ||
    document.schemaVersion !== "1.0" ||
    !Array.isArray(document.people) ||
    document.people.length < 1 ||
    document.people.length > RELATIONSHIP_GRAPH_MAX_PEOPLE ||
    !Array.isArray(document.connections) ||
    document.connections.length > RELATIONSHIP_GRAPH_MAX_CONNECTIONS
  ) {
    throw new Error("关系图内容不符合安全存储格式");
  }
  return { bytes, document };
}

async function atomicWritePrivateFile(target, content) {
  const directory = path.dirname(target);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(directory, 0o700);
  } catch {
    // Windows and some managed volumes do not expose POSIX modes.
  }
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    let lastRenameError = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        await fsp.rename(temporary, target);
        lastRenameError = null;
        break;
      } catch (error) {
        lastRenameError = error;
        if (!["EACCES", "EBUSY", "EPERM"].includes(error?.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
    if (lastRenameError) throw lastRenameError;
    try {
      await fsp.chmod(target, 0o600);
    } catch {
      // SafeStorage still protects the payload where POSIX modes are unavailable.
    }
  } catch (error) {
    try {
      await fsp.unlink(temporary);
    } catch {
      // Preserve the original write error.
    }
    throw error;
  }
}

function createRelationshipGraphVault({
  userDataPath,
  safeStorage,
  safeStorageAdapter,
}) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new Error("关系图存储目录无效");
  }
  const vaultDirectory = path.join(userDataPath, "relationship-graphs");
  const writeQueues = new Map();
  const secureStorage =
    safeStorageAdapter ?? createSafeStorageAdapter(safeStorage);

  async function assertEncryptionAvailable() {
    try {
      await secureStorage.ensureAvailable();
    } catch (error) {
      if (error?.code === "SAFE_STORAGE_TEMPORARILY_UNAVAILABLE") {
        throw new Error(
          "系统安全存储暂时不可用，客户脉络图仍保持加密，请稍后重试",
          { cause: error },
        );
      }
      if (isSafeStorageUnavailableError(error)) {
        throw new Error("系统安全存储不可用，拒绝明文保存关系图", {
          cause: error,
        });
      }
      throw error;
    }
  }

  function filePathForUser(userId) {
    return path.join(vaultDirectory, graphFileName(validateUserId(userId)));
  }

  async function readStoredGraph(userId) {
    await assertEncryptionAvailable();
    const normalizedUserId = validateUserId(userId);
    let encrypted;
    try {
      encrypted = await fsp.readFile(filePathForUser(normalizedUserId));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }

    let envelope;
    try {
      const { result } = await secureStorage.decryptString(encrypted);
      envelope = JSON.parse(result);
    } catch (error) {
      if (isSafeStorageUnavailableError(error)) throw error;
      if (error?.code === "SAFE_STORAGE_DECRYPT_FAILED") {
        throw new Error(
          "系统安全存储无法解密本机客户脉络图，原加密文件已保留",
          { cause: error },
        );
      }
      throw new Error("本机关系图数据无法解密或已损坏");
    }
    if (
      envelope?.vaultVersion !== RELATIONSHIP_GRAPH_VAULT_VERSION ||
      envelope.userId !== normalizedUserId ||
      !Number.isInteger(envelope.revision) ||
      envelope.revision < 1
    ) {
      throw new Error("本机关系图数据与当前账号不匹配");
    }
    validateGraphDocument(envelope.graphDocument);
    return {
      content: envelope.graphDocument,
      revision: envelope.revision,
      savedAt: typeof envelope.savedAt === "string" ? envelope.savedAt : null,
    };
  }

  async function load(userId) {
    const normalizedUserId = validateUserId(userId);
    const queued = writeQueues.get(normalizedUserId);
    if (queued) await queued;
    return readStoredGraph(normalizedUserId);
  }

  async function write(userId, graphDocument, revision) {
    await assertEncryptionAvailable();
    const normalizedUserId = validateUserId(userId);
    validateGraphDocument(graphDocument);
    const envelope = JSON.stringify({
      vaultVersion: RELATIONSHIP_GRAPH_VAULT_VERSION,
      userId: normalizedUserId,
      revision,
      savedAt: new Date().toISOString(),
      graphDocument,
    });
    const encrypted = await secureStorage.encryptString(envelope);
    await atomicWritePrivateFile(filePathForUser(normalizedUserId), encrypted);
    return revision;
  }

  function save(userId, graphDocument, revision) {
    const normalizedUserId = validateUserId(userId);
    validateGraphDocument(graphDocument);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new Error("关系图版本号无效");
    }
    const previous = writeQueues.get(normalizedUserId) ?? Promise.resolve();
    const queued = previous
      .catch(() => undefined)
      .then(async () => {
        const stored = await readStoredGraph(normalizedUserId);
        if (stored && revision < stored.revision) {
          throw new Error("拒绝用旧版本覆盖较新的关系图");
        }
        if (stored && revision === stored.revision) {
          if (stored.content === graphDocument) return revision;
          throw new Error("关系图版本冲突，请重新打开页面");
        }
        return write(normalizedUserId, graphDocument, revision);
      });
    writeQueues.set(normalizedUserId, queued);
    void queued.finally(() => {
      if (writeQueues.get(normalizedUserId) === queued) {
        writeQueues.delete(normalizedUserId);
      }
    }).catch(() => undefined);
    return queued;
  }

  async function flush(userId) {
    const normalizedUserId = validateUserId(userId);
    const queued = writeQueues.get(normalizedUserId);
    if (queued) await queued;
  }

  return { load, save, flush };
}

module.exports = {
  RELATIONSHIP_GRAPH_MAX_BYTES,
  RELATIONSHIP_GRAPH_MAX_CONNECTIONS,
  RELATIONSHIP_GRAPH_MAX_PEOPLE,
  RELATIONSHIP_GRAPH_VAULT_VERSION,
  atomicWritePrivateFile,
  createRelationshipGraphVault,
  graphFileName,
  validateGraphDocument,
  validateUserId,
};
