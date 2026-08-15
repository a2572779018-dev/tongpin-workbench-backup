export type UserRole = "member" | "boss" | "admin";
export type UserStatus =
  | "pending_email"
  | "pending_approval"
  | "active"
  | "disabled";
export type TaskStatus = "todo" | "doing" | "done";
export type TaskPriority = "p0" | "p1" | "p2" | "p3" | "p4";
export type TaskOrigin = "self" | "assigned" | "carryover";
export type TaskAuditAction =
  | "created"
  | "updated"
  | "completed"
  | "reopened"
  | "carried_over"
  | "assigned"
  | "deleted";
export type TaskAuditField =
  | "title"
  | "details"
  | "date"
  | "priority"
  | "status";
export type DirectMessageMode = "normal" | "flash";
export type VerificationPurpose = "register" | "reset_password";

import type {
  BossLoraReportOpen,
  LoraCollectorState,
  LoraDailyAddressBaseline,
  LoraDashboardCache,
  LoraIndexedBlock,
  LoraIndexedInternalTransaction,
  LoraIndexedSwap,
  LoraIndexedTransaction,
  LoraPriceSnapshot,
  LoraSourceHealth,
} from "./lora-chain/types";

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  status: UserStatus;
  jobTitle: string;
  avatarSeed: number;
  avatarVersion: number;
  avatarDataUrl: string | null;
  emailVerifiedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  userId: string;
  date: string;
  title: string;
  details: string;
  status: TaskStatus;
  priority: TaskPriority;
  origin: TaskOrigin;
  assignedBy: string | null;
  assignmentId: string | null;
  sourceTaskId: string | null;
  assignmentDeliveredAt: string | null;
  assignmentViewedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskAuditChange {
  field: TaskAuditField;
  before: string | null;
  after: string | null;
}

export interface TaskAuditEvent {
  id: string;
  taskId: string;
  userId: string;
  actorId: string;
  action: TaskAuditAction;
  changes: TaskAuditChange[];
  snapshot: Task;
  createdAt: string;
}

export interface VerificationCode {
  id: string;
  userId: string | null;
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: string;
  attempts: number;
  consumedAt: string | null;
  createdAt: string;
}

export interface RefreshSession {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  lastUsedAt: string;
  userAgent: string;
}

export interface AppNotification {
  id: string;
  dispatchId: string;
  senderId: string;
  recipientId: string;
  title: string;
  body: string;
  requiresAcknowledgement: boolean;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
  dingCount: number;
  lastDingAt: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationReceipt {
  notificationId: string;
  dispatchId: string;
  recipientId: string;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
}

export interface NotificationRecipientStatus {
  notificationId: string;
  user: PublicUser;
  deliveredAt: string | null;
  acknowledgedAt: string | null;
}

export interface NotificationDispatch {
  id: string;
  senderId: string;
  title: string;
  body: string;
  dingCount: number;
  lastDingAt: string | null;
  createdAt: string;
  recipients: NotificationRecipientStatus[];
  counts: {
    total: number;
    delivered: number;
    acknowledged: number;
    pending: number;
  };
}

export interface Contact {
  ownerId: string;
  contactId: string;
  createdAt: string;
}

export interface DirectMessage {
  id: string;
  senderId: string;
  recipientId: string;
  body: string;
  mode: DirectMessageMode;
  readAt: string | null;
  expiresAt: string | null;
  destroyedAt: string | null;
  createdAt: string;
}

export interface TaskRolloverDecision {
  id: string;
  userId: string;
  sourceDate: string;
  targetDate: string;
  selectedTaskIds: string[];
  createdAt: string;
}

export interface DatabaseShape {
  version: 5;
  users: User[];
  tasks: Task[];
  verificationCodes: VerificationCode[];
  refreshSessions: RefreshSession[];
  notifications: AppNotification[];
  contacts: Contact[];
  directMessages: DirectMessage[];
  taskRolloverDecisions: TaskRolloverDecision[];
  taskAuditEvents: TaskAuditEvent[];
  bossLoraReportOpens: BossLoraReportOpen[];
  loraBlocks: LoraIndexedBlock[];
  loraTransactions: LoraIndexedTransaction[];
  loraInternalTransactions: LoraIndexedInternalTransaction[];
  loraSwaps: LoraIndexedSwap[];
  loraAddressBaselines: LoraDailyAddressBaseline[];
  loraCollectorState: LoraCollectorState;
  loraCurrentTotalAddresses: string | null;
  loraPrice: LoraPriceSnapshot;
  loraHealth: LoraSourceHealth;
  loraDashboardCaches: LoraDashboardCache[];
}

export type PublicUser = Omit<User, "passwordHash" | "avatarDataUrl"> & {
  hasCustomAvatar: boolean;
};

export function toPublicUser(user: User): PublicUser {
  const {
    passwordHash: _passwordHash,
    avatarDataUrl,
    ...publicUser
  } = user;
  return {
    ...publicUser,
    hasCustomAvatar: Boolean(avatarDataUrl),
  };
}
