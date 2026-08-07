import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseShape } from "./types";

const EMPTY_DATABASE: DatabaseShape = {
  version: 4,
  users: [],
  tasks: [],
  verificationCodes: [],
  refreshSessions: [],
  notifications: [],
  contacts: [],
  directMessages: [],
  taskRolloverDecisions: [],
  taskAuditEvents: [],
};

function seedFromId(id: string): number {
  let total = 0;
  for (const character of id) total = (total + character.charCodeAt(0)) % 6;
  return total;
}

const WINDOWS_RENAME_RETRY_DELAYS = [20, 40, 80, 160, 320, 640];

function isRetryableRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return ["EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "EPERM"].includes(
    code ?? "",
  );
}

async function replaceFileWithRetry(
  temporaryPath: string,
  destinationPath: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(temporaryPath, destinationPath);
      return;
    } catch (error) {
      const delay = WINDOWS_RENAME_RETRY_DELAYS[attempt];
      if (!isRetryableRenameError(error) || delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export class JsonStore {
  private data: DatabaseShape;
  private writeQueue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    data: DatabaseShape,
  ) {
    this.data = data;
  }

  static async open(filePath: string): Promise<JsonStore> {
    const absolutePath = path.resolve(filePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });

    try {
      const raw = await readFile(absolutePath, "utf8");
      const parsed = JSON.parse(raw) as Omit<DatabaseShape, "version"> & {
        version: number;
      };
      if (
        parsed.version !== 1 &&
        parsed.version !== 2 &&
        parsed.version !== 3 &&
        parsed.version !== 4
      ) {
        throw new Error(`不支持的数据版本：${String(parsed.version)}`);
      }
      let migrated = false;
      if (parsed.version < 4) {
        parsed.version = 4;
        migrated = true;
      }
      for (const user of parsed.users) {
        if (typeof user.jobTitle !== "string") {
          user.jobTitle = "";
          migrated = true;
        }
        if (!Number.isInteger(user.avatarSeed)) {
          user.avatarSeed = seedFromId(user.id);
          migrated = true;
        }
        if (!Number.isInteger(user.avatarVersion)) {
          user.avatarVersion = 0;
          migrated = true;
        }
        if (typeof user.avatarDataUrl !== "string" && user.avatarDataUrl !== null) {
          user.avatarDataUrl = null;
          migrated = true;
        }
      }
      for (const task of parsed.tasks) {
        const legacyPriority = task.priority as string;
        if (legacyPriority === "high") {
          task.priority = "p1";
          migrated = true;
        } else if (
          legacyPriority === "normal" ||
          !["p0", "p1", "p2", "p3", "p4"].includes(legacyPriority)
        ) {
          task.priority = "p2";
          migrated = true;
        }
        if (!["self", "assigned", "carryover"].includes(task.origin)) {
          task.origin = "self";
          migrated = true;
        }
        if (typeof task.assignedBy !== "string" && task.assignedBy !== null) {
          task.assignedBy = null;
          migrated = true;
        }
        if (
          typeof task.assignmentId !== "string" &&
          task.assignmentId !== null
        ) {
          task.assignmentId = null;
          migrated = true;
        }
        if (
          typeof task.sourceTaskId !== "string" &&
          task.sourceTaskId !== null
        ) {
          task.sourceTaskId = null;
          migrated = true;
        }
        if (
          typeof task.assignmentDeliveredAt !== "string" &&
          task.assignmentDeliveredAt !== null
        ) {
          task.assignmentDeliveredAt = null;
          migrated = true;
        }
        if (
          typeof task.assignmentViewedAt !== "string" &&
          task.assignmentViewedAt !== null
        ) {
          task.assignmentViewedAt = null;
          migrated = true;
        }
      }
      for (const notification of parsed.notifications) {
        const legacy = notification as typeof notification & {
          dispatchId?: string;
          requiresAcknowledgement?: boolean;
          deliveredAt?: string | null;
          acknowledgedAt?: string | null;
          dingCount?: number;
          lastDingAt?: string | null;
        };
        if (typeof legacy.dispatchId !== "string") {
          legacy.dispatchId = notification.id;
          migrated = true;
        }
        if (typeof legacy.requiresAcknowledgement !== "boolean") {
          legacy.requiresAcknowledgement = false;
          migrated = true;
        }
        if (
          typeof legacy.deliveredAt !== "string" &&
          legacy.deliveredAt !== null
        ) {
          legacy.deliveredAt = null;
          migrated = true;
        }
        if (
          typeof legacy.acknowledgedAt !== "string" &&
          legacy.acknowledgedAt !== null
        ) {
          legacy.acknowledgedAt = null;
          migrated = true;
        }
        if (!Number.isInteger(legacy.dingCount)) {
          legacy.dingCount = 0;
          migrated = true;
        }
        if (
          typeof legacy.lastDingAt !== "string" &&
          legacy.lastDingAt !== null
        ) {
          legacy.lastDingAt = null;
          migrated = true;
        }
      }
      if (!Array.isArray(parsed.contacts)) {
        parsed.contacts = [];
        migrated = true;
      }
      if (!Array.isArray(parsed.directMessages)) {
        parsed.directMessages = [];
        migrated = true;
      }
      for (const message of parsed.directMessages) {
        if (message.mode !== "flash" && message.mode !== "normal") {
          message.mode = "normal";
          migrated = true;
        }
        if (
          typeof message.expiresAt !== "string" &&
          message.expiresAt !== null
        ) {
          message.expiresAt = null;
          migrated = true;
        }
        if (
          typeof message.destroyedAt !== "string" &&
          message.destroyedAt !== null
        ) {
          message.destroyedAt = null;
          migrated = true;
        }
        if (
          message.mode === "flash" &&
          message.expiresAt &&
          !message.destroyedAt &&
          Date.parse(message.expiresAt) <= Date.now()
        ) {
          message.body = "";
          message.destroyedAt = new Date().toISOString();
          migrated = true;
        }
      }
      if (!Array.isArray(parsed.taskRolloverDecisions)) {
        parsed.taskRolloverDecisions = [];
        migrated = true;
      }
      if (!Array.isArray(parsed.taskAuditEvents)) {
        parsed.taskAuditEvents = [];
        migrated = true;
      }
      const store = new JsonStore(absolutePath, parsed as DatabaseShape);
      if (migrated) await store.persist();
      return store;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const store = new JsonStore(absolutePath, structuredClone(EMPTY_DATABASE));
      await store.persist();
      return store;
    }
  }

  async read<T>(reader: (data: Readonly<DatabaseShape>) => T): Promise<T> {
    await this.writeQueue;
    return structuredClone(reader(this.data));
  }

  async mutate<T>(mutator: (data: DatabaseShape) => T | Promise<T>): Promise<T> {
    const operation = this.writeQueue.then(async () => {
      const nextData = structuredClone(this.data);
      const result = await mutator(nextData);
      await this.persist(nextData);
      this.data = nextData;
      return result;
    });

    this.writeQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async persist(data: DatabaseShape = this.data): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data, null, 2), "utf8");
    await replaceFileWithRetry(temporaryPath, this.filePath);
  }
}
