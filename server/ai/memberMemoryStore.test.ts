import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { AI_MEMORY_DEFAULT_SETTINGS, AI_MEMORY_LIMITS } from "../../shared/aiMemory";
import { applyAiModuleMigrations } from "./aiMigrations";
import {
  AiMemberMemoryRepository, applyMemoryBatch, findUniqueMemoryMatch, MEMBER_MEMORY_MIGRATIONS, memoryCharLength, memoryUsage, memoryUsagePercent, normalizeMemoryEntry,
} from "./memberMemoryStore";
import { AiStore, type AiSql } from "./storage";

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

// Semantics ported from Hermes tests/tools/test_memory_tool.py (MemoryStore core
// operations, batch, exact-entry priority, refuse-to-empty), on Tongpin's pure
// batch applier. Limits mirror the Hermes fixture (500 / 300 chars).
describe("bounded curated memory entries (Hermes MemoryStore semantics)", () => {
  const add = (entries: string[], content: string, limit = 500) => applyMemoryBatch(entries, [{ action: "add", content }], limit);

  it("counts code points and the \\n§\\n delimiter exactly like the rendered block", () => {
    expect(memoryUsage([])).toBe(0);
    expect(memoryUsage(["ab"])).toBe(2);
    expect(memoryUsage(["ab", "cd"])).toBe(7);
    expect(memoryCharLength("成员偏好先给结论")).toBe(8);
    expect(memoryCharLength("🙂好")).toBe(2);
    expect(memoryUsagePercent(670, 1000)).toBe(67);
    expect(memoryUsagePercent(2000, 1000)).toBe(100);
  });

  it("adds entries and treats an exact duplicate as a no-op, not a failure", () => {
    const first = add([], "Python 3.12 project");
    expect(first).toMatchObject({ ok: true, added: 1, entries: ["Python 3.12 project"] });
    const duplicate = add(["Python 3.12 project"], "Python 3.12 project");
    expect(duplicate).toMatchObject({ ok: true, added: 0, entries: ["Python 3.12 project"] });
  });

  it("returns an overflow error with usage instead of silently dropping entries", () => {
    const full = ["x".repeat(490)];
    const result = add(full, "this will exceed the limit");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("overflow");
    expect(result.usage).toBe("490/500");
    expect(result.message).toContain("超过上限");
    expect(result.message).toContain("replace");
    expect(result.message).toContain("remove");
    // A replace that blows the budget mirrors the add-overflow shape.
    const replace = applyMemoryBatch(full, [{ action: "replace", oldText: "x".repeat(490), content: "y".repeat(600) }], 500);
    expect(replace).toMatchObject({ ok: false, code: "overflow" });
  });

  it("replace overwrites the WHOLE matched entry; old_text only locates it", () => {
    const entry = "RULE A: gate merges. RULE B: ci per HEAD. RULE C: never squash.";
    const result = applyMemoryBatch([entry], [{ action: "replace", oldText: "RULE B: ci per HEAD.", content: "RULE B: CI is per-head." }], 500);
    expect(result).toMatchObject({ ok: true, updated: 1, entries: ["RULE B: CI is per-head."] });
  });

  it("rejects an ambiguous substring and reports a zero match", () => {
    const entries = ["server A runs nginx", "server B runs nginx"];
    expect(applyMemoryBatch(entries, [{ action: "replace", oldText: "nginx", content: "apache" }], 500)).toMatchObject({ ok: false, code: "ambiguous" });
    expect(applyMemoryBatch(["fact A"], [{ action: "remove", oldText: "nonexistent" }], 500)).toMatchObject({ ok: false, code: "no_match" });
    expect(applyMemoryBatch(["fact A"], [{ action: "remove", oldText: "  " }], 500)).toMatchObject({ ok: false, code: "invalid" });
  });

  it("an exact whole-entry match beats a substring collision", () => {
    const entries = ["test", "echo-reply tests pass via local twins and are false positives"];
    expect(findUniqueMemoryMatch(entries, "test")).toEqual({ index: 0 });
    expect(applyMemoryBatch(entries, [{ action: "remove", oldText: "test" }], 500))
      .toMatchObject({ ok: true, entries: ["echo-reply tests pass via local twins and are false positives"] });
  });

  it("applies a batch atomically against the FINAL budget", () => {
    const entries = ["stale one", "stale two"];
    const result = applyMemoryBatch(entries, [
      { action: "remove", oldText: "stale one" }, { action: "remove", oldText: "stale two" }, { action: "add", content: "fresh durable fact" },
    ], 500);
    expect(result).toMatchObject({ ok: true, entries: ["fresh durable fact"], added: 1, removed: 2 });
    // One call can free room and add even when the add alone would overflow.
    const tight = applyMemoryBatch(["a".repeat(480)], [{ action: "replace", oldText: "a".repeat(10), content: "a".repeat(100) }, { action: "add", content: "new fact here" }], 500);
    expect(tight).toMatchObject({ ok: true, entries: ["a".repeat(100), "new fact here"] });
  });

  it("an atomic batch writes nothing when any operation fails", () => {
    const entries = ["keep me"];
    const result = applyMemoryBatch(entries, [{ action: "add", content: "legit fact" }, { action: "remove", oldText: "missing" }], 500);
    expect(result).toMatchObject({ ok: false, code: "no_match", operationIndex: 1 });
    expect(entries).toEqual(["keep me"]);
  });

  it("skipInvalid mode skips unmatched operations but still enforces budget and emptying", () => {
    const result = applyMemoryBatch(["keep me"], [{ action: "add", content: "legit fact" }, { action: "remove", oldText: "missing" }], 500, { mode: "skipInvalid" });
    expect(result.ok && result.entries).toEqual(["keep me", "legit fact"]);
    expect(result.ok && result.skipped.map(item => item.code)).toEqual(["no_match"]);
  });

  it.each([["user", "Name: Alice"], ["memory", "fact A"]])("refuses to empty a non-empty %s store through a batch", (_target, seed) => {
    expect(applyMemoryBatch([seed], [{ action: "remove", oldText: seed }], 300)).toMatchObject({ ok: false, code: "empty_store" });
    expect(applyMemoryBatch([seed], [{ action: "remove", oldText: seed }], 300, { allowEmptying: true })).toMatchObject({ ok: true, entries: [] });
    expect(applyMemoryBatch([seed, "second entry"], [{ action: "remove", oldText: seed }, { action: "add", content: "replacement entry" }], 300))
      .toMatchObject({ ok: true, entries: ["second entry", "replacement entry"] });
  });

  it("a pinned entry (member edit by index) is refused once it changed", () => {
    expect(applyMemoryBatch(["new text"], [{ action: "remove", oldText: "old text", matchedEntry: "old text" }], 500)).toMatchObject({ ok: false, code: "stale" });
  });

  it("normalizes entries to one compact line so they cannot forge block headers", () => {
    expect(normalizeMemoryEntry("  成员偏好\n\n先给结论\t再展开 \u0007")).toBe("成员偏好 先给结论 再展开");
  });
});

