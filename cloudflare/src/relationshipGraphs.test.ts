import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { UserRole } from "../../server/types";
import { ApiError, type UserRow } from "./platform";
import {
  handleRelationshipGraphRequest,
  isRelationshipGraphPath,
  type RelationshipGraphRouteContext,
} from "./relationshipGraphs";

type Row = Record<string, string | number | null>;

/** Minimal SqlStorage over node:sqlite; only what the route module uses. */
function sqlStorage(db: DatabaseSync): SqlStorage {
  const cursor = (rows: Row[]) => ({ toArray: () => rows });
  return {
    exec(query: string, ...bindings: Array<string | number | null>) {
      if (/^\s*SELECT/i.test(query)) return cursor(db.prepare(query).all(...bindings) as Row[]);
      if (bindings.length === 0) db.exec(query);
      else db.prepare(query).run(...bindings);
      return cursor([]);
    },
  } as unknown as SqlStorage;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default', email TEXT, name TEXT,
    role TEXT, status TEXT, job_title TEXT DEFAULT '', avatar_seed INTEGER DEFAULT 0,
    avatar_version INTEGER DEFAULT 0, avatar_data_url TEXT, email_verified_at TEXT,
    last_login_at TEXT, created_at TEXT DEFAULT '', updated_at TEXT DEFAULT '')`);
  const insert = db.prepare("INSERT INTO users (id, tenant_id, email, name, role, status) VALUES (?, ?, ?, ?, ?, 'active')");
  insert.run("aaaaaaaa-0000-4000-8000-000000000001", "default", "boss@x.invalid", "老板", "boss");
  insert.run("aaaaaaaa-0000-4000-8000-000000000002", "default", "member@x.invalid", "小林", "member");
  let failWrites = false;
  const context: RelationshipGraphRouteContext = {
    sql: sqlStorage(db),
    transactionSync<T>(action: () => T): T {
      if (failWrites) throw new Error("Exceeded allowed rows written in Durable Objects free tier");
      db.exec("BEGIN");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async requireUser(request: Request, roles?: UserRole[]) {
      const id = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
      if (!user) throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
      if (roles && !roles.includes(user.role)) throw new ApiError(403, "FORBIDDEN", "你没有访问此功能的权限");
      return user;
    },
    schema: { ready: false },
  };
  return { db, context, failWrites: (value: boolean) => { failWrites = value; } };
}

const BOSS = "aaaaaaaa-0000-4000-8000-000000000001";
const MEMBER = "aaaaaaaa-0000-4000-8000-000000000002";
const graph = {
  schemaVersion: "1.0",
  title: "客户脉络",
  people: [{ id: "self", name: "你", level: "self" }, { id: "wang", name: "王总", level: "core" }],
  connections: [{ source: "self", target: "wang" }],
};
const body = JSON.stringify({
  graph,
  localVersion: 2,
  contentHash: createHash("sha256").update(JSON.stringify(graph)).digest("hex"),
  updatedAt: "2026-09-26T08:00:00.000Z",
});

function request(path: string, user: string, method = "GET", payload?: string) {
  return new Request(`http://local.invalid${path}`, {
    method,
    headers: { Authorization: `Bearer ${user}`, "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: payload }),
  });
}

async function run(context: RelationshipGraphRouteContext, path: string, user: string, method = "GET", payload?: string) {
  try {
    const response = await handleRelationshipGraphRequest(request(path, user, method, payload), path, context);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ApiError) return { status: error.status, body: { error: { code: error.code } } };
    throw error;
  }
}

describe("Worker relationship graph routes", () => {
  it("matches only the mirror paths", () => {
    expect(isRelationshipGraphPath("/api/relationship-graphs/me")).toBe(true);
    expect(isRelationshipGraphPath("/api/boss/relationship-graphs")).toBe(true);
    expect(isRelationshipGraphPath(`/api/boss/relationship-graphs/${MEMBER}`)).toBe(true);
    expect(isRelationshipGraphPath("/api/boss/team")).toBe(false);
    expect(isRelationshipGraphPath("/api/relationship-graphs")).toBe(false);
  });

  it("creates the migration-7 tables on first use when migrate() could not", async () => {
    const { db, context } = fixture();
    const put = await run(context, "/api/relationship-graphs/me", MEMBER, "PUT", body);
    expect(put.status).toBe(200);
    expect(context.schema.ready).toBe(true);
    expect(db.prepare("SELECT id FROM _sql_schema_migrations WHERE id = 7").all()).toHaveLength(1);
    const detail = await run(context, `/api/boss/relationship-graphs/${MEMBER}`, BOSS);
    expect(detail).toMatchObject({ status: 200, body: { graph } });
  });

  it("answers the free-plan row-write limit with a retryable 503", async () => {
    const pending = fixture();
    pending.failWrites(true);
    expect((await run(pending.context, "/api/relationship-graphs/me", MEMBER, "PUT", body)).body)
      .toEqual({ error: { code: "RELATIONSHIP_GRAPH_MAINTENANCE" } });

    const ready = fixture();
    expect((await run(ready.context, "/api/relationship-graphs/me", MEMBER, "PUT", body)).status).toBe(200);
    ready.failWrites(true);
    const busy = await run(ready.context, "/api/relationship-graphs/me", MEMBER, "PUT", body);
    expect(busy).toEqual({ status: 503, body: { error: { code: "RELATIONSHIP_GRAPH_SYNC_BUSY" } } });
  });

  it("refreshes metadata only for identical content", async () => {
    const { db, context } = fixture();
    await run(context, "/api/relationship-graphs/me", MEMBER, "PUT", body);
    const changes = () => Number((db.prepare("SELECT total_changes() AS count").get() as { count: number }).count);
    const before = changes();
    const again = await run(context, "/api/relationship-graphs/me", MEMBER, "PUT", body);
    expect(again.status).toBe(200);
    // One metadata row, no chunk delete/insert (a rewrite would change at least three rows).
    expect(changes() - before).toBe(1);
  });

  it("refuses to serve an incomplete snapshot", async () => {
    const { db, context } = fixture();
    await run(context, "/api/relationship-graphs/me", MEMBER, "PUT", body);
    db.prepare("UPDATE relationship_graph_snapshots SET chunk_count = 2 WHERE user_id = ?").run(MEMBER);
    const detail = await run(context, `/api/boss/relationship-graphs/${MEMBER}`, BOSS);
    expect(detail).toEqual({ status: 500, body: { error: { code: "RELATIONSHIP_GRAPH_CORRUPT" } } });
  });

  it("keeps unknown methods and nested paths closed", async () => {
    const { context } = fixture();
    expect((await run(context, "/api/relationship-graphs/me", MEMBER, "DELETE")).status).toBe(404);
    expect((await run(context, `/api/boss/relationship-graphs/${MEMBER}/extra`, BOSS)).status).toBe(404);
    expect((await run(context, "/api/boss/relationship-graphs", BOSS, "POST", body)).status).toBe(404);
  });
});
