import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The schema additions merged for 0.1.50 on one persisted SQLite Durable
 * Object, under workerd: numbered core migration 7 (relationship-graph mirror)
 * and the AI module ledger `ai_schema_migrations` (member memory v1). They must
 * appear on a fresh database and on an existing one that predates them, with
 * that database's rows kept. No network: every outbound request fails the test.
 */
describe.sequential("Worker schema upgrade: fresh and existing Durable Object databases", () => {
  const WORKER = "tongpin-upgrade-migrations-workerd";
  const HOST = "http://tongpin-upgrade.local";
  const PASSWORD = "UpgradeMigrations20260927!";
  type Session = { accessToken: string; user: { id: string; email: string; role: string } };
  let directory: string;
  let script: string;
  let mf: Miniflare | undefined;
  const outbound: V4FetchHandler = request => { throw new Error(`unexpected outbound request: ${request.url}`); };

  async function start(): Promise<Miniflare> {
    const instance = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER, modules: true, script,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "upgrade-migrations-workerd-secret-".repeat(3), BOOTSTRAP_ADMIN_EMAIL: "admin@upgrade.example.com",
        DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: HOST, AI_ALLOWED_HOSTS: "fixture.invalid",
        LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await instance.ready;
    return instance;
  }
  async function api<T>(route: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST", expectedStatus = 200): Promise<T> {
    const response = await mf!.dispatchFetch(`${HOST}${route}`, {
      method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as T;
    expect(response.status, `${method} ${route}: ${JSON.stringify(payload).slice(0, 300)}`).toBe(expectedStatus);
    return payload;
  }
  async function register(email: string) {
    const registered = await api<{ debugCode: string }>("/api/auth/register", undefined, { email, name: email.split("@")[0], password: PASSWORD }, "POST", 201);
    await api("/api/auth/verify-email", undefined, { email, code: registered.debugCode });
  }
  const login = (email: string) => api<Session>("/api/auth/login", undefined, { email, password: PASSWORD });
  const sql = async <T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(query: string): Promise<T[]> =>
    (await mf!.unsafeGetDurableObjectStorage(WORKER, "TongpinCore", { name: "primary" })).exec<T>(query);
  const tables = async () => (await sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'relationship_graph%' OR name LIKE 'ai_member_%' OR name='ai_schema_migrations') ORDER BY name")).map(row => row.name);
  const schemaState = async () => ({
    tables: await tables(),
    core: (await sql<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")).map(row => row.id),
    ai: await sql<{ module: string; version: number }>("SELECT module, version FROM ai_schema_migrations ORDER BY module, version"),
  });
  // member_memory v2 (history recall, incl. the trigram FTS5 table and its shadow tables) and v3 (personal skills, activity).
  const EXPECTED_TABLES = [
    "ai_member_activity", "ai_member_history_chunks", "ai_member_history_conversations", "ai_member_history_fts", "ai_member_history_fts_config", "ai_member_history_fts_data",
    "ai_member_history_fts_docsize", "ai_member_history_fts_idx", "ai_member_history_purges", "ai_member_history_queue", "ai_member_history_state",
    "ai_member_memories", "ai_member_memory_reviews", "ai_member_memory_snapshots", "ai_member_skills", "ai_schema_migrations", "relationship_graph_snapshot_chunks", "relationship_graph_snapshots",
  ];
  const EXPECTED_AI_LEDGER = [1, 2, 3].map(version => ({ module: "member_memory", version }));

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-upgrade-migrations-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    script = bundled.outputFiles[0].text;
    mf = await start();
  }, 60_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("creates both additions on a fresh database", async () => {
    await register("admin@upgrade.example.com");
    await register("member@upgrade.example.com");
    const state = await schemaState();
    expect(state.tables).toEqual(EXPECTED_TABLES);
    expect(state.core).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(state.ai).toEqual(EXPECTED_AI_LEDGER);
  }, 30_000);

  it("adds them to an existing database that predates them and keeps its rows", async () => {
    const admin = await login("admin@upgrade.example.com");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    const member = users.users.find(user => user.email === "member@upgrade.example.com")!;
    await api(`/api/admin/users/${member.id}/access`, admin, { status: "active" }, "PATCH");
    // Roll this database back to the shape of an installation from before these branches.
    for (const table of ["relationship_graph_snapshot_chunks", "relationship_graph_snapshots", "ai_member_memory_snapshots", "ai_member_memory_reviews", "ai_member_memories", "ai_schema_migrations",
      "ai_member_history_fts", "ai_member_history_chunks", "ai_member_history_conversations", "ai_member_history_state", "ai_member_history_queue", "ai_member_history_purges", "ai_member_skills", "ai_member_activity"]) await sql(`DROP TABLE ${table}`);
    await sql("DELETE FROM _sql_schema_migrations WHERE id = 7");
    expect(await tables()).toEqual([]);
    const userCount = (await sql<{ count: number }>("SELECT COUNT(*) AS count FROM users"))[0].count;

    // A new deployment starts the Durable Object again on the same storage.
    await mf!.dispose();
    mf = await start();
    const state = await schemaState();
    expect(state.tables).toEqual(EXPECTED_TABLES);
    expect(state.core).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(state.ai).toEqual(EXPECTED_AI_LEDGER);
    expect((await sql<{ count: number }>("SELECT COUNT(*) AS count FROM users"))[0].count).toBe(userCount);

    // Existing accounts keep working and both features answer on the upgraded database.
    const again = await login("admin@upgrade.example.com");
    const memberSession = await login("member@upgrade.example.com");
    expect(await api<{ snapshot: unknown }>("/api/relationship-graphs/me", memberSession)).toEqual({ snapshot: null });
    expect(await api<{ settings: { enabled: boolean } }>("/api/admin/ai/memory", again)).toMatchObject({ settings: { enabled: false } });
    // Restarting an up-to-date database changes nothing.
    await mf!.dispose();
    mf = await start();
    expect(await schemaState()).toEqual(state);
  }, 60_000);
});
