import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const baseUrl = (process.env.TONGPIN_CLOUDFLARE_TEST_URL ??
  "http://127.0.0.1:8787").replace(/\/$/, "");
const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const testDate = "2026-07-28";
const admin = {
  email: "admin@company.local",
  name: "本地管理员",
  password: "CloudAdmin123!",
};
const memberA = {
  email: `member-a-${runId}@company.local`,
  name: "测试成员甲",
  password: "MemberAlpha123!",
};
const memberB = {
  email: `member-b-${runId}@company.local`,
  name: "测试成员乙",
  password: "MemberBravo123!",
};

class ApiFailure extends Error {
  constructor(status, payload) {
    super(payload?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = payload?.error?.code ?? "REQUEST_FAILED";
    this.payload = payload;
  }
}

async function api(pathname, { method = "GET", token, body } = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload =
    response.status === 204
      ? undefined
      : await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiFailure(response.status, payload);
  return payload;
}

async function expectFailure(action, expectedStatus, expectedCode) {
  try {
    await action();
    assert.fail(`Expected ${expectedCode}`);
  } catch (error) {
    assert(error instanceof ApiFailure);
    assert.equal(error.status, expectedStatus);
    assert.equal(error.code, expectedCode);
  }
}

async function registerAndVerify(profile) {
  const registered = await api("/api/auth/register", {
    method: "POST",
    body: profile,
  });
  assert.equal(registered.delivery, "preview");
  assert.match(registered.debugCode, /^\d{6}$/);
  return api("/api/auth/verify-email", {
    method: "POST",
    body: { email: profile.email, code: registered.debugCode },
  });
}

async function login(profile) {
  return api("/api/auth/login", {
    method: "POST",
    body: { email: profile.email, password: profile.password },
  });
}

async function ensureAdmin() {
  try {
    return await login(admin);
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== "LOGIN_FAILED") {
      throw error;
    }
  }
  try {
    const verified = await registerAndVerify(admin);
    assert.equal(verified.nextStep, "ready_to_login");
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.code !== "EMAIL_EXISTS") {
      throw error;
    }
    const forgot = await api("/api/auth/forgot-password", {
      method: "POST",
      body: { email: admin.email },
    });
    assert.equal(forgot.delivery, "preview");
    assert.match(forgot.debugCode, /^\d{6}$/);
    await api("/api/auth/reset-password", {
      method: "POST",
      body: {
        email: admin.email,
        code: forgot.debugCode,
        password: admin.password,
      },
    });
  }
  const session = await login(admin);
  assert.equal(session.user.role, "admin");
  assert.equal(session.user.status, "active");
  return session;
}

function connectRealtime(accessToken) {
  const websocketUrl = new URL(`${baseUrl}/api/realtime`);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(websocketUrl);
  const messages = [];
  const listeners = new Set();

  socket.on("open", () => {
    socket.send(JSON.stringify({ type: "auth", token: accessToken }));
  });
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    for (const listener of listeners) listener(message);
  });

  function waitFor(type, timeoutMs = 5_000) {
    const existing = messages.find((message) => message.type === type);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(listener);
        reject(new Error(`Timed out waiting for WebSocket message ${type}`));
      }, timeoutMs);
      const listener = (message) => {
        if (message.type !== type) return;
        clearTimeout(timer);
        listeners.delete(listener);
        resolve(message);
      };
      listeners.add(listener);
    });
  }

  return { socket, waitFor };
}

const health = await api("/api/health");
assert.equal(health.storage, "durable-object-sqlite");
assert.equal(health.realtime, "websocket");
assert.equal(health.mailMode, "preview");

const adminSession = await ensureAdmin();
const adminToken = adminSession.accessToken;

for (const member of [memberA, memberB]) {
  const verified = await registerAndVerify(member);
  assert.equal(verified.nextStep, "await_approval");
  await expectFailure(() => login(member), 403, "ACCOUNT_PENDING");
}

const usersBeforeApproval = await api("/api/admin/users", {
  token: adminToken,
});
const userA = usersBeforeApproval.users.find(
  (user) => user.email === memberA.email,
);
const userB = usersBeforeApproval.users.find(
  (user) => user.email === memberB.email,
);
assert(userA);
assert(userB);
assert.equal(userA.status, "pending_approval");

for (const user of [userA, userB]) {
  const approved = await api(`/api/admin/users/${user.id}/access`, {
    method: "PATCH",
    token: adminToken,
    body: { status: "active" },
  });
  assert.equal(approved.user.status, "active");
}

let sessionA = await login(memberA);
const sessionBAsMember = await login(memberB);
assert.equal(sessionA.user.role, "member");
assert.equal(sessionBAsMember.user.role, "member");

