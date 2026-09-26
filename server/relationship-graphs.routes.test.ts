import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES } from "../shared/relationshipGraphMirror";
import { createRuntime, type AppRuntime } from "./app";
import { loadConfig } from "./config";
import { JsonStore } from "./store";
import { closeServer, listenLoopback } from "./testSupport/loopbackServer";
import type { User } from "./types";

const BOSS = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const QUIET_MEMBER = "33333333-3333-4333-8333-333333333333";
const OTHER_MEMBER = "44444444-4444-4444-8444-444444444444";
const OTHER_BOSS = "55555555-5555-4555-8555-555555555555";
const DISABLED_MEMBER = "66666666-6666-4666-8666-666666666666";
const PASSWORD = "Password123!";

function graph(label: string, extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: "1.0",
    title: "已合作客户脉络图",
    generatedAt: "2026-09-26T08:00:00.000Z",
    colorSemantics: { yellow: "核心", blue: "普通", pink: "关注", green: "新客户" },
    people: [
      { id: "self", name: "你", level: "self", avatar: null },
      { id: "wang", name: `${label}王总`, level: "core", phone: "13800000000", avatar: null },
    ],
    connections: [{ source: "self", target: "wang", relationship: "客户引荐", strength: 0.7 }],
    ...extra,
  };
}

function upload(value: unknown, localVersion = 1) {
  return {
    graph: value,
    localVersion,
    contentHash: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    updatedAt: "2026-09-26T08:00:00.000Z",
    avatarsOmitted: 0,
  };
}

