import { DurableObject } from "cloudflare:workers";
import type {
  AppNotification,
  DirectMessage,
  NotificationDispatch,
  NotificationReceipt,
  Task,
  TaskAuditAction,
  TaskAuditChange,
  TaskAuditEvent,
  TaskPriority,
  TaskStatus,
  UserRole,
  VerificationPurpose,
} from "../../server/types";
import { businessDateKey } from "../../server/business-date";
import { getMailMode, sendCodeEmail } from "./mailer";
import {
  ApiError,
  errorResponse,
  firstRow,
  isEnabled,
  json,
  normalizeEmail,
  parseJson,
  toDirectMessage,
  toNotification,
  toPublicUser,
  toTask,
  type DirectMessageRow,
  type NotificationDispatchRow,
  type NotificationRow,
  type NotificationReceiptRow,
  type TaskRow,
  type UserRow,
  type WorkerEnv,
} from "./platform";
import {
  DATABASE_MIGRATION_2,
  DATABASE_MIGRATION_3,
  DATABASE_MIGRATION_4,
  DATABASE_SCHEMA,
} from "./schema";
import {
  generateCode,
  hashOpaque,
  hashPassword,
  issueAccessToken,
  randomAvatarSeed,
  randomToken,
  verifyAccessToken,
  verifyPassword,
} from "./security";
import {
  parseAccessStatus,
  parseAvatar,
  parseContactRequest,
  parseContactSearch,
  parseDate,
  parseDirectMessage,
  parseEmail,
  parseJobTitle,
  parseLogin,
  parseNotificationRequest,
  parseRefreshToken,
  parseRegister,
  parseResend,
  parseResetPassword,
  parseRole,
  parseTaskCreate,
  parseTaskAssignment,
  parseTaskPatch,
  parseTaskRollover,
  parseTaskSync,
  parseVerification,
} from "./validation";

interface RefreshRow extends Record<string, SqlStorageValue> {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  last_used_at: string;
  user_agent: string;
}

interface VerificationRow extends Record<string, SqlStorageValue> {
  id: string;
  user_id: string | null;
  email: string;
  purpose: VerificationPurpose;
  code_hash: string;
  expires_at: string;
  attempts: number;
  consumed_at: string | null;
  created_at: string;
}

interface ContactRow extends Record<string, SqlStorageValue> {
  owner_id: string;
  contact_id: string;
  created_at: string;
}

interface CountRow extends Record<string, SqlStorageValue> {
  count: number;
}

interface RolloverDecisionRow extends Record<string, SqlStorageValue> {
  id: string;
  user_id: string;
  source_date: string;
  target_date: string;
  selected_task_ids: string;
  created_at: string;
}

interface TaskAuditRow extends Record<string, SqlStorageValue> {
  id: string;
  task_id: string;
  user_id: string;
  actor_id: string;
  action: TaskAuditAction;
  changes_json: string;
  snapshot_json: string;
  created_at: string;
}

interface SchemaColumnRow extends Record<string, SqlStorageValue> {
  name: string;
}

interface SocketAttachment {
  userId: string;
}

function decodeAvatarDataUrl(dataUrl: string): {
  contentType: string;
  bytes: Uint8Array;
} {
  const match = dataUrl.match(
    /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/,
  );
  if (!match) {
    throw new ApiError(
      400,
      "AVATAR_FORMAT_INVALID",
      "头像只支持 PNG、JPG 或 WebP 图片",
    );
  }
  const [, contentType, encoded] = match;
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length === 0 || bytes.length > 512 * 1024) {
    throw new ApiError(
      413,
      "AVATAR_TOO_LARGE",
      "头像处理后不能超过 512KB",
    );
  }
  const isPng =
    contentType === "image/png" &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (byte, index) => bytes[index] === byte,
    );
  const isJpeg =
    contentType === "image/jpeg" &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const isWebp =
    contentType === "image/webp" &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  if (!isPng && !isJpeg && !isWebp) {
    throw new ApiError(
      400,
      "AVATAR_CONTENT_INVALID",
      "图片内容与文件格式不一致",
    );
  }
  return { contentType, bytes };
}

function priorityRank(priority: TaskPriority): number {
  return { p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 }[priority];
}

function statusRank(status: TaskStatus): number {
  return { doing: 0, todo: 1, done: 2 }[status];
}

function previousDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function auditTaskChanges(before: Task, after: Task): TaskAuditChange[] {
  const fields = [
    "title",
    "details",
    "date",
    "priority",
    "status",
  ] as const;
  return fields.flatMap((field) =>
    before[field] === after[field]
      ? []
      : [{ field, before: before[field], after: after[field] }],
  );
}

