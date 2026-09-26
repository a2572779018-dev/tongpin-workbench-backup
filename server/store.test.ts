import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error("拒绝清理非临时目录");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

describe("JsonStore 中央服务持久化", () => {
  it("在 POSIX 上创建并收紧 0700 数据目录和 0600 JSON 文件", async () => {
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-store-mode-"));
    temporaryRoots.push(root);
    const dataDirectory = path.join(root, "private-data");
    const dataFile = path.join(dataDirectory, "tongpin.json");

    await JsonStore.open(dataFile);
    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(dataFile)).mode & 0o777).toBe(0o600);

    await chmod(dataDirectory, 0o777);
    await chmod(dataFile, 0o666);
    const reopened = await JsonStore.open(dataFile);
    expect((await stat(dataDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(dataFile)).mode & 0o777).toBe(0o600);

    await reopened.mutate((database) => {
      database.taskAuditEvents = [...database.taskAuditEvents];
    });
    expect((await stat(dataFile)).mode & 0o777).toBe(0o600);

    await rm(dataFile);
    await mkdir(dataFile);
    await expect(
      reopened.mutate((database) => {
        database.taskAuditEvents = [...database.taskAuditEvents];
      }),
    ).rejects.toBeDefined();
    expect((await stat(`${dataFile}.tmp`)).mode & 0o777).toBe(0o600);
  });

  it("从 0.1.7 的版本 1 数据原位升级且不丢任务", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-store-v1-"));
    temporaryRoots.push(root);
    const dataFile = path.join(root, "tongpin.json");
    const now = new Date().toISOString();
    await writeFile(
      dataFile,
      JSON.stringify({
        version: 1,
        users: [
          {
            id: "legacy-user",
            email: "legacy@example.com",
            name: "旧版成员",
            passwordHash: "hash",
            role: "member",
            status: "active",
            avatarSeed: 1,
            avatarVersion: 0,
            avatarDataUrl: null,
            emailVerifiedAt: now,
            lastLoginAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        tasks: [
          {
            id: "legacy-task",
            userId: "legacy-user",
            date: "2026-07-28",
            title: "旧版本任务",
            details: "",
            status: "todo",
            priority: "p1",
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        verificationCodes: [],
        refreshSessions: [],
        notifications: [],
        contacts: [],
        directMessages: [],
      }),
      "utf8",
    );

    const store = await JsonStore.open(dataFile);
    const snapshot = await store.read((database) => database);
    expect(snapshot.version).toBe(6);
    expect(snapshot.users[0]).toMatchObject({
      id: "legacy-user",
      jobTitle: "",
    });
    expect(snapshot.tasks[0]).toMatchObject({
      id: "legacy-task",
      title: "旧版本任务",
      origin: "self",
      assignedBy: null,
    });
    expect(snapshot.taskRolloverDecisions).toEqual([]);
    expect(snapshot.taskAuditEvents).toEqual([]);
    expect(snapshot.bossWorkReportStatuses).toEqual([]);
    expect(snapshot.relationshipGraphSnapshots).toEqual([]);
    expect(snapshot.bossLoraReportOpens).toEqual([]);
    expect(snapshot.loraTransactions).toEqual([]);
    expect(snapshot.loraCollectorState.checkpointBlock).toBeNull();
  });

  it("从版本 2 升级后保留旧任务并允许写入 P4", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-store-v2-"));
    temporaryRoots.push(root);
    const dataFile = path.join(root, "tongpin.json");
    const now = new Date().toISOString();
    await writeFile(
      dataFile,
      JSON.stringify({
        version: 2,
        users: [],
        tasks: [
          {
            id: "v2-task",
            userId: "v2-user",
            date: "2026-07-29",
            title: "版本 2 任务",
            details: "",
            status: "todo",
            priority: "p3",
            origin: "self",
            assignedBy: null,
            assignmentId: null,
            sourceTaskId: null,
            assignmentDeliveredAt: null,
            assignmentViewedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        verificationCodes: [],
        refreshSessions: [],
        notifications: [],
        contacts: [],
        directMessages: [],
        taskRolloverDecisions: [],
      }),
      "utf8",
    );

    const store = await JsonStore.open(dataFile);
    await store.mutate((database) => {
      database.tasks[0].priority = "p4";
    });
    const snapshot = await store.read((database) => database);

    expect(snapshot.version).toBe(6);
    expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]).toMatchObject({
      id: "v2-task",
      title: "版本 2 任务",
      priority: "p4",
    });
  });

  it("服务重新打开同一数据文件后仍能读取成员和任务", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-store-"));
    temporaryRoots.push(root);
    const dataFile = path.join(root, "tongpin.json");
    const first = await JsonStore.open(dataFile);
    const now = new Date().toISOString();

    await first.mutate((database) => {
      database.users.push({
        id: "user-persisted",
        email: "member@example.com",
        name: "持久化成员",
        passwordHash: "hash",
        role: "member",
        status: "active",
        jobTitle: "",
        avatarSeed: 2,
        avatarVersion: 0,
        avatarDataUrl: null,
        emailVerifiedAt: now,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
      database.tasks.push({
        id: "task-persisted",
        userId: "user-persisted",
        date: "2026-07-28",
        title: "换电脑后仍需存在",
        details: "",
        status: "todo",
        priority: "p0",
        origin: "self",
        assignedBy: null,
        assignmentId: null,
        sourceTaskId: null,
        assignmentDeliveredAt: null,
        assignmentViewedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    const reopened = await JsonStore.open(dataFile);
    const snapshot = await reopened.read((database) => ({
      user: database.users.find((item) => item.id === "user-persisted"),
      task: database.tasks.find((item) => item.id === "task-persisted"),
    }));

    expect(snapshot.user?.email).toBe("member@example.com");
    expect(snapshot.task).toMatchObject({
      title: "换电脑后仍需存在",
      priority: "p0",
    });
  });

  it("在 Windows 连续写入后仍能完整重启读取", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-store-burst-"));
    temporaryRoots.push(root);
    const dataFile = path.join(root, "tongpin.json");
    const store = await JsonStore.open(dataFile);
    const now = new Date().toISOString();

    await store.mutate((database) => {
      database.users.push({
        id: "burst-user",
        email: "burst@example.com",
        name: "连续写入成员",
        passwordHash: "hash",
        role: "member",
        status: "active",
        jobTitle: "",
        avatarSeed: 1,
        avatarVersion: 0,
        avatarDataUrl: null,
        emailVerifiedAt: now,
        lastLoginAt: null,
        createdAt: now,
        updatedAt: now,
      });
    });

    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.mutate((database) => {
          database.tasks.push({
            id: `burst-task-${index}`,
            userId: "burst-user",
            date: "2026-07-28",
            title: `连续写入任务 ${index}`,
            details: "",
            status: "todo",
            priority: index % 2 === 0 ? "p0" : "p1",
            origin: "self",
            assignedBy: null,
            assignmentId: null,
            sourceTaskId: null,
            assignmentDeliveredAt: null,
            assignmentViewedAt: null,
            completedAt: null,
            createdAt: now,
            updatedAt: now,
          });
        }),
      ),
    );

    const reopened = await JsonStore.open(dataFile);
    const persisted = await reopened.read((database) =>
      database.tasks.filter((task) => task.userId === "burst-user"),
    );

    expect(persisted).toHaveLength(30);
    expect(new Set(persisted.map((task) => task.id)).size).toBe(30);
  });
});
