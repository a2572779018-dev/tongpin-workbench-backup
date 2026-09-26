import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES } from "../../shared/relationshipGraphMirror";

/** Local, isolated SQLite Durable Object fixture: real bundled Worker routes,
 * loopback-only Miniflare, outbound network blocked, no production data. */
describe.sequential("relationship graph mirror through the bundled Worker and SQLite Durable Object", () => {
  const WORKER = "tongpin-relationship-graph-workerd";
  const HOST = "http://tongpin-relationship-local.invalid";
  const PASSWORD = "RelationshipWorkerd2026!";
  type Session = { accessToken: string; user: { id: string; email: string; role: string } };
  type Failure = { error: { code: string; message: string } };
  let directory = "";
  let bundle = "";
  let mf: Miniflare;
  let outboundCalls = 0;
  const sessions: Record<string, Session> = {};

  const noOutbound: V4FetchHandler = async (request) => {
    outboundCalls += 1;
    throw new Error(`relationship fixture blocked outbound request to ${new URL(request.url).host}`);
  };
  const start = () => new Miniflare({
    ...convertV4MiniflareOptions({
      name: WORKER, modules: true, script: bundle,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "relationship-workerd-isolated-secret-".repeat(3),
        BOOTSTRAP_ADMIN_EMAIL: "rg-admin@workerd.invalid", DEV_EMAIL_PREVIEW: "true",
        CLIENT_ORIGINS: HOST, AI_ALLOWED_HOSTS: "fixture.invalid",
        LORA_EXPLORER_API: "https://unused.invalid", LORA_RPC_URL: "https://unused.invalid",
      },
      outboundService: noOutbound, log: new Log(LogLevel.ERROR),
    }),
    unsafeInspectDurableObjects: true,
  });

  async function call<T>(route: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await mf.dispatchFetch(`${HOST}${route}`, {
      method,
      headers: {
        ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() as T };
  }
  async function ok<T>(route: string, session?: Session, body?: unknown, method?: string): Promise<T> {
    const result = await call<T | Failure>(route, session, body, method);
    expect(result.status, `${method ?? "GET"} ${route}: ${JSON.stringify(result.body).slice(0, 250)}`).toBe(200);
    return result.body as T;
  }
  async function register(email: string, name: string) {
    const created = await call<{ debugCode: string }>("/api/auth/register", undefined, { email, name, password: PASSWORD });
    expect(created.status).toBe(201);
    await ok("/api/auth/verify-email", undefined, { email, code: created.body.debugCode });
  }
  const login = (email: string) => ok<Session>("/api/auth/login", undefined, { email, password: PASSWORD });
  const storage = () => mf.unsafeGetDurableObjectStorage(WORKER, "TongpinCore", { name: "primary" });

  function graph(label: string, extra: Record<string, unknown> = {}) {
    return {
      schemaVersion: "1.0",
      title: "已合作客户脉络图",
      generatedAt: "2026-09-26T08:00:00.000Z",
      people: [
        { id: "self", name: "你", level: "self", avatar: null },
        { id: "wang", name: `${label}王总`, level: "core", avatar: null },
      ],
      connections: [{ source: "self", target: "wang", relationship: "客户引荐", strength: 0.7 }],
      ...extra,
    };
  }
  const upload = (value: unknown, localVersion = 1) => ({
    graph: value,
    localVersion,
    contentHash: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    updatedAt: "2026-09-26T08:00:00.000Z",
    avatarsOmitted: 0,
  });

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-relationship-workerd-"));
    const built = await build({
      entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false,
      platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"],
    });
    bundle = built.outputFiles[0].text;
    mf = start();
    await mf.ready;
    expect(await ok<{ storage: string }>("/api/health")).toMatchObject({ storage: "durable-object-sqlite" });
    const accounts = [
      ["admin", "rg-admin@workerd.invalid", "本地管理员"],
      ["boss", "rg-boss@workerd.invalid", "本地老板"],
      ["member", "rg-member@workerd.invalid", "小林"],
      ["quiet", "rg-quiet@workerd.invalid", "阿周"],
      ["other", "rg-other@workerd.invalid", "外部成员"],
      ["otherBoss", "rg-otherboss@workerd.invalid", "外部老板"],
    ] as const;
    for (const [, email, name] of accounts) await register(email, name);
    sessions.admin = await login("rg-admin@workerd.invalid");
    const users = await ok<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", sessions.admin);
    const idOf = (email: string) => users.users.find((user) => user.email === email)!.id;
    for (const [key, email] of accounts.slice(1)) {
      await ok(`/api/admin/users/${idOf(email)}/access`, sessions.admin, { status: "active" }, "PATCH");
      if (key === "boss" || key === "otherBoss") {
        await ok(`/api/admin/users/${idOf(email)}/role`, sessions.admin, { role: "boss" }, "PATCH");
      }
    }
    // A second organization exists only as server-owned data (no public route sets it).
    const store = await storage();
    await store.exec("UPDATE users SET tenant_id = 'acme' WHERE id IN (?, ?)", idOf("rg-other@workerd.invalid"), idOf("rg-otherboss@workerd.invalid"));
    for (const [key, email] of accounts.slice(1)) sessions[key] = await login(email);
  }, 60_000);

  afterAll(async () => {
    if (mf) await mf.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates migration 7 on a fresh database", async () => {
    const store = await storage();
    const tables = await store.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relationship_graph_snapshots', 'relationship_graph_snapshot_chunks') ORDER BY name",
    );
    expect(tables.map((row) => row.name)).toEqual(["relationship_graph_snapshot_chunks", "relationship_graph_snapshots"]);
    const migration = await store.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations WHERE id = 7");
    expect(migration).toHaveLength(1);
  });

  it("stores member uploads and serves them read-only to the boss of the same organization", async () => {
    const put = await ok<{ snapshot: { localVersion: number; contactCount: number; syncedAt: string } }>(
      "/api/relationship-graphs/me", sessions.member, upload(graph("第一版"), 3), "PUT",
    );
    expect(put.snapshot).toMatchObject({ localVersion: 3, contactCount: 1 });
    expect(await ok("/api/relationship-graphs/me", sessions.member)).toEqual(put);

    const list = await call<{ members: Array<{ user: { id: string; name: string }; snapshot: unknown }> }>(
      "/api/boss/relationship-graphs", sessions.boss,
    );
    expect(list.status).toBe(200);
    expect(list.headers.get("cache-control")).toBe("no-store");
    expect(list.body.members.map((item) => item.user.name).sort()).toEqual(["小林", "阿周"].sort());
    expect(list.body.members.find((item) => item.user.id === sessions.member.user.id)?.snapshot).toEqual(put.snapshot);
    expect(list.body.members.find((item) => item.user.id === sessions.quiet.user.id)?.snapshot).toBeNull();

    const detail = await call<{ user: { id: string }; snapshot: unknown; graph: unknown }>(
      `/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss,
    );
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect(detail.body).toEqual({ user: expect.objectContaining({ id: sessions.member.user.id }), snapshot: put.snapshot, graph: graph("第一版") });
    const unsynced = await call<Failure>(`/api/boss/relationship-graphs/${sessions.quiet.user.id}`, sessions.boss);
    expect([unsynced.status, unsynced.body.error.code]).toEqual([404, "RELATIONSHIP_GRAPH_NOT_SYNCED"]);
  }, 30_000);

  it("isolates organizations and roles", async () => {
    await ok("/api/relationship-graphs/me", sessions.other, upload(graph("外部")), "PUT");
    const otherList = await ok<{ members: Array<{ user: { id: string } }> }>("/api/boss/relationship-graphs", sessions.otherBoss);
    expect(otherList.members.map((item) => item.user.id)).toEqual([sessions.other.user.id]);
    for (const [viewer, target] of [["otherBoss", "member"], ["boss", "other"]] as const) {
      const denied = await call<Failure>(`/api/boss/relationship-graphs/${sessions[target].user.id}`, sessions[viewer]);
      expect([denied.status, denied.body.error.code]).toEqual([404, "USER_NOT_FOUND"]);
    }
    for (const name of ["member", "admin"]) {
      expect((await call("/api/boss/relationship-graphs", sessions[name])).status).toBe(403);
      expect((await call(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions[name])).status).toBe(403);
    }
    for (const name of ["boss", "admin"]) {
      expect((await call("/api/relationship-graphs/me", sessions[name])).status).toBe(403);
      expect((await call("/api/relationship-graphs/me", sessions[name], upload(graph("越权")), "PUT")).status).toBe(403);
    }
    expect((await call("/api/boss/relationship-graphs")).status).toBe(401);
    expect((await call(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss, upload(graph("老板改写")), "PUT")).status).toBe(404);
    expect((await ok<{ graph: unknown }>(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss)).graph).toEqual(graph("第一版"));
  }, 30_000);

  it("chunks a large graph below the 2 MB row limit and keeps only the latest snapshot", async () => {
    const note = "客".repeat(250_000);
    const large = graph("大图", {
      people: [
        { id: "self", name: "你", level: "self", avatar: null },
        ...Array.from({ length: 6 }, (_, index) => ({ id: `big${index}`, name: `大客户${index}`, level: "core", avatar: null, note })),
      ],
      connections: [],
    });
    const bytes = Buffer.byteLength(JSON.stringify(large), "utf8");
    expect(bytes).toBeGreaterThan(4 * 1024 * 1024);
    expect(bytes).toBeLessThan(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES);
    await ok("/api/relationship-graphs/me", sessions.member, upload(large, 4), "PUT");
    const store = await storage();
    const chunks = await store.exec<{ chunk_index: number; size: number }>(
      "SELECT chunk_index, length(CAST(data AS BLOB)) AS size FROM relationship_graph_snapshot_chunks WHERE user_id = ? ORDER BY chunk_index",
      sessions.member.user.id,
    );
    expect(chunks.length).toBeGreaterThan(5);
    expect(Math.max(...chunks.map((chunk) => Number(chunk.size)))).toBeLessThan(2 * 1024 * 1024);
    expect((await ok<{ graph: unknown }>(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss)).graph).toEqual(large);

    await ok("/api/relationship-graphs/me", sessions.member, upload(graph("第二版"), 5), "PUT");
    const remaining = await store.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM relationship_graph_snapshot_chunks WHERE user_id = ?", sessions.member.user.id,
    );
    expect(Number(remaining[0].count)).toBe(1);
    const rows = await store.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM relationship_graph_snapshots WHERE user_id = ?", sessions.member.user.id,
    );
    expect(Number(rows[0].count)).toBe(1);
  }, 60_000);

  it("rejects oversized and tampered uploads before touching the stored copy", async () => {
    const overBody = await call<Failure>(
      "/api/relationship-graphs/me", sessions.member,
      JSON.stringify({ padding: "x".repeat(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES + 70 * 1024) }), "PUT",
    );
    expect([overBody.status, overBody.body.error.code]).toEqual([413, "PAYLOAD_TOO_LARGE"]);
    const overGraph = graph("超限", {
      people: [
        { id: "self", name: "你", level: "self" },
        { id: "big", name: "大客户", level: "core", note: "x".repeat(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES) },
      ],
      connections: [],
    });
    const tooLarge = await call<Failure>("/api/relationship-graphs/me", sessions.member, upload(overGraph, 9), "PUT");
    expect([tooLarge.status, tooLarge.body.error.code]).toEqual([413, "RELATIONSHIP_GRAPH_TOO_LARGE"]);
    const tampered = await call<Failure>(
      "/api/relationship-graphs/me", sessions.member, { ...upload(graph("篡改"), 10), contentHash: "0".repeat(64) }, "PUT",
    );
    expect([tampered.status, tampered.body.error.code]).toEqual([400, "RELATIONSHIP_GRAPH_HASH_MISMATCH"]);
    const malformed = await call<Failure>("/api/relationship-graphs/me", sessions.member, "{not json", "PUT");
    expect([malformed.status, malformed.body.error.code]).toEqual([400, "INVALID_JSON"]);
    expect((await ok<{ graph: unknown }>(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss)).graph).toEqual(graph("第二版"));
  }, 60_000);

  it("survives a workerd restart and recreates the tables through the early-exit migration path", async () => {
    await mf.dispose();
    mf = start();
    await mf.ready;
    expect((await ok<{ graph: unknown }>(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss)).graph).toEqual(graph("第二版"));

    // Emulate an installation that predates migration 7 (users/tasks/LORA tables present).
    const store = await storage();
    await store.exec("DROP TABLE relationship_graph_snapshot_chunks");
    await store.exec("DROP TABLE relationship_graph_snapshots");
    await store.exec("DELETE FROM _sql_schema_migrations WHERE id = 7");
    await mf.dispose();
    mf = start();
    await mf.ready;
    const reopened = await storage();
    const tables = await reopened.exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('relationship_graph_snapshots', 'relationship_graph_snapshot_chunks')",
    );
    expect(tables).toHaveLength(2);
    expect(await reopened.exec("SELECT id FROM _sql_schema_migrations WHERE id = 7")).toHaveLength(1);
    const list = await ok<{ members: Array<{ snapshot: unknown }> }>("/api/boss/relationship-graphs", sessions.boss);
    expect(list.members.every((item) => item.snapshot === null)).toBe(true);
    await ok("/api/relationship-graphs/me", sessions.member, upload(graph("迁移后"), 6), "PUT");
    expect((await ok<{ graph: unknown }>(`/api/boss/relationship-graphs/${sessions.member.user.id}`, sessions.boss)).graph).toEqual(graph("迁移后"));
    expect(outboundCalls).toBe(0);
  }, 60_000);
});