const createdTasks = [];
for (const priority of ["p0", "p1", "p2", "p3", "p4"]) {
  const result = await api("/api/tasks", {
    method: "POST",
    token: sessionA.accessToken,
    body: {
      title: `${priority.toUpperCase()} 验证任务`,
      details: `优先级 ${priority} 的云端持久化任务`,
      date: testDate,
      priority,
      status: "todo",
    },
  });
  createdTasks.push(result.task);
}

const ownTasks = await api(`/api/tasks?date=${testDate}`, {
  token: sessionA.accessToken,
});
assert.equal(ownTasks.tasks.length, 5);
assert.deepEqual(
  new Set(ownTasks.tasks.map((task) => task.priority)),
  new Set(["p0", "p1", "p2", "p3", "p4"]),
);

const completed = await api(`/api/tasks/${createdTasks[0].id}`, {
  method: "PATCH",
  token: sessionA.accessToken,
  body: { status: "done" },
});
assert.equal(completed.task.status, "done");
assert(completed.task.completedAt);

await expectFailure(
  () =>
    api(`/api/tasks/${createdTasks[1].id}`, {
      method: "PATCH",
      token: sessionBAsMember.accessToken,
      body: { status: "done" },
    }),
  404,
  "TASK_NOT_FOUND",
);

const promoted = await api(`/api/admin/users/${userB.id}/role`, {
  method: "PATCH",
  token: adminToken,
  body: { role: "boss" },
});
assert.equal(promoted.user.role, "boss");
assert.equal(promoted.sessionRevoked, true);

const bossSession = await login(memberB);
assert.equal(bossSession.user.role, "boss");
await expectFailure(
  () =>
    api("/api/auth/me/avatar", {
      method: "PATCH",
      token: bossSession.accessToken,
      body: { dataUrl: null },
    }),
  403,
  "BOSS_AVATAR_LOCKED",
);

const avatarDataUrl =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const avatarResult = await api("/api/auth/me/avatar", {
  method: "PATCH",
  token: sessionA.accessToken,
  body: { dataUrl: avatarDataUrl },
});
assert.equal(avatarResult.user.hasCustomAvatar, true);
const avatarResponse = await fetch(
  `${baseUrl}/api/avatars/${sessionA.user.id}?v=${avatarResult.user.avatarVersion}`,
);
assert.equal(avatarResponse.status, 200);
assert.equal(avatarResponse.headers.get("content-type"), "image/png");

const team = await api(`/api/boss/team?date=${testDate}`, {
  token: bossSession.accessToken,
});
const memberAProgress = team.members.filter(
  (member) => member.user.id === sessionA.user.id,
);
assert.equal(memberAProgress.length, 1);
assert.equal(memberAProgress[0].total, 5);
assert.equal(memberAProgress[0].done, 1);

const memberTasks = await api(
  `/api/boss/members/${sessionA.user.id}/tasks?date=${testDate}`,
  { token: bossSession.accessToken },
);
assert.equal(memberTasks.user.name, memberA.name);
assert.equal(memberTasks.tasks.length, 5);

const profile = await api(`/api/admin/users/${sessionA.user.id}/profile`, {
  method: "PATCH",
  token: adminToken,
  body: { jobTitle: "产品设计师" },
});
assert.equal(profile.user.jobTitle, "产品设计师");

const assignmentRealtime = connectRealtime(sessionA.accessToken);
await assignmentRealtime.waitFor("realtime:ready");
const assignmentPromise = assignmentRealtime.waitFor("task:assigned");
const assigned = await api(
  `/api/boss/members/${sessionA.user.id}/tasks`,
  {
    method: "POST",
    token: bossSession.accessToken,
    body: {
      title: "整理明日客户复盘",
      details: "附上结论与下一步",
      date: "2026-07-29",
      priority: "p1",
    },
  },
);
const assignmentEvent = await assignmentPromise;
assert.equal(assignmentEvent.data.task.id, assigned.task.id);
assert.equal(assigned.task.origin, "assigned");
const pendingAssignments = await api("/api/tasks/assignments/pending", {
  token: sessionA.accessToken,
});
assert(
  pendingAssignments.assignments.some(
    (item) => item.task.id === assigned.task.id,
  ),
);
await api(`/api/tasks/${assigned.task.id}/assignment-delivered`, {
  method: "PATCH",
  token: sessionA.accessToken,
});
await api(`/api/tasks/${assigned.task.id}/assignment-viewed`, {
  method: "PATCH",
  token: sessionA.accessToken,
});
await expectFailure(
  () =>
    api(`/api/tasks/${assigned.task.id}`, {
      method: "PATCH",
      token: sessionA.accessToken,
      body: { title: "成员擅自改名" },
    }),
  403,
  "ASSIGNED_TASK_LOCKED",
);
assignmentRealtime.socket.close();

