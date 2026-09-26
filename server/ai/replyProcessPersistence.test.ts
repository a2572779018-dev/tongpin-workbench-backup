import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatResponse } from "../../shared/ai";
import { applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE, settleReplyProcess, type AiReplyProcess, type AiReplyProcessEvent } from "../../shared/aiReplyProcess";
import { AI_WORKSPACE_FEATURES, type AiWorkspaceMessage, type AiWorkspaceSnapshot, type AiWorkspaceState } from "../../shared/aiWorkspace";
import { replyProcessSummary, replyProcessView } from "../../src/features/tongpin-ai/replyProcessModel";
import { hydrateWorkspace, serializeWorkspace } from "../../src/features/tongpin-ai/workspaceState";
import { workspaceStateForServer } from "../../src/features/tongpin-ai/workspaceSync";
import type { TongpinAIMessage } from "../../src/features/tongpin-ai/types";
import { AiStore, emptyQuota, type AiSql } from "./storage";
import { AiWorkspaceRepository, validateAiWorkspaceConversationEntity, validateAiWorkspaceState } from "./workspace";
import { createAiWorkspaceRouter } from "./workspaceRoutes";
import { AiWorkspaceV2ShadowRepository } from "./workspaceV2Shadow";
import { AiWorkspaceV2Store } from "./workspaceV2Store";
import { handleAiWorkspaceV2Request } from "./workspaceV2Protocol";

// Keep Worker global types out of the Node tsconfig, as workspace.test.ts does.
const workerRouteModulePath = "../../cloudflare/src/ai/workspaceRoutes";
const { handleAiWorkspaceRequest } = await import(workerRouteModulePath) as {
  handleAiWorkspaceRequest(request: Request, repository: AiWorkspaceRepository, user: { id: string; role: string; status: string }): Promise<Response>;
};

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const value = action(); database.exec("COMMIT"); return value; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

const at = (timestamp: number, payload: AiReplyProcessEvent): AiReplyProcessEvent => ({ ...payload, timestamp });
const search = (callId: string, status: "in_progress" | "completed", extra: { query?: string; sourceCount?: number } = {}) =>
  ({ type: "tool_progress", data: { tool: "web_search", callId, status, ...extra } }) as const;
function liveProcess(): AiReplyProcess {
  const live = [
    at(1_000, { type: "run_started", data: { startedAt: 1_000 } }),
    at(1_100, { type: "public_summary_delta", data: { delta: "先核对来源。" } }),
    at(1_200, search("search-1", "in_progress")),
    at(2_400, search("search-1", "completed", { query: "上海 今日天气", sourceCount: 5 })),
    at(3_000, search("search-2", "in_progress")),
    at(5_100, search("search-2", "completed", { query: "上海 空气质量", sourceCount: 6 })),
  ].reduce(applyReplyProcessEvent, EMPTY_REPLY_PROCESS_LIVE);
  return settleReplyProcess(live, { outcome: "completed", durationMs: 9_200 })!;
}
function stateWith(message: Partial<AiWorkspaceMessage>): AiWorkspaceState {
  return {
    view: "chat", mode: "standard", activeConversationId: "chat-a", activeProjectId: null, enabledSkillIds: [], projects: [], artifacts: [], drafts: {},
    conversations: [{ id: "chat-a", title: "天气", timeLabel: "刚刚", messages: [
      { id: "user-a", role: "user", content: "今天上海天气？", time: "10:00" },
      { id: "reply-a", role: "assistant", content: "今天晴。", time: "10:00", status: "ready", analysisSummary: "先核对来源。",
        sources: [{ title: "气象台", url: "https://weather.example/" }], ...message },
    ] }],
  };
}

