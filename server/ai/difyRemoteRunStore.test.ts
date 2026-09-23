import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiStore, type AiSql, type StoredRequest } from "./storage";
import { DifyRemoteRunStore, type DifyRemoteRunBinding } from "./difyRemoteRunStore";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}
const requestId = "request-remote-0001";
const attemptId = "attempt-remote-0001";
const binding = (userId = "member-a", id = requestId, appId = "dify-sandbox-app"): DifyRemoteRunBinding => ({
  userId, requestId: id, attemptId, engine: "dify-cloud", appId,
});
function pending(userId = "member-a", id = requestId, kind: "chat" | "image" = "chat"): StoredRequest {
  return {
    userId, requestId: id, hash: "not-a-raw-prompt", status: "pending",
    createdAt: "2026-09-23T00:00:00.000Z", expiresAt: 2_000_000_000_000,
    inputReserve: 3, outputReserve: 4, kind, model: "configured-model", mode: "quick",
    conversationId: "local-conversation-001",
  };
}

describe("Dify remote-run reconciliation journal", () => {
  let directory: string;
  let database: DatabaseSync;
  let sql: AiSql;
  let defaultTenant: AiStore;
  let clock: number;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-dify-remote-run-"));
    database = new DatabaseSync(path.join(directory, "runs.sqlite"));
    sql = adapter(database);
    defaultTenant = new AiStore(sql);
    defaultTenant.initialize();
    clock = 1000;
  });
  afterEach(async () => { database.close(); await rm(directory, { recursive: true }); });
  const journal = (store: AiStore) => new DifyRemoteRunStore(store, () => ++clock);

  it("binds only a pending chat request and persists minimal metadata across restart", () => {
    defaultTenant.saveRequest(pending());
    const runs = journal(defaultTenant);
    const malicious = { ...binding(), authorization: "secret-token", query: "private prompt" } as DifyRemoteRunBinding;
    const started = runs.begin(malicious);
    expect(started).toMatchObject({ tenantId: "default", userId: "member-a", requestId, attemptId, engine: "dify-cloud", appId: "dify-sandbox-app", localConversationId: "local-conversation-001", status: "submitting" });
    expect(runs.begin(binding())).toEqual(started);
    expect(JSON.stringify(database.prepare("SELECT * FROM ai_dify_remote_runs").all())).not.toMatch(/secret-token|private prompt|not-a-raw-prompt/);
    database.close();
    database = new DatabaseSync(path.join(directory, "runs.sqlite"));
    sql = adapter(database);
    expect(journal(new AiStore(sql)).get("member-a", requestId)).toEqual(started);
  });

  it("rejects absent, terminal or image requests and cannot replace the bound app or attempt", () => {
    const runs = journal(defaultTenant);
    expect(() => runs.begin(binding())).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_REQUEST_NOT_PENDING" }));
    defaultTenant.saveRequest({ ...pending(), status: "completed" });
    expect(() => runs.begin(binding())).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_REQUEST_NOT_PENDING" }));
    defaultTenant.saveRequest(pending("member-a", requestId, "image"));
    expect(() => runs.begin(binding())).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_REQUEST_NOT_PENDING" }));
    defaultTenant.saveRequest(pending());
    runs.begin(binding());
    for (const changed of [{ ...binding(), appId: "other-app" }, { ...binding(), attemptId: "attempt-remote-0002" }]) {
      expect(() => runs.begin(changed)).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_BINDING_CONFLICT" }));
      expect(() => runs.advance(changed, { status: "streaming" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_BINDING_CONFLICT" }));
    }
  });

  it("supports recovery from unknown, write-once remote IDs, terminal idempotence and no rollback", () => {
    defaultTenant.saveRequest(pending());
    const runs = journal(defaultTenant);
    runs.begin(binding());
    const unknown = runs.advance(binding(), { status: "unknown", taskId: "task-123" });
    expect(unknown.status).toBe("unknown");
    const streaming = runs.advance(binding(), { status: "streaming", taskId: "task-123", messageId: "message-123", difyConversationId: "conversation-123" });
    expect(streaming).toMatchObject({ status: "streaming", taskId: "task-123", messageId: "message-123", difyConversationId: "conversation-123" });
    expect(() => runs.advance(binding(), { status: "submitting" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_STATE_CONFLICT" }));
    expect(() => runs.advance(binding(), { status: "streaming", taskId: "different-task" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_ID_CONFLICT" }));
    const finished = runs.advance(binding(), { status: "terminal", terminalOutcome: "completed", workflowRunId: "workflow-123" });
    expect(finished).toMatchObject({ status: "terminal", terminalOutcome: "completed", taskId: "task-123", messageId: "message-123", workflowRunId: "workflow-123" });
    expect(runs.advance(binding(), { status: "terminal", terminalOutcome: "completed" })).toEqual(finished);
    expect(() => runs.advance(binding(), { status: "terminal", terminalOutcome: "failed" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_STATE_CONFLICT" }));
    expect(() => runs.advance(binding(), { status: "unknown" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_STATE_CONFLICT" }));
  });

  it("isolates tenants and members, and refuses reuse of a remote task across scopes", () => {
    const otherTenant = defaultTenant.forTenant("tenant-b");
    defaultTenant.saveRequest(pending());
    defaultTenant.saveRequest(pending("member-b"));
    otherTenant.saveRequest(pending());
    const a = journal(defaultTenant), b = journal(otherTenant);
    a.begin(binding());
    a.begin(binding("member-b"));
    b.begin(binding());
    a.advance(binding(), { status: "streaming", taskId: "unique-task" });
    expect(a.get("member-b", requestId)?.taskId).toBeUndefined();
    expect(b.get("member-a", requestId)?.taskId).toBeUndefined();
    expect(() => a.advance(binding("member-b"), { status: "streaming", taskId: "unique-task" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_ID_CONFLICT" }));
    expect(() => b.advance(binding(), { status: "streaming", taskId: "unique-task" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_ID_CONFLICT" }));
    expect(a.get("member-a", requestId)?.taskId).toBe("unique-task");
    expect(b.outstanding("member-a")).toHaveLength(1);
    expect(a.outstanding("member-b")).toHaveLength(1);
  });

  it("allows Dify conversation reuse within one local chat but not across accounts or chats", () => {
    const secondId = "request-remote-0002";
    const thirdId = "request-remote-0003";
    defaultTenant.saveRequest(pending());
    defaultTenant.saveRequest(pending("member-a", secondId));
    defaultTenant.saveRequest({ ...pending("member-a", thirdId), conversationId: "different-local-conversation" });
    defaultTenant.saveRequest(pending("member-b"));
    const runs = journal(defaultTenant);
    for (const id of [requestId, secondId, thirdId]) runs.begin(binding("member-a", id));
    runs.begin(binding("member-b"));
    runs.advance(binding(), { status: "streaming", difyConversationId: "remote-conversation" });
    expect(runs.advance(binding("member-a", secondId), { status: "streaming", difyConversationId: "remote-conversation" }).difyConversationId).toBe("remote-conversation");
    expect(() => runs.advance(binding("member-a", thirdId), { status: "streaming", difyConversationId: "remote-conversation" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_CONVERSATION_CONFLICT" }));
    expect(() => runs.advance(binding("member-b"), { status: "streaming", difyConversationId: "remote-conversation" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_CONVERSATION_CONFLICT" }));
    expect(runs.get("member-b", requestId)?.status).toBe("submitting");
  });

  it("returns only caller-scoped nonterminal reconciliation candidates", () => {
    const secondId = "request-remote-0002";
    defaultTenant.saveRequest(pending());
    defaultTenant.saveRequest(pending("member-a", secondId));
    defaultTenant.saveRequest(pending("member-b"));
    const runs = journal(defaultTenant);
    runs.begin(binding());
    runs.begin(binding("member-a", secondId));
    runs.begin(binding("member-b"));
    runs.advance(binding(), { status: "terminal", terminalOutcome: "failed" });
    runs.advance(binding("member-a", secondId), { status: "unknown" });
    expect(runs.outstanding("member-a").map(run => run.requestId)).toEqual([secondId]);
    expect(runs.outstanding("member-b").map(run => run.requestId)).toEqual([requestId]);
    expect(() => runs.outstanding("member-a", 101)).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_LIMIT_INVALID" }));
    expect(() => runs.advance(binding("member-a", secondId), { status: "terminal" })).toThrow(expect.objectContaining({ code: "DIFY_REMOTE_STATE_INVALID" }));
  });
});