const rolloverPrompt = await api(
  "/api/tasks/rollover?targetDate=2026-07-29",
  { token: sessionA.accessToken },
);
assert.equal(rolloverPrompt.pending, true);
assert(
  rolloverPrompt.tasks.some((task) => task.id === createdTasks[1].id),
);
const rollover = await api("/api/tasks/rollover", {
  method: "POST",
  token: sessionA.accessToken,
  body: {
    targetDate: "2026-07-29",
    taskIds: [createdTasks[1].id],
  },
});
assert.equal(rollover.created.length, 1);
assert.equal(rollover.created[0].origin, "carryover");
assert.equal(rollover.created[0].sourceTaskId, createdTasks[1].id);
const rolloverRepeated = await api("/api/tasks/rollover", {
  method: "POST",
  token: sessionA.accessToken,
  body: {
    targetDate: "2026-07-29",
    taskIds: [createdTasks[1].id],
  },
});
assert.equal(rolloverRepeated.created.length, 1);
const yesterdayAfterRollover = await api(`/api/tasks?date=${testDate}`, {
  token: sessionA.accessToken,
});
assert(
  yesterdayAfterRollover.tasks.some(
    (task) => task.id === createdTasks[1].id,
  ),
);

const contact = await api("/api/contacts", {
  method: "POST",
  token: sessionA.accessToken,
  body: { userId: bossSession.user.id },
});
assert.equal(contact.contact.user.jobTitle, "");
const flash = await api(
  `/api/contacts/${bossSession.user.id}/messages`,
  {
    method: "POST",
    token: sessionA.accessToken,
    body: { body: "只保留到已读后的五秒", mode: "flash" },
  },
);
assert.equal(flash.message.mode, "flash");
const flashRead = await api(
  `/api/contacts/${sessionA.user.id}/read`,
  {
    method: "PATCH",
    token: bossSession.accessToken,
  },
);
assert(
  flashRead.messages.some(
    (message) =>
      message.id === flash.message.id &&
      message.readAt &&
      message.expiresAt,
  ),
);
await new Promise((resolve) => setTimeout(resolve, 5_500));
const flashMessages = await api(
  `/api/contacts/${bossSession.user.id}/messages`,
  { token: sessionA.accessToken },
);
const destroyedFlash = flashMessages.messages.find(
  (message) => message.id === flash.message.id,
);
assert.equal(destroyedFlash.body, "");
assert(destroyedFlash.destroyedAt);

const realtime = connectRealtime(sessionA.accessToken);
await realtime.waitFor("realtime:ready");
const notificationPromise = realtime.waitFor("notification:new");
const pushed = await api("/api/boss/notifications", {
  method: "POST",
  token: bossSession.accessToken,
  body: {
    all: false,
    recipientIds: [sessionA.user.id],
    title: "即时推送验证",
    body: "这是一条通过标准 WebSocket 送达的桌面通知。",
  },
});
assert.equal(pushed.delivered, 1);
const received = await notificationPromise;
assert.equal(received.data.id, pushed.notifications[0].id);
realtime.socket.close();

const inbox = await api("/api/notifications", {
  token: sessionA.accessToken,
});
assert(inbox.notifications.some((item) => item.id === received.data.id));
const read = await api(`/api/notifications/${received.data.id}/read`, {
  method: "PATCH",
  token: sessionA.accessToken,
});
assert(read.notification.readAt);

const forgot = await api("/api/auth/forgot-password", {
  method: "POST",
  body: { email: memberA.email },
});
assert.equal(forgot.delivery, "preview");
assert.match(forgot.debugCode, /^\d{6}$/);
const newPassword = "MemberAlpha456!";
await api("/api/auth/reset-password", {
  method: "POST",
  body: {
    email: memberA.email,
    code: forgot.debugCode,
    password: newPassword,
  },
});
await expectFailure(() => login(memberA), 401, "LOGIN_FAILED");
memberA.password = newPassword;
sessionA = await login(memberA);
const tasksAfterRelogin = await api(`/api/tasks?date=${testDate}`, {
  token: sessionA.accessToken,
});
assert.equal(tasksAfterRelogin.tasks.length, 5);

const result = {
  ok: true,
  baseUrl,
  runId,
  date: testDate,
  adminEmail: admin.email,
  memberEmail: memberA.email,
  memberPassword: memberA.password,
  memberId: sessionA.user.id,
  taskIds: createdTasks.map((task) => task.id),
  notificationId: received.data.id,
  checks: [
    "email registration and verification",
    "admin approval",
    "role promotion and session revocation",
    "per-user task isolation",
    "P0-P4 task persistence and completion",
    "member avatar upload and boss avatar lock",
    "boss team progress and task inspection",
    "admin-managed job title profile",
    "boss task assignment, realtime delivery, receipts, and member lock",
    "idempotent yesterday-to-today rollover with history retained",
    "contact messaging and server-authoritative flash expiry",
    "standard WebSocket notification delivery",
    "notification inbox and read state",
    "password reset and cross-login data persistence",
  ],
};
const outputDirectory = path.resolve("output");
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  path.join(outputDirectory, "cloudflare-e2e-result.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8",
);
console.log(JSON.stringify(result, null, 2));
