import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, type AppRuntime } from "../app";
import { loadConfig, type AppConfig } from "../config";
import { issueAccessToken } from "../security";
import { shanghaiDateKey } from "./time";
import type { User } from "../types";

function activeUser(
  id: string,
  role: User["role"],
  now: string,
): User {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    passwordHash: "unused",
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
  };
}

describe("LORA boss API permissions and daily claim persistence", () => {
  let temporaryRoot = "";
  let config: AppConfig;
  let runtime: AppRuntime;
  let bossToken = "";
  let memberToken = "";
  let adminToken = "";

  async function startRuntime() {
    const created = await createRuntime(config, {
      attachSockets: false,
      loraSource: {
        collect: async () => { throw new Error("fixed offline fixture"); },
      },
    });
    // Avoid supertest #894: wildcard listen(0) can overlap another macOS
    // loopback listener. Await an owned IPv4 server; close it before reopening.
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        created.server.once("error", onError);
        created.server.listen(0, "127.0.0.1", () => {
          created.server.off("error", onError);
          resolve();
        });
      });
      expect(created.server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
      return created;
    } catch (error) {
      await created.close();
      throw error;
    }
  }

  beforeAll(async () => {
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-api-"));
    config = loadConfig({
      dataFile: path.join(temporaryRoot, "database.json"),
      jwtSecret: "lora-dashboard-test-secret-over-thirty-two-characters",
      bootstrapAdminEmail: "admin-lora@example.com",
      bootstrapAdminPassword: "Admin123!",
      bootstrapAdminName: "LORA 管理员",
      isProduction: false,
      devEmailPreview: true,
    });
    runtime = await startRuntime();
    const now = new Date().toISOString();
    const boss = activeUser("10000000-0000-4000-8000-000000000001", "boss", now);
    const member = activeUser(
      "10000000-0000-4000-8000-000000000002",
      "member",
      now,
    );
    await runtime.store.mutate((database) => {
      database.users.push(boss, member);
    });
    const admin = await runtime.store.read((database) =>
      database.users.find((user) => user.role === "admin"),
    );
    expect(admin).toBeTruthy();
    bossToken = issueAccessToken(boss, config);
    memberToken = issueAccessToken(member, config);
    adminToken = issueAccessToken(admin!, config);
  });

  afterAll(async () => {
    await runtime.close();
    const resolved = path.resolve(temporaryRoot);
    if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error("拒绝清理非临时目录");
    }
    await rm(resolved, { recursive: true, force: true });
  });

  it("allows only the boss to read the dashboard", async () => {
    await request(runtime.server)
      .get("/api/boss/lora-chain/dashboard")
      .set("Authorization", `Bearer ${memberToken}`)
      .expect(403);
    const boss = await request(runtime.server)
      .get("/api/boss/lora-chain/dashboard")
      .set("Authorization", `Bearer ${bossToken}`)
      .expect(200);
    await request(runtime.server)
      .get("/api/boss/lora-chain/dashboard")
      .set("Authorization", `Bearer ${adminToken}`)
      .expect(403);
    expect(boss.body.timezone).toBe("Asia/Shanghai");
    expect(boss.body.nodes.todayCount).toBeNull();
  });

  it("atomically lets only one window/device claim the boss daily popup", async () => {
    const claims = await Promise.all(
      ["startup", "login", "reconnect", "08:00"].map((trigger) =>
        request(runtime.server)
          .post("/api/boss/lora-chain/daily-popup/claim")
          .set("Authorization", `Bearer ${bossToken}`)
          .send({ trigger })
          .expect(200),
      ),
    );
    expect(claims.filter((response) => response.body.shouldOpen)).toHaveLength(
      1,
    );
    expect(new Set(claims.map((response) => response.body.claimedAt)).size).toBe(
      1,
    );
    const persisted = await runtime.store.read(
      (database) => database.bossLoraReportOpens,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      bossUserId: "10000000-0000-4000-8000-000000000001",
      reportDate: shanghaiDateKey(),
    });
  });

  it("keeps manual access non-consuming and rejects the admin", async () => {
    const manual = await request(runtime.server)
      .post("/api/boss/lora-chain/daily-popup/claim")
      .set("Authorization", `Bearer ${bossToken}`)
      .send({ trigger: "manual" })
      .expect(200);
    await request(runtime.server)
      .post("/api/boss/lora-chain/daily-popup/claim")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ trigger: "startup" })
      .expect(403);
    expect(manual.body.shouldOpen).toBe(false);
    expect(
      await runtime.store.read(
        (database) => database.bossLoraReportOpens.length,
      ),
    ).toBe(1);
  });

  it("keeps the unique claim after service restart", async () => {
    await runtime.close();
    runtime = await startRuntime();
    const response = await request(runtime.server)
      .post("/api/boss/lora-chain/daily-popup/claim")
      .set("Authorization", `Bearer ${bossToken}`)
      .send({ trigger: "startup" })
      .expect(200);
    expect(response.body.shouldOpen).toBe(false);
    expect(
      await runtime.store.read(
        (database) => database.bossLoraReportOpens.length,
      ),
    ).toBe(1);
  });

  it("waits for manual refresh and returns the completed dashboard", async () => {
    const current = await request(runtime.server)
      .get("/api/boss/lora-chain/dashboard")
      .set("Authorization", `Bearer ${bossToken}`)
      .expect(200);
    const freshGeneratedAt = "2040-01-02T03:04:05.000Z";
    const freshDashboard = {
      ...current.body,
      generatedAt: freshGeneratedAt,
    };
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshSpy = vi
      .spyOn(runtime.loraCollector, "refresh")
      .mockImplementation(async () => {
        await refreshGate;
        return freshDashboard;
      });

    try {
      let settled = false;
      const pendingResponse = request(runtime.server)
        .post("/api/boss/lora-chain/refresh")
        .set("Authorization", `Bearer ${bossToken}`)
        .expect(200)
        .then((response) => {
          settled = true;
          return response;
        });
      for (
        let attempt = 0;
        attempt < 20 && !refreshSpy.mock.calls.length;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(refreshSpy).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      releaseRefresh();
      const response = await pendingResponse;
      expect(response.body).toMatchObject({
        accepted: true,
        dashboard: {
          reportDate: shanghaiDateKey(),
          generatedAt: freshGeneratedAt,
        },
      });
    } finally {
      releaseRefresh();
      refreshSpy.mockRestore();
    }
  });
});
