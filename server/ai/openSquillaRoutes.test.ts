import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_OPENSQUILLA_ROUTING } from "../../shared/aiOpenSquilla";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";
import type { PublicUser } from "../types";
import type { AiTransport } from "./provider";
import { createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";

const mapping = { enabled: true, applyPromptPolicy: false, tiers: { c0: "direct", c1: "search", c2: "reasoning", c3: "suggest_upgrade" } };
const defaults = { ...DEFAULT_OPENSQUILLA_ROUTING, updatedAt: null };

describe("OpenSquilla admin routes (Node)", () => {
  const transport = vi.fn<AiTransport>();
  let database: DatabaseSync;
  let http: Server | undefined;
  beforeEach(async () => {
    transport.mockReset();
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    const store = new AiStore(sql); store.initialize();
    const service = new AiService(store, () => createSecretBox("opensquilla-admin-route-secret-32-bytes"), transport);
    const users = { read: async <T>(read: (value: { users: PublicUser[] }) => T) => read({ users: [] }) } as unknown as JsonStore;
    const requireAuth = async (incoming: Request, _response: Response, next: NextFunction) => {
      incoming.currentUser = {
        id: "actor", email: "actor@example.test", name: "actor", role: incoming.get("X-Test-Role") || "admin", status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0,
        tenantId: incoming.get("X-Authenticated-Tenant") || "default",
      } as PublicUser;
      next();
    };
    const app = express(); app.use(express.json());
    app.use("/api/admin/ai", createAiRouter(service, users, requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>, true));
    http = await listenLoopback(app);
  });
  afterEach(async () => { await closeServer(http); http = undefined; database.close(); });

  it("reads defaults, saves a validated mapping per tenant and is admin-only", async () => {
    const alpha = { "X-Authenticated-Tenant": "tenant-alpha" };
    expect((await request(http!).get("/api/admin/ai/opensquilla").set(alpha).expect(200)).body).toEqual({ settings: defaults });
    const saved = await request(http!).put("/api/admin/ai/opensquilla").set(alpha).send(mapping).expect(200);
    expect(saved.body.settings).toMatchObject({ ...mapping, updatedAt: expect.any(String) });
    expect((await request(http!).get("/api/admin/ai/opensquilla").set(alpha).expect(200)).body.settings).toEqual(saved.body.settings);
    expect((await request(http!).get("/api/admin/ai/opensquilla").set({ "X-Authenticated-Tenant": "tenant-beta" }).expect(200)).body.settings).toEqual(defaults);
    const invalid = await request(http!).put("/api/admin/ai/opensquilla").set(alpha).send({ ...mapping, tiers: { ...mapping.tiers, c3: "pro" } }).expect(400);
    expect(invalid.body.error.code).toBe("AI_OPENSQUILLA_SETTINGS_INVALID");
    await request(http!).get("/api/admin/ai/opensquilla").set({ ...alpha, "X-Test-Role": "member" }).expect(403);
    await request(http!).put("/api/admin/ai/opensquilla").set({ ...alpha, "X-Test-Role": "member" }).send(mapping).expect(403);
    expect(transport).not.toHaveBeenCalled();
  });
});
