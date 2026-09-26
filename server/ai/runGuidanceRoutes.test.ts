import express, { type NextFunction, type Request, type Response as ExpressResponse } from "express";
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessRunStatus } from "../../shared/ai";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import type { PublicUser } from "../types";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import { takePendingGuidance } from "./runGuidance";

const RUN = "3f9d1c52-0f5e-4a55-9a51-6f4c3a2b1d10";

describe("Node authenticated run-guidance routes", () => {
  let directory: string;
  let node: Awaited<ReturnType<typeof createNodeAi>>;
  let http: Server | undefined;
  const transport = vi.fn<AiTransport>();
  const headers = (userId = "member-a", tenantId = "tenant-alpha", account = userId) => ({
    "X-Test-User": userId, "X-Authenticated-Tenant": tenantId, "X-Tongpin-Account": account,
  });
  const url = (requestId = RUN, guidanceId?: string) => `/api/ai/requests/${requestId}/guidance${guidanceId ? `/${guidanceId}` : ""}`;
  const createRun = (tenantId: string, userId: string, requestId: string, status: AiHarnessRunStatus) => node.service.forTenant(tenantId).store.createHarnessRun({
    id: crypto.randomUUID(), requestId, userId, conversationId: "conversation-a", tier: "quick", providerId: "primary",
    capability: "presentation", goalKind: "presentation", goalSummary: "完成当前演示文稿任务。", status,
    reasoningSummary: "进行中", startedAt: 1, updatedAt: 1,
  }, []);

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-guidance-routes-"));
    transport.mockReset();
    node = await createNodeAi(path.join(directory, "fixture.json"), transport);
    for (const tenantId of ["tenant-alpha", "tenant-beta"]) {
      for (const userId of ["member-a", "member-b"]) node.service.forTenant(tenantId).setQuota(userId, "admin", { limitTokens: 20_000 });
    }
    const timestamp = new Date().toISOString();
    const users = { read: async <T,>(read: (value: { users: PublicUser[] }) => T) => read({ users: [] }) } as unknown as JsonStore;
    const requireAuth = (incoming: Request, _response: ExpressResponse, next: NextFunction) => {
      const id = incoming.get("X-Test-User") || "member-a";
      incoming.currentUser = {
        id, tenantId: incoming.get("X-Authenticated-Tenant") || "tenant-alpha", email: `${id}@example.com`, name: id,
        role: "member", status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0,
        emailVerifiedAt: timestamp, lastLoginAt: timestamp, createdAt: timestamp, updatedAt: timestamp, hasCustomAvatar: false,
      };
      next();
    };
    const app = express();
    app.use(express.json());
    app.use("/api/ai", createAiRouter(node.service, users, requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>));
    app.use((error: { status?: number; code?: string; message?: string }, _request: Request, response: ExpressResponse, _next: NextFunction) => {
      response.status(error.status ?? 500).json({ error: { code: error.code ?? "TEST_ROUTE_ERROR", message: error.message ?? "failed" } });
    });
    http = await listenLoopback(app);
  });

  afterEach(async () => { await closeServer(http); http = undefined; node.close(); await rm(directory, { recursive: true }); });

  it("stores, lists and withdraws guidance for the caller's own active run only", async () => {
    createRun("tenant-alpha", "member-a", RUN, "running");
    const posted = await request(http!).post(url()).set(headers()).send({ id: "guidance-route-000001", text: "第二页改成对比表" }).expect(200);
    expect(posted.body).toMatchObject({ created: true, guidance: { id: "guidance-route-000001", status: "pending" } });
    expect(JSON.stringify(posted.body)).not.toContain("对比表");
    await request(http!).post(url()).set(headers()).send({ id: "guidance-route-000001", text: "第二页改成对比表" }).expect(200)
      .then(response => expect(response.body.created).toBe(false));

    // The body can never choose the account or tenant.
    await request(http!).post(url()).set(headers()).send({ id: "guidance-route-000002", text: "越权", userId: "member-b", tenantId: "tenant-beta" }).expect(400);
    // Another member of the tenant, and the same member id in another tenant, see nothing.
    for (const [userId, tenantId] of [["member-b", "tenant-alpha"], ["member-a", "tenant-beta"]]) {
      await request(http!).post(url()).set(headers(userId, tenantId)).send({ id: "guidance-route-000003", text: "越权" }).expect(404)
        .then(response => expect(response.body.error.code).toBe("AI_RUN_NOT_FOUND"));
      await request(http!).get(url()).set(headers(userId, tenantId)).expect(200).then(response => expect(response.body.guidance).toEqual([]));
      await request(http!).delete(url(RUN, "guidance-route-000001")).set(headers(userId, tenantId)).expect(404);
    }
    // A header naming another account is rejected before any guidance route runs.
    await request(http!).post(url()).set(headers("member-a", "tenant-alpha", "member-b")).send({ id: "guidance-route-000004", text: "x" }).expect(409);

    const listed = await request(http!).get(url()).set(headers()).expect(200);
    expect(listed.body.guidance).toEqual([expect.objectContaining({ id: "guidance-route-000001", status: "pending" })]);
    await request(http!).delete(url(RUN, "guidance-route-000001")).set(headers()).expect(200)
      .then(response => expect(response.body.guidance.status).toBe("cancelled"));
    expect(takePendingGuidance(node.service.forTenant("tenant-alpha").store, "member-a", RUN)).toEqual([]);
  });

  it("validates input, the run state and the per-run bound", async () => {
    createRun("tenant-alpha", "member-a", RUN, "running");
    await request(http!).post(url("not-a-valid-id")).set(headers()).send({ id: "guidance-route-000001", text: "x" }).expect(400);
    await request(http!).post(url()).set(headers()).send({ id: "guidance-route-000001", text: "字".repeat(2001) }).expect(400)
      .then(response => expect(response.body.error.code).toBe("AI_GUIDANCE_INVALID"));
    await request(http!).post(url()).set(headers()).send({ id: "guidance-route-000001", text: " " }).expect(400);
    for (let index = 1; index <= 5; index += 1) await request(http!).post(url()).set(headers()).send({ id: `guidance-limit-00000${index}`, text: `第${index}条` }).expect(200);
    await request(http!).post(url()).set(headers()).send({ id: "guidance-limit-000006", text: "第6条" }).expect(409)
      .then(response => expect(response.body.error.code).toBe("AI_GUIDANCE_LIMIT"));
    takePendingGuidance(node.service.forTenant("tenant-alpha").store, "member-a", RUN);
    await request(http!).delete(url(RUN, "guidance-limit-000001")).set(headers()).expect(409)
      .then(response => expect(response.body.error.code).toBe("AI_GUIDANCE_DELIVERED"));

    const finished = "0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    createRun("tenant-alpha", "member-a", finished, "succeeded");
    await request(http!).post(url(finished)).set(headers()).send({ id: "guidance-late-0000001", text: "晚了" }).expect(409)
      .then(response => expect(response.body.error.code).toBe("AI_RUN_NOT_ACTIVE"));
    expect(transport).not.toHaveBeenCalled();
  });
});
