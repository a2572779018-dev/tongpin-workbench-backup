import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRuntime, type AppRuntime } from "./app";
import { businessDateKey } from "./business-date";
import { loadConfig } from "./config";

describe("boss work report routes", () => {
  let runtime: AppRuntime;
  let root = "";
  let bossToken = "";
  let memberToken = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "tongpin-work-report-"));
    runtime = await createRuntime(
      loadConfig({
        dataFile: path.join(root, "database.json"),
        jwtSecret: "work-report-test-secret-with-thirty-two-characters",
        devEmailPreview: true,
        isProduction: false,
        bootstrapAdminEmail: "admin@example.com",
        bootstrapAdminPassword: "Admin123!",
        bootstrapAdminName: "管理员",
      }),
      { attachSockets: false, startLoraCollector: false },
    );
    const passwordHash = await bcrypt.hash("Password123!", 4);
    const now = new Date().toISOString();
    await runtime.store.mutate((database) => {
      database.users.push(
        {
          id: "11111111-1111-4111-8111-111111111111",
          email: "boss@example.com",
          name: "老板",
          passwordHash,
          role: "boss",
          status: "active",
          jobTitle: "老板",
          avatarSeed: 0,
          avatarVersion: 0,
          avatarDataUrl: null,
          emailVerifiedAt: now,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          email: "member@example.com",
          name: "小林",
          passwordHash,
          role: "member",
          status: "active",
          jobTitle: "成员",
          avatarSeed: 1,
          avatarVersion: 0,
          avatarDataUrl: null,
          emailVerifiedAt: now,
          lastLoginAt: null,
          createdAt: now,
          updatedAt: now,
        },
      );
    });
    bossToken = (
      await request(runtime.app)
        .post("/api/auth/login")
        .send({ email: "boss@example.com", password: "Password123!" })
        .expect(200)
    ).body.accessToken;
    memberToken = (
      await request(runtime.app)
        .post("/api/auth/login")
        .send({ email: "member@example.com", password: "Password123!" })
        .expect(200)
    ).body.accessToken;
  });

  afterAll(async () => {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  });

  it("rejects members and lets only one boss device claim the day", async () => {
    await request(runtime.app)
      .post("/api/boss/work-reports/claim")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ trigger: "startup" })
      .expect(403);

    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        request(runtime.app)
          .post("/api/boss/work-reports/claim")
          .set("Authorization", `Bearer ${bossToken}`)
          .send({ trigger: "startup" })
          .expect(200),
      ),
    );
    expect(claims.filter((result) => result.body.shouldOpen)).toHaveLength(1);
    expect(claims[0].body.report.reportDate).toBe(businessDateKey());
    expect(claims[0].body.report.status.openedAt).toBeTruthy();
  });

  it("keeps a closed report pending until it is explicitly read", async () => {
    const dismissed = await request(runtime.app)
      .patch("/api/boss/work-reports/current/dismiss")
      .set("Authorization", `Bearer ${bossToken}`)
      .expect(200);
    expect(dismissed.body.report.status.dismissedAt).toBeTruthy();
    expect(dismissed.body.report.status.readAt).toBeNull();

    const pending = await request(runtime.app)
      .get("/api/boss/work-reports/current")
      .set("Authorization", `Bearer ${bossToken}`)
      .expect(200);
    expect(pending.body.report.status.readAt).toBeNull();

    const read = await request(runtime.app)
      .patch("/api/boss/work-reports/current/read")
      .set("Authorization", `Bearer ${bossToken}`)
      .expect(200);
    expect(read.body.report.status.readAt).toBeTruthy();

    const claimedAgain = await request(runtime.app)
      .post("/api/boss/work-reports/claim")
      .set("Authorization", `Bearer ${bossToken}`)
      .send({ trigger: "reconnect" })
      .expect(200);
    expect(claimedAgain.body.shouldOpen).toBe(false);
  });

  it("lets the boss send a strong reminder to one active member", async () => {
    await request(runtime.app)
      .post("/api/boss/work-reports/nudge")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ userId: "22222222-2222-4222-8222-222222222222" })
      .expect(403);

    const nudged = await request(runtime.app)
      .post("/api/boss/work-reports/nudge")
      .set("Authorization", `Bearer ${bossToken}`)
      .send({ userId: "22222222-2222-4222-8222-222222222222" })
      .expect(201);
    expect(nudged.body.notification).toMatchObject({
      recipientId: "22222222-2222-4222-8222-222222222222",
      title: "老板提醒您",
      body: "昨日任务不要忘记完成哦",
      requiresAcknowledgement: true,
    });

    const inbox = await request(runtime.app)
      .get("/api/notifications")
      .set("Authorization", `Bearer ${memberToken}`)
      .expect(200);
    expect(inbox.body.notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: nudged.body.notification.id }),
      ]),
    );
  });
});
