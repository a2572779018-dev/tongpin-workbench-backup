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
import {
  ExplorerLoraChainDataSource,
  normalizePendingInternalTransactions,
} from "../../server/lora-chain/source";
import {
  collectLoraAggregateSnapshot,
  readLoraAggregateDashboard,
} from "./lora-aggregate";
import {
  LORA_BURN_ADDRESS,
  LORA_BOOTSTRAP_INTERVAL_MS,
  LORA_CACHE_STALE_AFTER_MS,
  LORA_COLLECT_INTERVAL_MS,
  LORA_DEFAULT_RPC_URL,
  LORA_EXPLORER_API,
  LORA_PAIR_ADDRESS,
} from "../../server/lora-chain/constants";
import {
  EMPTY_LORA_COLLECTOR_STATE,
  EMPTY_LORA_HEALTH,
  EMPTY_LORA_PRICE,
} from "../../server/lora-chain/state";
import { buildLoraDashboard } from "../../server/lora-chain/statistics";
import {
  nextShanghaiClock,
  shanghaiDateKey,
  shanghaiDayBounds,
} from "../../server/lora-chain/time";
import type {
  LoraCollectionBatch,
  LoraCollectorState,
  LoraDailyAddressBaseline,
  LoraDashboardData,
  LoraDataStatus,
  LoraIndexedBlock,
  LoraIndexedInternalTransaction,
  LoraIndexedSwap,
  LoraIndexedTransaction,
  LoraPendingInternalTransaction,
  LoraPriceSnapshot,
  LoraSourceHealth,
} from "../../server/lora-chain/types";
import {
  businessDateKey,
  taskDatesForScope,
} from "../../server/business-date";
import { getMailMode, sendCodeEmail } from "./mailer";
import {
  ApiError,
  errorResponse,
  firstRow,
  isCompleteLoraCollectionCycle,
  isLoraDashboardRole,
  isLoraRpcSourceReachable,
  isEnabled,
  json,
  normalizeEmail,
  nextUnifiedAlarmTimestamp,
  nextLoraSuccessfulSyncAt,
  parseJson,
  resolveLoraNullableCheckpoint,
  shouldDispatchLoraDailyDue,
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
  DATABASE_MIGRATION_5,
  DATABASE_SCHEMA,
  LORA_INSERT_ADDRESS_BASELINE,
  LORA_RETENTION_QUERIES,
} from "./schema";

const LORA_RAW_COLLECTION_PAUSED = true;
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

interface LoraCheckpointRow extends Record<string, SqlStorageValue> {
  id: number;
  checkpoint_block: number | null;
  checkpoint_hash: string | null;
  block_cursor_json: string | null;
  transaction_cursor_json: string | null;
  burn_cursor_json: string | null;
  burn_history_cursor_json: string | null;
  head_transaction_hash: string | null;
  head_burn_key: string | null;
  block_head_cursor_json: string | null;
  block_head_candidate_key: string | null;
  transaction_head_cursor_json: string | null;
  transaction_head_candidate_hash: string | null;
  burn_head_cursor_json: string | null;
  burn_head_candidate_key: string | null;
  swap_checkpoint_block: number | null;
  pending_internal_transactions_json: string;
  internal_details_complete: number;
  swap_today_complete: number;
  bootstrap_date: string | null;
  transaction_today_complete: number;
  transaction_yesterday_complete: number;
  burn_today_complete: number;
  block_today_complete: number;
  today_complete: number;
  yesterday_complete: number;
  history_complete: number;
  current_total_addresses: string | null;
  next_run_at: string | null;
  last_attempt_at: string | null;
  last_successful_sync_at: string | null;
  last_0800_date: string | null;
  consecutive_failures: number;
}

interface LoraBlockRow extends Record<string, SqlStorageValue> {
  height: number;
  hash: string;
  parent_hash: string;
  timestamp: string;
  gas_used: string;
}

interface LoraTransactionRow extends Record<string, SqlStorageValue> {
  hash: string;
  block_number: number;
  timestamp: string;
  from_address: string;
  to_address: string | null;
  value_wei: string;
  success: number;
  gas_used: string;
  gas_price_wei: string;
  input: string;
  to_is_contract: number | null;
}

interface LoraInternalTransactionRow
  extends Record<string, SqlStorageValue> {
  transaction_hash: string;
  trace_index: string;
  block_number: number;
  timestamp: string;
  from_address: string;
  to_address: string | null;
  value_wei: string;
  success: number;
  call_type: string;
}

interface LoraSwapRow extends Record<string, SqlStorageValue> {
  transaction_hash: string;
  log_index: number;
  block_number: number;
  timestamp: string;
  side: string;
  lrb_wei: string;
  usdt_units: string;
  price_usdt: string;
  initiator: string;
  current_native_balance_wei: string | null;
}

interface LoraAddressBaselineRow extends Record<string, SqlStorageValue> {
  report_date: string;
  total_addresses: string;
  captured_at: string;
  block_number: number | null;
}

interface LoraPriceRow extends Record<string, SqlStorageValue> {
  id: number;
  status: LoraDataStatus;
  price_usdt: string | null;
  reserve_usdt: string | null;
  reserve_wlrb: string | null;
  block_number: number | null;
  updated_at: string | null;
  source: string | null;
  config_error: string | null;
}

interface LoraHealthRow extends Record<string, SqlStorageValue> {
  id: number;
  rpc_status: LoraDataStatus;
  explorer_status: LoraDataStatus;
  collector_status: LoraDataStatus;
  last_rpc_success_at: string | null;
  last_explorer_success_at: string | null;
  last_successful_sync_at: string | null;
  last_error: string | null;
}

interface LoraDashboardCacheRow extends Record<string, SqlStorageValue> {
  report_date: string;
  dashboard_json: string;
  generated_at: string;
  last_successful_sync_at: string | null;
}

interface SocketAttachment {
  userId: string | null;
  authenticationDeadline?: number;
}

const REALTIME_AUTHENTICATION_TIMEOUT_MS = 5_000;
const MAX_PENDING_REALTIME_AUTHENTICATIONS = 32;

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