export class TongpinCore extends DurableObject<WorkerEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private hasColumn(table: "users" | "tasks" | "direct_messages", column: string) {
    return this.sql
      .exec<SchemaColumnRow>(`PRAGMA table_info(${table})`)
      .toArray()
      .some((item) => item.name === column);
  }

  private taskPrioritySupportsP4(): boolean {
    const table = firstRow(
      this.sql.exec<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
      ),
    );
    return table?.sql.includes("'p4'") ?? false;
  }

  private migrate(): void {
    this.sql.exec("PRAGMA foreign_keys = ON;");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const version = Number(
      firstRow(
        this.sql.exec<{ version: number }>(
          "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
        ),
      )?.version ?? 0,
    );

    this.sql.exec(DATABASE_SCHEMA);
    if (version < 1) {
      this.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1)",
      );
    }
    if (version < 2) {
      const additions = [
        ["users", "job_title", "TEXT NOT NULL DEFAULT ''"],
        [
          "tasks",
          "origin",
          "TEXT NOT NULL DEFAULT 'self' CHECK (origin IN ('self', 'assigned', 'carryover'))",
        ],
        ["tasks", "assigned_by", "TEXT"],
        ["tasks", "assignment_id", "TEXT"],
        ["tasks", "source_task_id", "TEXT"],
        ["tasks", "assignment_delivered_at", "TEXT"],
        ["tasks", "assignment_viewed_at", "TEXT"],
        [
          "direct_messages",
          "mode",
          "TEXT NOT NULL DEFAULT 'normal' CHECK (mode IN ('normal', 'flash'))",
        ],
        ["direct_messages", "expires_at", "TEXT"],
        ["direct_messages", "destroyed_at", "TEXT"],
      ] as const;
      for (const [table, column, definition] of additions) {
        if (!this.hasColumn(table, column)) {
          this.sql.exec(
            `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
          );
        }
      }
      this.sql.exec(DATABASE_MIGRATION_2);
      this.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (2)",
      );
    }
    if (version < 3) {
      if (this.taskPrioritySupportsP4()) {
        this.sql.exec(
          "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3)",
        );
      } else {
        this.ctx.storage.transactionSync(() => {
          const sourceCount = Number(
            firstRow(
              this.sql.exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM tasks",
              ),
            )?.count ?? 0,
          );
          this.sql.exec(DATABASE_MIGRATION_3);
          const migratedCount = Number(
            firstRow(
              this.sql.exec<{ count: number }>(
                "SELECT COUNT(*) AS count FROM tasks",
              ),
            )?.count ?? 0,
          );
          if (sourceCount !== migratedCount) {
            throw new Error("P4 数据迁移校验失败");
          }
          this.sql.exec(
            "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3)",
          );
        });
      }
    }
    if (version < 4) {
      this.sql.exec(DATABASE_MIGRATION_4);
      this.sql.exec(
        "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (4)",
      );
    }
  }

  private recordTaskAudit(
    task: Task,
    actorId: string,
    action: TaskAuditAction,
    changes: TaskAuditChange[] = [],
    createdAt = new Date().toISOString(),
  ): void {
    this.sql.exec(
      `INSERT INTO task_audit_events
       (id, task_id, user_id, actor_id, action, changes_json, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      task.id,
      task.userId,
      actorId,
      action,
      JSON.stringify(changes),
      JSON.stringify(task),
      createdAt,
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (path === "/api/realtime") {
        return this.upgradeRealtime(request);
      }
      if (path === "/api/health" && method === "GET") {
        return json({
          ok: true,
          service: "tongpin-cloudflare-api",
          storage: "durable-object-sqlite",
          realtime: "websocket",
          mailMode: getMailMode(this.env),
          time: new Date().toISOString(),
        });
      }
      if (path.startsWith("/api/avatars/") && method === "GET") {
        return this.getAvatar(decodeURIComponent(path.slice(13)));
      }

      if (path.startsWith("/api/auth/") && method === "POST") {
        await this.enforceAuthRate(request, path);
      }
      if (path === "/api/auth/register" && method === "POST") {
        return await this.register(request);
      }
      if (path === "/api/auth/verify-email" && method === "POST") {
        return await this.verifyEmail(request);
      }
      if (path === "/api/auth/resend-code" && method === "POST") {
        return await this.resendCode(request);
      }
      if (path === "/api/auth/login" && method === "POST") {
        return await this.login(request);
      }
      if (path === "/api/auth/refresh" && method === "POST") {
        return await this.refresh(request);
      }
      if (path === "/api/auth/logout" && method === "POST") {
        return await this.logout(request);
      }
      if (path === "/api/auth/forgot-password" && method === "POST") {
        return await this.forgotPassword(request);
      }
      if (path === "/api/auth/reset-password" && method === "POST") {
        return await this.resetPassword(request);
      }
      if (path === "/api/auth/me/avatar" && method === "PATCH") {
        return await this.updateAvatar(request);
      }
      if (path === "/api/auth/me" && method === "GET") {
        const user = await this.requireUser(request);
        return json({ user: toPublicUser(user) });
      }

      if (path === "/api/tasks" && method === "GET") {
        return await this.getTasks(request, url);
      }
      if (path === "/api/tasks/summary" && method === "GET") {
        return await this.getTaskSummary(request, url);
      }
      if (path === "/api/tasks/rollover" && method === "GET") {
        return await this.getTaskRollover(request, url);
      }
      if (path === "/api/tasks/rollover" && method === "POST") {
        return await this.applyTaskRollover(request);
      }
      if (path === "/api/tasks/sync-to-today" && method === "GET") {
        return await this.getTaskSyncToToday(request, url);
      }
      if (path === "/api/tasks/sync-to-today" && method === "POST") {
        return await this.applyTaskSyncToToday(request);
      }
      if (path === "/api/tasks/assignments/pending" && method === "GET") {
        return await this.getPendingAssignments(request);
      }
      if (path === "/api/tasks" && method === "POST") {
        return await this.createTask(request);
      }
      const assignmentReceiptMatch = path.match(
        /^\/api\/tasks\/([0-9a-f-]+)\/assignment-(delivered|viewed)$/i,
      );
      if (assignmentReceiptMatch && method === "PATCH") {
        return await this.markAssignmentReceipt(
          request,
          assignmentReceiptMatch[1],
          assignmentReceiptMatch[2] as "delivered" | "viewed",
        );
      }
      const taskMatch = path.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
      if (taskMatch && method === "PATCH") {
        return await this.patchTask(request, taskMatch[1]);
      }
      if (taskMatch && method === "DELETE") {
        return await this.deleteTask(request, taskMatch[1]);
      }

      if (path === "/api/admin/users" && method === "GET") {
        return await this.getAdminUsers(request);
      }
      const accessMatch = path.match(
        /^\/api\/admin\/users\/([0-9a-f-]+)\/access$/i,
      );
      if (accessMatch && method === "PATCH") {
        return await this.changeAccess(request, accessMatch[1]);
      }
      const roleMatch = path.match(
        /^\/api\/admin\/users\/([0-9a-f-]+)\/role$/i,
      );
      if (roleMatch && method === "PATCH") {
        return await this.changeRole(request, roleMatch[1]);
      }
      const profileMatch = path.match(
        /^\/api\/admin\/users\/([0-9a-f-]+)\/profile$/i,
      );
      if (profileMatch && method === "PATCH") {
        return await this.changeUserProfile(request, profileMatch[1]);
      }

      if (path === "/api/boss/team" && method === "GET") {
        return await this.getTeam(request, url);
      }
      const memberTaskHistoryMatch = path.match(
        /^\/api\/boss\/members\/([0-9a-f-]+)\/tasks\/([0-9a-f-]+)\/history$/i,
      );
      if (memberTaskHistoryMatch && method === "GET") {
        return await this.getMemberTaskHistory(
          request,
          memberTaskHistoryMatch[1],
          memberTaskHistoryMatch[2],
        );
      }
      const memberTasksMatch = path.match(
        /^\/api\/boss\/members\/([0-9a-f-]+)\/tasks$/i,
      );
      if (memberTasksMatch && method === "GET") {
        return await this.getMemberTasks(
          request,
          url,
          memberTasksMatch[1],
        );
      }
      if (memberTasksMatch && method === "POST") {
        return await this.assignMemberTask(
          request,
          memberTasksMatch[1],
        );
      }
      if (path === "/api/boss/notifications" && method === "POST") {
        return await this.createNotifications(request);
      }
      if (
        path === "/api/boss/notification-dispatches" &&
        method === "GET"
      ) {
        return await this.getNotificationDispatches(request);
      }
      const dingMatch = path.match(
        /^\/api\/boss\/notification-dispatches\/([0-9a-f-]+)\/ding$/i,
      );
      if (dingMatch && method === "POST") {
        return await this.dingNotificationDispatch(request, dingMatch[1]);
      }

      if (path === "/api/contacts/search" && method === "GET") {
        return await this.searchContacts(request, url);
      }
      if (path === "/api/contacts" && method === "GET") {
        return await this.getContacts(request);
      }
      if (path === "/api/contacts" && method === "POST") {
        return await this.addContact(request);
      }
      const contactMatch = path.match(
        /^\/api\/contacts\/([0-9a-f-]+)\/(messages|read)$/i,
      );
      if (contactMatch && contactMatch[2] === "messages" && method === "GET") {
        return await this.getDirectMessages(request, contactMatch[1]);
      }
      if (contactMatch && contactMatch[2] === "messages" && method === "POST") {
        return await this.sendDirectMessage(request, contactMatch[1]);
      }
      if (contactMatch && contactMatch[2] === "read" && method === "PATCH") {
        return await this.readDirectMessages(request, contactMatch[1]);
      }

      if (path === "/api/notifications" && method === "GET") {
        return await this.getNotifications(request);
      }
      const readMatch = path.match(
        /^\/api\/notifications\/([0-9a-f-]+)\/read$/i,
      );
      if (readMatch && method === "PATCH") {
        return await this.readNotification(request, readMatch[1]);
      }
      const deliveredMatch = path.match(
        /^\/api\/notifications\/([0-9a-f-]+)\/delivered$/i,
      );
      if (deliveredMatch && method === "PATCH") {
        return await this.deliverNotification(request, deliveredMatch[1]);
      }
      const acknowledgeMatch = path.match(
        /^\/api\/notifications\/([0-9a-f-]+)\/acknowledge$/i,
      );
      if (acknowledgeMatch && method === "PATCH") {
        return await this.acknowledgeNotification(
          request,
          acknowledgeMatch[1],
        );
      }

      throw new ApiError(404, "NOT_FOUND", "请求的接口不存在");
    } catch (error) {
      return errorResponse(error);
    }
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    try {
      const raw =
        typeof message === "string"
          ? message
          : new TextDecoder().decode(message);
      const payload = JSON.parse(raw) as { type?: string; token?: string };
      if (payload.type === "auth" && typeof payload.token === "string") {
        const claims = await verifyAccessToken(payload.token, this.env);
        const user = this.userById(claims.sub);
        if (!user || user.status !== "active") {
          socket.close(4001, "unauthorized");
          return;
        }
        socket.serializeAttachment({ userId: user.id } satisfies SocketAttachment);
        socket.send(
          JSON.stringify({
            type: "realtime:ready",
            data: { connected: true },
          }),
        );
        return;
      }
      if (payload.type === "ping") {
        socket.send(JSON.stringify({ type: "pong" }));
        return;
      }
      socket.close(4002, "authentication required");
    } catch {
      socket.close(4000, "invalid message");
    }
  }

  webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): void {
    if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
  }

  webSocketError(_socket: WebSocket, error: unknown): void {
    console.error("Tongpin realtime WebSocket error", error);
  }

  async alarm(): Promise<void> {
    this.expireDueFlashMessages();
    await this.scheduleNextFlashAlarm();
  }

  private upgradeRealtime(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "WEBSOCKET_REQUIRED", "需要 WebSocket 连接");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private userById(id: string): UserRow | undefined {
    return firstRow(
      this.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", id),
    );
  }

  private userByEmail(email: string): UserRow | undefined {
    return firstRow(
      this.sql.exec<UserRow>(
        "SELECT * FROM users WHERE email = ? COLLATE NOCASE",
        email,
      ),
    );
  }

  private async requireUser(
    request: Request,
    roles?: UserRole[],
  ): Promise<UserRow> {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) {
      throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
    }
    let claims: { sub: string; role: UserRole };
    try {
      claims = await verifyAccessToken(authorization.slice(7), this.env);
    } catch {
      throw new ApiError(
        401,
        "SESSION_INVALID",
        "登录状态已失效，请重新登录",
      );
    }
    const user = this.userById(claims.sub);
    if (!user || user.status !== "active") {
      throw new ApiError(
        401,
        "SESSION_INVALID",
        "登录状态已失效，请重新登录",
      );
    }
    if (roles && !roles.includes(user.role)) {
      throw new ApiError(403, "FORBIDDEN", "你没有访问此功能的权限");
    }
    return user;
  }

  private async enforceAuthRate(
    request: Request,
    path: string,
  ): Promise<void> {
    const now = Date.now();
    const windowMs = 10 * 60 * 1000;
    const ip =
      request.headers.get("CF-Connecting-IP") ??
      request.headers.get("x-forwarded-for") ??
      "local";
    const key = `${ip}:${path}`;
    const current = firstRow(
      this.sql.exec<{
        key: string;
        window_started: number;
        count: number;
      }>("SELECT * FROM rate_limits WHERE key = ?", key),
    );
    if (!current || now - current.window_started >= windowMs) {
      this.sql.exec(
        `INSERT INTO rate_limits (key, window_started, count)
         VALUES (?, ?, 1)
         ON CONFLICT(key) DO UPDATE SET window_started = excluded.window_started, count = 1`,
        key,
        now,
      );
      return;
    }
    if (current.count >= 40) {
      throw new ApiError(
        429,
        "RATE_LIMITED",
        "请求过于频繁，请稍后再试",
      );
    }
    this.sql.exec(
      "UPDATE rate_limits SET count = count + 1 WHERE key = ?",
      key,
    );
  }

  private cleanupSecurityRecords(): void {
    const nowIso = new Date().toISOString();
    const codeCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    this.sql.exec(
      "DELETE FROM refresh_sessions WHERE expires_at <= ?",
      nowIso,
    );
    this.sql.exec(
      `DELETE FROM verification_codes
       WHERE expires_at <= ? AND (consumed_at IS NULL OR consumed_at <= ?)`,
      codeCutoff,
      codeCutoff,
    );
    this.sql.exec(
      "DELETE FROM rate_limits WHERE window_started < ?",
      Date.now() - 24 * 60 * 60 * 1000,
    );
  }

  private async createVerification(
    email: string,
    userId: string | null,
    purpose: VerificationPurpose,
  ): Promise<{
    provider: "resend" | "preview";
    debugCode?: string;
  }> {
    this.cleanupSecurityRecords();
    const latest = firstRow(
      this.sql.exec<VerificationRow>(
        `SELECT * FROM verification_codes
         WHERE email = ? COLLATE NOCASE AND purpose = ? AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        email,
        purpose,
      ),
    );
    if (
      latest &&
      Date.now() - Date.parse(latest.created_at) < 60 * 1000
    ) {
      throw new ApiError(
        429,
        "CODE_COOLDOWN",
        "验证码发送过于频繁，请 60 秒后再试",
      );
    }

    const now = new Date();
    const id = crypto.randomUUID();
    const code = generateCode();
    const codeHash = await hashOpaque(code);
    this.sql.exec(
      `UPDATE verification_codes SET consumed_at = ?
       WHERE email = ? COLLATE NOCASE AND purpose = ? AND consumed_at IS NULL`,
      now.toISOString(),
      email,
      purpose,
    );
    this.sql.exec(
      `INSERT INTO verification_codes
       (id, user_id, email, purpose, code_hash, expires_at, attempts, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
      id,
      userId,
      email,
      purpose,
      codeHash,
      new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
      now.toISOString(),
    );
    try {
      const delivery = await sendCodeEmail(
        this.env,
        email,
        purpose,
        code,
        `verification-${purpose}-${id}`,
      );
      return {
        provider: delivery.provider,
        debugCode: delivery.provider === "preview" ? code : undefined,
      };
    } catch (error) {
      this.sql.exec(
        `UPDATE verification_codes SET consumed_at = ?
         WHERE id = ? AND consumed_at IS NULL`,
        new Date().toISOString(),
        id,
      );
      throw error;
    }
  }

  private async register(request: Request): Promise<Response> {
    const body = parseRegister(await parseJson(request));
    const email = normalizeEmail(body.email);
    const passwordHash = await hashPassword(body.password);
    const now = new Date().toISOString();
    const bootstrapEmail = normalizeEmail(
      this.env.BOOTSTRAP_ADMIN_EMAIL ?? "",
    );
    const existing = this.userByEmail(email);
    if (existing && existing.status !== "pending_email") {
      throw new ApiError(409, "EMAIL_EXISTS", "该邮箱已经注册");
    }

    let userId: string;
    if (existing) {
      userId = existing.id;
      this.sql.exec(
        `UPDATE users
         SET name = ?, password_hash = ?, role = ?, updated_at = ?
         WHERE id = ?`,
        body.name,
        passwordHash,
        email === bootstrapEmail ? "admin" : "member",
        now,
        existing.id,
      );
    } else {
      userId = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO users
         (id, email, name, password_hash, role, status, avatar_seed, avatar_version,
          avatar_data_url, email_verified_at, last_login_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending_email', ?, 0, NULL, NULL, NULL, ?, ?)`,
        userId,
        email,
        body.name,
        passwordHash,
        email === bootstrapEmail ? "admin" : "member",
        randomAvatarSeed(),
        now,
        now,
      );
    }

    const delivery = await this.createVerification(
      email,
      userId,
      "register",
    );
    return json(
      {
        nextStep: "verify_email",
        email,
        delivery: delivery.provider,
        debugCode: delivery.debugCode,
      },
      201,
    );
  }

  private async verifyEmail(request: Request): Promise<Response> {
    const body = parseVerification(await parseJson(request));
    const email = normalizeEmail(body.email);
    const user = this.userByEmail(email);
    if (!user) {
      throw new ApiError(404, "ACCOUNT_NOT_FOUND", "没有找到该注册账号");
    }
    if (user.email_verified_at) {
      return json({
        nextStep:
          user.role === "admin" && user.status === "active"
            ? "ready_to_login"
            : "await_approval",
        user: toPublicUser(user),
      });
    }

    const verification = firstRow(
      this.sql.exec<VerificationRow>(
        `SELECT * FROM verification_codes
         WHERE email = ? COLLATE NOCASE AND purpose = 'register' AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        email,
      ),
    );
    if (
      !verification ||
      Date.parse(verification.expires_at) <= Date.now()
    ) {
      throw new ApiError(400, "CODE_EXPIRED", "验证码已过期，请重新发送");
    }
    if (verification.attempts >= 5) {
      throw new ApiError(
        429,
        "CODE_LOCKED",
        "验证码错误次数过多，请重新发送",
      );
    }
    const codeHash = await hashOpaque(body.code);
    if (verification.code_hash !== codeHash) {
      this.sql.exec(
        "UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?",
        verification.id,
      );
      throw new ApiError(400, "CODE_INVALID", "验证码不正确");
    }

    const now = new Date().toISOString();
    const isBootstrapAdmin =
      user.role === "admin" &&
      email === normalizeEmail(this.env.BOOTSTRAP_ADMIN_EMAIL ?? "");
    this.sql.exec(
      "UPDATE verification_codes SET consumed_at = ? WHERE id = ?",
      now,
      verification.id,
    );
    this.sql.exec(
      `UPDATE users
       SET email_verified_at = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      now,
      isBootstrapAdmin ? "active" : "pending_approval",
      now,
      user.id,
    );
    const updated = this.userById(user.id)!;
    return json({
      nextStep: isBootstrapAdmin ? "ready_to_login" : "await_approval",
      user: toPublicUser(updated),
    });
  }

  private async resendCode(request: Request): Promise<Response> {
    const body = parseResend(await parseJson(request));
    const email = normalizeEmail(body.email);
    const user = this.userByEmail(email);
    if (!user) return json({ sent: true });
    if (body.purpose === "register" && user.email_verified_at) {
      throw new ApiError(409, "ALREADY_VERIFIED", "该邮箱已经完成验证");
    }
    const delivery = await this.createVerification(
      email,
      user.id,
      body.purpose,
    );
    return json({
      sent: true,
      delivery: delivery.provider,
      debugCode: delivery.debugCode,
    });
  }

  private async issueSession(
    user: UserRow,
    userAgent: string,
  ): Promise<{
    accessToken: string;
    refreshToken: string;
    user: ReturnType<typeof toPublicUser>;
  }> {
    const rawRefresh = randomToken();
    const tokenHash = await hashOpaque(rawRefresh);
    const now = new Date();
    this.sql.exec(
      `INSERT INTO refresh_sessions
       (id, user_id, token_hash, expires_at, created_at, last_used_at, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      user.id,
      tokenHash,
      new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      now.toISOString(),
      now.toISOString(),
      userAgent.slice(0, 300),
    );
    return {
      accessToken: await issueAccessToken(user.id, user.role, this.env),
      refreshToken: rawRefresh,
      user: toPublicUser(user),
    };
  }

  private async login(request: Request): Promise<Response> {
    const body = parseLogin(await parseJson(request));
    const email = normalizeEmail(body.email);
    const user = this.userByEmail(email);
    const matches = await verifyPassword(
      body.password,
      user?.password_hash ?? "invalid",
    );
    if (!user || !matches) {
      throw new ApiError(401, "LOGIN_FAILED", "邮箱或密码不正确");
    }
    if (user.status === "pending_email") {
      throw new ApiError(403, "EMAIL_NOT_VERIFIED", "请先完成邮箱验证");
    }
    if (user.status === "pending_approval") {
      throw new ApiError(
        403,
        "ACCOUNT_PENDING",
        "账号正在等待管理员批准",
      );
    }
    if (user.status === "disabled") {
      throw new ApiError(
        403,
        "ACCOUNT_DISABLED",
        "账号已被管理员停用",
      );
    }
    this.cleanupSecurityRecords();
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
      now,
      now,
      user.id,
    );
    return json(
      await this.issueSession(
        this.userById(user.id)!,
        request.headers.get("user-agent") ?? "",
      ),
    );
  }

  private async refresh(request: Request): Promise<Response> {
    const refreshToken = parseRefreshToken(await parseJson(request));
    this.cleanupSecurityRecords();
    const tokenHash = await hashOpaque(refreshToken);
    const session = firstRow(
      this.sql.exec<RefreshRow>(
        "SELECT * FROM refresh_sessions WHERE token_hash = ?",
        tokenHash,
      ),
    );
    if (!session) {
      throw new ApiError(
        401,
        "REFRESH_INVALID",
        "登录已过期，请重新登录",
      );
    }
    const user = this.userById(session.user_id);
    this.sql.exec("DELETE FROM refresh_sessions WHERE id = ?", session.id);
    if (!user || user.status !== "active") {
      throw new ApiError(
        401,
        "REFRESH_INVALID",
        "登录已过期，请重新登录",
      );
    }
    return json(
      await this.issueSession(
        user,
        request.headers.get("user-agent") ?? "",
      ),
    );
  }

  private async logout(request: Request): Promise<Response> {
    const refreshToken = parseRefreshToken(await parseJson(request));
    const tokenHash = await hashOpaque(refreshToken);
    this.sql.exec(
      "DELETE FROM refresh_sessions WHERE token_hash = ?",
      tokenHash,
    );
    return new Response(null, { status: 204 });
  }

  private async forgotPassword(request: Request): Promise<Response> {
    const rawEmail = parseEmail(await parseJson(request));
    const email = normalizeEmail(rawEmail);
    const user = this.userByEmail(email);
    if (!user?.email_verified_at) return json({ sent: true });
    const delivery = await this.createVerification(
      email,
      user.id,
      "reset_password",
    );
    return json({
      sent: true,
      delivery: delivery.provider,
      debugCode: delivery.debugCode,
    });
  }

  private async resetPassword(request: Request): Promise<Response> {
    const body = parseResetPassword(await parseJson(request));
    const email = normalizeEmail(body.email);
    const user = this.userByEmail(email);
    const verification = firstRow(
      this.sql.exec<VerificationRow>(
        `SELECT * FROM verification_codes
         WHERE email = ? COLLATE NOCASE AND purpose = 'reset_password'
           AND consumed_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        email,
      ),
    );
    if (
      !user ||
      !verification ||
      Date.parse(verification.expires_at) <= Date.now()
    ) {
      throw new ApiError(400, "CODE_EXPIRED", "验证码已过期，请重新发送");
    }
    if (verification.attempts >= 5) {
      throw new ApiError(
        429,
        "CODE_LOCKED",
        "验证码错误次数过多，请重新发送",
      );
    }
    if (verification.code_hash !== (await hashOpaque(body.code))) {
      this.sql.exec(
        "UPDATE verification_codes SET attempts = attempts + 1 WHERE id = ?",
        verification.id,
      );
      throw new ApiError(400, "CODE_INVALID", "验证码不正确");
    }
    const passwordHash = await hashPassword(body.password);
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE verification_codes SET consumed_at = ? WHERE id = ?",
      now,
      verification.id,
    );
    this.sql.exec(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
      passwordHash,
      now,
      user.id,
    );
    this.sql.exec(
      "DELETE FROM refresh_sessions WHERE user_id = ?",
      user.id,
    );
    return json({ reset: true });
  }

  private async updateAvatar(request: Request): Promise<Response> {
    const user = await this.requireUser(request);
    if (user.role === "boss") {
      throw new ApiError(
        403,
        "BOSS_AVATAR_LOCKED",
        "不好意思，您无权限更换自己的头像",
      );
    }
    if (user.role !== "member") {
      throw new ApiError(
        403,
        "AVATAR_CHANGE_FORBIDDEN",
        "该账号的头像由系统统一管理",
      );
    }
    const dataUrl = parseAvatar(await parseJson(request));
    if (dataUrl) decodeAvatarDataUrl(dataUrl);
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE users
       SET avatar_data_url = ?, avatar_version = avatar_version + 1, updated_at = ?
       WHERE id = ?`,
      dataUrl,
      now,
      user.id,
    );
    return json({ user: toPublicUser(this.userById(user.id)!) });
  }

  private getAvatar(userId: string): Response {
    const user = this.userById(userId);
    if (!user?.avatar_data_url) {
      throw new ApiError(
        404,
        "AVATAR_NOT_FOUND",
        "该账号使用系统默认头像",
      );
    }
    const avatar = decodeAvatarDataUrl(user.avatar_data_url);
    return new Response(avatar.bytes, {
      headers: {
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": avatar.contentType,
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
    });
  }

  private async getTasks(request: Request, url: URL): Promise<Response> {
    const user = await this.requireUser(request);
    const date = parseDate(url.searchParams.get("date"));
    const rows = this.sql
      .exec<TaskRow>(
        "SELECT * FROM tasks WHERE user_id = ? AND date = ?",
        user.id,
        date,
      )
      .toArray()
      .map(toTask)
      .sort(
        (left, right) =>
          Number(left.status === "done") - Number(right.status === "done") ||
          priorityRank(left.priority) - priorityRank(right.priority) ||
          statusRank(left.status) - statusRank(right.status) ||
          right.createdAt.localeCompare(left.createdAt),
      );
    return json({ tasks: rows });
  }

  private async getTaskSummary(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const from = parseDate(url.searchParams.get("from"));
    const to = parseDate(url.searchParams.get("to"));
    if (from > to) {
      throw new ApiError(
        400,
        "DATE_RANGE_INVALID",
        "开始日期不能晚于结束日期",
      );
    }
    const numberOfDays =
      Math.floor(
        (Date.parse(`${to}T00:00:00Z`) -
          Date.parse(`${from}T00:00:00Z`)) /
          86_400_000,
      ) + 1;
    if (numberOfDays > 42) {
      throw new ApiError(
        400,
        "DATE_RANGE_TOO_LARGE",
        "一次最多查询 42 天",
      );
    }
    const rows = this.sql
      .exec<{
        date: string;
        total: number;
        done: number;
        doing: number;
      }>(
        `SELECT date,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'doing' THEN 1 ELSE 0 END) AS doing
         FROM tasks
         WHERE user_id = ? AND date BETWEEN ? AND ?
         GROUP BY date`,
        user.id,
        from,
        to,
      )
      .toArray();
    return json({
      summary: Object.fromEntries(
        rows.map((row) => [
          row.date,
          {
            total: Number(row.total),
            done: Number(row.done),
            doing: Number(row.doing),
          },
        ]),
      ),
    });
  }

  private async getTaskRollover(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const targetDate = parseDate(url.searchParams.get("targetDate"));
    const sourceDate = previousDate(targetDate);
    const decision = firstRow(
      this.sql.exec<RolloverDecisionRow>(
        `SELECT * FROM task_rollover_decisions
         WHERE user_id = ? AND target_date = ?`,
        user.id,
        targetDate,
      ),
    );
    const tasks = this.sql
      .exec<TaskRow>(
        `SELECT * FROM tasks
         WHERE user_id = ? AND date = ? AND status != 'done'`,
        user.id,
        sourceDate,
      )
      .toArray()
      .map(toTask)
      .sort(
        (left, right) =>
          priorityRank(left.priority) - priorityRank(right.priority) ||
          right.createdAt.localeCompare(left.createdAt),
      );
    return json({
      sourceDate,
      targetDate,
      pending: !decision && tasks.length > 0,
      decidedAt: decision?.created_at ?? null,
      tasks,
    });
  }

  private async applyTaskRollover(request: Request): Promise<Response> {
    const user = await this.requireUser(request);
    const body = parseTaskRollover(await parseJson(request));
    const sourceDate = previousDate(body.targetDate);
    const existingDecision = firstRow(
      this.sql.exec<RolloverDecisionRow>(
        `SELECT * FROM task_rollover_decisions
         WHERE user_id = ? AND target_date = ?`,
        user.id,
        body.targetDate,
      ),
    );
    if (existingDecision) {
      const selectedIds = JSON.parse(
        existingDecision.selected_task_ids,
      ) as string[];
      const existing = this.sql
        .exec<TaskRow>(
          `SELECT * FROM tasks
           WHERE user_id = ? AND date = ? AND source_task_id IS NOT NULL`,
          user.id,
          body.targetDate,
        )
        .toArray()
        .map(toTask)
        .filter(
          (task) =>
            task.sourceTaskId !== null &&
            selectedIds.includes(task.sourceTaskId),
        );
      return json({
        sourceDate,
        targetDate: body.targetDate,
        created: existing,
        alreadyDecided: true,
      });
    }

    const eligible = this.sql
      .exec<TaskRow>(
        `SELECT * FROM tasks
         WHERE user_id = ? AND date = ? AND status != 'done'`,
        user.id,
        sourceDate,
      )
      .toArray()
      .filter((task) => body.taskIds.includes(task.id));
    const now = new Date().toISOString();
    const created: Task[] = [];
    for (const source of eligible) {
      const duplicate = firstRow(
        this.sql.exec<TaskRow>(
          `SELECT * FROM tasks
           WHERE user_id = ? AND date = ? AND source_task_id = ?`,
          user.id,
          body.targetDate,
          source.id,
        ),
      );
      if (duplicate) {
        created.push(toTask(duplicate));
        continue;
      }
      const id = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO tasks
         (id, user_id, date, title, details, status, priority, origin,
          assigned_by, assignment_id, source_task_id,
          assignment_delivered_at, assignment_viewed_at,
          completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'todo', ?, 'carryover', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        id,
        user.id,
        body.targetDate,
        source.title,
        source.details,
        source.priority,
        source.assigned_by,
        source.assignment_id,
        source.id,
        source.assignment_delivered_at,
        source.assignment_viewed_at,
        now,
        now,
      );
      created.push(
        toTask(
          firstRow(
            this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id),
          )!,
        ),
      );
      this.recordTaskAudit(
        created.at(-1)!,
        user.id,
        "carried_over",
        [
          {
            field: "date",
            before: sourceDate,
            after: body.targetDate,
          },
        ],
        now,
      );
    }
    this.sql.exec(
      `INSERT INTO task_rollover_decisions
       (id, user_id, source_date, target_date, selected_task_ids, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      user.id,
      sourceDate,
      body.targetDate,
      JSON.stringify(eligible.map((task) => task.id)),
      now,
    );
    if (created.length > 0) {
      this.pushToUser(user.id, "task:batch-changed", {
        tasks: created,
        dates: [sourceDate, body.targetDate],
      });
    }
    return json(
      {
        sourceDate,
        targetDate: body.targetDate,
        created,
        alreadyDecided: false,
      },
      201,
    );
  }

  private async getTaskSyncToToday(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const sourceDate = parseDate(url.searchParams.get("sourceDate"));
    const targetDate = businessDateKey();
    if (sourceDate >= targetDate) {
      throw new ApiError(
        400,
        "PAST_DATE_REQUIRED",
        "只能从往日待办同步到今天",
      );
    }
    const tasks = this.sql
      .exec<TaskRow>(
        `SELECT * FROM tasks
         WHERE user_id = ? AND date = ? AND status != 'done'`,
        user.id,
        sourceDate,
      )
      .toArray()
      .map(toTask)
      .sort(
        (left, right) =>
          priorityRank(left.priority) - priorityRank(right.priority) ||
          right.createdAt.localeCompare(left.createdAt),
      );
    const sourceIds = new Set(tasks.map((task) => task.id));
    const syncedTaskIds = this.sql
      .exec<{ source_task_id: string }>(
        `SELECT source_task_id FROM tasks
         WHERE user_id = ? AND date = ? AND source_task_id IS NOT NULL`,
        user.id,
        targetDate,
      )
      .toArray()
      .map((row) => row.source_task_id)
      .filter((taskId) => sourceIds.has(taskId));
    return json({ sourceDate, targetDate, tasks, syncedTaskIds });
  }

  private async applyTaskSyncToToday(
    request: Request,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const body = parseTaskSync(await parseJson(request));
    const targetDate = businessDateKey();
    if (body.sourceDate >= targetDate) {
      throw new ApiError(
        400,
        "PAST_DATE_REQUIRED",
        "只能从往日待办同步到今天",
      );
    }
    const eligible = this.sql
      .exec<TaskRow>(
        `SELECT * FROM tasks
         WHERE user_id = ? AND date = ? AND status != 'done'`,
        user.id,
        body.sourceDate,
      )
      .toArray()
      .filter((task) => body.taskIds.includes(task.id));
    const now = new Date().toISOString();
    const created: Task[] = [];
    const skippedTaskIds: string[] = [];
    for (const source of eligible) {
      const duplicate = firstRow(
        this.sql.exec<TaskRow>(
          `SELECT * FROM tasks
           WHERE user_id = ? AND date = ? AND source_task_id = ?`,
          user.id,
          targetDate,
          source.id,
        ),
      );
      if (duplicate) {
        skippedTaskIds.push(source.id);
        continue;
      }
      const id = crypto.randomUUID();
      this.sql.exec(
        `INSERT INTO tasks
         (id, user_id, date, title, details, status, priority, origin,
          assigned_by, assignment_id, source_task_id,
          assignment_delivered_at, assignment_viewed_at,
          completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'todo', ?, 'carryover', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        id,
        user.id,
        targetDate,
        source.title,
        source.details,
        source.priority,
        source.assigned_by,
        source.assignment_id,
        source.id,
        source.assignment_delivered_at,
        source.assignment_viewed_at,
        now,
        now,
      );
      const task = toTask(
        firstRow(
          this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id),
        )!,
      );
      created.push(task);
      this.recordTaskAudit(
        task,
        user.id,
        "carried_over",
        [
          {
            field: "date",
            before: body.sourceDate,
            after: targetDate,
          },
        ],
        now,
      );
    }
    if (created.length > 0) {
      this.pushToUser(user.id, "task:batch-changed", {
        tasks: created,
        dates: [body.sourceDate, targetDate],
      });
    }
    return json(
      {
        sourceDate: body.sourceDate,
        targetDate,
        created,
        skippedTaskIds,
        rejectedTaskIds: body.taskIds.filter(
          (taskId) => !eligible.some((task) => task.id === taskId),
        ),
      },
      201,
    );
  }

  private async getPendingAssignments(request: Request): Promise<Response> {
    const user = await this.requireUser(request, ["member", "boss"]);
    const assignments = this.sql
      .exec<TaskRow>(
        `SELECT * FROM tasks
         WHERE user_id = ? AND assigned_by IS NOT NULL
           AND assignment_viewed_at IS NULL
         ORDER BY created_at DESC LIMIT 20`,
        user.id,
      )
      .toArray()
      .map((row) => {
        const assigner = row.assigned_by
          ? this.userById(row.assigned_by)
          : undefined;
        return assigner
          ? { task: toTask(row), assigner: toPublicUser(assigner) }
          : null;
      })
      .filter((item) => item !== null);
    return json({ assignments });
  }

  private async markAssignmentReceipt(
    request: Request,
    taskId: string,
    receipt: "delivered" | "viewed",
  ): Promise<Response> {
    const user = await this.requireUser(request, ["member", "boss"]);
    const current = firstRow(
      this.sql.exec<TaskRow>(
        `SELECT * FROM tasks
         WHERE id = ? AND user_id = ? AND assigned_by IS NOT NULL`,
        taskId,
        user.id,
      ),
    );
    if (!current) {
      throw new ApiError(
        404,
        "ASSIGNMENT_NOT_FOUND",
        "没有找到该派发任务",
      );
    }
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE tasks
       SET assignment_delivered_at = COALESCE(assignment_delivered_at, ?),
           assignment_viewed_at = CASE
             WHEN ? = 'viewed' THEN COALESCE(assignment_viewed_at, ?)
             ELSE assignment_viewed_at
           END
       WHERE id = ? AND user_id = ?`,
      now,
      receipt,
      now,
      taskId,
      user.id,
    );
    const task = toTask(
      firstRow(
        this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId),
      )!,
    );
    this.pushToUser(task.assignedBy!, "task:assignment-receipt", {
      task,
      receipt,
    });
    this.pushToUser(task.userId, "task:changed", { task });
    return json({ task });
  }

  private async createTask(request: Request): Promise<Response> {
    const user = await this.requireUser(request);
    const body = parseTaskCreate(await parseJson(request));
    if (body.date < businessDateKey()) {
      throw new ApiError(
        400,
        "PAST_TASK_CREATE_FORBIDDEN",
        "往日待办不能新增，请勾选未完成任务同步到今天",
      );
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO tasks
       (id, user_id, date, title, details, status, priority, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      user.id,
      body.date,
      body.title,
      body.details,
      body.status,
      body.priority,
      body.status === "done" ? now : null,
      now,
      now,
    );
    const task = firstRow(
      this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", id),
    )!;
    const created = toTask(task);
    this.recordTaskAudit(created, user.id, "created", [], now);
    this.pushToUser(user.id, "task:changed", { task: created });
    return json({ task: created }, 201);
  }

  private async patchTask(
    request: Request,
    taskId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const body = parseTaskPatch(await parseJson(request));
    const current = firstRow(
      this.sql.exec<TaskRow>(
        "SELECT * FROM tasks WHERE id = ? AND user_id = ?",
        taskId,
        user.id,
      ),
    );
    if (!current) {
      throw new ApiError(404, "TASK_NOT_FOUND", "没有找到该任务");
    }
    if (
      current.assigned_by &&
      (body.title !== undefined ||
        body.date !== undefined ||
        body.priority !== undefined)
    ) {
      throw new ApiError(
        403,
        "ASSIGNED_TASK_LOCKED",
        "老板派发的标题、日期和优先级不能由成员修改",
      );
    }
    if (
      body.date &&
      body.date < businessDateKey() &&
      body.date !== current.date
    ) {
      throw new ApiError(
        400,
        "PAST_TASK_MOVE_FORBIDDEN",
        "不能把任务改到往日日期",
      );
    }
    const before = toTask(current);
    const now = new Date().toISOString();
    const status = body.status ?? current.status;
    const completedAt =
      status === "done"
        ? current.status === "done"
          ? current.completed_at
          : now
        : null;
    const preview: Task = {
      ...before,
      title: body.title ?? current.title,
      details: body.details ?? current.details,
      date: body.date ?? current.date,
      status,
      priority: body.priority ?? current.priority,
      completedAt,
      updatedAt: now,
    };
    const changes = auditTaskChanges(before, preview);
    if (changes.length === 0) {
      return json({ task: before });
    }
    this.sql.exec(
      `UPDATE tasks SET
        title = ?, details = ?, date = ?, status = ?, priority = ?,
        completed_at = ?, updated_at = ?
       WHERE id = ? AND user_id = ?`,
      body.title ?? current.title,
      body.details ?? current.details,
      body.date ?? current.date,
      status,
      body.priority ?? current.priority,
      completedAt,
      now,
      taskId,
      user.id,
    );
    const task = toTask(
      firstRow(
        this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId),
      )!,
    );
    const action: TaskAuditAction =
      before.status !== "done" && task.status === "done"
        ? "completed"
        : before.status === "done" && task.status !== "done"
          ? "reopened"
          : "updated";
    this.recordTaskAudit(
      task,
      user.id,
      action,
      changes,
      now,
    );
    if (task.assignedBy) {
      this.pushToUser(task.assignedBy, "task:status", { task });
    }
    this.pushToUser(user.id, "task:changed", { task });
    return json({ task });
  }

  private async deleteTask(
    request: Request,
    taskId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const existing = firstRow(
      this.sql.exec<TaskRow>(
        "SELECT * FROM tasks WHERE id = ? AND user_id = ?",
        taskId,
        user.id,
      ),
    );
    if (!existing) {
      throw new ApiError(404, "TASK_NOT_FOUND", "没有找到该任务");
    }
    if (existing.assigned_by) {
      throw new ApiError(
        403,
        "ASSIGNED_TASK_LOCKED",
        "老板派发的任务不能由成员删除",
      );
    }
    this.recordTaskAudit(
      toTask(existing),
      user.id,
      "deleted",
    );
    this.sql.exec(
      "DELETE FROM tasks WHERE id = ? AND user_id = ?",
      taskId,
      user.id,
    );
    this.pushToUser(user.id, "task:deleted", {
      taskId,
      date: existing.date,
    });
    return new Response(null, { status: 204 });
  }

  private async getAdminUsers(request: Request): Promise<Response> {
    const admin = await this.requireUser(request, ["admin"]);
    const users = this.sql
      .exec<UserRow & { task_count: number }>(
        `SELECT users.*, COUNT(tasks.id) AS task_count
         FROM users LEFT JOIN tasks ON tasks.user_id = users.id
         GROUP BY users.id
         ORDER BY users.status ASC, users.created_at DESC`,
      )
      .toArray()
      .map((row) => ({
        ...toPublicUser(row),
        taskCount: Number(row.task_count),
        isCurrent: row.id === admin.id,
      }));
    return json({ users });
  }

  private async changeAccess(
    request: Request,
    userId: string,
  ): Promise<Response> {
    const admin = await this.requireUser(request, ["admin"]);
    const status = parseAccessStatus(await parseJson(request));
    if (userId === admin.id) {
      throw new ApiError(
        400,
        "SELF_ACCESS_CHANGE",
        "不能停用自己的管理员账号",
      );
    }
    const target = this.userById(userId);
    if (!target) {
      throw new ApiError(404, "USER_NOT_FOUND", "没有找到该账号");
    }
    if (target.role === "admin") {
      throw new ApiError(
        403,
        "ADMIN_PROTECTED",
        "不能修改其他管理员账号",
      );
    }
    if (!target.email_verified_at) {
      throw new ApiError(
        400,
        "EMAIL_NOT_VERIFIED",
        "该账号尚未完成邮箱验证",
      );
    }
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE users SET status = ?, updated_at = ? WHERE id = ?",
      status,
      now,
      userId,
    );
    if (status === "disabled") {
      this.sql.exec(
        "DELETE FROM refresh_sessions WHERE user_id = ?",
        userId,
      );
      this.closeUserSockets(userId);
    }
    return json({ user: toPublicUser(this.userById(userId)!) });
  }

  private async changeRole(
    request: Request,
    userId: string,
  ): Promise<Response> {
    await this.requireUser(request, ["admin"]);
    const role = parseRole(await parseJson(request));
    const target = this.userById(userId);
    if (!target) {
      throw new ApiError(404, "USER_NOT_FOUND", "没有找到该账号");
    }
    if (target.role === "admin") {
      throw new ApiError(
        403,
        "ADMIN_PROTECTED",
        "不能修改管理员角色",
      );
    }
    const now = new Date().toISOString();
    this.sql.exec(
      "UPDATE users SET role = ?, updated_at = ? WHERE id = ?",
      role,
      now,
      userId,
    );
    this.sql.exec(
      "DELETE FROM refresh_sessions WHERE user_id = ?",
      userId,
    );
    this.closeUserSockets(userId);
    return json({
      user: toPublicUser(this.userById(userId)!),
      sessionRevoked: true,
    });
  }

  private async changeUserProfile(
    request: Request,
    userId: string,
  ): Promise<Response> {
    await this.requireUser(request, ["admin"]);
    const jobTitle = parseJobTitle(await parseJson(request));
    const target = this.userById(userId);
    if (!target) {
      throw new ApiError(404, "USER_NOT_FOUND", "没有找到该账号");
    }
    if (target.role === "admin") {
      throw new ApiError(403, "ADMIN_PROTECTED", "不能修改管理员资料");
    }
    this.sql.exec(
      `UPDATE users SET job_title = ?, updated_at = ? WHERE id = ?`,
      jobTitle,
      new Date().toISOString(),
      userId,
    );
    return json({ user: toPublicUser(this.userById(userId)!) });
  }

  private async getTeam(request: Request, url: URL): Promise<Response> {
    await this.requireUser(request, ["boss"]);
    const date = parseDate(url.searchParams.get("date"));
    const members = this.sql
      .exec<
        UserRow & {
          total: number;
          done: number;
          doing: number;
        }
      >(
        `SELECT users.*,
          COUNT(tasks.id) AS total,
          SUM(CASE WHEN tasks.status = 'done' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN tasks.status = 'doing' THEN 1 ELSE 0 END) AS doing
         FROM users
         LEFT JOIN tasks ON tasks.user_id = users.id AND tasks.date = ?
         WHERE users.status = 'active' AND users.role IN ('member', 'boss')
         GROUP BY users.id`,
        date,
      )
      .toArray()
      .map((row) => {
        const total = Number(row.total);
        const done = Number(row.done ?? 0);
        return {
          user: toPublicUser(row),
          total,
          done,
          doing: Number(row.doing ?? 0),
          completionRate:
            total === 0 ? 0 : Math.round((done / total) * 100),
        };
      })
      .sort(
        (left, right) =>
          right.completionRate - left.completionRate ||
          left.user.name.localeCompare(right.user.name, "zh-CN"),
      );
    return json({ date, members });
  }

  private async getMemberTasks(
    request: Request,
    url: URL,
    userId: string,
  ): Promise<Response> {
    await this.requireUser(request, ["boss"]);
    const date = parseDate(url.searchParams.get("date"));
    const user = this.userById(userId);
    if (
      !user ||
      user.status !== "active" ||
      user.role === "admin"
    ) {
      throw new ApiError(404, "USER_NOT_FOUND", "没有找到该成员");
    }
    const tasks = this.sql
      .exec<TaskRow>(
        "SELECT * FROM tasks WHERE user_id = ? AND date = ?",
        userId,
        date,
      )
      .toArray()
      .map(toTask)
      .sort(
        (left, right) =>
          Number(left.status === "done") - Number(right.status === "done") ||
          priorityRank(left.priority) - priorityRank(right.priority) ||
          statusRank(left.status) - statusRank(right.status) ||
          right.createdAt.localeCompare(left.createdAt),
      );
    return json({ user: toPublicUser(user), tasks });
  }

  private async getMemberTaskHistory(
    request: Request,
    userId: string,
    taskId: string,
  ): Promise<Response> {
    await this.requireUser(request, ["boss"]);
    const user = this.userById(userId);
    const taskRow = firstRow(
      this.sql.exec<TaskRow>(
        "SELECT * FROM tasks WHERE id = ? AND user_id = ?",
        taskId,
        userId,
      ),
    );
    if (
      !user ||
      user.status !== "active" ||
      user.role === "admin" ||
      !taskRow
    ) {
      throw new ApiError(
        404,
        "TASK_NOT_FOUND",
        "没有找到该成员的任务",
      );
    }
    const history = this.sql
      .exec<TaskAuditRow>(
        `SELECT * FROM task_audit_events
         WHERE task_id = ?
         ORDER BY created_at DESC`,
        taskId,
      )
      .toArray()
      .map((row): TaskAuditEvent & { actor: ReturnType<typeof toPublicUser> | null } => {
        const actor = this.userById(row.actor_id);
        return {
          id: row.id,
          taskId: row.task_id,
          userId: row.user_id,
          actorId: row.actor_id,
          action: row.action,
          changes: JSON.parse(row.changes_json) as TaskAuditChange[],
          snapshot: JSON.parse(row.snapshot_json) as Task,
          createdAt: row.created_at,
          actor: actor ? toPublicUser(actor) : null,
        };
      });
    return json({
      user: toPublicUser(user),
      task: toTask(taskRow),
      history,
      auditCoverage: history.length === 0 ? "legacy" : "tracked",
    });
  }

  private async assignMemberTask(
    request: Request,
    userId: string,
  ): Promise<Response> {
    const assigner = await this.requireUser(request, ["boss"]);
    const assignee = this.userById(userId);
    if (
      !assignee ||
      assignee.status !== "active" ||
      assignee.role !== "member"
    ) {
      throw new ApiError(
        404,
        "ASSIGNEE_NOT_FOUND",
        "没有找到可派发任务的成员",
      );
    }
    const body = parseTaskAssignment(await parseJson(request));
    if (body.date < businessDateKey()) {
      throw new ApiError(
        400,
        "PAST_TASK_CREATE_FORBIDDEN",
        "不能给成员派发往日任务",
      );
    }
    const now = new Date().toISOString();
    const taskId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO tasks
       (id, user_id, date, title, details, status, priority, origin,
        assigned_by, assignment_id, source_task_id,
        assignment_delivered_at, assignment_viewed_at,
        completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'todo', ?, 'assigned', ?, ?, NULL, NULL, NULL, NULL, ?, ?)`,
      taskId,
      assignee.id,
      body.date,
      body.title,
      body.details,
      body.priority,
      assigner.id,
      crypto.randomUUID(),
      now,
      now,
    );
    const task = toTask(
      firstRow(
        this.sql.exec<TaskRow>("SELECT * FROM tasks WHERE id = ?", taskId),
      )!,
    );
    this.recordTaskAudit(task, assigner.id, "assigned", [], now);
    const payload = {
      task,
      assigner: toPublicUser(assigner),
      assignee: toPublicUser(assignee),
    };
    this.pushToUser(assignee.id, "task:assigned", payload);
    return json(payload, 201);
  }

  private contactSummary(ownerId: string, contact: ContactRow) {
    const user = this.userById(contact.contact_id);
    if (!user || user.status !== "active" || user.role === "admin") {
      return null;
    }
    const lastMessageRow = firstRow(
      this.sql.exec<DirectMessageRow>(
        `SELECT * FROM direct_messages
         WHERE (sender_id = ? AND recipient_id = ?)
            OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC
         LIMIT 1`,
        ownerId,
        contact.contact_id,
        contact.contact_id,
        ownerId,
      ),
    );
    const unreadRow = firstRow(
      this.sql.exec<CountRow>(
        `SELECT COUNT(*) AS count FROM direct_messages
         WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
        contact.contact_id,
        ownerId,
      ),
    );
    return {
      user: toPublicUser(user),
      addedAt: contact.created_at,
      unreadCount: Number(unreadRow?.count ?? 0),
      lastMessage: lastMessageRow ? toDirectMessage(lastMessageRow) : null,
    };
  }

  private async searchContacts(
    request: Request,
    url: URL,
  ): Promise<Response> {
    const user = await this.requireUser(request, ["member", "boss"]);
    const query = parseContactSearch(url.searchParams.get("q") ?? "");
    const users = this.sql
      .exec<UserRow>(
        `SELECT * FROM users
         WHERE status = 'active'
           AND role != 'admin'
           AND id != ?
           AND instr(lower(name), lower(?)) > 0
         ORDER BY name COLLATE NOCASE
         LIMIT 12`,
        user.id,
        query,
      )
      .toArray()
      .map(toPublicUser);
    return json({ users });
  }

  private async getContacts(request: Request): Promise<Response> {
    const user = await this.requireUser(request, ["member", "boss"]);
    const contacts = this.sql
      .exec<ContactRow>(
        `SELECT * FROM contacts
         WHERE owner_id = ?
         ORDER BY created_at DESC
         LIMIT 100`,
        user.id,
      )
      .toArray()
      .map((contact) => this.contactSummary(user.id, contact))
      .filter((contact) => contact !== null)
      .sort((left, right) =>
        (right.lastMessage?.createdAt ?? right.addedAt).localeCompare(
          left.lastMessage?.createdAt ?? left.addedAt,
        ),
      );
    return json({
      contacts,
      unread: contacts.reduce(
        (total, contact) => total + contact.unreadCount,
        0,
      ),
    });
  }

  private async addContact(request: Request): Promise<Response> {
    const owner = await this.requireUser(request, ["member", "boss"]);
    const contactId = parseContactRequest(await parseJson(request));
    if (contactId === owner.id) {
      throw new ApiError(400, "CONTACT_SELF", "不能把自己添加为联系人");
    }
    const contactUser = this.userById(contactId);
    if (
      !contactUser ||
      contactUser.status !== "active" ||
      contactUser.role === "admin"
    ) {
      throw new ApiError(404, "CONTACT_NOT_FOUND", "没有找到该联系人");
    }
    const now = new Date().toISOString();
    this.sql.exec(
      `INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at)
       VALUES (?, ?, ?)`,
      owner.id,
      contactId,
      now,
    );
    const row = firstRow(
      this.sql.exec<ContactRow>(
        `SELECT * FROM contacts WHERE owner_id = ? AND contact_id = ?`,
        owner.id,
        contactId,
      ),
    )!;
    return json({ contact: this.contactSummary(owner.id, row) }, 201);
  }

  private async getDirectMessages(
    request: Request,
    contactId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request, ["member", "boss"]);
    this.expireDueFlashMessages();
    const contact = firstRow(
      this.sql.exec<ContactRow>(
        `SELECT * FROM contacts WHERE owner_id = ? AND contact_id = ?`,
        user.id,
        contactId,
      ),
    );
    if (!contact) {
      throw new ApiError(404, "CONTACT_NOT_FOUND", "请先添加该联系人");
    }
    const messages = this.sql
      .exec<DirectMessageRow>(
        `SELECT * FROM direct_messages
         WHERE (sender_id = ? AND recipient_id = ?)
            OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC
         LIMIT 100`,
        user.id,
        contactId,
        contactId,
        user.id,
      )
      .toArray()
      .map(toDirectMessage)
      .reverse();
    return json({ messages });
  }

  private async sendDirectMessage(
    request: Request,
    contactId: string,
  ): Promise<Response> {
    const sender = await this.requireUser(request, ["member", "boss"]);
    const contact = firstRow(
      this.sql.exec<ContactRow>(
        `SELECT * FROM contacts WHERE owner_id = ? AND contact_id = ?`,
        sender.id,
        contactId,
      ),
    );
    const recipient = this.userById(contactId);
    if (
      !contact ||
      !recipient ||
      recipient.status !== "active" ||
      recipient.role === "admin"
    ) {
      throw new ApiError(404, "CONTACT_NOT_FOUND", "请先添加该联系人");
    }
    const { body, mode } = parseDirectMessage(await parseJson(request));
    const now = new Date().toISOString();
    const message: DirectMessage = {
      id: crypto.randomUUID(),
      senderId: sender.id,
      recipientId: recipient.id,
      body,
      mode,
      readAt: null,
      expiresAt: null,
      destroyedAt: null,
      createdAt: now,
    };
    this.sql.exec(
      `INSERT INTO direct_messages
       (id, sender_id, recipient_id, body, mode, read_at, expires_at,
        destroyed_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)`,
      message.id,
      message.senderId,
      message.recipientId,
      message.body,
      message.mode,
      message.createdAt,
    );
    this.sql.exec(
      `INSERT OR IGNORE INTO contacts (owner_id, contact_id, created_at)
       VALUES (?, ?, ?)`,
      recipient.id,
      sender.id,
      now,
    );
    this.pushDirectMessage(message, sender);
    return json({ message }, 201);
  }

  private async readDirectMessages(
    request: Request,
    contactId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request, ["member", "boss"]);
    const unread = this.sql
      .exec<DirectMessageRow>(
        `SELECT * FROM direct_messages
         WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL`,
        contactId,
        user.id,
      )
      .toArray();
    const now = new Date().toISOString();
    const flashExpiry = new Date(Date.now() + 5_000).toISOString();
    const updated: DirectMessage[] = [];
    for (const message of unread) {
      this.sql.exec(
        `UPDATE direct_messages
         SET read_at = COALESCE(read_at, ?),
             expires_at = CASE
               WHEN mode = 'flash' THEN COALESCE(expires_at, ?)
               ELSE expires_at
             END
         WHERE id = ?`,
        now,
        flashExpiry,
        message.id,
      );
      const current = toDirectMessage(
        firstRow(
          this.sql.exec<DirectMessageRow>(
            "SELECT * FROM direct_messages WHERE id = ?",
            message.id,
          ),
        )!,
      );
      updated.push(current);
      this.pushToUser(current.senderId, "message:read", {
        message: current,
      });
      this.pushToUser(current.recipientId, "message:read", {
        message: current,
      });
    }
    await this.scheduleNextFlashAlarm();
    return json({ ok: true, messages: updated });
  }

  private expireDueFlashMessages(): DirectMessage[] {
    const due = this.sql
      .exec<DirectMessageRow>(
        `SELECT * FROM direct_messages
         WHERE mode = 'flash' AND destroyed_at IS NULL
           AND expires_at IS NOT NULL AND expires_at <= ?`,
        new Date().toISOString(),
      )
      .toArray();
    if (due.length === 0) return [];
    const destroyedAt = new Date().toISOString();
    const destroyed: DirectMessage[] = [];
    for (const row of due) {
      this.sql.exec(
        `UPDATE direct_messages
         SET body = '', destroyed_at = ?
         WHERE id = ? AND destroyed_at IS NULL`,
        destroyedAt,
        row.id,
      );
      const message = toDirectMessage(
        firstRow(
          this.sql.exec<DirectMessageRow>(
            "SELECT * FROM direct_messages WHERE id = ?",
            row.id,
          ),
        )!,
      );
      destroyed.push(message);
      this.pushToUser(message.senderId, "message:expired", { message });
      this.pushToUser(message.recipientId, "message:expired", { message });
    }
    return destroyed;
  }

  private async scheduleNextFlashAlarm(): Promise<void> {
    const next = firstRow(
      this.sql.exec<{ expires_at: string | null }>(
        `SELECT MIN(expires_at) AS expires_at
         FROM direct_messages
         WHERE mode = 'flash' AND destroyed_at IS NULL
           AND expires_at IS NOT NULL`,
      ),
    )?.expires_at;
    if (!next) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(
      Math.max(Date.now() + 1, Date.parse(next)),
    );
  }

  private notificationById(
    notificationId: string,
  ): AppNotification | undefined {
    const row = firstRow(
      this.sql.exec<NotificationRow>(
        `SELECT n.*,
                r.dispatch_id,
                r.delivered_at,
                r.acknowledged_at,
                d.ding_count,
                d.last_ding_at
         FROM notifications n
         LEFT JOIN notification_receipts r ON r.notification_id = n.id
         LEFT JOIN notification_dispatches d ON d.id = r.dispatch_id
         WHERE n.id = ?`,
        notificationId,
      ),
    );
    return row ? toNotification(row) : undefined;
  }

  private notificationDispatchById(
    dispatchId: string,
    senderId: string,
  ): NotificationDispatch | undefined {
    const dispatch = firstRow(
      this.sql.exec<NotificationDispatchRow>(
        `SELECT * FROM notification_dispatches
         WHERE id = ? AND sender_id = ?`,
        dispatchId,
        senderId,
      ),
    );
    if (!dispatch) return undefined;

    const receiptRows = this.sql
      .exec<NotificationReceiptRow>(
        `SELECT * FROM notification_receipts
         WHERE dispatch_id = ?
         ORDER BY notification_id`,
        dispatchId,
      )
      .toArray();
    const recipients: NotificationDispatch["recipients"] = [];
    for (const receipt of receiptRows) {
      const notification = this.notificationById(receipt.notification_id);
      if (!notification) continue;
      const user = this.userById(notification.recipientId);
      if (!user) continue;
      recipients.push({
        notificationId: notification.id,
        user: toPublicUser(user),
        deliveredAt: notification.deliveredAt,
        acknowledgedAt: notification.acknowledgedAt,
      });
    }

    const acknowledged = recipients.filter(
      (recipient) => recipient.acknowledgedAt,
    ).length;
    const delivered = recipients.filter(
      (recipient) => recipient.deliveredAt,
    ).length;
    return {
      id: dispatch.id,
      senderId: dispatch.sender_id,
      title: dispatch.title,
      body: dispatch.body,
      dingCount: Number(dispatch.ding_count),
      lastDingAt: dispatch.last_ding_at,
      createdAt: dispatch.created_at,
      recipients,
      counts: {
        total: recipients.length,
        delivered,
        acknowledged,
        pending: recipients.length - acknowledged,
      },
    };
  }

  private async createNotifications(request: Request): Promise<Response> {
    const boss = await this.requireUser(request, ["boss"]);
    const body = parseNotificationRequest(await parseJson(request));
    const candidates = this.sql
      .exec<UserRow>(
        `SELECT * FROM users
         WHERE status = 'active' AND role != 'admin' AND id != ?`,
        boss.id,
      )
      .toArray();
    const recipients = candidates.filter(
      (candidate) => body.all || body.recipientIds.includes(candidate.id),
    );
    if (recipients.length === 0) {
      throw new ApiError(
        400,
        "NO_RECIPIENTS",
        "没有可接收通知的成员",
      );
    }
    const now = new Date().toISOString();
    const dispatchId = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO notification_dispatches
       (id, sender_id, title, body, ding_count, last_ding_at, created_at)
       VALUES (?, ?, ?, ?, 0, NULL, ?)`,
      dispatchId,
      boss.id,
      body.title,
      body.body,
      now,
    );
    const notifications: AppNotification[] = [];
    for (const recipient of recipients) {
      const notification: AppNotification = {
        id: crypto.randomUUID(),
        dispatchId,
        senderId: boss.id,
        recipientId: recipient.id,
        title: body.title,
        body: body.body,
        requiresAcknowledgement: true,
        deliveredAt: null,
        acknowledgedAt: null,
        dingCount: 0,
        lastDingAt: null,
        readAt: null,
        createdAt: now,
      };
      this.sql.exec(
        `INSERT INTO notifications
         (id, sender_id, recipient_id, title, body, read_at, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        notification.id,
        notification.senderId,
        notification.recipientId,
        notification.title,
        notification.body,
        notification.createdAt,
      );
      this.sql.exec(
        `INSERT INTO notification_receipts
         (notification_id, dispatch_id, delivered_at, acknowledged_at)
         VALUES (?, ?, NULL, NULL)`,
        notification.id,
        dispatchId,
      );
      notifications.push(notification);
      this.pushNotification(notification);
    }
    const dispatch = this.notificationDispatchById(dispatchId, boss.id)!;
    return json(
      {
        targeted: notifications.length,
        delivered: notifications.length,
        notifications,
        dispatch,
      },
      201,
    );
  }

  private async getNotificationDispatches(
    request: Request,
  ): Promise<Response> {
    const boss = await this.requireUser(request, ["boss"]);
    const rows = this.sql
      .exec<NotificationDispatchRow>(
        `SELECT * FROM notification_dispatches
         WHERE sender_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
        boss.id,
      )
      .toArray();
    const dispatches = rows
      .map((row) => this.notificationDispatchById(row.id, boss.id))
      .filter(
        (dispatch): dispatch is NotificationDispatch =>
          dispatch !== undefined,
      );
    return json({ dispatches });
  }

  private async dingNotificationDispatch(
    request: Request,
    dispatchId: string,
  ): Promise<Response> {
    const boss = await this.requireUser(request, ["boss"]);
    const existing = this.notificationDispatchById(dispatchId, boss.id);
    if (!existing) {
      throw new ApiError(
        404,
        "NOTIFICATION_DISPATCH_NOT_FOUND",
        "没有找到该提醒",
      );
    }
    if (existing.counts.pending === 0) {
      throw new ApiError(
        409,
        "NOTIFICATION_ALREADY_ACKNOWLEDGED",
        "所有成员都已确认收到",
      );
    }

    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE notification_dispatches
       SET ding_count = ding_count + 1, last_ding_at = ?
       WHERE id = ? AND sender_id = ?`,
      now,
      dispatchId,
      boss.id,
    );
    const pending = this.sql
      .exec<NotificationReceiptRow>(
        `SELECT * FROM notification_receipts
         WHERE dispatch_id = ? AND acknowledged_at IS NULL`,
        dispatchId,
      )
      .toArray();
    for (const receipt of pending) {
      const notification = this.notificationById(receipt.notification_id);
      if (notification) {
        this.pushNotification(notification, "notification:ding");
      }
    }
    return json({
      targeted: pending.length,
      dispatch: this.notificationDispatchById(dispatchId, boss.id)!,
    });
  }

  private async getNotifications(request: Request): Promise<Response> {
    const user = await this.requireUser(request);
    const notifications = this.sql
      .exec<NotificationRow>(
        `SELECT n.*,
                r.dispatch_id,
                r.delivered_at,
                r.acknowledged_at,
                d.ding_count,
                d.last_ding_at
         FROM notifications n
         LEFT JOIN notification_receipts r ON r.notification_id = n.id
         LEFT JOIN notification_dispatches d ON d.id = r.dispatch_id
         WHERE n.recipient_id = ?
         ORDER BY n.created_at DESC LIMIT 100`,
        user.id,
      )
      .toArray()
      .map(toNotification);
    return json({
      notifications,
      unread: notifications.filter((item) => !item.readAt).length,
    });
  }

  private async readNotification(
    request: Request,
    notificationId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const existing = firstRow(
      this.sql.exec<NotificationRow>(
        `SELECT * FROM notifications
         WHERE id = ? AND recipient_id = ?`,
        notificationId,
        user.id,
      ),
    );
    if (!existing) {
      throw new ApiError(
        404,
        "NOTIFICATION_NOT_FOUND",
        "没有找到该通知",
      );
    }
    this.sql.exec(
      `UPDATE notifications SET read_at = COALESCE(read_at, ?)
       WHERE id = ? AND recipient_id = ?`,
      new Date().toISOString(),
      notificationId,
      user.id,
    );
    return json({
      notification: this.notificationById(notificationId)!,
    });
  }

  private async deliverNotification(
    request: Request,
    notificationId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const notification = this.notificationById(notificationId);
    if (
      !notification ||
      notification.recipientId !== user.id ||
      !notification.requiresAcknowledgement
    ) {
      throw new ApiError(
        404,
        "NOTIFICATION_NOT_FOUND",
        "没有找到该提醒",
      );
    }
    this.sql.exec(
      `UPDATE notification_receipts
       SET delivered_at = COALESCE(delivered_at, ?)
       WHERE notification_id = ?`,
      new Date().toISOString(),
      notificationId,
    );
    const updated = this.notificationById(notificationId)!;
    this.pushNotificationReceipt(updated);
    return json({ notification: updated });
  }

  private async acknowledgeNotification(
    request: Request,
    notificationId: string,
  ): Promise<Response> {
    const user = await this.requireUser(request);
    const notification = this.notificationById(notificationId);
    if (
      !notification ||
      notification.recipientId !== user.id ||
      !notification.requiresAcknowledgement
    ) {
      throw new ApiError(
        404,
        "NOTIFICATION_NOT_FOUND",
        "没有找到该提醒",
      );
    }
    const now = new Date().toISOString();
    this.sql.exec(
      `UPDATE notification_receipts
       SET delivered_at = COALESCE(delivered_at, ?),
           acknowledged_at = COALESCE(acknowledged_at, ?)
       WHERE notification_id = ?`,
      now,
      now,
      notificationId,
    );
    this.sql.exec(
      `UPDATE notifications
       SET read_at = COALESCE(read_at, ?)
       WHERE id = ? AND recipient_id = ?`,
      now,
      notificationId,
      user.id,
    );
    const updated = this.notificationById(notificationId)!;
    this.pushNotificationReceipt(updated);
    return json({ notification: updated });
  }

  private pushNotificationReceipt(notification: AppNotification): void {
    const receipt: NotificationReceipt = {
      notificationId: notification.id,
      dispatchId: notification.dispatchId,
      recipientId: notification.recipientId,
      deliveredAt: notification.deliveredAt,
      acknowledgedAt: notification.acknowledgedAt,
    };
    this.pushToUser(
      notification.senderId,
      "notification:receipt",
      receipt,
    );
  }

  private pushNotification(
    notification: AppNotification,
    type = "notification:new",
  ): void {
    this.pushToUser(notification.recipientId, type, notification);
  }

  private pushToUser(userId: string, type: string, data: unknown): void {
    const message = JSON.stringify({ type, data });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (
        attachment?.userId === userId &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.send(message);
      }
    }
  }

  private pushDirectMessage(message: DirectMessage, sender: UserRow): void {
    const payload = JSON.stringify({
      type: "message:new",
      data: {
        message,
        sender: toPublicUser(sender),
      },
    });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (
        attachment?.userId === message.recipientId &&
        socket.readyState === WebSocket.OPEN
      ) {
        socket.send(payload);
      }
    }
  }

  private closeUserSockets(userId: string): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.userId === userId) {
        socket.close(4003, "session revoked");
      }
    }
  }
}
