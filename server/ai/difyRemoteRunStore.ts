import { AiError } from "./security";
import type { AiStore } from "./storage";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_dify_remote_runs (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  app_id TEXT NOT NULL,
  local_conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  terminal_outcome TEXT,
  task_id TEXT,
  message_id TEXT,
  dify_conversation_id TEXT,
  workflow_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id,user_id,request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_dify_remote_task ON ai_dify_remote_runs(app_id,task_id) WHERE task_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_dify_remote_message ON ai_dify_remote_runs(app_id,message_id) WHERE message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ai_dify_remote_workflow ON ai_dify_remote_runs(app_id,workflow_run_id) WHERE workflow_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_dify_remote_conversation ON ai_dify_remote_runs(app_id,dify_conversation_id) WHERE dify_conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_dify_remote_reconcile ON ai_dify_remote_runs(tenant_id,user_id,status,updated_at);
`;

export type DifyRemoteRunStatus = "submitting" | "streaming" | "unknown" | "terminal";
export type DifyRemoteRunOutcome = "completed" | "failed" | "cancelled";
export interface DifyRemoteRunBinding {
  userId: string;
  requestId: string;
  attemptId: string;
  engine: "dify-cloud";
  appId: string;
}
export interface DifyRemoteRunIds {
  taskId?: string;
  messageId?: string;
  difyConversationId?: string;
  workflowRunId?: string;
}
export interface DifyRemoteRunRecord extends DifyRemoteRunBinding, DifyRemoteRunIds {
  tenantId: string;
  localConversationId: string;
  status: DifyRemoteRunStatus;
  terminalOutcome?: DifyRemoteRunOutcome;
  createdAt: number;
  updatedAt: number;
}
export interface DifyRemoteRunChange extends DifyRemoteRunIds {
  status: DifyRemoteRunStatus;
  terminalOutcome?: DifyRemoteRunOutcome;
}

type Row = {
  tenant_id: string; user_id: string; request_id: string; attempt_id: string;
  engine: "dify-cloud"; app_id: string; local_conversation_id: string;
  status: DifyRemoteRunStatus; terminal_outcome: DifyRemoteRunOutcome | null;
  task_id: string | null; message_id: string | null;
  dify_conversation_id: string | null; workflow_run_id: string | null;
  created_at: number; updated_at: number;
};

const REQUEST_ID = /^[a-zA-Z0-9_-]{16,100}$/;
const REMOTE_ID = /^[a-zA-Z0-9_-]{1,160}$/;
function invalid(code: string, message: string, status = 409): never {
  throw new AiError(status, code, message);
}
function validateBinding(binding: DifyRemoteRunBinding): void {
  if (typeof binding.userId !== "string" || !binding.userId || binding.userId.length > 256 ||
      !REQUEST_ID.test(binding.requestId) || !REQUEST_ID.test(binding.attemptId) ||
      binding.engine !== "dify-cloud" || typeof binding.appId !== "string" || !REMOTE_ID.test(binding.appId)) {
    invalid("DIFY_REMOTE_BINDING_INVALID", "Dify 远端任务绑定无效", 400);
  }
}
function validateChange(change: DifyRemoteRunChange): void {
  if (!["submitting", "streaming", "unknown", "terminal"].includes(change.status) ||
      (change.status === "terminal") !== (change.terminalOutcome !== undefined) ||
      (change.terminalOutcome !== undefined && !["completed", "failed", "cancelled"].includes(change.terminalOutcome))) {
    invalid("DIFY_REMOTE_STATE_INVALID", "Dify 远端任务状态无效", 400);
  }
  for (const key of ["taskId", "messageId", "difyConversationId", "workflowRunId"] as const) {
    const value = change[key];
    if (value !== undefined && (typeof value !== "string" || !REMOTE_ID.test(value))) {
      invalid("DIFY_REMOTE_ID_INVALID", "Dify 远端任务编号无效", 400);
    }
  }
}
function asRecord(row: Row): DifyRemoteRunRecord {
  return {
    tenantId: row.tenant_id, userId: row.user_id, requestId: row.request_id,
    attemptId: row.attempt_id, engine: row.engine, appId: row.app_id,
    localConversationId: row.local_conversation_id, status: row.status,
    ...(row.terminal_outcome ? { terminalOutcome: row.terminal_outcome } : {}),
    ...(row.task_id ? { taskId: row.task_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    ...(row.dify_conversation_id ? { difyConversationId: row.dify_conversation_id } : {}),
    ...(row.workflow_run_id ? { workflowRunId: row.workflow_run_id } : {}),
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Reconciliation journal only. It is not a second quota ledger or a tool grant store.
 * The caller must obtain AiStore from the authenticated tenant, and pass the authenticated userId.
 * This module does not send requests to Dify or change the chat execution path. */
export class DifyRemoteRunStore {
  constructor(private store: AiStore, private now = Date.now) { store.sql.exec(SCHEMA); }

  private row(userId: string, requestId: string): Row | undefined {
    return this.store.sql.all<Row>(
      "SELECT * FROM ai_dify_remote_runs WHERE tenant_id=? AND user_id=? AND request_id=?",
      this.store.tenantId, userId, requestId,
    )[0];
  }

  get(userId: string, requestId: string): DifyRemoteRunRecord | undefined {
    const row = this.row(userId, requestId);
    return row ? asRecord(row) : undefined;
  }

  /** Creates one immutable engine/app/attempt binding per local request. A lost-response retry
   * may read the same binding; a different attempt must use a new local request ID. */
  begin(binding: DifyRemoteRunBinding): DifyRemoteRunRecord {
    validateBinding(binding);
    return this.store.sql.transaction(() => {
      const existing = this.row(binding.userId, binding.requestId);
      if (existing) {
        if (existing.attempt_id !== binding.attemptId || existing.engine !== binding.engine || existing.app_id !== binding.appId) {
          invalid("DIFY_REMOTE_BINDING_CONFLICT", "远端任务已绑定另一执行尝试或应用");
        }
        return asRecord(existing);
      }
      const request = this.store.request(binding.userId, binding.requestId);
      if (!request || request.userId !== binding.userId || request.status !== "pending" ||
          (request.kind ?? "chat") !== "chat" || !request.conversationId) {
        invalid("DIFY_REMOTE_REQUEST_NOT_PENDING", "仅待处理的本账号聊天请求可创建远端任务绑定");
      }
      const time = this.now();
      this.store.sql.exec(
        "INSERT INTO ai_dify_remote_runs(tenant_id,user_id,request_id,attempt_id,engine,app_id,local_conversation_id,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        this.store.tenantId, binding.userId, binding.requestId, binding.attemptId,
        binding.engine, binding.appId, request.conversationId, "submitting", time, time,
      );
      return asRecord(this.row(binding.userId, binding.requestId)!);
    });
  }

  /** CAS-like monotonic state update. Remote IDs are write-once, and a task/message/workflow
   * ID cannot be attached to a second tenant or request under the same Dify app. */
  advance(binding: DifyRemoteRunBinding, change: DifyRemoteRunChange): DifyRemoteRunRecord {
    validateBinding(binding);
    validateChange(change);
    return this.store.sql.transaction(() => {
      const row = this.row(binding.userId, binding.requestId);
      if (!row) invalid("DIFY_REMOTE_RUN_NOT_FOUND", "远端任务记录不存在", 404);
      if (row.attempt_id !== binding.attemptId || row.engine !== binding.engine || row.app_id !== binding.appId) {
        invalid("DIFY_REMOTE_BINDING_CONFLICT", "远端任务绑定不匹配");
      }
      if ((row.status === "terminal" && (change.status !== "terminal" || row.terminal_outcome !== change.terminalOutcome)) ||
          (row.status !== "terminal" && change.status === "submitting" && row.status !== "submitting")) {
        invalid("DIFY_REMOTE_STATE_CONFLICT", "远端任务状态不能倒退或改写终态");
      }
      const ids = {
        task_id: this.writeOnce(row, "task_id", change.taskId),
        message_id: this.writeOnce(row, "message_id", change.messageId),
        dify_conversation_id: this.writeOnce(row, "dify_conversation_id", change.difyConversationId),
        workflow_run_id: this.writeOnce(row, "workflow_run_id", change.workflowRunId),
      };
      for (const key of ["task_id", "message_id", "workflow_run_id"] as const) {
        const value = ids[key];
        if (!value || value === row[key]) continue;
        const used = this.store.sql.all<{ request_id: string }>(
          `SELECT request_id FROM ai_dify_remote_runs WHERE app_id=? AND ${key}=? LIMIT 1`, row.app_id, value,
        );
        if (used.length) invalid("DIFY_REMOTE_ID_CONFLICT", "远端任务编号已绑定其他请求");
      }
      // A Dify conversation may span several local turns, but never cross an
      // authenticated tenant/member/local-conversation boundary.
      if (ids.dify_conversation_id && ids.dify_conversation_id !== row.dify_conversation_id) {
        const peers = this.store.sql.all<Pick<Row, "tenant_id" | "user_id" | "local_conversation_id">>(
          "SELECT tenant_id,user_id,local_conversation_id FROM ai_dify_remote_runs WHERE app_id=? AND dify_conversation_id=?",
          row.app_id, ids.dify_conversation_id,
        );
        if (peers.some(peer => peer.tenant_id !== row.tenant_id || peer.user_id !== row.user_id || peer.local_conversation_id !== row.local_conversation_id)) {
          invalid("DIFY_REMOTE_CONVERSATION_CONFLICT", "远端会话已绑定其他账号或本地对话");
        }
      }
      if (row.status === change.status && row.terminal_outcome === (change.terminalOutcome ?? null) &&
          row.task_id === ids.task_id && row.message_id === ids.message_id &&
          row.dify_conversation_id === ids.dify_conversation_id && row.workflow_run_id === ids.workflow_run_id) {
        return asRecord(row);
      }
      this.store.sql.exec(
        "UPDATE ai_dify_remote_runs SET status=?,terminal_outcome=?,task_id=?,message_id=?,dify_conversation_id=?,workflow_run_id=?,updated_at=? WHERE tenant_id=? AND user_id=? AND request_id=?",
        change.status, change.terminalOutcome ?? null, ids.task_id, ids.message_id,
        ids.dify_conversation_id, ids.workflow_run_id, this.now(),
        this.store.tenantId, binding.userId, binding.requestId,
      );
      return asRecord(this.row(binding.userId, binding.requestId)!);
    });
  }

  private writeOnce(row: Row, key: "task_id" | "message_id" | "dify_conversation_id" | "workflow_run_id", value?: string): string | null {
    const previous = row[key];
    if (previous && value && previous !== value) invalid("DIFY_REMOTE_ID_CONFLICT", "远端任务编号不能改写");
    return previous ?? value ?? null;
  }

  /** Caller-scoped candidates only; unknown runs remain visible for safe reconciliation. */
  outstanding(userId: string, limit = 50): DifyRemoteRunRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid("DIFY_REMOTE_LIMIT_INVALID", "远端任务查询上限无效", 400);
    return this.store.sql.all<Row>(
      "SELECT * FROM ai_dify_remote_runs WHERE tenant_id=? AND user_id=? AND status!='terminal' ORDER BY updated_at ASC LIMIT ?",
      this.store.tenantId, userId, limit,
    ).map(asRecord);
  }
}