function parseCursorJson(
  value: string | null,
): Record<string, string | number> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const cursor: Record<string, string | number> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item === "string" || typeof item === "number") {
        cursor[key] = item;
      }
    }
    return Object.keys(cursor).length > 0 ? cursor : null;
  } catch {
    return null;
  }
}

function parsePendingTransactionsJson(
  value: string | null,
): LoraPendingInternalTransaction[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return normalizePendingInternalTransactions(parsed);
  } catch {
    return [];
  }
}

function toLoraBlock(row: LoraBlockRow): LoraIndexedBlock {
  return {
    height: Number(row.height),
    hash: row.hash,
    parentHash: row.parent_hash,
    timestamp: row.timestamp,
    gasUsed: row.gas_used,
  };
}

function toLoraTransaction(row: LoraTransactionRow): LoraIndexedTransaction {
  return {
    hash: row.hash,
    blockNumber: Number(row.block_number),
    timestamp: row.timestamp,
    from: row.from_address,
    to: row.to_address,
    valueWei: row.value_wei,
    success: Boolean(row.success),
    gasUsed: row.gas_used,
    gasPriceWei: row.gas_price_wei,
    input: row.input,
    toIsContract:
      row.to_is_contract === null ? undefined : Boolean(row.to_is_contract),
  };
}

function toLoraInternalTransaction(
  row: LoraInternalTransactionRow,
): LoraIndexedInternalTransaction {
  return {
    transactionHash: row.transaction_hash,
    index: row.trace_index,
    blockNumber: Number(row.block_number),
    timestamp: row.timestamp,
    from: row.from_address,
    to: row.to_address,
    valueWei: row.value_wei,
    success: Boolean(row.success),
    callType: row.call_type,
  };
}

function toLoraSwap(row: LoraSwapRow): LoraIndexedSwap {
  return {
    transactionHash: row.transaction_hash,
    logIndex: Number(row.log_index),
    blockNumber: Number(row.block_number),
    timestamp: row.timestamp,
    side: row.side === "买入" ? "买入" : "卖出",
    lrbWei: row.lrb_wei,
    usdtUnits: row.usdt_units,
    priceUsdt: row.price_usdt,
    initiator: row.initiator,
    currentNativeBalanceWei: row.current_native_balance_wei,
  };
}

function toLoraAddressBaseline(
  row: LoraAddressBaselineRow,
): LoraDailyAddressBaseline {
  return {
    reportDate: row.report_date,
    totalAddresses: row.total_addresses,
    capturedAt: row.captured_at,
    blockNumber:
      row.block_number === null ? null : Number(row.block_number),
  };
}

function toLoraPrice(row: LoraPriceRow | undefined): LoraPriceSnapshot {
  if (!row) {
    return {
      ...EMPTY_LORA_PRICE,
      source: `WLRB/USDT Pair ${LORA_PAIR_ADDRESS}`,
    };
  }
  return {
    status: row.status,
    priceUsdt: row.price_usdt,
    reserveUsdt: row.reserve_usdt,
    reserveWlrb: row.reserve_wlrb,
    blockNumber:
      row.block_number === null ? null : Number(row.block_number),
    updatedAt: row.updated_at,
    source: row.source,
    configError: row.config_error,
  };
}

function toLoraHealth(row: LoraHealthRow | undefined): LoraSourceHealth {
  if (!row) return structuredClone(EMPTY_LORA_HEALTH);
  return {
    rpc: row.rpc_status,
    explorer: row.explorer_status,
    collector: row.collector_status,
    lastRpcSuccessAt: row.last_rpc_success_at,
    lastExplorerSuccessAt: row.last_explorer_success_at,
    lastSuccessfulSyncAt: row.last_successful_sync_at,
    lastError: row.last_error,
  };
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

function isDurableObjectRowWriteLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Exceeded allowed rows written in Durable Objects free tier")
  );
}

