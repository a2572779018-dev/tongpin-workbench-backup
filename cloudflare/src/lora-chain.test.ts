import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  isCompleteLoraCollectionCycle,
  isLoraDashboardRole,
  isLoraRpcSourceReachable,
  nextLoraSuccessfulSyncAt,
  nextUnifiedAlarmTimestamp,
  resolveLoraNullableCheckpoint,
  shouldDispatchLoraDailyDue,
} from "./platform";
import {
  DATABASE_MIGRATION_5,
  LORA_INSERT_ADDRESS_BASELINE,
  LORA_RETENTION_QUERIES,
} from "./schema";

describe("Cloudflare LORA dashboard security and persistence", () => {
  it("allows only boss and admin roles", () => {
    expect(isLoraDashboardRole("boss")).toBe(true);
    expect(isLoraDashboardRole("admin")).toBe(true);
    expect(isLoraDashboardRole("member")).toBe(false);
  });

  it("persists one daily report claim per boss and report date", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    database.exec(DATABASE_MIGRATION_5);
    database.prepare("INSERT INTO users (id) VALUES (?)").run("boss-1");
    const insert = database.prepare(
      `INSERT INTO boss_lora_report_opens
       (boss_user_id, report_date, claimed_at, trigger)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("boss-1", "2026-08-14", "2026-08-14T00:00:00Z", "startup");
    expect(() =>
      insert.run(
        "boss-1",
        "2026-08-14",
        "2026-08-14T00:00:01Z",
        "reconnect",
      ),
    ).toThrow();
    insert.run("boss-1", "2026-08-15", "2026-08-15T00:00:00Z", "startup");
    const count = database
      .prepare("SELECT COUNT(*) AS count FROM boss_lora_report_opens")
      .get() as { count: number };
    expect(count.count).toBe(2);
    const checkpointColumns = database
      .prepare("PRAGMA table_info(lora_chain_checkpoint)")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(checkpointColumns).toEqual(
      expect.arrayContaining([
        "burn_history_cursor_json",
        "head_transaction_hash",
        "head_burn_key",
        "block_head_cursor_json",
        "block_head_candidate_key",
        "transaction_head_cursor_json",
        "transaction_head_candidate_hash",
        "burn_head_cursor_json",
        "burn_head_candidate_key",
        "swap_checkpoint_block",
        "pending_internal_transactions_json",
        "internal_details_complete",
        "swap_today_complete",
      ]),
    );
    database.close();
  });

  it("stores all on-chain integer amounts as TEXT", () => {
    for (const column of [
      "value_wei TEXT NOT NULL",
      "gas_price_wei TEXT NOT NULL",
      "lrb_wei TEXT NOT NULL",
      "usdt_units TEXT NOT NULL",
      "reserve_usdt TEXT",
      "reserve_wlrb TEXT",
    ]) {
      expect(DATABASE_MIGRATION_5).toContain(column);
    }
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    database.exec(DATABASE_MIGRATION_5);
    const wei = "1000000000000000000001";
    database
      .prepare(
        `INSERT INTO lora_chain_transactions
         (hash, block_number, timestamp, from_address, value_wei, success,
          gas_used, gas_price_wei, input)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `0x${"1".repeat(64)}`,
        1,
        "2026-08-14T00:00:00Z",
        `0x${"2".repeat(40)}`,
        wei,
        1,
        "21000",
        "1000000000",
        "0x",
      );
    const row = database
      .prepare(
        `SELECT value_wei, typeof(value_wei) AS storage_type
         FROM lora_chain_transactions`,
      )
      .get() as { value_wei: string; storage_type: string };
    expect(row).toEqual({ value_wei: wei, storage_type: "text" });
    database.close();
  });

  it("prunes old internal details without deleting cumulative burn history", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    database.exec(DATABASE_MIGRATION_5);
    const insert = database.prepare(
      `INSERT INTO lora_chain_internal_transactions
       (transaction_hash, trace_index, block_number, timestamp, from_address,
        to_address, value_wei, success, call_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const from = `0x${"1".repeat(40)}`;
    const dead = "0x000000000000000000000000000000000000dead";
    insert.run(
      `0x${"2".repeat(64)}`,
      "0",
      1,
      "2026-07-01T00:00:00Z",
      from,
      dead,
      "1000000000000000000000",
      1,
      "CALL",
    );
    insert.run(
      `0x${"3".repeat(64)}`,
      "0",
      1,
      "2026-07-01T00:00:00Z",
      from,
      `0x${"4".repeat(40)}`,
      "200000000000000000000",
      1,
      "CALL",
    );
    database
      .prepare(LORA_RETENTION_QUERIES.nonBurnInternals)
      .run("2026-08-01T00:00:00Z", dead);
    const rows = database
      .prepare(
        "SELECT transaction_hash, to_address FROM lora_chain_internal_transactions",
      )
      .all();
    expect(rows).toEqual([
      { transaction_hash: `0x${"2".repeat(64)}`, to_address: dead },
    ]);
    database.close();
  });

  it("keeps the first midnight address baseline for a report date", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    database.exec(DATABASE_MIGRATION_5);
    const insert = database.prepare(LORA_INSERT_ADDRESS_BASELINE);
    insert.run("2026-08-15", "100", "2026-08-14T16:00:01Z", 10);
    insert.run("2026-08-15", "120", "2026-08-14T16:01:59Z", 20);
    const baseline = database
      .prepare(
        `SELECT total_addresses, captured_at, block_number
         FROM lora_chain_address_baselines WHERE report_date = ?`,
      )
      .get("2026-08-15");
    expect(baseline).toEqual({
      total_addresses: "100",
      captured_at: "2026-08-14T16:00:01Z",
      block_number: 10,
    });
    database.close();
  });

  it("distinguishes an omitted Swap checkpoint from an explicit reset", () => {
    expect(resolveLoraNullableCheckpoint(undefined, 88)).toBe(88);
    expect(resolveLoraNullableCheckpoint(null, 88)).toBeNull();
    expect(resolveLoraNullableCheckpoint(99, 88)).toBe(99);
  });

  it("requires both mandatory sources before advancing global health time", () => {
    const previous = "2026-08-15T00:00:00.000Z";
    const now = "2026-08-15T00:01:00.000Z";
    expect(
      isCompleteLoraCollectionCycle({
        rpcHealthy: true,
        explorerHealthy: false,
      }),
    ).toBe(false);
    expect(nextLoraSuccessfulSyncAt(false, now, previous)).toBe(previous);
    expect(
      isCompleteLoraCollectionCycle({
        rpcHealthy: true,
        explorerHealthy: true,
      }),
    ).toBe(true);
    expect(nextLoraSuccessfulSyncAt(true, now, previous)).toBe(now);
  });

  it("treats Pair config errors as RPC reachability only", () => {
    const rpcReachable = isLoraRpcSourceReachable(false, "config-error");
    expect(rpcReachable).toBe(true);
    expect(
      isCompleteLoraCollectionCycle({
        rpcHealthy: rpcReachable,
        explorerHealthy: true,
      }),
    ).toBe(true);
    expect(isLoraRpcSourceReachable(false, "unavailable")).toBe(false);
  });
});

describe("Cloudflare unified alarm", () => {
  it("selects the earliest flash, collector, midnight, or 08:00 work", () => {
    expect(
      nextUnifiedAlarmTimestamp(1_000, [8_000, 4_000, 7_000, 6_000]),
    ).toBe(4_000);
  });

  it("never schedules in the past", () => {
    expect(nextUnifiedAlarmTimestamp(1_000, [500])).toBe(1_001);
  });

  it("dispatches the 08:00 signal once per Shanghai report date", () => {
    const dueAtMs = Date.parse("2026-08-14T08:00:00+08:00");
    expect(
      shouldDispatchLoraDailyDue({
        nowMs: dueAtMs - 1,
        dueAtMs,
        reportDate: "2026-08-14",
        lastDispatchedDate: null,
      }),
    ).toBe(false);
    expect(
      shouldDispatchLoraDailyDue({
        nowMs: dueAtMs,
        dueAtMs,
        reportDate: "2026-08-14",
        lastDispatchedDate: null,
      }),
    ).toBe(true);
    expect(
      shouldDispatchLoraDailyDue({
        nowMs: dueAtMs + 60_000,
        dueAtMs,
        reportDate: "2026-08-14",
        lastDispatchedDate: "2026-08-14",
      }),
    ).toBe(false);
  });
});
