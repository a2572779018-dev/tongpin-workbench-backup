import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createRuntime, type AppRuntime } from "./app";
import { businessDateKey } from "./business-date";
import { loadConfig } from "./config";

const TODAY = businessDateKey();
const yesterday = new Date(`${TODAY}T00:00:00Z`);
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
const YESTERDAY = yesterday.toISOString().slice(0, 10);

describe("同频 API 纵向流程", () => {
  let runtime: AppRuntime;
  let temporaryRoot: string;
  let adminToken = "";
  let aliceToken = "";
  let aliceRefreshToken = "";
  let aliceId = "";
  let bobToken = "";
  let bobId = "";
  let aliceTaskId = "";

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tongpin-test-"));
    runtime = await createRuntime(
      loadConfig({
        dataFile: path.join(temporaryRoot, "database.json"),
        jwtSecret: "test-secret-with-more-than-thirty-two-characters",
        devEmailPreview: true,
        isProduction: false,
        bootstrapAdminEmail: "admin@example.com",
        bootstrapAdminPassword: "Admin123!",
        bootstrapAdminName: "测试管理员",
      }),
    );
    await new Promise<void>((resolve, reject) => {
      runtime.server.once("error", reject);
      runtime.server.listen(0, "127.0.0.1", () => {
        runtime.server.off("error", reject);
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
    const resolved = path.resolve(temporaryRoot);
    if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error("拒绝清理非临时目录");
    }
    await rm(resolved, { recursive: true, force: true });
  });

  async function registerAndVerify(
    name: string,
    email: string,
    password: string,
  ): Promise<string> {
    const registered = await request(runtime.app)
      .post("/api/auth/register")
      .send({ name, email, password })
      .expect(201);
    expect(registered.body.delivery).toBe("preview");
    expect(registered.body.debugCode).toMatch(/^\d{6}$/);

    const throttled = await request(runtime.app)
      .post("/api/auth/resend-code")
      .send({ email, purpose: "register" })
      .expect(429);
    expect(throttled.body.error.code).toBe("CODE_COOLDOWN");

    const verified = await request(runtime.app)
      .post("/api/auth/verify-email")
      .send({ email, code: registered.body.debugCode })
      .expect(200);
    expect(verified.body.nextStep).toBe("await_approval");
    return verified.body.user.id as string;
  }

  async function approve(userId: string): Promise<void> {
    await request(runtime.app)
      .patch(`/api/admin/users/${userId}/access`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ status: "active" })
      .expect(200);
  }

  function waitForRealtimeMessage(
    socket: WebSocket,
    type: string,
  ): Promise<{ type: string; data: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${type}`)),
        5_000,
      );
      socket.on("message", function listener(raw) {
        const message = JSON.parse(raw.toString()) as {
          type: string;
          data: unknown;
        };
        if (message.type !== type) return;
        clearTimeout(timer);
        socket.off("message", listener);
        resolve(message);
      });
    });
  }

  it("完成邮箱注册、验证、等待审批、批准与登录", async () => {
    const health = await request(runtime.app).get("/api/health").expect(200);
    expect(health.body.mailMode).toBe("preview");

    aliceId = await registerAndVerify(
      "林小满",
      "alice@example.com",
      "Alice1234",
    );

    const pendingLogin = await request(runtime.app)
      .post("/api/auth/login")
      .send({ email: "alice@example.com", password: "Alice1234" })
      .expect(403);
    expect(pendingLogin.body.error.code).toBe("ACCOUNT_PENDING");

    const adminLogin = await request(runtime.app)
      .post("/api/auth/login")
      .send({ email: "admin@example.com", password: "Admin123!" })
      .expect(200);
    adminToken = adminLogin.body.accessToken;
    expect(adminLogin.body.user.role).toBe("admin");

    const users = await request(runtime.app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(200);
    expect(
      users.body.users.find((user: { id: string }) => user.id === aliceId)
        .status,
    ).toBe("pending_approval");

    await approve(aliceId);

    const login = await request(runtime.app)
      .post("/api/auth/login")
      .send({ email: "alice@example.com", password: "Alice1234" })
      .expect(200);
    aliceToken = login.body.accessToken;
    aliceRefreshToken = login.body.refreshToken;
    expect(login.body.user.role).toBe("member");
  });

  it("支持刷新会话与完整找回密码流程", async () => {
    const refreshed = await request(runtime.app)
      .post("/api/auth/refresh")
      .send({ refreshToken: aliceRefreshToken })
      .expect(200);
    aliceToken = refreshed.body.accessToken;
    aliceRefreshToken = refreshed.body.refreshToken;

    const forgot = await request(runtime.app)
      .post("/api/auth/forgot-password")
      .send({ email: "alice@example.com" })
      .expect(200);
    expect(forgot.body.debugCode).toMatch(/^\d{6}$/);

    await request(runtime.app)
      .post("/api/auth/reset-password")
      .send({
        email: "alice@example.com",
        code: forgot.body.debugCode,
        password: "Alice5678",
      })
      .expect(200);

    await request(runtime.app)
      .post("/api/auth/login")
      .send({ email: "alice@example.com", password: "Alice1234" })
      .expect(401);

    const login = await request(runtime.app)
      .post("/api/auth/login")
      .send({ email: "alice@example.com", password: "Alice5678" })
      .expect(200);
    aliceToken = login.body.accessToken;
  });

  it("成员有系统默认头像，也可以上传和恢复自定义头像", async () => {
    const before = await request(runtime.app)
      .get("/api/auth/me")
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(before.body.user.hasCustomAvatar).toBe(false);
    expect(before.body.user.avatarSeed).toBeTypeOf("number");
    expect(before.body.user).not.toHaveProperty("avatarDataUrl");

    const pngDataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const uploaded = await request(runtime.app)
      .patch("/api/auth/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ dataUrl: pngDataUrl })
      .expect(200);
    expect(uploaded.body.user.hasCustomAvatar).toBe(true);
    expect(uploaded.body.user.avatarVersion).toBe(1);
    expect(uploaded.body.user).not.toHaveProperty("avatarDataUrl");

    const avatar = await request(runtime.app)
      .get(`/api/avatars/${aliceId}?v=1`)
      .expect(200)
      .expect("Content-Type", /image\/png/);
    expect(Buffer.isBuffer(avatar.body)).toBe(true);

    const restored = await request(runtime.app)
      .patch("/api/auth/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ dataUrl: null })
      .expect(200);
    expect(restored.body.user.hasCustomAvatar).toBe(false);
    expect(restored.body.user.avatarVersion).toBe(2);
  });

  it("服务端强制隔离成员任务，不依赖前端隐藏", async () => {
    bobId = await registerAndVerify("周野", "bob@example.com", "Bob12345");
    await approve(bobId);
    const bobLogin = await request(runtime.app)
      .post("/api/auth/login")
      .send({ email: "bob@example.com", password: "Bob12345" })
      .expect(200);
    bobToken = bobLogin.body.accessToken;

    const created = await request(runtime.app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        date: TODAY,
        title: "完成季度复盘",
        details: "整理关键结论",
        priority: "p0",
      })
      .expect(201);
    aliceTaskId = created.body.task.id;
    expect(created.body.task.priority).toBe("p0");

    const bobTasks = await request(runtime.app)
      .get(`/api/tasks?date=${TODAY}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(bobTasks.body.tasks).toHaveLength(0);

    const deferred = await request(runtime.app)
      .patch(`/api/tasks/${aliceTaskId}`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ priority: "p4" })
      .expect(200);
    expect(deferred.body.task.priority).toBe("p4");

    await request(runtime.app)
      .patch(`/api/tasks/${aliceTaskId}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ status: "done" })
      .expect(404);

    const completed = await request(runtime.app)
      .patch(`/api/tasks/${aliceTaskId}`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ status: "done" })
      .expect(200);
    expect(completed.body.task.completedAt).toBeTruthy();
  });

  it("管理员可设置老板，老板可看进度并给成员发送通知", async () => {
    await request(runtime.app)
      .patch(`/api/admin/users/${aliceId}/role`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ role: "boss" })
      .expect(200);

    const lockedAvatar = await request(runtime.app)
      .patch("/api/auth/me/avatar")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ dataUrl: null })
      .expect(403);
    expect(lockedAvatar.body.error).toEqual({
      code: "BOSS_AVATAR_LOCKED",
      message: "不好意思，您无权限更换自己的头像",
    });

    const team = await request(runtime.app)
      .get(`/api/boss/team?date=${TODAY}`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    const alice = team.body.members.find(
      (member: { user: { id: string } }) => member.user.id === aliceId,
    );
    expect(alice.completionRate).toBe(100);

    await request(runtime.app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        date: TODAY,
        title: "整理一般资料",
        priority: "p3",
      })
      .expect(201);
    await request(runtime.app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        date: TODAY,
        title: "完成今日交付",
        priority: "p1",
      })
      .expect(201);

    const taskDetails = await request(runtime.app)
      .get(`/api/boss/members/${aliceId}/tasks?date=${TODAY}`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(
      taskDetails.body.tasks.map(
        (task: { priority: string; status: string }) =>
          `${task.priority}:${task.status}`,
      ),
    ).toEqual(["p1:todo", "p3:todo", "p4:done"]);

    const history = await request(runtime.app)
      .get(
        `/api/boss/members/${aliceId}/tasks/${aliceTaskId}/history`,
      )
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(history.body.auditCoverage).toBe("tracked");
    expect(
      history.body.history.map(
        (event: { action: string }) => event.action,
      ),
    ).toEqual(["completed", "updated", "created"]);
    expect(
      history.body.history.find(
        (event: { action: string }) => event.action === "updated",
      ).changes,
    ).toContainEqual({
      field: "priority",
      before: "p0",
      after: "p4",
    });

    const address = runtime.server.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/realtime`,
    );
    const bossSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/realtime`,
    );
    const socketReady = waitForRealtimeMessage(socket, "realtime:ready");
    const bossReady = waitForRealtimeMessage(
      bossSocket,
      "realtime:ready",
    );
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: bobToken }));
    });
    bossSocket.on("open", () => {
      bossSocket.send(
        JSON.stringify({ type: "auth", token: aliceToken }),
      );
    });
    await Promise.all([socketReady, bossReady]);
    const pushedNotification = waitForRealtimeMessage(
      socket,
      "notification:new",
    );

    const sent = await request(runtime.app)
      .post("/api/boss/notifications")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        all: false,
        recipientIds: [bobId],
        title: "十分钟后开会",
        body: "请带上今日任务进度。",
      })
      .expect(201);
    expect(sent.body.delivered).toBe(1);
    expect(sent.body.targeted).toBe(1);
    expect(sent.body.dispatch.counts).toEqual({
      total: 1,
      delivered: 0,
      acknowledged: 0,
      pending: 1,
    });
    const realtimeMessage = await pushedNotification;
    const notificationId = sent.body.notifications[0].id as string;
    const dispatchId = sent.body.dispatch.id as string;
    expect((realtimeMessage.data as { id: string }).id).toBe(notificationId);

    const deliveredReceipt = waitForRealtimeMessage(
      bossSocket,
      "notification:receipt",
    );
    const delivered = await request(runtime.app)
      .patch(`/api/notifications/${notificationId}/delivered`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(delivered.body.notification.deliveredAt).toBeTruthy();
    expect(
      (
        (await deliveredReceipt).data as {
          deliveredAt: string | null;
        }
      ).deliveredAt,
    ).toBeTruthy();

    const dingMessage = waitForRealtimeMessage(
      socket,
      "notification:ding",
    );
    const dinged = await request(runtime.app)
      .post(`/api/boss/notification-dispatches/${dispatchId}/ding`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(dinged.body.targeted).toBe(1);
    expect(dinged.body.dispatch.dingCount).toBe(1);
    expect(
      ((await dingMessage).data as { dingCount: number }).dingCount,
    ).toBe(1);

    const acknowledgedReceipt = waitForRealtimeMessage(
      bossSocket,
      "notification:receipt",
    );
    const acknowledged = await request(runtime.app)
      .patch(`/api/notifications/${notificationId}/acknowledge`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(acknowledged.body.notification.acknowledgedAt).toBeTruthy();
    expect(
      (
        (await acknowledgedReceipt).data as {
          acknowledgedAt: string | null;
        }
      ).acknowledgedAt,
    ).toBeTruthy();

    const dispatches = await request(runtime.app)
      .get("/api/boss/notification-dispatches")
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(dispatches.body.dispatches[0].counts).toEqual({
      total: 1,
      delivered: 1,
      acknowledged: 1,
      pending: 0,
    });
    await request(runtime.app)
      .post(`/api/boss/notification-dispatches/${dispatchId}/ding`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(409);

    socket.close();
    bossSocket.close();

    const inbox = await request(runtime.app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(inbox.body.unread).toBe(0);
    expect(inbox.body.notifications[0].title).toBe("十分钟后开会");
    expect(inbox.body.notifications[0].acknowledgedAt).toBeTruthy();
  });

  it("成员可按姓名确认联系人，并实时收发持久化消息", async () => {
    const search = await request(runtime.app)
      .get("/api/contacts/search?q=林小满")
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(search.body.users).toHaveLength(1);
    expect(search.body.users[0]).toMatchObject({
      id: aliceId,
      name: "林小满",
      role: "boss",
    });

    const added = await request(runtime.app)
      .post("/api/contacts")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ userId: aliceId })
      .expect(201);
    expect(added.body.contact.user.id).toBe(aliceId);

    const address = runtime.server.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/realtime`,
    );
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "auth", token: aliceToken }));
    });
    await waitForRealtimeMessage(socket, "realtime:ready");
    const pushedMessage = waitForRealtimeMessage(socket, "message:new");

    const sent = await request(runtime.app)
      .post(`/api/contacts/${aliceId}/messages`)
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ body: "复盘材料已经整理好了。" })
      .expect(201);
    expect(sent.body.message.body).toBe("复盘材料已经整理好了。");

    const realtimeMessage = await pushedMessage;
    expect(realtimeMessage.data).toMatchObject({
      message: {
        id: sent.body.message.id,
        senderId: bobId,
        recipientId: aliceId,
      },
      sender: {
        id: bobId,
        name: "周野",
      },
    });
    socket.close();

    const aliceContacts = await request(runtime.app)
      .get("/api/contacts")
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(aliceContacts.body.unread).toBe(1);
    expect(aliceContacts.body.contacts[0].user.id).toBe(bobId);

    const messages = await request(runtime.app)
      .get(`/api/contacts/${bobId}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(messages.body.messages).toHaveLength(1);
    expect(messages.body.messages[0].body).toBe(
      "复盘材料已经整理好了。",
    );

    await request(runtime.app)
      .patch(`/api/contacts/${bobId}/read`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    const afterRead = await request(runtime.app)
      .get("/api/contacts")
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    expect(afterRead.body.unread).toBe(0);

    const persisted = await runtime.store.read((database) =>
      database.directMessages.find(
        (message) => message.id === sent.body.message.id,
      ),
    );
    expect(persisted?.readAt).toBeTruthy();
  });

  it("同频闪信由服务端在已读后隐去内容并保留记录", async () => {
    const sent = await request(runtime.app)
      .post(`/api/contacts/${aliceId}/messages`)
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ body: "只在读到时出现", mode: "flash" })
      .expect(201);
    expect(sent.body.message.mode).toBe("flash");
    expect(sent.body.message.expiresAt).toBeNull();

    const read = await request(runtime.app)
      .patch(`/api/contacts/${bobId}/read`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    const readMessage = read.body.messages.find(
      (message: { id: string }) => message.id === sent.body.message.id,
    );
    expect(readMessage.readAt).toBeTruthy();
    expect(readMessage.expiresAt).toBeTruthy();

    await runtime.store.mutate((database) => {
      const message = database.directMessages.find(
        (candidate) => candidate.id === sent.body.message.id,
      );
      if (message) message.expiresAt = new Date(Date.now() - 1_000).toISOString();
    });
    const messages = await request(runtime.app)
      .get(`/api/contacts/${bobId}/messages`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .expect(200);
    const destroyed = messages.body.messages.find(
      (message: { id: string }) => message.id === sent.body.message.id,
    );
    expect(destroyed.body).toBe("");
    expect(destroyed.destroyedAt).toBeTruthy();
  });

  it("老板派发任务后成员收到任务，权限锁定且进度回传", async () => {
    const address = runtime.server.address() as AddressInfo;
    const memberSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/realtime`,
    );
    const bossSocket = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/realtime`,
    );
    memberSocket.on("open", () => {
      memberSocket.send(JSON.stringify({ type: "auth", token: bobToken }));
    });
    bossSocket.on("open", () => {
      bossSocket.send(JSON.stringify({ type: "auth", token: aliceToken }));
    });
    await Promise.all([
      waitForRealtimeMessage(memberSocket, "realtime:ready"),
      waitForRealtimeMessage(bossSocket, "realtime:ready"),
    ]);

    const pushed = waitForRealtimeMessage(memberSocket, "task:assigned");
    const assigned = await request(runtime.app)
      .post(`/api/boss/members/${bobId}/tasks`)
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({
        title: "提交客户复盘",
        details: "附上结论",
        date: TODAY,
        priority: "p1",
      })
      .expect(201);
    expect((await pushed).data).toMatchObject({
      task: { id: assigned.body.task.id, origin: "assigned" },
      assigner: { id: aliceId },
    });

    const pending = await request(runtime.app)
      .get("/api/tasks/assignments/pending")
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(pending.body.assignments[0].task.id).toBe(assigned.body.task.id);

    const deliveredReceipt = waitForRealtimeMessage(
      bossSocket,
      "task:assignment-receipt",
    );
    await request(runtime.app)
      .patch(`/api/tasks/${assigned.body.task.id}/assignment-delivered`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect((await deliveredReceipt).data).toMatchObject({
      receipt: "delivered",
      task: { id: assigned.body.task.id },
    });

    await request(runtime.app)
      .patch(`/api/tasks/${assigned.body.task.id}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ title: "擅自改名" })
      .expect(403);
    await request(runtime.app)
      .delete(`/api/tasks/${assigned.body.task.id}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(403);

    const statusPush = waitForRealtimeMessage(bossSocket, "task:status");
    await request(runtime.app)
      .patch(`/api/tasks/${assigned.body.task.id}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ status: "done" })
      .expect(200);
    expect((await statusPush).data).toMatchObject({
      task: { id: assigned.body.task.id, status: "done" },
    });
    memberSocket.close();
    bossSocket.close();
  });

  it("昨日未完成任务只复制到今天一次，历史日期保持不变", async () => {
    await request(runtime.app)
      .post("/api/tasks")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({
        date: YESTERDAY,
        title: "不允许补写昨天",
        priority: "p0",
      })
      .expect(400)
      .expect((response) => {
        expect(response.body.error.code).toBe(
          "PAST_TASK_CREATE_FORBIDDEN",
        );
      });
    const originalTaskId = randomUUID();
    const seededAt = new Date().toISOString();
    await runtime.store.mutate((database) => {
      database.tasks.push({
        id: originalTaskId,
        userId: bobId,
        title: "昨日遗留事项",
        details: "",
        date: YESTERDAY,
        status: "todo",
        priority: "p0",
        origin: "self",
        assignedBy: null,
        assignmentId: null,
        sourceTaskId: null,
        assignmentDeliveredAt: null,
        assignmentViewedAt: null,
        completedAt: null,
        createdAt: seededAt,
        updatedAt: seededAt,
      });
    });
    const prompt = await request(runtime.app)
      .get(`/api/tasks/rollover?targetDate=${TODAY}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(prompt.body.pending).toBe(true);

    const carried = await request(runtime.app)
      .post("/api/tasks/rollover")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({
        targetDate: TODAY,
        taskIds: [originalTaskId],
      })
      .expect(201);
    expect(carried.body.created[0]).toMatchObject({
      date: TODAY,
      origin: "carryover",
      sourceTaskId: originalTaskId,
    });

    const repeated = await request(runtime.app)
      .post("/api/tasks/rollover")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({
        targetDate: TODAY,
        taskIds: [originalTaskId],
      })
      .expect(200);
    expect(repeated.body.created).toHaveLength(1);

    const snapshot = await runtime.store.read((database) => ({
      original: database.tasks.find((task) => task.id === originalTaskId),
      copies: database.tasks.filter(
        (task) => task.sourceTaskId === originalTaskId,
      ),
      audit: database.taskAuditEvents.filter(
        (event) => event.taskId === carried.body.created[0].id,
      ),
    }));
    expect(snapshot.original?.date).toBe(YESTERDAY);
    expect(snapshot.copies).toHaveLength(1);
    expect(snapshot.audit[0]?.action).toBe("carried_over");
  });

  it("可从任意往日勾选未完成任务同步到今天且不会重复", async () => {
    const taskId = randomUUID();
    const completedTaskId = randomUUID();
    const seededAt = new Date().toISOString();
    await runtime.store.mutate((database) => {
      database.tasks.push(
        {
          id: taskId,
          userId: bobId,
          title: "往日未完成任务",
          details: "只同步这一条",
          date: YESTERDAY,
          status: "doing",
          priority: "p2",
          origin: "self",
          assignedBy: null,
          assignmentId: null,
          sourceTaskId: null,
          assignmentDeliveredAt: null,
          assignmentViewedAt: null,
          completedAt: null,
          createdAt: seededAt,
          updatedAt: seededAt,
        },
        {
          id: completedTaskId,
          userId: bobId,
          title: "往日已完成任务",
          details: "",
          date: YESTERDAY,
          status: "done",
          priority: "p3",
          origin: "self",
          assignedBy: null,
          assignmentId: null,
          sourceTaskId: null,
          assignmentDeliveredAt: null,
          assignmentViewedAt: null,
          completedAt: seededAt,
          createdAt: seededAt,
          updatedAt: seededAt,
        },
      );
    });

    const candidates = await request(runtime.app)
      .get(`/api/tasks/sync-to-today?sourceDate=${YESTERDAY}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(200);
    expect(
      candidates.body.tasks.map((task: { id: string }) => task.id),
    ).toContain(taskId);
    expect(
      candidates.body.tasks.map((task: { id: string }) => task.id),
    ).not.toContain(completedTaskId);

    const first = await request(runtime.app)
      .post("/api/tasks/sync-to-today")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ sourceDate: YESTERDAY, taskIds: [taskId] })
      .expect(201);
    expect(first.body.created).toHaveLength(1);

    const repeated = await request(runtime.app)
      .post("/api/tasks/sync-to-today")
      .set("Authorization", `Bearer ${bobToken}`)
      .send({ sourceDate: YESTERDAY, taskIds: [taskId] })
      .expect(201);
    expect(repeated.body.created).toHaveLength(0);
    expect(repeated.body.skippedTaskIds).toEqual([taskId]);

    const copies = await runtime.store.read((database) =>
      database.tasks.filter((task) => task.sourceTaskId === taskId),
    );
    expect(copies).toHaveLength(1);
  });

  it("普通成员无法访问管理员端和老板端", async () => {
    await request(runtime.app)
      .get("/api/admin/users")
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(403);
    await request(runtime.app)
      .get(`/api/boss/team?date=${TODAY}`)
      .set("Authorization", `Bearer ${bobToken}`)
      .expect(403);
  });
});
