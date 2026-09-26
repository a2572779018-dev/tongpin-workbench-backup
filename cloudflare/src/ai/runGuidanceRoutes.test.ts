import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessRunStatus } from "../../../shared/ai";
import { createSecretBox } from "../../../server/ai/security";
import { AiService } from "../../../server/ai/service";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import type { AiTransport } from "../../../server/ai/provider";
import { takePendingGuidance } from "../../../server/ai/runGuidance";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";

const RUN = "3f9d1c52-0f5e-4a55-9a51-6f4c3a2b1d10";

describe("Cloudflare authenticated run-guidance routes", () => {
  let database: DatabaseSync;
  let service: AiService;
  const transport = vi.fn<AiTransport>();
  const principal = (id = "member-a", tenantId = "tenant-alpha", role = "member") => ({
    id, tenant_id: tenantId, name: id, role, status: "active", email: `${id}@example.com`,
    password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0,
    avatar_data_url: null, email_verified_at: "2026-09-26T00:00:00Z", last_login_at: null,
    created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z",
  } as UserRow);
  const invoke = async (path: string, method: string, actor = principal(), body?: unknown) => {
    const response = await handleAiRequest(new Request(`https://tongpin.example.com${path}`, {
      method,
      // A spoofed tenant header must never select the storage scope.
      headers: { "X-Tongpin-Account": actor.id, "X-Tongpin-Tenant": "tenant-spoofed", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), service, actor, () => [actor]);
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const url = (requestId = RUN, guidanceId?: string) => `/api/ai/requests/${requestId}/guidance${guidanceId ? `/${guidanceId}` : ""}`;
  const createRun = (tenantId: string, userId: string, requestId: string, status: AiHarnessRunStatus) => service.forTenant(tenantId).store.createHarnessRun({
    id: crypto.randomUUID(), requestId, userId, conversationId: "conversation-a", tier: "quick", providerId: "primary",
    capability: "presentation", goalKind: "presentation", goalSummary: "完成当前演示文稿任务。", status,
    reasoningSummary: "进行中", startedAt: 1, updatedAt: 1,
  }, []);

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T {
        database.exec("BEGIN");
        try { const result = action(); database.exec("COMMIT"); return result; }
        catch (error) { database.exec("ROLLBACK"); throw error; }
      },
    };
    const store = new AiStore(sql); store.initialize();
    transport.mockReset();
    service = new AiService(store, () => createSecretBox("worker-guidance-route-fixture-secret-at-least-32-bytes"), transport);
    for (const tenantId of ["tenant-alpha", "tenant-beta"]) for (const userId of ["member-a", "member-b"]) service.forTenant(tenantId).setQuota(userId, "admin", { limitTokens: 20_000 });
  });
  afterEach(() => database.close());

  it("mirrors the Express contract with principal-owned tenant and member scope", async () => {
    createRun("tenant-alpha", "member-a", RUN, "running");
    const posted = await invoke(url(), "POST", principal(), { id: "guidance-worker-00001", text: "只保留三页" });
    expect(posted).toMatchObject({ status: 200, body: { created: true, guidance: { id: "guidance-worker-00001", status: "pending" } } });
    expect(JSON.stringify(posted.body)).not.toContain("三页");
    expect((await invoke(url(), "POST", principal(), { id: "guidance-worker-00002", text: "越权", tenantId: "tenant-beta" })).status).toBe(400);

    for (const actor of [principal("member-b"), principal("member-a", "tenant-beta")]) {
      expect(await invoke(url(), "POST", actor, { id: "guidance-worker-00003", text: "越权" })).toMatchObject({ status: 404, body: { error: { code: "AI_RUN_NOT_FOUND" } } });
      expect(await invoke(url(), "GET", actor)).toMatchObject({ status: 200, body: { guidance: [] } });
      expect((await invoke(url(RUN, "guidance-worker-00001"), "DELETE", actor)).status).toBe(404);
    }
    expect((await invoke(url(), "POST", principal("admin-a", "tenant-alpha", "admin"), { id: "guidance-worker-00004", text: "x" })).status).toBe(403);

    expect(await invoke(url(), "GET")).toMatchObject({ status: 200, body: { guidance: [{ id: "guidance-worker-00001", status: "pending" }] } });
    expect(takePendingGuidance(service.forTenant("tenant-alpha").store, "member-a", RUN)).toEqual([{ id: "guidance-worker-00001", text: "只保留三页" }]);
    expect(await invoke(url(RUN, "guidance-worker-00001"), "DELETE")).toMatchObject({ status: 409, body: { error: { code: "AI_GUIDANCE_DELIVERED" } } });
    expect((await invoke(url(), "PUT", principal(), { id: "guidance-worker-00005", text: "x" })).status).toBe(404);
    expect(await invoke(url("not-a-valid-id"), "POST", principal(), { id: "guidance-worker-00006", text: "x" })).toMatchObject({ status: 400 });
    expect(transport).not.toHaveBeenCalled();
  });
});
