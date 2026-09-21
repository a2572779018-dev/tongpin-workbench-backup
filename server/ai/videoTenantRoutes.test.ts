import express, { type NextFunction, type Request, type Response } from "express";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import type { PublicUser } from "../types";
import { createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";
import type { AiTransport } from "./provider";

describe("Node video routes use the authenticated AI tenant", () => {
  let database: DatabaseSync;
  let app: express.Express;
  const transport = vi.fn<AiTransport>();

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    const store = new AiStore(sql); store.initialize();
    const service = new AiService(store, () => createSecretBox("node-tenant-video-route-secret-32-bytes"), transport);
    const users = { read: async <T>(read: (value: { users: PublicUser[] }) => T) => read({ users: [] }) } as unknown as JsonStore;
    const requireAuth = async (incoming: Request, _response: Response, next: NextFunction) => {
      incoming.currentUser = {
        id: "same-admin", email: "admin@example.test", name: "admin", role: "admin", status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0,
        tenantId: incoming.get("X-Authenticated-Tenant") || "default",
      } as PublicUser;
      next();
    };
    app = express(); app.use(express.json());
    app.use("/api/admin/ai", createAiRouter(service, users, requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>, true));
  });

  afterEach(() => database.close());

  it("accepts non-default tenants, isolates their video settings and ignores a tenant header", async () => {
    const account = { "X-Tongpin-Account": "same-admin" };
    await request(app).put("/api/admin/ai/video")
      .set({ ...account, "X-Authenticated-Tenant": "tenant-alpha", "X-Tongpin-Tenant": "tenant-beta" })
      .send({ enabled: true, quotaPoints: 777, apiKey: "alpha-video-key" }).expect(200);
    const alpha = await request(app).get("/api/admin/ai/video").set({ ...account, "X-Authenticated-Tenant": "tenant-alpha" }).expect(200);
    const beta = await request(app).get("/api/admin/ai/video").set({ ...account, "X-Authenticated-Tenant": "tenant-beta" }).expect(200);
    expect(alpha.body.settings).toMatchObject({ enabled: true, quotaPoints: 777 });
    expect(beta.body).toMatchObject({ settings: { enabled: false, quotaPoints: 0 }, pending: [] });
    expect(transport).not.toHaveBeenCalled();
  });
});