describe("reply process persistence", () => {
  let directory: string, database: DatabaseSync, sql: AiSql, repository: AiWorkspaceRepository;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-reply-process-"));
    database = new DatabaseSync(path.join(directory, "store.sqlite")); sql = adapter(database);
    repository = new AiWorkspaceRepository(sql); repository.initialize();
    const ai = new AiStore(sql); ai.initialize(); ai.saveQuota("member-a", { ...emptyQuota(), limitTokens: 1_000 });
  });
  afterEach(async () => { vi.useRealTimers(); database.close(); await rm(directory, { recursive: true }); });

  it("round-trips the bounded process through save, reload and the client view", async () => {
    const process = liveProcess();
    // The page's own serialization path, then the server's full validation.
    const session = hydrateWorkspace(stateWith({ process }));
    const saved = await repository.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: serializeWorkspace(session) });
    expect(saved.revision).toBe(1);
    const reloaded = repository.read("member-a");
    const message = reloaded.state!.conversations[0].messages[1] as TongpinAIMessage;
    expect(message.process).toEqual(process);
    const view = replyProcessView({ message: hydrateWorkspace(reloaded.state).conversations[0].messages[1] })!;
    expect(view.parts.map(part => part.kind === "search" ? part.query : part.kind)).toEqual(["thinking", "上海 今日天气", "上海 空气质量"]);
    expect(replyProcessSummary(view)).toBe("搜索 2 次 · 11 个来源 · 用时 9 秒");
    // V2 entities reuse the same message rules.
    expect(validateAiWorkspaceConversationEntity(stateWith({ process }).conversations[0]).messages[1].process).toEqual(process);
  });

  it("rejects malformed, smuggled or oversized process records before any write", async () => {
    const valid = liveProcess();
    const invalid: Array<[string, unknown, string]> = [
      ["unknown field", { ...valid, note: "x" }, "AI_WORKSPACE_INVALID"],
      ["raw reasoning text", { ...valid, steps: [{ kind: "thinking", text: "raw private chain" }] }, "AI_WORKSPACE_INVALID"],
      ["unknown step kind", { ...valid, steps: [{ kind: "reasoning" }] }, "AI_WORKSPACE_INVALID"],
      ["future version", { ...valid, version: 2 }, "AI_WORKSPACE_INVALID"],
      ["unknown outcome", { ...valid, outcome: "done" }, "AI_WORKSPACE_INVALID"],
      ["empty steps", { ...valid, steps: [] }, "AI_WORKSPACE_INVALID"],
      ["duplicate thinking", { ...valid, steps: [{ kind: "thinking" }, { kind: "thinking" }] }, "AI_WORKSPACE_INVALID"],
      ["search status", { ...valid, steps: [{ kind: "search", status: "searching" }] }, "AI_WORKSPACE_INVALID"],
      ["query control characters", { ...valid, steps: [{ kind: "search", status: "completed", query: "a\u0007b" }] }, "AI_WORKSPACE_INVALID"],
      ["negative sources", { ...valid, steps: [{ kind: "search", status: "completed", sourceCount: -1 }] }, "AI_WORKSPACE_INVALID"],
      ["duration beyond a day", { ...valid, durationMs: 24 * 60 * 60 * 1000 + 1 }, "AI_WORKSPACE_INVALID"],
      ["tool without a real hand-off", { ...valid, steps: [{ kind: "tool", tool: "image", status: "handed_off" }] }, "AI_WORKSPACE_INVALID"],
      ["too many steps", { ...valid, steps: Array.from({ length: 9 }, () => ({ kind: "search", status: "completed" })) }, "AI_WORKSPACE_TOO_LARGE"],
      ["oversized query", { ...valid, steps: [{ kind: "search", status: "completed", query: "长".repeat(401) }] }, "AI_WORKSPACE_TOO_LARGE"],
    ];
    for (const [label, process, code] of invalid) {
      expect(() => validateAiWorkspaceState(stateWith({ process } as Partial<AiWorkspaceMessage>)), label).toThrow(expect.objectContaining({ code }));
    }
    const onUser = stateWith({ process: valid });
    (onUser.conversations[0].messages[0] as AiWorkspaceMessage).process = valid;
    expect(() => validateAiWorkspaceState(onUser)).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_INVALID" }));
    await expect(repository.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: onUser })).rejects.toMatchObject({ code: "AI_WORKSPACE_INVALID" });
    expect(repository.read("member-a").revision).toBe(0);
  });

  it("advertises the field on V1 reads and saves, and older servers never receive it", async () => {
    const app = express();
    app.use("/api/ai/workspace", createAiWorkspaceRouter(repository, ((_request: { currentUser?: unknown }, _response: unknown, next: () => void) => {
      _request.currentUser = { id: "member-a", role: "member", status: "active" }; next();
    }) as never));
    const body = { expectedRevision: 0, mutationId: crypto.randomUUID(), state: stateWith({ process: liveProcess() }) };
    const put = await request(app).put("/api/ai/workspace").send(body).expect(200);
    expect(put.body.features).toContain(AI_WORKSPACE_FEATURES.replyProcess);
    const get = await request(app).get("/api/ai/workspace").expect(200);
    expect(get.body.features).toEqual([AI_WORKSPACE_FEATURES.replyProcess]);
    const worker = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace"), repository, { id: "member-a", role: "member", status: "active" });
    expect(((await worker.json()) as AiWorkspaceSnapshot).features).toEqual([AI_WORKSPACE_FEATURES.replyProcess]);

    const state = stateWith({ process: liveProcess() });
    expect(workspaceStateForServer(state, [AI_WORKSPACE_FEATURES.replyProcess])).toBe(state);
    const legacy = workspaceStateForServer(state, undefined);
    expect(JSON.stringify(legacy)).not.toContain("\"process\"");
    expect(legacy.conversations[0].messages[1]).toMatchObject({ content: "今天晴。", analysisSummary: "先核对来源。" });
    const plain = stateWith({});
    expect(workspaceStateForServer(plain, undefined)).toBe(plain);
  });

  it("commits a V2 reply with the process rebuilt from the server journal, not the browser", async () => {
    const workspace = new AiWorkspaceRepository(sql);
    const v2 = new AiWorkspaceV2Store(sql, workspace); v2.initialize();
    const principal = { id: "member-a", role: "member", status: "active", tenantId: "default" };
    const call = (route: string, method = "GET", body?: unknown) => handleAiWorkspaceV2Request(new Request(`http://localhost/api/ai/workspace-v2${route}`, {
      method, headers: { "X-Tongpin-Account": principal.id, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), v2, principal);
    await workspace.save("member-a", { expectedRevision: 0, mutationId: crypto.randomUUID(), state: { ...stateWith({}), conversations: [{ id: "chat-a", title: "天气", timeLabel: "刚刚", messages: [] }] } });
    await new AiWorkspaceV2ShadowRepository(sql, workspace).stageFromV1("member-a");
    const epoch = (await v2.prepareFromShadow("member-a"))!.epoch;
    sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id='default' AND user_id='member-a'", new Date().toISOString());
    sql.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id='default' AND user_id='member-a'");

    const requestId = crypto.randomUUID();
    const result: AiChatResponse = { requestId, content: "今天晴。", model: "server-model", analysisSummary: "先核对来源。",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3, estimated: false }, quota: emptyQuota() };
    const ai = new AiStore(sql);
    ai.saveRequest({ requestId, userId: "member-a", hash: "hash", status: "completed", kind: "chat", createdAt: "2026-09-26T10:00:00.000Z", expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, model: "server-model", mode: "standard", conversationId: "chat-a", result });
    vi.useFakeTimers({ toFake: ["Date"] });
    const journal: Array<[number, AiReplyProcessEvent]> = [
      [1_000, { type: "run_started", data: { startedAt: 1_000 } }],
      [1_100, { type: "public_summary_delta", data: { delta: "先核对来源。" } }],
      [1_150, { type: "reasoning_delta", data: { delta: "raw private chain", source: "provider_reasoning_content" } }],
      [1_200, search("search-1", "in_progress")],
      [2_400, search("search-1", "completed", { query: "上海 今日天气", sourceCount: 5 })],
      [2_500, { type: "answer_delta", data: { delta: "今天晴。" } }],
      [4_200, { type: "run_finished", data: { response: result } }],
    ];
    for (const [time, payload] of journal) { vi.setSystemTime(time); ai.appendRunEvent("member-a", requestId, payload); }
    vi.useRealTimers();

    expect((await call("/append-user", "POST", { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 1,
      message: { id: "user-a", role: "user", content: "今天上海天气？", time: "10:00", requestId } })).status).toBe(200);
    const commit = { epoch, mutationId: crypto.randomUUID(), conversationId: "chat-a", expectedRevision: 2, requestId, messageId: "reply-a" };
    expect((await call("/commit-assistant", "POST", { ...commit, process: { version: 1, outcome: "completed", steps: [{ kind: "thinking" }] } })).status).toBe(400);
    expect((await call("/commit-assistant", "POST", commit)).status).toBe(200);
    const page = await (await call("/conversations/chat-a/messages")).json() as { messages: AiWorkspaceMessage[] };
    const reply = page.messages.at(-1)!;
    expect(reply.process).toEqual({ version: 1, outcome: "completed", durationMs: 3_200, steps: [
      { kind: "thinking" },
      { kind: "search", status: "completed", query: "上海 今日天气", sourceCount: 5, durationMs: 1_200 },
    ] });
    expect(JSON.stringify(page)).not.toContain("raw private chain");
  });
});
