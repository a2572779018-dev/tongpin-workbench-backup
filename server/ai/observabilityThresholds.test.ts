import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiStore, type AiSql } from "./storage";
import { AI_LATENCY_THRESHOLDS, aiLatencyThresholds } from "./observabilityThresholds";

describe("capability-aware latency alerts", () => {
  let database: DatabaseSync;
  let store: AiStore;
  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    store = new AiStore(sql); store.initialize();
  });
  afterEach(() => database.close());
  function sample(capability: "video" | "image", latencyMs: number, operation: "planning" | "execution" = "execution") {
    store.addObservability({ userId: "member", tier: "standard", providerId: "provider", capability, operation, success: true, latencyMs });
  }
  it.each(["video", "image"] as const)("does not report normal %s generation latency as a text outage", capability => {
    const limit = AI_LATENCY_THRESHOLDS[capability];
    for (let index = 0; index < 3; index++) sample(capability, limit.warningMs - 1);
    expect(store.observability().alerts).toEqual([]);
    sample(capability, limit.warningMs);
    expect(store.observability().alerts).toEqual([expect.objectContaining({ code: "HIGH_LATENCY", severity: "warning", occurrences: 1 })]);
    sample(capability, 65_000);
    expect(store.observability().alerts[0].occurrences).toBe(1);
    sample(capability, limit.criticalMs);
    expect(store.observability().alerts[0]).toMatchObject({ severity: "critical", occurrences: 2 });
  });
  it.each(["video", "image"] as const)("keeps %s planning on the text threshold", capability => {
    expect(aiLatencyThresholds(capability, "planning")).toEqual(AI_LATENCY_THRESHOLDS.text);
    for (let index = 0; index < 3; index++) sample(capability, 60_000, "planning");
    expect(store.observability().alerts[0]).toMatchObject({ code: "HIGH_LATENCY", severity: "warning" });
    sample(capability, 120_000, "planning");
    expect(store.observability().alerts[0].severity).toBe("critical");
  });
  it("keeps planning alerts separate from long successful video execution", () => {
    for (let index = 0; index < 3; index++) {
      sample("video", 65_000, "planning");
      sample("video", 10 * 60_000, "execution");
    }
    const alerts = store.observability().alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ code: "HIGH_LATENCY", severity: "warning", occurrences: 1 });
  });
});
