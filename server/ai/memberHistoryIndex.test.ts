import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiWorkspaceMessage } from "../../shared/aiWorkspace";
import { AiMemberHistoryIndex, indexableHistoryMessages, MEMBER_HISTORY_LIMITS, memberHistoryFtsAvailable, type HistorySourceConversation } from "./memberHistoryIndex";
import { historyQuery } from "./memberHistoryText";
import { AiStore, type AiSql } from "./storage";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

const unlimited = { messages: 1_000, characters: 1_000_000 };
const user = (id: string, content: string): AiWorkspaceMessage => ({ id, role: "user", content, time: "10:00" });
const reply = (id: string, content: string, extra: Partial<AiWorkspaceMessage> = {}): AiWorkspaceMessage => ({ id, role: "assistant", content, time: "10:01", status: "ready", ...extra });
const conversation = (id: string, title: string, messages: AiWorkspaceMessage[]): HistorySourceConversation => ({ id, title, messages });

describe("member history index (per-member, incremental, trigram FTS5)", () => {
  let database: DatabaseSync;
  let sql: AiSql;
  let index: AiMemberHistoryIndex;
  const sync = (conversations: HistorySourceConversation[], options: Partial<{ full: boolean; budget: { messages: number; characters: number }; live: boolean; revision: number }> = {}, target = index, member = "member-a") =>
    target.sync(member, { conversations, full: options.full ?? true, version: 1, revision: options.revision ?? 1, live: options.live ?? true, budget: options.budget ?? unlimited });
  const search = (text: string, exclude?: string, target = index, member = "member-a") => target.candidates(member, historyQuery(text), { excludeConversationId: exclude });
  const count = (table: string, where = "1=1") => (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number }).count;
  const ftsRows = () => (database.prepare("SELECT COUNT(*) AS count FROM ai_member_history_fts WHERE ai_member_history_fts MATCH ?").get('owner:"k"') as { count: number }).count;
  const allFtsRows = () => database.prepare("SELECT rowid FROM ai_member_history_chunks").all().length;

  const report = conversation("conv-report", "季度汇报", [
    user("m1", "帮我做一个季度汇报模板，要有完成情况、问题和下季度计划"),
    reply("m2", "季度汇报模板：一、本季度完成情况；二、遇到的问题；三、下季度计划。", { requestId: "request-report-000000001" }),
  ]);
  const lora = conversation("conv-lora", "LORA 合作", [
    user("m3", "LORA Chain 生态合作方案怎么写"),
    reply("m4", "LORA 生态合作方案建议分三部分：目标伙伴、合作方式、里程碑。"),
  ]);

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    sql = adapter(database);
    new AiStore(sql).initialize();
    index = new AiMemberHistoryIndex(sql);
  });

  it("creates the trigram FTS table through the member_memory migrations", () => {
    expect(memberHistoryFtsAvailable(sql)).toBe(true);
    const ddl = (database.prepare("SELECT sql FROM sqlite_master WHERE name='ai_member_history_fts'").get() as { sql: string }).sql;
    expect(ddl).toContain("tokenize='trigram'");
    expect(ddl).toContain("contentless_delete=1");
  });

  it("indexes user and settled assistant text only, and finds CJK topics by substring", () => {
    const streaming = conversation("conv-live", "进行中", [user("m5", "季度汇报再补一段"), reply("m6", "正在写季度汇报…", { status: "typing" }), reply("m7", "出错了", { status: "error" })]);
    expect(indexableHistoryMessages(streaming.messages).map(message => message.id)).toEqual(["m5"]);
    expect(sync([report, lora, streaming])).toMatchObject({ complete: true, indexed: 5 });
    // Candidates contain the topic's trigrams ("季度汇报再补一段" does not).
    const hits = search("上次那个汇报模板");
    expect(hits.map(hit => hit.messageId).sort()).toEqual(["m1", "m2"]);
    expect(search("季度汇报").map(hit => hit.messageId).sort()).toEqual(["m1", "m2", "m5"]);
    expect(search("lora 合作方案").map(hit => hit.conversationId)).toContain("conv-lora");
    // The current conversation is excluded.
    expect(search("季度汇报", "conv-report").map(hit => hit.messageId)).toEqual(["m5"]);
    // Two-character terms fall back to a bounded scan of this member's rows.
    expect(search("上次说的问题").map(hit => hit.messageId)).toContain("m2");
    expect(index.overview("member-a")).toEqual({ indexedConversations: 3, indexedMessages: 5, pending: false });
  });

  it("is incremental: unchanged conversations cost nothing, edits and deletions follow", () => {
    sync([report, lora]);
    const chunks = count("ai_member_history_chunks");
    // A second identical sync touches nothing.
    expect(sync([report, lora])).toMatchObject({ indexed: 0, removed: 0 });
    expect(count("ai_member_history_chunks")).toBe(chunks);
    // A title change updates metadata only.
    expect(sync([{ ...report, title: "季度汇报（定稿）" }, lora])).toMatchObject({ indexed: 0, removed: 0 });
    expect(index.conversationTitles("member-a", ["conv-report"]).get("conv-report")).toBe("季度汇报（定稿）");
    // A new message is the only new work.
    const extended = { ...report, messages: [...report.messages, user("m8", "再加一个风险提示部分")] };
    expect(sync([extended, lora])).toMatchObject({ indexed: 1, removed: 0 });
    expect(search("风险提示").map(hit => hit.messageId)).toEqual(["m8"]);
    // An edited message is re-indexed; its old text no longer matches.
    const edited = { ...extended, messages: extended.messages.map(message => message.id === "m2" ? { ...message, content: "月度复盘模板：目标、结果、改进。" } : message) };
    expect(sync([edited, lora])).toMatchObject({ indexed: 1, removed: 1 });
    expect(search("季度汇报模板").map(hit => hit.messageId)).not.toContain("m2");
    expect(search("月度复盘模板").map(hit => hit.messageId)).toEqual(["m2"]);
    // A deleted message and a deleted conversation leave the index, FTS rows included.
    const trimmed = { ...edited, messages: edited.messages.filter(message => message.id !== "m8") };
    expect(sync([trimmed])).toMatchObject({ removed: 3 });
    expect(search("风险提示")).toEqual([]);
    expect(search("lora 合作方案")).toEqual([]);
    expect(count("ai_member_history_conversations")).toBe(1);
    const remaining = count("ai_member_history_chunks");
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_member_history_fts WHERE ai_member_history_fts MATCH ?").get('body:"复盘模"')).toEqual({ count: 1 });
    // Clearing the whole workspace removes everything.
    sync([]);
    expect(count("ai_member_history_chunks")).toBe(0);
    expect(remaining).toBeGreaterThan(0);
    expect(index.overview("member-a")).toMatchObject({ indexedConversations: 0, indexedMessages: 0 });
  });

  it("dates replies from the server request ledger and questions from their reply", () => {
    new AiStore(sql).saveRequest({ requestId: "request-report-000000001", userId: "member-a", hash: "h", status: "completed", createdAt: "2026-09-12T02:00:00.000Z", expiresAt: 0, inputReserve: 0, outputReserve: 0, kind: "chat", model: "m", mode: "quick" });
    sync([report], { live: false });
    const dates = database.prepare("SELECT message_id, at FROM ai_member_history_chunks ORDER BY message_id").all() as Array<{ message_id: string; at: number }>;
    expect(dates).toEqual([{ message_id: "m1", at: Date.parse("2026-09-12T02:00:00.000Z") }, { message_id: "m2", at: Date.parse("2026-09-12T02:00:00.000Z") }]);
    // Undated history in a backfill stays undated rather than looking new.
    sync([report, lora], { live: false });
    expect(database.prepare("SELECT DISTINCT at FROM ai_member_history_chunks WHERE conversation_id='conv-lora'").all()).toEqual([{ at: 0 }]);
  });

  it("works within a budget and resumes without duplicating rows (backfill)", () => {
    const many = Array.from({ length: 6 }, (_, number) => conversation(`conv-${number}`, `对话 ${number}`, [user(`q${number}`, `第 ${number} 个季度汇报问题`), reply(`a${number}`, `第 ${number} 个季度汇报回答`)]));
    const first = sync(many, { budget: { messages: 5, characters: 1_000_000 } });
    expect(first).toMatchObject({ complete: false, truncated: true, indexed: 5 });
    expect(index.overview("member-a").pending).toBe(true);
    let rounds = 1;
    while (!sync(many, { budget: { messages: 5, characters: 1_000_000 } }).complete) rounds += 1;
    expect(rounds).toBeLessThanOrEqual(3);
    expect(count("ai_member_history_chunks")).toBe(12);
    expect(new Set(database.prepare("SELECT message_id FROM ai_member_history_chunks").all().map(row => (row as { message_id: string }).message_id)).size).toBe(12);
    expect(allFtsRows()).toBe(12);
    expect(index.overview("member-a")).toEqual({ indexedConversations: 6, indexedMessages: 12, pending: false });
  });

  it("caps each member: the least recently active conversations stop being searchable", () => {
    const capped = new AiMemberHistoryIndex(sql, "default", { memberCharacters: 120 });
    const at = (iso: string) => new AiStore(sql).saveRequest({ requestId: `request-${iso.replace(/\D/g, "")}-0000`, userId: "member-a", hash: "h", status: "completed", createdAt: iso, expiresAt: 0, inputReserve: 0, outputReserve: 0, kind: "chat", model: "m", mode: "quick" });
    at("2026-09-01T00:00:00.000Z"); at("2026-09-20T00:00:00.000Z");
    const old = conversation("conv-old", "旧对话", [reply("o1", `旧的季度汇报方案${"甲".repeat(70)}`, { requestId: "request-20260901000000000-0000" })]);
    const fresh = conversation("conv-new", "新对话", [reply("n1", `新的季度汇报方案${"乙".repeat(70)}`, { requestId: "request-20260920000000000-0000" })]);
    sync([fresh, old], {}, capped);
    expect(search("季度汇报方案", undefined, capped).map(hit => hit.conversationId)).toEqual(["conv-new"]);
    // A capped conversation is not re-indexed by the next sync unless it changes.
    expect(sync([fresh, old], {}, capped)).toMatchObject({ indexed: 0 });
    // Per-conversation cap keeps the newest messages.
    const perConversation = new AiMemberHistoryIndex(sql, "default", { conversationCharacters: 40 });
    perConversation.reset("member-b", "sync");
    sync([conversation("conv-long", "长对话", [user("l1", `最早讨论的预算方案${"丙".repeat(26)}`), user("l2", `最新确认的排期计划${"丁".repeat(26)}`)])], {}, perConversation, "member-b");
    expect(search("排期计划", undefined, perConversation, "member-b").map(hit => hit.messageId)).toEqual(["l2"]);
    expect(search("预算方案", undefined, perConversation, "member-b")).toEqual([]);
    expect(MEMBER_HISTORY_LIMITS.memberCharacters).toBe(600_000);
  });

  it("keeps members and organizations apart", () => {
    sync([report]);
    const other = new AiMemberHistoryIndex(sql, "org-2");
    sync([conversation("conv-x", "别人的汇报", [user("x1", "季度汇报模板我自己来写")])], {}, other, "member-a");
    sync([conversation("conv-b", "同事的汇报", [user("b1", "季度汇报模板同事版本")])], {}, index, "member-b");
    expect(search("汇报模板").map(hit => hit.messageId).sort()).toEqual(["m1", "m2"]);
    expect(search("汇报模板", undefined, index, "member-b").map(hit => hit.messageId)).toEqual(["b1"]);
    expect(search("汇报模板", undefined, other, "member-a").map(hit => hit.messageId)).toEqual(["x1"]);
    // The substring scan path is scoped the same way.
    expect(search("上次说的问题", undefined, index, "member-b")).toEqual([]);
    expect(index.titleMentions("member-b", ["季度汇报"])).toEqual([]);
    expect(index.titleMentions("member-a", ["季度汇报"])).toEqual(["季度汇报"]);
  });

  it("purges by generation at once, deletes rows later, and can keep existing messages forgotten (clear-all)", () => {
    sync([report, lora]);
    index.reset("member-a", "baseline");
    expect(search("汇报模板")).toEqual([]);
    expect(count("ai_member_history_chunks")).toBeGreaterThan(0);
    expect(count("ai_member_history_purges")).toBe(1);
    expect(AiMemberHistoryIndex.runPurges(sql, 4)).toBeGreaterThan(0);
    expect(count("ai_member_history_chunks")).toBe(0);
    expect(allFtsRows()).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_member_history_fts WHERE ai_member_history_fts MATCH ?").get('body:"汇报模"')).toEqual({ count: 0 });
    expect(count("ai_member_history_purges")).toBe(0);
    // Baseline: what existed at the clear is recorded as seen, not indexed.
    expect(sync([report, lora])).toMatchObject({ indexed: 0 });
    expect(index.mode("member-a")).toBe("sync");
    expect(search("汇报模板")).toEqual([]);
    // New and edited messages after the clear are indexed.
    const later = { ...report, messages: [...report.messages, user("m9", "新的季度汇报模板要加上预算")] };
    expect(sync([later, lora])).toMatchObject({ indexed: 1 });
    expect(search("汇报模板").map(hit => hit.messageId)).toEqual(["m9"]);
    const editedOld = { ...lora, messages: [lora.messages[0], { ...lora.messages[1], content: "LORA 生态合作方案第二版：增加激励计划。" }] };
    expect(sync([later, editedOld])).toMatchObject({ indexed: 1 });
    expect(search("lora 合作方案").map(hit => hit.messageId)).toEqual(["m4"]);
    // An organization switch-off purges every member.
    index.resetTenant();
    expect(search("汇报模板")).toEqual([]);
    AiMemberHistoryIndex.runPurges(sql, 4);
    expect(count("ai_member_history_chunks")).toBe(0);
  });

  it("queues backfill work, reconciles workspace drift and retries with backoff", () => {
    database.exec("CREATE TABLE IF NOT EXISTS ai_workspaces (user_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', revision INTEGER NOT NULL, schema_version INTEGER NOT NULL, updated_at TEXT NOT NULL, data TEXT NOT NULL)");
    database.prepare("INSERT INTO ai_workspaces(user_id,tenant_id,revision,schema_version,updated_at,data) VALUES(?,?,?,?,?,?)").run("member-a", "default", 4, 1, "2026-09-27T00:00:00.000Z", "{}");
    database.prepare("INSERT INTO ai_workspaces(user_id,tenant_id,revision,schema_version,updated_at,data) VALUES(?,?,?,?,?,?)").run("member-b", "default", 2, 1, "2026-09-27T00:00:00.000Z", "{}");
    sync([report], { revision: 4 });
    expect(index.enqueueDrift()).toBe(1);
    expect(AiMemberHistoryIndex.dueQueue(sql, Date.now(), 10)).toEqual([{ tenantId: "default", userId: "member-b", reason: "reconcile", attempts: 0 }]);
    index.failQueued("member-b", 0);
    expect(AiMemberHistoryIndex.dueQueue(sql, Date.now(), 10)).toEqual([]);
    expect(AiMemberHistoryIndex.dueQueue(sql, Date.now() + 61_000, 10)).toHaveLength(1);
    index.finishQueued("member-b", true);
    expect(count("ai_member_history_queue")).toBe(0);
    // A member who turned learning off is not queued.
    database.prepare("INSERT INTO ai_member_memories(tenant_id,user_id,revision,learning_enabled) VALUES('default','member-b',1,0)").run();
    expect(index.enqueueDrift()).toBe(0);
  });
});