describe("member memory persistence", () => {
  let database: DatabaseSync;
  let sql: AiSql;
  let repository: AiMemberMemoryRepository;
  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    sql = adapter(database);
    new AiStore(sql).initialize();
    repository = new AiMemberMemoryRepository(sql);
  });

  it("runs numbered migration 1 once through the AI store and records it in the ledger", () => {
    const ledger = database.prepare("SELECT module, version FROM ai_schema_migrations").all();
    expect(ledger).toEqual([{ module: "member_memory", version: 1 }]);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'ai_member_memor%' ORDER BY name").all().map(row => row.name);
    expect(tables).toEqual(["ai_member_memories", "ai_member_memory_reviews", "ai_member_memory_snapshots"]);
    // Idempotent on every Durable Object start.
    expect(applyAiModuleMigrations(sql, "member_memory", MEMBER_MEMORY_MIGRATIONS)).toEqual([]);
    new AiStore(sql).initialize();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_schema_migrations").get()).toEqual({ count: 1 });
  });

  it("defaults to an empty, learning-enabled member and the administrator's disabled feature", () => {
    expect(repository.read("member-a")).toEqual({ revision: 0, memory: [], user: [], learningEnabled: true, updatedAt: null, updatedBy: null });
    expect(repository.settings()).toEqual(AI_MEMORY_DEFAULT_SETTINGS);
    expect(AI_MEMORY_DEFAULT_SETTINGS.enabled).toBe(false);
  });

  it("uses compare-and-set revisions for concurrent writers", () => {
    const first = repository.write("member-a", 0, { memory: ["fact"], user: [], learningEnabled: true }, "review");
    expect(first.revision).toBe(1);
    expect(() => repository.write("member-a", 0, { memory: ["other"], user: [], learningEnabled: true }, "member")).toThrow(expect.objectContaining({ status: 409, code: "AI_MEMORY_CONFLICT" }));
    expect(repository.read("member-a").memory).toEqual(["fact"]);
    expect(() => repository.write("member-a", 1, { memory: ["x".repeat(AI_MEMORY_LIMITS.entryCharacters + 1)], user: [], learningEnabled: true }, "member")).toThrow(expect.objectContaining({ code: "AI_MEMORY_FULL" }));
  });

  it("keeps the same account id isolated between tenants", () => {
    repository.write("member-a", 0, { memory: ["默认组织的笔记"], user: [], learningEnabled: true }, "member");
    const other = repository.forTenant("org-2");
    expect(other.read("member-a").memory).toEqual([]);
    other.write("member-a", 0, { memory: ["另一个组织的笔记"], user: [], learningEnabled: true }, "member");
    expect(repository.read("member-a").memory).toEqual(["默认组织的笔记"]);
    expect(other.read("member-a").memory).toEqual(["另一个组织的笔记"]);
  });

  it("refuses to treat unreadable stored entries as empty (no silent wipe)", () => {
    repository.write("member-a", 0, { memory: ["fact"], user: [], learningEnabled: true }, "member");
    database.prepare("UPDATE ai_member_memories SET memory_entries='not json'").run();
    expect(() => repository.read("member-a")).toThrow(expect.objectContaining({ code: "AI_MEMORY_CORRUPT" }));
  });

  it("stores frozen snapshots per conversation and bounds them per member", () => {
    repository.saveSnapshot("member-a", "conv-1", "block-1", 1000);
    expect(repository.snapshot("member-a", "conv-1")).toEqual({ block: "block-1", capturedAt: 1000 });
    expect(repository.snapshot("member-b", "conv-1")).toBeUndefined();
    for (let index = 0; index < 130; index += 1) repository.saveSnapshot("member-a", `conv-${index + 10}`, "b", 2000 + index);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_member_memory_snapshots").get()).toEqual({ count: 120 });
    repository.deleteSnapshots("member-a");
    expect(database.prepare("SELECT COUNT(*) AS count FROM ai_member_memory_snapshots").get()).toEqual({ count: 0 });
  });

  it("exposes review status to the owner as counts only", () => {
    expect(repository.insertReview("member-a", "request-aaaaaaaaaaaa", "conv-1", "remember", 1000)).toBe(true);
    expect(repository.insertReview("member-a", "request-aaaaaaaaaaaa", "conv-1", "remember", 1000)).toBe(false);
    expect(repository.reviewStatuses("member-a", ["request-aaaaaaaaaaaa", "request-bbbbbbbbbbbb"])).toEqual([
      { requestId: "request-aaaaaaaaaaaa", status: "pending" }, { requestId: "request-bbbbbbbbbbbb", status: "none" },
    ]);
    repository.updateReview("member-a", "request-aaaaaaaaaaaa", { status: "applied", added: 2, updated: 1, removed: 0 }, 2000);
    expect(repository.reviewStatuses("member-a", ["request-aaaaaaaaaaaa"])).toEqual([{ requestId: "request-aaaaaaaaaaaa", status: "applied", changes: { added: 2, updated: 1, removed: 0 } }]);
    expect(repository.reviewStatuses("member-b", ["request-aaaaaaaaaaaa"])).toEqual([{ requestId: "request-aaaaaaaaaaaa", status: "none" }]);
  });

  it("gives administrators organization aggregates without any entry text", () => {
    repository.write("member-a", 0, { memory: ["私密的工作笔记"], user: ["私密的偏好"], learningEnabled: true }, "member");
    repository.write("member-b", 0, { memory: [], user: [], learningEnabled: false }, "member");
    repository.insertReview("member-a", "request-aaaaaaaaaaaa", "conv-1", "none", Date.now());
    repository.updateReview("member-a", "request-aaaaaaaaaaaa", { status: "applied", chargedPoints: 50, inputTokens: 900, outputTokens: 60 }, Date.now());
    const stats = repository.stats(Date.now());
    expect(stats).toEqual({ membersWithMemory: 1, membersLearningOff: 1, totalEntries: 2, reviews7d: { applied: 1, unchanged: 0, skipped: 0, failed: 0 }, points7d: 50, tokens7d: { input: 900, output: 60 } });
    expect(JSON.stringify(stats)).not.toContain("私密");
  });

  it("clear-all removes entries, snapshots and settled review rows but keeps the opt-in choice", () => {
    repository.write("member-a", 0, { memory: ["fact"], user: ["pref"], learningEnabled: false }, "member");
    repository.saveSnapshot("member-a", "conv-1", "block", 1000);
    repository.insertReview("member-a", "request-aaaaaaaaaaaa", "conv-1", "none", 1000);
    repository.updateReview("member-a", "request-aaaaaaaaaaaa", { status: "applied" }, 1000);
    repository.insertReview("member-a", "request-bbbbbbbbbbbb", "conv-1", "none", 1000);
    const cleared = repository.clear("member-a", 2000);
    expect(cleared).toMatchObject({ memory: [], user: [], learningEnabled: false, revision: 2 });
    expect(repository.snapshot("member-a", "conv-1")).toBeUndefined();
    expect(repository.review("member-a", "request-aaaaaaaaaaaa")).toBeUndefined();
    expect(repository.review("member-a", "request-bbbbbbbbbbbb")).toMatchObject({ status: "skipped", reason: "cleared" });
  });
});
