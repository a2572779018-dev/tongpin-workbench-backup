import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import type { PublicUser, User } from "../types";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";
import type { AiTransport } from "./provider";
import { createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";

describe("administrator quota grants", () => {
  let database: DatabaseSync;
  let store: AiStore;
  let service: AiService;
  let http: Server | undefined;
  const transport = vi.fn<AiTransport>();
  const account = (id: string, role: User["role"]) => ({
    id, email: `${id}@example.test`, name: id, role, status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0,
    avatarDataUrl: null, passwordHash: "never-used", emailVerifiedAt: null, lastLoginAt: null, createdAt: "2026-09-28T00:00:00Z", updatedAt: "2026-09-28T00:00:00Z",
  }) as User;

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    store = new AiStore(sql); store.initialize();
    service = new AiService(store, () => createSecretBox("quota-adjustment-route-secret-32-bytes"), transport);
    const users = { read: async <T>(read: (value: { users: User[] }) => T) => read({ users: [account("admin", "admin"), account("member-a", "member")] }) } as unknown as JsonStore;
    const requireAuth = async (incoming: Request, _response: Response, next: NextFunction) => {
      incoming.currentUser = { ...account("admin", "admin"), hasCustomAvatar: false } as unknown as PublicUser;
      next();
    };
    const app = express(); app.use(express.json());
    app.use("/api/admin/ai", createAiRouter(service, users, requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>, true));
    http = await listenLoopback(app);
  });
  afterEach(async () => { await closeServer(http); http = undefined; database.close(); });

  it("adds to the limit current at write time, so a stale snapshot cannot undo another grant", () => {
    service.setQuota("member-a", "admin", { limitTokens: 1000 });
    // Two administrators both saw 1,000 and each adds 500.
    expect(service.setQuota("member-a", "admin-1", { addTokens: 500 })).toMatchObject({ limitTokens: 1500, remainingTokens: 1500 });
    expect(service.setQuota("member-a", "admin-2", { addTokens: 500, reason: "季度追加" })).toMatchObject({ limitTokens: 2000, remainingTokens: 2000 });
    expect(store.usage("member-a").filter(entry => entry.kind === "quota").slice(0, 2)).toEqual([
      expect.objectContaining({ actorId: "admin-2", status: "adjusted", limitTokens: 2000, reason: "季度追加", totalTokens: 0 }),
      expect.objectContaining({ actorId: "admin-1", status: "adjusted", limitTokens: 1500, reason: "管理员追加额度", totalTokens: 0 }),
    ]);
    // The absolute form keeps working as before.
    expect(service.setQuota("member-a", "admin", { limitTokens: 1200 }).limitTokens).toBe(1200);
    expect(store.usage("member-a")[0]).toMatchObject({ limitTokens: 1200, reason: "管理员调整额度" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("validates an additive grant, including against the current limit, and writes nothing on rejection", () => {
    service.setQuota("member-a", "admin", { limitTokens: 1000 });
    for (const addTokens of [0, -5, 1.5, "500", null, 1_000_000_001]) {
      expect(() => service.setQuota("member-a", "admin", { addTokens })).toThrow(expect.objectContaining({ status: 400, code: "AI_QUOTA_INVALID" }));
    }
    expect(() => service.setQuota("member-a", "admin", { addTokens: 10, limitTokens: 10 })).toThrow(expect.objectContaining({ status: 400, code: "AI_QUOTA_INVALID" }));
    expect(() => service.setQuota("member-a", "admin", { addTokens: 999_999_001 })).toThrow(expect.objectContaining({ status: 400, code: "AI_QUOTA_INVALID" }));
    expect(service.quota("member-a").limitTokens).toBe(1000);
    expect(store.usage("member-a").filter(entry => entry.kind === "quota")).toHaveLength(1);
    expect(service.setQuota("member-a", "admin", { addTokens: 999_999_000 }).limitTokens).toBe(1_000_000_000);
  });

  it("accepts { addTokens } on the Node admin route", async () => {
    await request(http!).put("/api/admin/ai/members/member-a/quota").send({ limitTokens: 1000 }).expect(200);
    const added = await request(http!).put("/api/admin/ai/members/member-a/quota").send({ addTokens: 250, reason: "管理员追加额度" }).expect(200);
    expect(added.body.member).toMatchObject({ id: "member-a", quota: { limitTokens: 1250, remainingTokens: 1250 } });
    const rejected = await request(http!).put("/api/admin/ai/members/member-a/quota").send({ addTokens: 0 }).expect(400);
    expect(rejected.body.error.code).toBe("AI_QUOTA_INVALID");
    expect(service.quota("member-a").limitTokens).toBe(1250);
  });
});