describe("relationship graph mirror routes (Express)", () => {
  let runtime: AppRuntime;
  let http: Server;
  let root = "";
  const tokens: Record<string, string> = {};
  const config = () =>
    loadConfig({
      dataFile: path.join(root, "database.json"),
      jwtSecret: "relationship-graph-test-secret-with-32-characters",
      devEmailPreview: true,
      isProduction: false,
      bootstrapAdminEmail: "admin@example.com",
      bootstrapAdminPassword: "Admin123!",
      bootstrapAdminName: "管理员",
    });
  const auth = (name: string) => ({ Authorization: `Bearer ${tokens[name]}` });

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "tongpin-relationship-graphs-"));
    runtime = await createRuntime(config(), { attachSockets: false, startLoraCollector: false });
    http = await listenLoopback(runtime.app);
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const now = new Date().toISOString();
    const user = (
      id: string,
      email: string,
      name: string,
      role: User["role"],
      extra: Partial<User> = {},
    ): User => ({
      id,
      email,
      name,
      passwordHash,
      role,
      status: "active",
      jobTitle: "",
      avatarSeed: 0,
      avatarVersion: 0,
      avatarDataUrl: null,
      emailVerifiedAt: now,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    await runtime.store.mutate((database) => {
      database.users.push(
        user(BOSS, "boss@example.com", "老板", "boss"),
        user(MEMBER, "member@example.com", "小林", "member"),
        user(QUIET_MEMBER, "quiet@example.com", "阿周", "member"),
        user(OTHER_MEMBER, "other@example.com", "外部成员", "member", { tenantId: "acme" }),
        user(OTHER_BOSS, "otherboss@example.com", "外部老板", "boss", { tenantId: "acme" }),
        user(DISABLED_MEMBER, "gone@example.com", "已停用", "member", { status: "disabled" }),
      );
      database.relationshipGraphSnapshots.push({
        userId: DISABLED_MEMBER,
        tenantId: "default",
        localVersion: 1,
        contentHash: "f".repeat(64),
        updatedAt: now,
        syncedAt: now,
        contactCount: 1,
        connectionCount: 1,
        avatarsOmitted: 0,
        bytes: 2,
        graphJson: JSON.stringify(graph("停用")),
      });
    });
    for (const [name, email, password] of [
      ["boss", "boss@example.com", PASSWORD],
      ["member", "member@example.com", PASSWORD],
      ["quiet", "quiet@example.com", PASSWORD],
      ["other", "other@example.com", PASSWORD],
      ["otherBoss", "otherboss@example.com", PASSWORD],
      ["admin", "admin@example.com", "Admin123!"],
    ] as const) {
      tokens[name] = (
        await request(http).post("/api/auth/login").send({ email, password }).expect(200)
      ).body.accessToken;
    }
  });

  afterAll(async () => {
    await closeServer(http);
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  it("lets a member upload and the boss of the same organization list and read it", async () => {
    const put = await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .send(upload(graph("第一版"), 3))
      .expect(200);
    expect(put.headers["cache-control"]).toBe("no-store");
    expect(put.body.snapshot).toMatchObject({
      localVersion: 3,
      contactCount: 1,
      connectionCount: 1,
      avatarsOmitted: 0,
      updatedAt: "2026-09-26T08:00:00.000Z",
    });
    expect(Date.parse(put.body.snapshot.syncedAt)).not.toBeNaN();
    expect(put.body.snapshot).not.toHaveProperty("graph");

    const own = await request(http).get("/api/relationship-graphs/me").set(auth("member")).expect(200);
    expect(own.body.snapshot).toEqual(put.body.snapshot);

    const list = await request(http).get("/api/boss/relationship-graphs").set(auth("boss")).expect(200);
    expect(list.headers["cache-control"]).toBe("no-store");
    expect(list.body.members.map((item: { user: { id: string } }) => item.user.id).sort()).toEqual(
      [MEMBER, QUIET_MEMBER].sort(),
    );
    const listed = list.body.members.find((item: { user: { id: string } }) => item.user.id === MEMBER);
    expect(listed.snapshot).toEqual(put.body.snapshot);
    expect(listed.user).not.toHaveProperty("passwordHash");
    expect(list.body.members.find((item: { user: { id: string } }) => item.user.id === QUIET_MEMBER).snapshot).toBeNull();

    const detail = await request(http)
      .get(`/api/boss/relationship-graphs/${MEMBER}`)
      .set(auth("boss"))
      .expect(200);
    expect(detail.headers["cache-control"]).toBe("no-store");
    expect(detail.body.user).toMatchObject({ id: MEMBER, name: "小林" });
    expect(detail.body.snapshot).toEqual(put.body.snapshot);
    expect(detail.body.graph).toEqual(graph("第一版"));

    const unsynced = await request(http)
      .get(`/api/boss/relationship-graphs/${QUIET_MEMBER}`)
      .set(auth("boss"))
      .expect(404);
    expect(unsynced.body.error.code).toBe("RELATIONSHIP_GRAPH_NOT_SYNCED");
  });

  it("keeps only the latest snapshot and never rewrites identical content", async () => {
    await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .send(upload(graph("第二版"), 4))
      .expect(200);
    const before = await runtime.store.read((database) =>
      database.relationshipGraphSnapshots.filter((item) => item.userId === MEMBER),
    );
    expect(before).toHaveLength(1);
    expect(JSON.parse(before[0].graphJson)).toEqual(graph("第二版"));

    const repeated = await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .send(upload(graph("第二版"), 4))
      .expect(200);
    const after = await runtime.store.read((database) =>
      database.relationshipGraphSnapshots.filter((item) => item.userId === MEMBER),
    );
    expect(after).toHaveLength(1);
    expect(after[0].graphJson).toBe(before[0].graphJson);
    expect(repeated.body.snapshot.syncedAt >= before[0].syncedAt).toBe(true);

    const detail = await request(http)
      .get(`/api/boss/relationship-graphs/${MEMBER}`)
      .set(auth("boss"))
      .expect(200);
    expect(detail.body.graph).toEqual(graph("第二版"));
    // The member wrote only its own record.
    const quiet = await request(http).get("/api/relationship-graphs/me").set(auth("quiet")).expect(200);
    expect(quiet.body.snapshot).toBeNull();
  });

  it("isolates organizations, roles and disabled accounts", async () => {
    await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("other"))
      .send(upload(graph("外部"), 1))
      .expect(200);

    const otherList = await request(http)
      .get("/api/boss/relationship-graphs")
      .set(auth("otherBoss"))
      .expect(200);
    expect(otherList.body.members.map((item: { user: { id: string } }) => item.user.id)).toEqual([OTHER_MEMBER]);
    expect(
      (await request(http).get(`/api/boss/relationship-graphs/${MEMBER}`).set(auth("otherBoss")).expect(404)).body.error.code,
    ).toBe("USER_NOT_FOUND");
    expect(
      (await request(http).get(`/api/boss/relationship-graphs/${OTHER_MEMBER}`).set(auth("boss")).expect(404)).body.error.code,
    ).toBe("USER_NOT_FOUND");

    const ownList = await request(http).get("/api/boss/relationship-graphs").set(auth("boss")).expect(200);
    const ownIds = ownList.body.members.map((item: { user: { id: string } }) => item.user.id);
    expect(ownIds).not.toContain(OTHER_MEMBER);
    expect(ownIds).not.toContain(DISABLED_MEMBER);
    expect(ownIds).not.toContain(BOSS);
    expect(
      (await request(http).get(`/api/boss/relationship-graphs/${DISABLED_MEMBER}`).set(auth("boss")).expect(404)).body.error.code,
    ).toBe("USER_NOT_FOUND");

    for (const name of ["member", "admin"]) {
      await request(http).get("/api/boss/relationship-graphs").set(auth(name)).expect(403);
      await request(http).get(`/api/boss/relationship-graphs/${MEMBER}`).set(auth(name)).expect(403);
    }
    for (const name of ["boss", "admin"]) {
      await request(http).get("/api/relationship-graphs/me").set(auth(name)).expect(403);
      await request(http)
        .put("/api/relationship-graphs/me")
        .set(auth(name))
        .send(upload(graph("越权")))
        .expect(403);
    }
    await request(http).get("/api/boss/relationship-graphs").expect(401);
    await request(http).put("/api/relationship-graphs/me").send(upload(graph("匿名"))).expect(401);
    // There is no write route for the boss.
    await request(http)
      .put(`/api/boss/relationship-graphs/${MEMBER}`)
      .set(auth("boss"))
      .send(upload(graph("老板改写")))
      .expect(404);
    await request(http).get("/api/boss/relationship-graphs/not-a-member-id").set(auth("boss")).expect(404);

    const detail = await request(http)
      .get(`/api/boss/relationship-graphs/${MEMBER}`)
      .set(auth("boss"))
      .expect(200);
    expect(detail.body.graph).toEqual(graph("第二版"));
  });

  it("rejects oversized, malformed and tampered uploads without touching the stored copy", async () => {
    const oversizedBody = await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES + 70 * 1024) }))
      .expect(413);
    expect(oversizedBody.body.error.code).toBe("RELATIONSHIP_GRAPH_TOO_LARGE");

    const justOverCap = graph("超限", {
      people: [
        { id: "self", name: "你", level: "self" },
        { id: "big", name: "大客户", level: "core", note: "x".repeat(RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES) },
      ],
      connections: [],
    });
    const tooLarge = await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .send(upload(justOverCap, 9))
      .expect(413);
    expect(tooLarge.body.error.code).toBe("RELATIONSHIP_GRAPH_TOO_LARGE");

    const malformed = await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .set("Content-Type", "application/json")
      .send("{not json")
      .expect(400);
    expect(malformed.body.error.code).toBe("INVALID_JSON");

    const tampered = await request(http)
      .put("/api/relationship-graphs/me")
      .set(auth("member"))
      .send({ ...upload(graph("篡改"), 10), contentHash: "0".repeat(64) })
      .expect(400);
    expect(tampered.body.error.code).toBe("RELATIONSHIP_GRAPH_HASH_MISMATCH");

    const detail = await request(http)
      .get(`/api/boss/relationship-graphs/${MEMBER}`)
      .set(auth("boss"))
      .expect(200);
    expect(detail.body.graph).toEqual(graph("第二版"));
    expect(detail.body.snapshot.localVersion).toBe(4);
  });

  it("serves the same snapshot after the server restarts on the same data file", async () => {
    await closeServer(http);
    await runtime.close();
    runtime = await createRuntime(config(), { attachSockets: false, startLoraCollector: false });
    http = await listenLoopback(runtime.app);
    const detail = await request(http)
      .get(`/api/boss/relationship-graphs/${MEMBER}`)
      .set(auth("boss"))
      .expect(200);
    expect(detail.body.graph).toEqual(graph("第二版"));
  });
});

