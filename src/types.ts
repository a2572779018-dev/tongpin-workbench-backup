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

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  jobTitle: string;
  avatarSeed: number;
  avatarVersion: number;
  hasCustomAvatar: boolean;
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
  actor: User | null;
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
  user: User;
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

export interface TaskAssignmentEvent {
  task: Task;
  assigner: User;
}

export interface BossWorkReportStatus {
  bossUserId: string;
  reportDate: string;
  trigger: "startup" | "login" | "resume" | "reconnect" | "day-change";
  openedAt: string;
  dismissedAt: string | null;
  readAt: string | null;
}

export type WorkReportPeriodKind = "daily" | "weekly" | "monthly";

export interface WorkReportPeriod {
  kind: WorkReportPeriodKind;
  startDate: string;
  endDate: string;
}

export interface BossWorkReportMember {
  user: User;
  selfCreated: number;
  carriedOver: number;
  assigned: number;
  completed: number;
  scheduled: number;
  scheduledDone: number;
  doing: number;
  completionRate: number;
}

export interface BossWorkReportSummary {
  people: number;
  activePeople: number;
  selfCreated: number;
  carriedOver: number;
  assigned: number;
  completed: number;
  scheduled: number;
  scheduledDone: number;
  doing: number;
  completionRate: number;
}

export interface BossWorkReportSection {
  period: WorkReportPeriod;
  summary: BossWorkReportSummary;
  members: BossWorkReportMember[];
}

export interface BossWorkReportBundle {
  reportDate: string;
  generatedAt: string;
  status: BossWorkReportStatus | null;
  daily: BossWorkReportSection;
  weekly: BossWorkReportSection;
  monthly: BossWorkReportSection;
}

export type DirectMessageRealtimeEvent =
  | {
      type: "message:new";
      message: DirectMessage;
      sender: User;
    }
  | {
      type: "message:read" | "message:expired";
      message: DirectMessage;
    };

export interface ContactSummary {
  user: User;
  addedAt: string;
  unreadCount: number;
  lastMessage: DirectMessage | null;
}

export interface IncomingDirectMessage {
  message: DirectMessage;
  sender: User;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: User;
}

export interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}
