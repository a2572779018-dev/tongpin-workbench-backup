import type {
  AppNotification,
  DirectMessage,
  Task,
  User,
  UserRole,
} from "../../server/types";

export interface WorkerEnv extends WorkerBindings {
  JWT_SECRET: string;
  DIFY_TOOL_ENABLED?: string;
  DIFY_APP_ID?: string;
  DIFY_TOOL_SECRET?: string;
  TONGPIN_H3_API_KEY?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  RELEASE_UPLOAD_TOKEN?: string;
  LORA_EXPLORER_API: string;
  LORA_RPC_URL: string;
}

export interface UserRow extends Record<string, SqlStorageValue> {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  role: UserRole;
  status: User["status"];
  job_title: string;
  avatar_seed: number;
  avatar_version: number;
  avatar_data_url: string | null;
  email_verified_at: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow extends Record<string, SqlStorageValue> {
  id: string;
  user_id: string;
  date: string;
  title: string;
  details: string;
  status: Task["status"];
  priority: Task["priority"];
  origin: Task["origin"];
  assigned_by: string | null;
  assignment_id: string | null;
  source_task_id: string | null;
  assignment_delivered_at: string | null;
  assignment_viewed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface NotificationRow extends Record<string, SqlStorageValue> {
  id: string;
  sender_id: string;
  recipient_id: string;
  title: string;
  body: string;
  read_at: string | null;
  created_at: string;
  dispatch_id: string | null;
  delivered_at: string | null;
  acknowledged_at: string | null;
  ding_count: number | null;
  last_ding_at: string | null;
}

export interface NotificationDispatchRow
  extends Record<string, SqlStorageValue> {
  id: string;
  sender_id: string;
  title: string;
  body: string;
  ding_count: number;
  last_ding_at: string | null;
  created_at: string;
}

export interface NotificationReceiptRow
  extends Record<string, SqlStorageValue> {
  notification_id: string;
  dispatch_id: string;
  delivered_at: string | null;
  acknowledged_at: string | null;
}

export interface DirectMessageRow extends Record<string, SqlStorageValue> {
  id: string;
  sender_id: string;
  recipient_id: string;
  body: string;
  mode: DirectMessage["mode"];
  read_at: string | null;
  expires_at: string | null;
  destroyed_at: string | null;
  created_at: string;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return json(
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  console.error("Tongpin Worker error", error);
  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "服务器处理失败，请稍后重试",
      },
    },
    500,
  );
}

export async function parseJson<T = unknown>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 768 * 1024) {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "提交内容过大");
  }
  try {
    return (await request.json()) as T;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "提交内容不是有效 JSON");
  }
}

export function toPublicUser(row: UserRow): Omit<User, "passwordHash" | "avatarDataUrl"> & {
  hasCustomAvatar: boolean;
} {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    status: row.status,
    jobTitle: row.job_title ?? "",
    avatarSeed: row.avatar_seed,
    avatarVersion: row.avatar_version,
    hasCustomAvatar: Boolean(row.avatar_data_url),
    emailVerifiedAt: row.email_verified_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    userId: row.user_id,
    date: row.date,
    title: row.title,
    details: row.details,
    status: row.status,
    priority: row.priority,
    origin: row.origin ?? "self",
    assignedBy: row.assigned_by ?? null,
    assignmentId: row.assignment_id ?? null,
    sourceTaskId: row.source_task_id ?? null,
    assignmentDeliveredAt: row.assignment_delivered_at ?? null,
    assignmentViewedAt: row.assignment_viewed_at ?? null,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    dispatchId: row.dispatch_id ?? row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    title: row.title,
    body: row.body,
    requiresAcknowledgement: Boolean(row.dispatch_id),
    deliveredAt: row.delivered_at ?? null,
    acknowledgedAt: row.acknowledged_at ?? null,
    dingCount: Number(row.ding_count ?? 0),
    lastDingAt: row.last_ding_at ?? null,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export function toDirectMessage(row: DirectMessageRow): DirectMessage {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    body: row.body,
    mode: row.mode ?? "normal",
    readAt: row.read_at,
    expiresAt: row.expires_at ?? null,
    destroyedAt: row.destroyed_at ?? null,
    createdAt: row.created_at,
  };
}

export function firstRow<T extends Record<string, SqlStorageValue>>(
  cursor: SqlStorageCursor<T>,
): T | undefined {
  return cursor.toArray()[0];
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isEnabled(value: string | undefined): boolean {
  return value?.toLowerCase() === "true";
}

export function isLoraDashboardRole(role: UserRole): boolean {
  return role === "boss";
}

export function resolveLoraNullableCheckpoint<T>(
  incoming: T | null | undefined,
  current: T | null,
): T | null {
  return incoming === undefined ? current : incoming;
}

export function isCompleteLoraCollectionCycle(input: {
  rpcHealthy: boolean;
  explorerHealthy: boolean;
}): boolean {
  return input.rpcHealthy && input.explorerHealthy;
}

export function isLoraRpcSourceReachable(
  rpcHealthy: boolean,
  priceStatus: string,
): boolean {
  return rpcHealthy || priceStatus === "config-error";
}

export function nextLoraSuccessfulSyncAt(
  cycleComplete: boolean,
  nowIso: string,
  current: string | null,
): string | null {
  return cycleComplete ? nowIso : current;
}

export function shouldDispatchLoraDailyDue(input: {
  nowMs: number;
  dueAtMs: number;
  reportDate: string;
  lastDispatchedDate: string | null;
}): boolean {
  return (
    input.nowMs >= input.dueAtMs &&
    input.lastDispatchedDate !== input.reportDate
  );
}

export function nextUnifiedAlarmTimestamp(
  nowMs: number,
  candidates: Array<number | null | undefined>,
): number {
  const next = Math.min(
    ...candidates.filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    ),
  );
  if (!Number.isFinite(next)) return nowMs + 1_000;
  return Math.max(nowMs + 1, next);
}