describe("JsonStore migration for the relationship graph mirror", () => {
  it("adds the snapshot list to a 0.1.48 (version 6) data file without a version bump", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-relationship-store-"));
    try {
      const dataFile = path.join(root, "tongpin.json");
      await writeFile(
        dataFile,
        JSON.stringify({
          version: 6,
          users: [],
          tasks: [],
          verificationCodes: [],
          refreshSessions: [],
          notifications: [],
          contacts: [],
          directMessages: [],
          taskRolloverDecisions: [],
          taskAuditEvents: [],
          bossWorkReportStatuses: [],
        }),
        "utf8",
      );
      const store = await JsonStore.open(dataFile);
      expect(await store.read((database) => database.relationshipGraphSnapshots)).toEqual([]);
      const persisted = JSON.parse(await readFile(dataFile, "utf8")) as Record<string, unknown>;
      // Same version keeps a rolled-back server able to open (and preserve) the file.
      expect(persisted.version).toBe(6);
      expect(persisted.relationshipGraphSnapshots).toEqual([]);

      await store.mutate((database) => {
        database.relationshipGraphSnapshots.push({
          userId: MEMBER,
          tenantId: "default",
          localVersion: 2,
          contentHash: "a".repeat(64),
          updatedAt: "2026-09-26T08:00:00.000Z",
          syncedAt: "2026-09-26T08:00:01.000Z",
          contactCount: 1,
          connectionCount: 1,
          avatarsOmitted: 0,
          bytes: 10,
          graphJson: JSON.stringify(graph("迁移")),
        });
      });
      const reopened = await JsonStore.open(dataFile);
      const records = await reopened.read((database) => database.relationshipGraphSnapshots);
      expect(records).toHaveLength(1);
      expect(JSON.parse(records[0].graphJson)).toEqual(graph("迁移"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