export class TongpinCore extends DurableObject<WorkerEnv> {
  private readonly sql: SqlStorage;
  private readonly loraSource: ExplorerLoraChainDataSource;
  private loraCollectionInFlight: Promise<LoraDashboardData> | null = null;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.loraSource = new ExplorerLoraChainDataSource(
      env.LORA_EXPLORER_API ?? LORA_EXPLORER_API,
      env.LORA_RPC_URL ?? LORA_DEFAULT_RPC_URL,
    );
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      if (!LORA_RAW_COLLECTION_PAUSED) {
        await this.scheduleNextAlarm();
      }
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
    try {
      const existingTables = new Set(
        this.sql
          .exec<{ name: string }>(
            `SELECT name FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('users', 'tasks', 'lora_chain_checkpoint')`,
          )
          .toArray()
          .map((row) => row.name),
      );
      if (
        existingTables.has("users") &&
        existingTables.has("tasks") &&
        existingTables.has("lora_chain_checkpoint")
      ) {
        return;
      }
    } catch (error) {
      if (isDurableObjectRowWriteLimit(error)) return;
      throw error;
    }
    try {
      const currentVersion = Number(
        firstRow(
          this.sql.exec<{ version: number }>(
            "SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations",
          ),
        )?.version ?? 0,
      );
      if (currentVersion >= 5) return;
    } catch {
      // A fresh database does not have the migration table yet.
    }
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
    if (version < 5) {
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(DATABASE_MIGRATION_5);
        this.sql.exec(
          `INSERT OR IGNORE INTO lora_chain_checkpoint
           (id, next_run_at) VALUES (1, ?)`,
          new Date(Date.now() + 1_000).toISOString(),
        );
        this.sql.exec(
          `INSERT OR IGNORE INTO lora_chain_price
           (id, status, source)
           VALUES (1, 'unavailable', ?)`,
          `WLRB/USDT Pair ${LORA_PAIR_ADDRESS}`,
        );
        this.sql.exec(
          `INSERT OR IGNORE INTO lora_chain_health
           (id, rpc_status, explorer_status, collector_status)
           VALUES (1, 'unavailable', 'unavailable', 'building')`,
        );
        this.sql.exec(
          "INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (5)",
        );
      });
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

      if (path === "/api/boss/lora-chain/dashboard" && method === "GET") {
        return await this.getLoraDashboard(request);
      }
      if (path === "/api/boss/lora-chain/refresh" && method === "POST") {
        return await this.refreshLoraDashboard(request);
      }
      if (
        path === "/api/boss/lora-chain/daily-popup/claim" &&
        method === "POST"
      ) {
        return await this.claimLoraDailyPopup(request);
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
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (
        !attachment?.userId &&
        typeof attachment?.authenticationDeadline === "number" &&
        Date.now() > attachment.authenticationDeadline
      ) {
        socket.close(4001, "authentication timeout");
        return;
      }
      if (payload.type === "auth" && typeof payload.token === "string") {
        if (attachment?.userId) {
          socket.close(4002, "already authenticated");
          return;
        }
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
            data: { connected: true, heartbeat: true },
          }),
        );
        for (const notification of this.pendingNotificationsForUser(user.id)) {
          socket.send(
            JSON.stringify({
              type: "notification:new",
              data: notification,
            }),
          );
        }
        return;
      }
      if (payload.type === "ping" && attachment?.userId) {
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
    const now = new Date();
    try {
      this.expireDueFlashMessages();
      this.dispatchLoraDailyDue(now);
    } catch (error) {
      if (!isDurableObjectRowWriteLimit(error)) throw error;
    }
    if (LORA_RAW_COLLECTION_PAUSED) {
      return;
    }
    const checkpoint = this.loraCheckpoint();
    const nextMidnight = nextShanghaiClock(now, 0);
    const millisecondsUntilMidnight =
      nextMidnight.getTime() - now.getTime();
    if (
      checkpoint.bootstrap_date === shanghaiDateKey(now) &&
      millisecondsUntilMidnight > 0 &&
      millisecondsUntilMidnight <= 15_000 &&
      (!checkpoint.next_run_at ||
        Date.parse(checkpoint.next_run_at) <= now.getTime())
    ) {
      this.sql.exec(
        "UPDATE lora_chain_checkpoint SET next_run_at = ? WHERE id = 1",
        nextMidnight.toISOString(),
      );
      await this.scheduleNextAlarm(now);
      return;
    }
    if (
      checkpoint.bootstrap_date !== shanghaiDateKey(now) ||
      !checkpoint.next_run_at ||
      Date.parse(checkpoint.next_run_at) <= now.getTime()
    ) {
      await this.runLoraCollection();
      return;
    }
    await this.scheduleNextAlarm(now);
  }

  private upgradeRealtime(request: Request): Response {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      throw new ApiError(426, "WEBSOCKET_REQUIRED", "需要 WebSocket 连接");
    }
    if (
      this.pendingRealtimeAuthenticationCount() >=
      MAX_PENDING_REALTIME_AUTHENTICATIONS
    ) {
      throw new ApiError(
        503,
        "REALTIME_BUSY",
        "实时连接繁忙，请稍后重试",
      );
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      userId: null,
      authenticationDeadline: Date.now() + REALTIME_AUTHENTICATION_TIMEOUT_MS,
    } satisfies SocketAttachment);
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

  private loraCheckpoint(): LoraCheckpointRow {
    let row = firstRow(
      this.sql.exec<LoraCheckpointRow>(
        "SELECT * FROM lora_chain_checkpoint WHERE id = 1",
      ),
    );
    if (!row) {
      this.sql.exec(
        `INSERT INTO lora_chain_checkpoint (id, next_run_at)
         VALUES (1, ?)`,
        new Date(Date.now() + 1_000).toISOString(),
      );
      row = firstRow(
        this.sql.exec<LoraCheckpointRow>(
          "SELECT * FROM lora_chain_checkpoint WHERE id = 1",
        ),
      );
    }
    if (!row) throw new Error("LORA checkpoint initialization failed");
    return row;
  }

  private async requireLoraUser(request: Request): Promise<UserRow> {
    const user = await this.requireUser(request);
    if (!isLoraDashboardRole(user.role)) {
      throw new ApiError(403, "FORBIDDEN", "你没有访问此功能的权限");
    }
    return user;
  }

  private loraStateFromCheckpoint(
    row: LoraCheckpointRow,
  ): LoraCollectorState {
    return {
      checkpointBlock:
        row.checkpoint_block === null ? null : Number(row.checkpoint_block),
      checkpointHash: row.checkpoint_hash,
      blockCursor: parseCursorJson(row.block_cursor_json),
      transactionCursor: parseCursorJson(row.transaction_cursor_json),
      burnCursor: parseCursorJson(row.burn_cursor_json),
      burnHistoryCursor: parseCursorJson(row.burn_history_cursor_json),
      headTransactionHash: row.head_transaction_hash,
      headBurnKey: row.head_burn_key,
      blockHeadCursor: parseCursorJson(row.block_head_cursor_json),
      blockHeadCandidateKey: row.block_head_candidate_key,
      transactionHeadCursor: parseCursorJson(
        row.transaction_head_cursor_json,
      ),
      transactionHeadCandidateHash: row.transaction_head_candidate_hash,
      burnHeadCursor: parseCursorJson(row.burn_head_cursor_json),
      burnHeadCandidateKey: row.burn_head_candidate_key,
      swapCheckpointBlock:
        row.swap_checkpoint_block === null
          ? null
          : Number(row.swap_checkpoint_block),
      pendingInternalTransactions: parsePendingTransactionsJson(
        row.pending_internal_transactions_json,
      ),
      internalDetailsComplete: Boolean(row.internal_details_complete),
      swapTodayComplete: Boolean(row.swap_today_complete),
      bootstrapDate: row.bootstrap_date,
      transactionTodayComplete: Boolean(row.transaction_today_complete),
      transactionYesterdayComplete: Boolean(
        row.transaction_yesterday_complete,
      ),
      burnTodayComplete: Boolean(row.burn_today_complete),
      blockTodayComplete: Boolean(row.block_today_complete),
      todayComplete: Boolean(row.today_complete),
      yesterdayComplete: Boolean(row.yesterday_complete),
      historyComplete: Boolean(row.history_complete),
      nextRunAt: row.next_run_at,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessfulSyncAt: row.last_successful_sync_at,
      consecutiveFailures: Number(row.consecutive_failures),
    };
  }

  private prepareLoraState(now: Date): LoraCollectorState {
    const reportDate = shanghaiDateKey(now);
    const row = this.loraCheckpoint();
    if (row.bootstrap_date !== reportDate) {
      this.sql.exec(
        `UPDATE lora_chain_checkpoint
         SET bootstrap_date = ?,
             block_cursor_json = NULL,
             transaction_cursor_json = NULL,
             burn_cursor_json = NULL,
             transaction_today_complete = 0,
             transaction_yesterday_complete = 0,
             burn_today_complete = 0,
             block_today_complete = 0,
             internal_details_complete = 0,
             swap_today_complete = 0,
             today_complete = 0,
             yesterday_complete = 0
         WHERE id = 1`,
        reportDate,
      );
    }
    return this.loraStateFromCheckpoint(this.loraCheckpoint());
  }

  private buildLoraDashboardFromSql(now = new Date()): LoraDashboardData {
    const { yesterdayStart } = shanghaiDayBounds(now);
    const lowerBound = yesterdayStart.toISOString();
    const checkpoint = this.loraCheckpoint();
    const blocks = this.sql
      .exec<LoraBlockRow>(
        `SELECT * FROM lora_chain_blocks
         WHERE timestamp >= ? ORDER BY height ASC`,
        lowerBound,
      )
      .toArray()
      .map(toLoraBlock);
    const transactions = this.sql
      .exec<LoraTransactionRow>(
        `SELECT * FROM lora_chain_transactions
         WHERE timestamp >= ? ORDER BY timestamp ASC`,
        lowerBound,
      )
      .toArray()
      .map(toLoraTransaction);
    const internalTransactions = this.sql
      .exec<LoraInternalTransactionRow>(
        `SELECT * FROM lora_chain_internal_transactions
         WHERE timestamp >= ? OR lower(to_address) = ?
         ORDER BY timestamp ASC`,
        lowerBound,
        LORA_BURN_ADDRESS,
      )
      .toArray()
      .map(toLoraInternalTransaction);
    const swaps = this.sql
      .exec<LoraSwapRow>(
        `SELECT * FROM lora_chain_swaps
         WHERE timestamp >= ?
            OR rowid = (
              SELECT rowid FROM lora_chain_swaps
              ORDER BY timestamp DESC LIMIT 1
            )
         ORDER BY timestamp ASC`,
        lowerBound,
      )
      .toArray()
      .map(toLoraSwap);
    const addressBaselines = this.sql
      .exec<LoraAddressBaselineRow>(
        `SELECT * FROM lora_chain_address_baselines
         ORDER BY report_date DESC LIMIT 3`,
      )
      .toArray()
      .map(toLoraAddressBaseline);
    const price = toLoraPrice(
      firstRow(
        this.sql.exec<LoraPriceRow>(
          "SELECT * FROM lora_chain_price WHERE id = 1",
        ),
      ),
    );
    const health = toLoraHealth(
      firstRow(
        this.sql.exec<LoraHealthRow>(
          "SELECT * FROM lora_chain_health WHERE id = 1",
        ),
      ),
    );
    const state = this.loraStateFromCheckpoint(checkpoint);
    if (state.bootstrapDate !== shanghaiDateKey(now)) {
      state.blockCursor = null;
      state.transactionCursor = null;
      state.burnCursor = null;
      state.transactionTodayComplete = false;
      state.transactionYesterdayComplete = false;
      state.burnTodayComplete = false;
      state.blockTodayComplete = false;
      state.internalDetailsComplete = false;
      state.swapTodayComplete = false;
      state.todayComplete = false;
      state.yesterdayComplete = false;
    }
    return buildLoraDashboard({
      now,
      blocks,
      transactions,
      internalTransactions,
      swaps,
      addressBaselines,
      currentTotalAddresses: checkpoint.current_total_addresses,
      price,
      state,
      health,
    });
  }

  private cachedLoraDashboard(now = new Date()): LoraDashboardData {
    const row = firstRow(
      this.sql.exec<LoraDashboardCacheRow>(
        `SELECT * FROM lora_chain_dashboard_cache
         WHERE report_date = ? LIMIT 1`,
        shanghaiDateKey(now),
      ),
    );
    if (row) {
      try {
        const dashboard = JSON.parse(row.dashboard_json) as LoraDashboardData;
        const lastSuccessfulSyncAt =
          row.last_successful_sync_at ?? dashboard.lastSuccessfulSyncAt;
        const stale =
          !lastSuccessfulSyncAt ||
          now.getTime() - Date.parse(lastSuccessfulSyncAt) >
            LORA_CACHE_STALE_AFTER_MS;
        if (!stale) return dashboard;
        const staleStatus = (status: LoraDataStatus): LoraDataStatus =>
          status === "ready" ? "stale" : status;
        return {
          ...dashboard,
          generatedAt: now.toISOString(),
          stale: true,
          baselineStatus:
            dashboard.baselineStatus === "building"
              ? "building"
              : "stale",
          health: {
            ...dashboard.health,
            rpc: staleStatus(dashboard.health.rpc),
            explorer: staleStatus(dashboard.health.explorer),
            collector: staleStatus(dashboard.health.collector),
          },
          price: {
            ...dashboard.price,
            status: staleStatus(dashboard.price.status),
          },
          swaps: {
            ...dashboard.swaps,
            status: staleStatus(dashboard.swaps.status),
          },
        };
      } catch {
        // Rebuild only from persisted SQL if a cache row is corrupt.
      }
    }
    return this.buildLoraDashboardFromSql(now);
  }

  private async getLoraDashboard(request: Request): Promise<Response> {
    await this.requireLoraUser(request);
    const now = new Date();
    const dashboard =
      (await readLoraAggregateDashboard(this.env.RELEASES, now)) ??
      this.buildLoraDashboardFromSql(now);
    return json(dashboard);
  }

  private async refreshLoraDashboard(request: Request): Promise<Response> {
    await this.requireLoraUser(request);
    const now = new Date();
    const current =
      (await readLoraAggregateDashboard(this.env.RELEASES, now)) ??
      this.buildLoraDashboardFromSql(now);
    this.ctx.waitUntil(
      collectLoraAggregateSnapshot({
        bucket: this.env.RELEASES,
        source: this.loraSource,
      })
        .then((dashboard) => this.pushLoraDashboard(dashboard))
        .catch((error) => console.error("LORA aggregate refresh failed", error)),
    );
    return json({ accepted: true, dashboard: current }, 202);
  }

  private async claimLoraDailyPopup(request: Request): Promise<Response> {
    const user = await this.requireLoraUser(request);
    let payload: unknown = {};
    if (request.body) payload = await parseJson(request);
    const trigger =
      payload && typeof payload === "object" && "trigger" in payload
        ? (payload as { trigger?: unknown }).trigger
        : "startup";
    const allowedTriggers = new Set([
      "startup",
      "login",
      "08:00",
      "reconnect",
      "manual",
    ]);
    if (typeof trigger !== "string" || !allowedTriggers.has(trigger)) {
      throw new ApiError(400, "INVALID_TRIGGER", "无效的驾驶舱打开来源");
    }
    const reportDate = shanghaiDateKey();
    const dashboard =
      (await readLoraAggregateDashboard(this.env.RELEASES)) ??
      this.cachedLoraDashboard();
    if (user.role === "admin" || trigger === "manual") {
      return json({ shouldOpen: false, reportDate, dashboard });
    }

    const claimedAt = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const existing = firstRow(
        this.sql.exec<{ claimed_at: string }>(
          `SELECT claimed_at FROM boss_lora_report_opens
           WHERE boss_user_id = ? AND report_date = ?`,
          user.id,
          reportDate,
        ),
      );
      if (existing) {
        return { shouldOpen: false, claimedAt: existing.claimed_at };
      }
      this.sql.exec(
        `INSERT INTO boss_lora_report_opens
         (boss_user_id, report_date, claimed_at, trigger)
         VALUES (?, ?, ?, ?)`,
        user.id,
        reportDate,
        claimedAt,
        trigger,
      );
      return { shouldOpen: true, claimedAt };
    });
    return json({ reportDate, ...result, dashboard });
  }

  private persistLoraBatch(batch: LoraCollectionBatch, now: Date): void {
    this.ctx.storage.transactionSync(() => {
      for (const block of batch.blocks) {
        this.sql.exec(
          `INSERT INTO lora_chain_blocks
           (height, hash, parent_hash, timestamp, gas_used)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(height) DO UPDATE SET
             hash = excluded.hash,
             parent_hash = excluded.parent_hash,
             timestamp = excluded.timestamp,
             gas_used = excluded.gas_used`,
          block.height,
          block.hash,
          block.parentHash,
          block.timestamp,
          block.gasUsed,
        );
      }
      for (const transaction of batch.transactions) {
        this.sql.exec(
          `INSERT INTO lora_chain_transactions
           (hash, block_number, timestamp, from_address, to_address,
            value_wei, success, gas_used, gas_price_wei, input, to_is_contract)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hash) DO UPDATE SET
             block_number = excluded.block_number,
             timestamp = excluded.timestamp,
             from_address = excluded.from_address,
             to_address = excluded.to_address,
             value_wei = excluded.value_wei,
             success = excluded.success,
             gas_used = excluded.gas_used,
             gas_price_wei = excluded.gas_price_wei,
             input = excluded.input,
             to_is_contract = excluded.to_is_contract`,
          transaction.hash,
          transaction.blockNumber,
          transaction.timestamp,
          transaction.from,
          transaction.to,
          transaction.valueWei,
          transaction.success ? 1 : 0,
          transaction.gasUsed,
          transaction.gasPriceWei,
          transaction.input,
          transaction.toIsContract === undefined
            ? null
            : transaction.toIsContract
              ? 1
              : 0,
        );
      }
      for (const transaction of batch.internalTransactions) {
        this.sql.exec(
          `INSERT INTO lora_chain_internal_transactions
           (transaction_hash, trace_index, block_number, timestamp,
            from_address, to_address, value_wei, success, call_type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(transaction_hash, trace_index) DO UPDATE SET
             block_number = excluded.block_number,
             timestamp = excluded.timestamp,
             from_address = excluded.from_address,
             to_address = excluded.to_address,
             value_wei = excluded.value_wei,
             success = excluded.success,
             call_type = excluded.call_type`,
          transaction.transactionHash,
          transaction.index,
          transaction.blockNumber,
          transaction.timestamp,
          transaction.from,
          transaction.to,
          transaction.valueWei,
          transaction.success ? 1 : 0,
          transaction.callType,
        );
      }
      for (const swap of batch.swaps) {
        this.sql.exec(
          `INSERT INTO lora_chain_swaps
           (transaction_hash, log_index, block_number, timestamp, side,
            lrb_wei, usdt_units, price_usdt, initiator,
            current_native_balance_wei)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(transaction_hash, log_index) DO UPDATE SET
             block_number = excluded.block_number,
             timestamp = excluded.timestamp,
             side = excluded.side,
             lrb_wei = excluded.lrb_wei,
             usdt_units = excluded.usdt_units,
             price_usdt = excluded.price_usdt,
             initiator = excluded.initiator,
             current_native_balance_wei = excluded.current_native_balance_wei`,
          swap.transactionHash,
          swap.logIndex,
          swap.blockNumber,
          swap.timestamp,
          swap.side,
          swap.lrbWei,
          swap.usdtUnits,
          swap.priceUsdt,
          swap.initiator,
          swap.currentNativeBalanceWei,
        );
      }
      if (batch.addressBaseline) {
        this.sql.exec(
          LORA_INSERT_ADDRESS_BASELINE,
          batch.addressBaseline.reportDate,
          batch.addressBaseline.totalAddresses,
          batch.addressBaseline.capturedAt,
          batch.addressBaseline.blockNumber,
        );
      }

      const currentPrice = firstRow(
        this.sql.exec<LoraPriceRow>(
          "SELECT * FROM lora_chain_price WHERE id = 1",
        ),
      );
      if (
        batch.price.status === "ready" ||
        batch.price.status === "config-error" ||
        !currentPrice?.updated_at
      ) {
        this.sql.exec(
          `INSERT INTO lora_chain_price
           (id, status, price_usdt, reserve_usdt, reserve_wlrb,
            block_number, updated_at, source, config_error)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             status = excluded.status,
             price_usdt = excluded.price_usdt,
             reserve_usdt = excluded.reserve_usdt,
             reserve_wlrb = excluded.reserve_wlrb,
             block_number = excluded.block_number,
             updated_at = excluded.updated_at,
             source = excluded.source,
             config_error = excluded.config_error`,
          batch.price.status,
          batch.price.priceUsdt,
          batch.price.reserveUsdt,
          batch.price.reserveWlrb,
          batch.price.blockNumber,
          batch.price.updatedAt,
          batch.price.source,
          batch.price.configError,
        );
      } else {
        this.sql.exec(
          "UPDATE lora_chain_price SET status = 'stale' WHERE id = 1",
        );
      }

      const checkpoint = this.loraCheckpoint();
      const rpcReachable = isLoraRpcSourceReachable(
        batch.rpcHealthy,
        batch.price.status,
      );
      const cycleComplete = isCompleteLoraCollectionCycle({
        rpcHealthy: rpcReachable,
        explorerHealthy: batch.explorerHealthy,
      });
      const syncedAt = nextLoraSuccessfulSyncAt(
        cycleComplete,
        now.toISOString(),
        checkpoint.last_successful_sync_at,
      );
      this.sql.exec(
        `UPDATE lora_chain_checkpoint
         SET checkpoint_block = ?,
             checkpoint_hash = ?,
             block_cursor_json = ?,
             transaction_cursor_json = ?,
             burn_cursor_json = ?,
             burn_history_cursor_json = ?,
             head_transaction_hash = ?,
             head_burn_key = ?,
             block_head_cursor_json = ?,
             block_head_candidate_key = ?,
             transaction_head_cursor_json = ?,
             transaction_head_candidate_hash = ?,
             burn_head_cursor_json = ?,
             burn_head_candidate_key = ?,
             swap_checkpoint_block = ?,
             pending_internal_transactions_json = ?,
             internal_details_complete = ?,
             swap_today_complete = ?,
             bootstrap_date = ?,
             transaction_today_complete = ?,
             transaction_yesterday_complete = ?,
             burn_today_complete = ?,
             block_today_complete = ?,
             today_complete = ?,
             yesterday_complete = ?,
             history_complete = ?,
             current_total_addresses = COALESCE(?, current_total_addresses),
             next_run_at = ?,
             last_attempt_at = ?,
             last_successful_sync_at = ?,
             consecutive_failures = ?
         WHERE id = 1`,
        batch.checkpointBlock,
        batch.checkpointHash,
        batch.nextBlockCursor ? JSON.stringify(batch.nextBlockCursor) : null,
        batch.nextTransactionCursor
          ? JSON.stringify(batch.nextTransactionCursor)
          : null,
        batch.nextBurnCursor ? JSON.stringify(batch.nextBurnCursor) : null,
        batch.nextBurnHistoryCursor
          ? JSON.stringify(batch.nextBurnHistoryCursor)
          : null,
        batch.headTransactionHash ?? checkpoint.head_transaction_hash,
        batch.headBurnKey ?? checkpoint.head_burn_key,
        batch.blockHeadCursor === undefined
          ? checkpoint.block_head_cursor_json
          : batch.blockHeadCursor
            ? JSON.stringify(batch.blockHeadCursor)
            : null,
        batch.blockHeadCandidateKey === undefined
          ? checkpoint.block_head_candidate_key
          : batch.blockHeadCandidateKey,
        batch.transactionHeadCursor === undefined
          ? checkpoint.transaction_head_cursor_json
          : batch.transactionHeadCursor
            ? JSON.stringify(batch.transactionHeadCursor)
            : null,
        batch.transactionHeadCandidateHash === undefined
          ? checkpoint.transaction_head_candidate_hash
          : batch.transactionHeadCandidateHash,
        batch.burnHeadCursor === undefined
          ? checkpoint.burn_head_cursor_json
          : batch.burnHeadCursor
            ? JSON.stringify(batch.burnHeadCursor)
            : null,
        batch.burnHeadCandidateKey === undefined
          ? checkpoint.burn_head_candidate_key
          : batch.burnHeadCandidateKey,
        resolveLoraNullableCheckpoint(
          batch.swapCheckpointBlock,
          checkpoint.swap_checkpoint_block,
        ),
        JSON.stringify(
          batch.pendingInternalTransactions ??
            parsePendingTransactionsJson(
              checkpoint.pending_internal_transactions_json,
            ),
        ),
        (batch.internalDetailsComplete ??
        Boolean(checkpoint.internal_details_complete))
          ? 1
          : 0,
        (batch.swapTodayComplete ?? Boolean(checkpoint.swap_today_complete))
          ? 1
          : 0,
        shanghaiDateKey(now),
        batch.transactionTodayComplete ? 1 : 0,
        batch.transactionYesterdayComplete ? 1 : 0,
        batch.burnTodayComplete ? 1 : 0,
        batch.blockTodayComplete ? 1 : 0,
        batch.todayComplete ? 1 : 0,
        batch.yesterdayComplete ? 1 : 0,
        batch.historyComplete ? 1 : 0,
        batch.currentTotalAddresses,
        new Date(
          now.getTime() +
            (batch.todayComplete
              ? LORA_COLLECT_INTERVAL_MS
              : LORA_BOOTSTRAP_INTERVAL_MS),
        ).toISOString(),
        now.toISOString(),
        syncedAt,
        cycleComplete ? 0 : Number(checkpoint.consecutive_failures) + 1,
      );

      const health = toLoraHealth(
        firstRow(
          this.sql.exec<LoraHealthRow>(
            "SELECT * FROM lora_chain_health WHERE id = 1",
          ),
        ),
      );
      this.sql.exec(
        `INSERT INTO lora_chain_health
         (id, rpc_status, explorer_status, collector_status,
          last_rpc_success_at, last_explorer_success_at,
          last_successful_sync_at, last_error)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           rpc_status = excluded.rpc_status,
           explorer_status = excluded.explorer_status,
           collector_status = excluded.collector_status,
           last_rpc_success_at = excluded.last_rpc_success_at,
           last_explorer_success_at = excluded.last_explorer_success_at,
           last_successful_sync_at = excluded.last_successful_sync_at,
           last_error = excluded.last_error`,
        rpcReachable ? "ready" : "unavailable",
        batch.explorerHealthy ? "ready" : "unavailable",
        cycleComplete ? "ready" : "unavailable",
        rpcReachable ? now.toISOString() : health.lastRpcSuccessAt,
        batch.explorerHealthy
          ? now.toISOString()
          : health.lastExplorerSuccessAt,
        syncedAt,
        cycleComplete
          ? null
          : !rpcReachable && !batch.explorerHealthy
            ? "RPC and Explorer unavailable"
            : !rpcReachable
              ? "RPC unavailable"
              : "Explorer collection incomplete",
      );

      const retentionBoundary = new Date(
        now.getTime() - 9 * 24 * 60 * 60 * 1_000,
      ).toISOString();
      this.sql.exec(
        LORA_RETENTION_QUERIES.blocks,
        retentionBoundary,
      );
      this.sql.exec(
        LORA_RETENTION_QUERIES.transactions,
        retentionBoundary,
      );
      this.sql.exec(
        LORA_RETENTION_QUERIES.nonBurnInternals,
        retentionBoundary,
        LORA_BURN_ADDRESS,
      );
      this.sql.exec(
        LORA_RETENTION_QUERIES.swaps,
        retentionBoundary,
      );
    });

    const dashboard = this.buildLoraDashboardFromSql(now);
    this.sql.exec(
      `INSERT INTO lora_chain_dashboard_cache
       (report_date, dashboard_json, generated_at, last_successful_sync_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(report_date) DO UPDATE SET
         dashboard_json = excluded.dashboard_json,
         generated_at = excluded.generated_at,
         last_successful_sync_at = excluded.last_successful_sync_at`,
      dashboard.reportDate,
      JSON.stringify(dashboard),
      dashboard.generatedAt,
      dashboard.lastSuccessfulSyncAt,
    );
    this.sql.exec(
      `DELETE FROM lora_chain_dashboard_cache
       WHERE report_date NOT IN (
         SELECT report_date FROM lora_chain_dashboard_cache
         ORDER BY report_date DESC LIMIT 8
       )`,
    );
  }

  private markLoraCollectionFailure(error: unknown, now: Date): void {
    const checkpoint = this.loraCheckpoint();
    const message = error instanceof Error ? error.message : "collection failed";
    this.sql.exec(
      `UPDATE lora_chain_checkpoint
       SET last_attempt_at = ?, next_run_at = ?, consecutive_failures = ?
       WHERE id = 1`,
      now.toISOString(),
      new Date(now.getTime() + LORA_COLLECT_INTERVAL_MS).toISOString(),
      Number(checkpoint.consecutive_failures) + 1,
    );
    this.sql.exec(
      `UPDATE lora_chain_health
       SET collector_status = 'unavailable', last_error = ?
       WHERE id = 1`,
      message.slice(0, 300),
    );
  }

  private pushLoraDashboard(dashboard: LoraDashboardData): void {
    const recipients = this.sql
      .exec<{ id: string }>(
        `SELECT id FROM users
         WHERE status = 'active' AND role IN ('boss', 'admin')`,
      )
      .toArray();
    for (const recipient of recipients) {
      this.pushToUser(recipient.id, "lora-chain:updated", { dashboard });
    }
  }

  private runLoraCollection(): Promise<LoraDashboardData> {
    if (this.loraCollectionInFlight) return this.loraCollectionInFlight;
    const operation = this.collectLoraOnce();
    this.loraCollectionInFlight = operation.finally(() => {
      this.loraCollectionInFlight = null;
    });
    return this.loraCollectionInFlight;
  }

  private async collectLoraOnce(): Promise<LoraDashboardData> {
    const now = new Date();
    try {
      const state = this.prepareLoraState(now);
      const batch = await this.loraSource.collect({ state, now });
      this.persistLoraBatch(batch, now);
      const dashboard = this.cachedLoraDashboard(now);
      this.pushLoraDashboard(dashboard);
      return dashboard;
    } catch (error) {
      this.markLoraCollectionFailure(error, now);
      const dashboard = this.cachedLoraDashboard(now);
      this.pushLoraDashboard(dashboard);
      return dashboard;
    } finally {
      await this.scheduleNextAlarm();
    }
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
    const dates = taskDatesForScope(body.date, body.scope);
    const created: Task[] = [];
    this.ctx.storage.transactionSync(() => {
      for (const date of dates) {
        const id = crypto.randomUUID();
        this.sql.exec(
          `INSERT INTO tasks
           (id, user_id, date, title, details, status, priority, completed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          user.id,
          date,
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
        const item = toTask(task);
        this.recordTaskAudit(item, user.id, "created", [], now);
        created.push(item);
      }
    });
    if (body.scope === "rest_of_week") {
      this.pushToUser(user.id, "task:batch-changed", {
        tasks: created,
        dates,
      });
    } else {
      this.pushToUser(user.id, "task:changed", { task: created[0] });
    }
    return json({ task: created[0], tasks: created }, 201);
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
    await this.scheduleNextAlarm();
  }

  private dispatchLoraDailyDue(now: Date): void {
    const reportDate = shanghaiDateKey(now);
    const dueAt = Date.parse(`${reportDate}T08:00:00+08:00`);
    const checkpoint = this.loraCheckpoint();
    if (!shouldDispatchLoraDailyDue({
      nowMs: now.getTime(),
      dueAtMs: dueAt,
      reportDate,
      lastDispatchedDate: checkpoint.last_0800_date,
    })) {
      return;
    }
    const bosses = this.sql
      .exec<{ id: string }>(
        `SELECT u.id
         FROM users u
         WHERE u.status = 'active' AND u.role = 'boss'
           AND NOT EXISTS (
             SELECT 1 FROM boss_lora_report_opens report
             WHERE report.boss_user_id = u.id
               AND report.report_date = ?
           )`,
        reportDate,
      )
      .toArray();
    for (const boss of bosses) {
      this.pushToUser(boss.id, "lora-chain:daily-popup", {
        reportDate,
        trigger: "08:00",
      });
    }
    this.sql.exec(
      "UPDATE lora_chain_checkpoint SET last_0800_date = ? WHERE id = 1",
      reportDate,
    );
  }

  private async scheduleNextAlarm(now = new Date()): Promise<void> {
    const nextFlash = firstRow(
      this.sql.exec<{ expires_at: string | null }>(
        `SELECT MIN(expires_at) AS expires_at
         FROM direct_messages
         WHERE mode = 'flash' AND destroyed_at IS NULL
           AND expires_at IS NOT NULL`,
      ),
    )?.expires_at;
    const checkpoint = this.loraCheckpoint();
    const candidates = [
      nextFlash ? Date.parse(nextFlash) : Number.POSITIVE_INFINITY,
      checkpoint.next_run_at
        ? Date.parse(checkpoint.next_run_at)
        : now.getTime() + 1_000,
      nextShanghaiClock(now, 0).getTime(),
    ];
    const reportDate = shanghaiDateKey(now);
    const today0800 = Date.parse(`${reportDate}T08:00:00+08:00`);
    if (
      checkpoint.last_0800_date !== reportDate &&
      now.getTime() >= today0800
    ) {
      candidates.push(now.getTime() + 1);
    } else {
      candidates.push(nextShanghaiClock(now, 8).getTime());
    }
    await this.ctx.storage.setAlarm(
      nextUnifiedAlarmTimestamp(now.getTime(), candidates),
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
    const notifications: AppNotification[] = [];
    this.ctx.storage.transactionSync(() => {
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
      }
    });
    for (const notification of notifications) {
      this.pushNotification(notification);
    }
    const dispatch = this.notificationDispatchById(dispatchId, boss.id)!;
    return json(
      {
        targeted: notifications.length,
        accepted: notifications.length,
        delivered: 0,
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
    const recent = this.sql
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
    const merged = new Map(
      this.pendingNotificationsForUser(user.id).map((notification) => [
        notification.id,
        notification,
      ]),
    );
    for (const notification of recent) {
      merged.set(notification.id, notification);
    }
    const notifications = [...merged.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
    return json({
      notifications,
      unread: notifications.filter((item) => !item.readAt).length,
    });
  }

  private pendingNotificationsForUser(userId: string): AppNotification[] {
    return this.sql
      .exec<NotificationRow>(
        `SELECT n.*,
                r.dispatch_id,
                r.delivered_at,
                r.acknowledged_at,
                d.ding_count,
                d.last_ding_at
         FROM notifications n
         INNER JOIN notification_receipts r ON r.notification_id = n.id
         INNER JOIN notification_dispatches d ON d.id = r.dispatch_id
         WHERE n.recipient_id = ? AND r.acknowledged_at IS NULL
         ORDER BY n.created_at ASC`,
        userId,
      )
      .toArray()
      .map(toNotification);
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
    const changed = !notification.deliveredAt;
    this.sql.exec(
      `UPDATE notification_receipts
       SET delivered_at = COALESCE(delivered_at, ?)
       WHERE notification_id = ?`,
      new Date().toISOString(),
      notificationId,
    );
    const updated = this.notificationById(notificationId)!;
    if (changed) this.pushNotificationReceipt(updated);
    this.pushNotification(updated);
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
    const changed = !notification.acknowledgedAt;
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
    if (changed) this.pushNotificationReceipt(updated);
    this.pushNotification(updated);
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
    for (const socket of this.authenticatedSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (
        attachment?.userId === userId &&
        socket.readyState === WebSocket.OPEN
      ) {
        try {
          socket.send(message);
        } catch {
          try {
            socket.close(1011, "realtime delivery failed");
          } catch {
            // A failed client must not block delivery to the remaining devices.
          }
        }
      }
    }
  }

  private pushDirectMessage(message: DirectMessage, sender: UserRow): void {
    this.pushToUser(message.recipientId, "message:new", {
      message,
      sender: toPublicUser(sender),
    });
  }

  private closeUserSockets(userId: string): void {
    for (const socket of this.authenticatedSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.userId === userId) {
        try {
          socket.close(4003, "session revoked");
        } catch {
          // Continue revoking any other open device sessions.
        }
      }
    }
  }

  private authenticatedSockets(): WebSocket[] {
    const now = Date.now();
    const authenticated: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.userId) {
        authenticated.push(socket);
        continue;
      }
      if (
        typeof attachment?.authenticationDeadline === "number" &&
        now > attachment.authenticationDeadline
      ) {
        try {
          socket.close(4001, "authentication timeout");
        } catch {
          // Closing one stale socket must not interrupt realtime fan-out.
        }
      }
    }
    return authenticated;
  }

  private pendingRealtimeAuthenticationCount(): number {
    const now = Date.now();
    let pending = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.userId) continue;
      if (
        typeof attachment?.authenticationDeadline === "number" &&
        now <= attachment.authenticationDeadline
      ) {
        pending += 1;
        continue;
      }
      try {
        socket.close(4001, "authentication timeout");
      } catch {
        // A stale unauthenticated socket must not block a new legitimate client.
      }
    }
    return pending;
  }
}
