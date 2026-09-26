import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DATABASE_MIGRATION_7 } from "./schema";

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  db.exec(DATABASE_MIGRATION_7);
  db.prepare("INSERT INTO users (id) VALUES (?)").run("member-1");
  db.prepare("INSERT INTO users (id) VALUES (?)").run("member-2");
  return db;
}

const insertSnapshot = (db: DatabaseSync, userId: string, chunkCount = 1, localVersion = 1) =>
  db
    .prepare(
      `INSERT INTO relationship_graph_snapshots
       (user_id, tenant_id, local_version, content_hash, updated_at, synced_at,
        contact_count, connection_count, avatars_omitted, byte_length, chunk_count)
       VALUES (?, 'default', ?, ?, '2026-09-26T08:00:00Z', '2026-09-26T08:00:01Z', 1, 1, 0, 10, ?)`,
    )
    .run(userId, localVersion, "a".repeat(64), chunkCount);

describe("Cloudflare migration 7: relationship graph mirror", () => {
  it("keeps exactly one snapshot row per member with ordered chunks", () => {
    const db = database();
    insertSnapshot(db, "member-1", 2);
    expect(() => insertSnapshot(db, "member-1")).toThrow();
    const chunk = db.prepare(
      "INSERT INTO relationship_graph_snapshot_chunks (user_id, chunk_index, data) VALUES (?, ?, ?)",
    );
    chunk.run("member-1", 0, "{\"a\":");
    chunk.run("member-1", 1, "1}");
    expect(() => chunk.run("member-1", 1, "dup")).toThrow();
    expect(() => chunk.run("member-1", -1, "negative")).toThrow();
    expect(() => insertSnapshot(db, "member-2", 0)).toThrow();
    expect(() => insertSnapshot(db, "member-2", 1, 0)).toThrow();
    const joined = db
      .prepare(
        "SELECT group_concat(data, '') AS text FROM (SELECT data FROM relationship_graph_snapshot_chunks WHERE user_id = ? ORDER BY chunk_index)",
      )
      .get("member-1") as { text: string };
    expect(JSON.parse(joined.text)).toEqual({ a: 1 });
    db.close();
  });

  it("rejects rows for unknown accounts and cascades when an account row is removed", () => {
    const db = database();
    expect(() => insertSnapshot(db, "missing-user")).toThrow();
    insertSnapshot(db, "member-2");
    db.prepare(
      "INSERT INTO relationship_graph_snapshot_chunks (user_id, chunk_index, data) VALUES (?, 0, '{}')",
    ).run("member-2");
    db.prepare("DELETE FROM users WHERE id = ?").run("member-2");
    const counts = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM relationship_graph_snapshots) AS snapshots,
           (SELECT COUNT(*) FROM relationship_graph_snapshot_chunks) AS chunks`,
      )
      .get();
    expect(counts).toEqual({ snapshots: 0, chunks: 0 });
    db.close();
  });

  it("is idempotent so the early-exit path and the lazy guard can both apply it", () => {
    const db = database();
    insertSnapshot(db, "member-1");
    db.exec(DATABASE_MIGRATION_7);
    const count = db.prepare("SELECT COUNT(*) AS count FROM relationship_graph_snapshots").get() as { count: number };
    expect(count.count).toBe(1);
    db.close();
  });
});
