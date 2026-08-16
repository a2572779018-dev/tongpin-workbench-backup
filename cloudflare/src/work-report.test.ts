import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DATABASE_MIGRATION_6 } from "./schema";

describe("Cloudflare BOSS work report persistence", () => {
  it("stores one report state per boss and Shanghai report date", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    database.exec(DATABASE_MIGRATION_6);
    database.prepare("INSERT INTO users (id) VALUES (?)").run("boss-1");
    const insert = database.prepare(
      `INSERT INTO boss_work_report_statuses
       (boss_user_id, report_date, trigger, opened_at)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("boss-1", "2026-08-16", "startup", "2026-08-15T16:00:01Z");
    expect(() =>
      insert.run("boss-1", "2026-08-16", "resume", "2026-08-15T16:01:00Z"),
    ).toThrow();
    insert.run("boss-1", "2026-08-17", "resume", "2026-08-16T16:00:01Z");
    const rows = database
      .prepare(
        `SELECT report_date, dismissed_at, read_at
         FROM boss_work_report_statuses ORDER BY report_date`,
      )
      .all();
    expect(rows).toEqual([
      { report_date: "2026-08-16", dismissed_at: null, read_at: null },
      { report_date: "2026-08-17", dismissed_at: null, read_at: null },
    ]);
    database.close();
  });
});
