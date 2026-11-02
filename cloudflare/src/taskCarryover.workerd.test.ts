import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { businessDateKey } from "../../server/business-date";

describe.sequential("history task carryover in real SQLite Durable Object", () => {
  const name = "task-carryover-local", host = "http://tasks.local.invalid", password = "LocalTasks2026!";
  const today = businessDateKey();
  const past = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);
  type Session = { accessToken: string; user: { id: string } };
  let mf: Miniflare, directory = "", script = "", member: Session, other: Session;
  const start = () => new Miniflare({ ...convertV4MiniflareOptions({ name, modules: true, script, compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"], resourcePersistencePath: directory,
    durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
    bindings: { JWT_SECRET: "local-task-secret-".repeat(4), BOOTSTRAP_ADMIN_EMAIL: "admin@tasks.invalid", DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: host },
    outboundService: async () => { throw new Error("No external network in task test"); }, log: new Log(LogLevel.ERROR),
  }), unsafeInspectDurableObjects: true });
  const storage = () => mf.unsafeGetDurableObjectStorage(name, "TongpinCore", { name: "primary" });
  async function call(route: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await mf.dispatchFetch(host + route, { method, headers: { ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}), "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-task-carryover-"));
    script = (await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, write: false, format: "esm", platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] })).outputFiles[0].text;
    mf = start(); await mf.ready;
    for (const email of ["admin@tasks.invalid", "member@tasks.invalid", "other@tasks.invalid"]) {
      const created = await call("/api/auth/register", undefined, { name: email, email, password });
      expect(created.status).toBe(201);
      expect((await call("/api/auth/verify-email", undefined, { email, code: created.body.debugCode })).status).toBe(200);
    }
    const admin = (await call("/api/auth/login", undefined, { email: "admin@tasks.invalid", password })).body as Session;
    const users = (await call("/api/admin/users", admin)).body.users;
    for (const email of ["member@tasks.invalid", "other@tasks.invalid"]) {
      const id = users.find((u: any) => u.email === email).id;
      expect((await call(`/api/admin/users/${id}/access`, admin, { status: "active" }, "PATCH")).status).toBe(200);
    }
    member = (await call("/api/auth/login", undefined, { email: "member@tasks.invalid", password })).body;
    other = (await call("/api/auth/login", undefined, { email: "other@tasks.invalid", password })).body;
  }, 60000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function seed(date: string, source: string | null = null, status = "todo", user = member.user.id) {
    const id = randomUUID(), now = new Date().toISOString(), db = await storage();
    await db.exec("INSERT INTO tasks (id,user_id,date,title,details,status,priority,origin,source_task_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'p2','self',?,?,?)", id, user, date, "本地历史任务", "", status, source, now, now);
    return id;
  }
  it("finds a Friday and a long-break task, excludes another member, paginates without skips", async () => {
    const friday = await seed(past(3)), older = await seed(past(40));
    await seed(past(2), null, "todo", other.user.id);
    const first = await call("/api/tasks/backlog?limit=1", member);
    expect(first.status).toBe(200); expect(first.body.tasks.map((t: any) => t.id)).toEqual([friday]); expect(first.body.total).toBe(2);
    const sent = await call("/api/tasks/sync-to-today", member, { sourceDate: past(3), taskIds: [friday] });
    expect(sent.status).toBe(201); expect(sent.body.created).toHaveLength(1);
    const next = await call(`/api/tasks/backlog?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`, member);
    expect(next.body.tasks.map((t: any) => t.id)).toEqual([older]);
    const forbiddenCursor = await call(`/api/tasks/backlog?cursor=${encodeURIComponent(first.body.nextCursor)}`, other);
    expect(forbiddenCursor.status).toBe(400);
    expect((await call("/api/tasks/backlog?limit=101", member)).status).toBe(400);
  });
  it("rechecks lineage and completion, deduplicates concurrent and repeated requests", async () => {
    const a = await seed(past(6)), b = await seed(past(3), a);
    const ids = [b, b];
    const sent = await Promise.all([call("/api/tasks/sync-to-today", member, { sourceDate: past(3), taskIds: ids }), call("/api/tasks/sync-to-today", member, { sourceDate: past(3), taskIds: [b] })]);
    expect(sent.reduce((n, r) => n + r.body.created.length, 0)).toBe(1);
    expect((await call("/api/tasks/sync-to-today", member, { sourceDate: past(6), taskIds: [a] })).body.skippedTaskIds).toEqual([a]);
    const done = await seed(past(2));
    await (await storage()).exec("UPDATE tasks SET status='done' WHERE id=?", done);
    const stale = await call("/api/tasks/sync-to-today", member, { sourceDate: past(2), taskIds: [done] });
    expect(stale.body.created).toEqual([]); expect(stale.body.rejectedTaskIds).toEqual([done]);
    const before = (await call("/api/tasks/backlog?limit=100", member)).body;
    expect(before.tasks.some((t: any) => [a, b, done].includes(t.id))).toBe(false);
    await mf.dispose(); mf = start(); await mf.ready;
    expect((await call("/api/tasks/backlog?limit=100", member)).body).toEqual(before);
  });
  it("rolls back a failed batch including its audit rows", async () => {
    const first = await seed(past(7)), second = await seed(past(7)), db = await storage();
    await db.exec(`CREATE TRIGGER local_batch_failure BEFORE INSERT ON tasks WHEN NEW.source_task_id = '${second}' BEGIN SELECT RAISE(ABORT, 'local fixture write failure'); END`);
    try {
      const response = await call("/api/tasks/sync-to-today", member, { sourceDate: past(7), taskIds: [first, second] });
      expect(response.status).toBe(500);
      const copies = await db.exec("SELECT id FROM tasks WHERE source_task_id IN (?, ?)", first, second);
      expect(copies).toEqual([]);
      const audit = await db.exec("SELECT id FROM task_audit_events WHERE json_valid(snapshot_json) AND json_extract(snapshot_json, '$.sourceTaskId') IN (?, ?)", first, second);
      expect(audit).toEqual([]);
    } finally { await db.exec("DROP TRIGGER local_batch_failure"); }
  });

  it("uses deleted audit links without resurrecting them, and tolerates damaged audit JSON", async () => {
    const a = await seed(past(8)), b = await seed(past(4), a), db = await storage();
    const now = new Date().toISOString();
    await db.exec("INSERT INTO task_audit_events (id,task_id,user_id,actor_id,action,changes_json,snapshot_json,created_at) VALUES (?,?,?,?,'deleted','[]',?,?)", randomUUID(), b, member.user.id, member.user.id, JSON.stringify({ id: b, userId: member.user.id, date: past(4), status: "todo", sourceTaskId: a }), now);
    await db.exec("DELETE FROM tasks WHERE id=?", b);
    await db.exec("INSERT INTO task_audit_events (id,task_id,user_id,actor_id,action,changes_json,snapshot_json,created_at) VALUES (?,?,?,?,'deleted','[]','invalid json',?)", randomUUID(), randomUUID(), member.user.id, member.user.id, now);
    const backlog = await call("/api/tasks/backlog?limit=100", member);
    expect(backlog.status).toBe(200); expect(backlog.body.tasks.some((t: any) => t.id === a || t.id === b)).toBe(false);
    const stale = await call("/api/tasks/sync-to-today", member, { sourceDate: past(8), taskIds: [a] });
    expect(stale.body.created).toEqual([]); expect(stale.body.rejectedTaskIds).toEqual([a]);
  });
});
