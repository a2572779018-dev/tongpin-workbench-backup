import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import { AiService } from "../../../server/ai/service";
import { createSecretBox } from "../../../server/ai/security";
import type { AiTransport } from "../../../server/ai/provider";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";
import { AiPersonaRepository } from "../../../server/ai/persona";
import { toolPlanContextFingerprint } from "../../../server/ai/toolPlans";

describe("Cloudflare AI route contract with shared transactional service", () => {
  let database: DatabaseSync;
  let store: AiStore;
  let service: AiService;
  let emptyToolPlanContextFingerprint: string;
  const transport = vi.fn<AiTransport>();
  const user = (id: string, role: UserRow["role"] = "member"): UserRow => ({ id, name: id, role, status: "active", email: `${id}@example.com`, password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0, avatar_data_url: null, email_verified_at: "2026-09-05T00:00:00Z", last_login_at: null, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" });
  const admin = user("admin", "admin"), a = user("a"), b = user("b"), boss = user("boss", "boss");
  const provider = { name: "Test", baseUrl: "https://provider.example.com", apiKey: "private-test-key", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true };
  const invoke = (path: string, method: string, actor = admin, body?: unknown, headers: Record<string, string> = {}) => handleAiRequest(new Request(`https://tongpin.example.com${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), service, actor, () => [admin, a, b, boss]);
  const saveToolPlan = (actor: UserRow, plan: { kind: "image"; prompt: string } | { kind: "video"; prompt: string; videoParameters: { model: string; seconds: number; resolution: string; aspectRatio: "16:9" | "9:16"; referenceCount: number; referenceFingerprints: string[] } }) => {
    const requestId = crypto.randomUUID();
    store.saveRequest({
      requestId, userId: actor.id, hash: `fixture-${requestId}`, status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
      inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "quick", mode: "quick",
      toolPlanContextFingerprint: emptyToolPlanContextFingerprint,
      result: {
        requestId, content: `已整理${plan.kind === "video" ? "视频" : "图片"}任务，请确认后生成。`, model: "quick",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false },
        toolPlan: { ...plan, summary: "测试工具方案" },
      },
    });
    return requestId;
  };
  beforeEach(async () => {
    emptyToolPlanContextFingerprint = await toolPlanContextFingerprint();
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    store = new AiStore(sql); store.initialize();
    new AiPersonaRepository(sql).initialize();
    transport.mockReset();
    transport.mockImplementation(async (_url, init) => init.method === "GET" ? Response.json({ data: [{ id: "quick" }] }) : Response.json({ output_text: "来自真实服务合同的测试回复", usage: { input_tokens: 12, output_tokens: 5, total_tokens: 17 } }));
    service = new AiService(store, () => createSecretBox("test-encryption-secret-with-at-least-32-bytes"), transport);
  });
  afterEach(() => { database.close(); });
  it("does not expose Dify tool capabilities from a member HTTP route", async () => {
    await service.saveProvider({ ...provider, imageModel: "fixture-image", imageQuotaTokens: 100 });
    service.setQuota("a", "admin", { limitTokens: 1000 });
    const planRequestId = saveToolPlan(a, { kind: "image", prompt: "one fixture image" });
    const planned = store.request("a", planRequestId)!;
    planned.conversationId = "cloudflare-conversation";
    planned.toolPlanExpiresAt = Date.now() + 600_000;
    store.saveRequest(planned);
    const approval = { planRequestId, requestId: crypto.randomUUID(), maxPoints: 100 };
    expect((await invoke("/api/ai/dify/grants", "POST", admin, approval)).status).toBe(403);
    expect((await invoke("/api/ai/dify/grants", "POST", a, approval, { "X-Tongpin-Account": "b" })).status).toBe(409);
    expect((await invoke("/api/ai/dify/grants", "POST", a, approval)).status).toBe(404);
    expect((await invoke("/api/ai/dify/grants", "GET", a)).status).toBe(404);
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps availability authenticated, account-bound, no-store and non-generating", async () => {
    expect((await invoke("/api/ai/availability", "GET", admin)).status).toBe(403);
    expect((await invoke("/api/ai/availability", "GET", { ...a, status: "disabled" } as UserRow)).status).toBe(401);
    expect((await invoke("/api/ai/availability", "GET", a, undefined, { "X-Tongpin-Account": "b" })).status).toBe(409);
    expect(transport).not.toHaveBeenCalled();
    await service.saveProvider(provider); service.setQuota("a", "admin", { limitTokens: 5000 });
    const response = await invoke("/api/ai/availability?target=chat", "GET", a);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ check: { state: "reachable" }, status: { quota: { usedTokens: 0 } } });
    expect(transport.mock.calls[0][1].method).toBe("GET");
    expect((await invoke("/api/ai/availability?target=invalid", "GET", a)).status).toBe(400);
    expect((await invoke("/api/ai/availability", "POST", a)).status).toBe(404);
  });
  it("keeps video configuration admin-only and jobs/content account-bound", async () => {
    const settings = { enabled: true, quotaPoints: 1000, apiKey: "fixture-video-only-key" };
    expect((await invoke("/api/admin/ai/video", "PUT", a, settings)).status).toBe(403);
    const saved = await invoke("/api/admin/ai/video", "PUT", admin, settings);
    expect(saved.status).toBe(200); expect(await saved.text()).not.toContain(settings.apiKey);
    transport.mockResolvedValueOnce(Response.json({ data: [{ id: "minimax_h3" }] }));
    const checked = await invoke("/api/admin/ai/video/test", "POST", admin);
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ availableModels: ["minimax_h3"] });
    const videoParameters = { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9" as const, referenceCount: 0, referenceFingerprints: [] };
    const request = { requestId: crypto.randomUUID(), prompt: "测试视频", seconds: 15, resolution: "768p", aspectRatio: "16:9", planRequestId: saveToolPlan(a, { kind: "video", prompt: "测试视频", videoParameters }) };
    expect((await invoke("/api/ai/videos", "POST", a, request)).status).toBe(403);
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 5000 });
    await invoke("/api/admin/ai/members/b/quota", "PUT", admin, { limitTokens: 5000 });
    transport.mockResolvedValue(Response.json({ id: "task_fixture_route_123", status: "completed", progress: 100 }));
    expect((await invoke("/api/ai/videos", "POST", a, request, { "X-Tongpin-Account": "b" })).status).toBe(409);
    expect((await invoke("/api/ai/videos", "POST", a, request)).status).toBe(200);
    expect((await invoke(`/api/ai/videos/${request.requestId}/content`, "GET", b)).status).toBe(404);
    expect((await invoke(`/api/admin/ai/videos/a/${request.requestId}/reconcile`, "POST", b, { action: "release" })).status).toBe(403);
    transport.mockResolvedValue(new Response("mp4-fixture", { headers: { "content-type": "video/mp4" } }));
    const content = await invoke(`/api/ai/videos/${request.requestId}/content`, "GET", a);
    expect(content.headers.get("cache-control")).toBe("no-store"); expect(await content.text()).toBe("mp4-fixture");
  });
  it("derives video scope from the authenticated Worker principal instead of a caller header", async () => {
    const alphaAdmin = { ...admin, tenant_id: "tenant-alpha" } as UserRow;
    const betaAdmin = { ...admin, tenant_id: "tenant-beta" } as UserRow;
    const settings = { enabled: true, quotaPoints: 1111, apiKey: "tenant-alpha-video-key" };
    const saved = await invoke("/api/admin/ai/video", "PUT", alphaAdmin, settings, { "X-Tongpin-Tenant": "tenant-beta" });
    expect(saved.status).toBe(200);
    expect(await (await invoke("/api/admin/ai/video", "GET", alphaAdmin)).json()).toMatchObject({ settings: { enabled: true, quotaPoints: 1111 } });
    expect(await (await invoke("/api/admin/ai/video", "GET", betaAdmin)).json()).toMatchObject({ settings: { enabled: false, quotaPoints: 0 }, pending: [] });
    expect(transport).not.toHaveBeenCalled();
  });
  it("enforces role boundaries before touching AI service", async () => {
    expect((await invoke("/api/admin/ai/provider", "GET", a)).status).toBe(403);
    expect((await invoke("/api/ai/status", "GET", admin)).status).toBe(403);
    expect((await invoke("/api/admin/ai/provider", "GET", boss)).status).toBe(403);
    expect(await (await invoke("/api/ai/status", "GET", boss)).json()).toMatchObject({ accessGranted: false, quota: { limitTokens: 0 } });
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps observability alerts tenant-scoped and acknowledges them without exposing request content", async () => {
    for (let index = 0; index < 4; index++) store.addObservability({
      userId: `private-member-${index}`, tier: "deep", providerId: "primary", capability: "presentation", operation: "planning", success: false, latencyMs: 65_000, errorCode: "AI_TOOL_PLAN_INVALID",
    });
    expect((await invoke("/api/admin/ai/observability", "GET", a)).status).toBe(403);
    const dashboardResponse = await invoke("/api/admin/ai/observability", "GET", admin);
    const dashboard = await dashboardResponse.json() as { alerts: Array<{ id: string; acknowledgedAt: string | null }>; alertHistory: unknown[] };
    expect(dashboard.alerts.length).toBeGreaterThan(0);
    expect(JSON.stringify(dashboard)).not.toContain("private-member");
    const alertId = dashboard.alerts[0].id;
    const acknowledged = await invoke(`/api/admin/ai/observability/alerts/${encodeURIComponent(alertId)}/acknowledge`, "PATCH", admin);
    expect(acknowledged.status).toBe(200);
    expect(await acknowledged.json()).toMatchObject({ alert: { id: alertId, acknowledgedAt: expect.any(String) } });

    const otherTenantAdmin = { ...admin, id: "other-admin", tenant_id: "other-tenant" } as UserRow;
    const hidden = await invoke(`/api/admin/ai/observability/alerts/${encodeURIComponent(alertId)}/acknowledge`, "PATCH", otherTenantAdmin);
    expect(hidden.status).toBe(404);
  });
  it("reports ungranted access and rejects forged ownership before generation, independently of provider configuration", async () => {
    expect(await (await invoke("/api/ai/status", "GET", a)).json()).toMatchObject({ accessGranted: false, configured: false });
    await invoke("/api/admin/ai/provider", "PUT", admin, provider);
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 5000 });
    await invoke("/api/admin/ai/members/b/quota", "PUT", admin, { limitTokens: 0 });
    expect(await (await invoke("/api/ai/status", "GET", b)).json()).toMatchObject({ accessGranted: false, configured: true });
    const chat = await invoke("/api/ai/chat", "POST", b, { userId: a.id, accessGranted: true, requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "不应发送" }] });
    expect(chat.status).toBe(403); expect(await chat.json()).toMatchObject({ error: { code: "AI_ACCESS_NOT_GRANTED" } });
    expect((await invoke("/api/ai/images", "POST", b, { requestId: crypto.randomUUID(), prompt: "不应生成", userId: a.id })).status).toBe(403);
    expect((await invoke("/api/ai/status", "GET", { ...a, status: "disabled" })).status).toBe(401);
    expect(transport).not.toHaveBeenCalled();
    expect(service.quota(a.id).usedTokens).toBe(0);
  });
  it("supports unsaved discovery and write-only provider configuration", async () => {
    const discovery = await invoke("/api/admin/ai/provider/test", "POST", admin, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
    expect(await discovery.json()).toMatchObject({ ok: true, models: ["quick"] });
    expect(service.provider()).toBeNull();
    const saved = await invoke("/api/admin/ai/provider", "PUT", admin, provider);
    const text = await saved.text();
    expect(text).toContain("apiKeyConfigured"); expect(text).not.toContain(provider.apiKey);
    expect(saved.headers.get("cache-control")).toBe("no-store");
  });
  it("lists member and boss identities without granting them quota or exposing password hashes", async () => {
    const response = await invoke("/api/admin/ai/members", "GET");
    const text = await response.text();
    expect(text).not.toContain("never-return-password");
    expect(JSON.parse(text).members.map((member: { id: string }) => member.id)).toEqual(["a", "b", "boss"]);
    expect(service.status(boss.id)).toMatchObject({ accessGranted: false, quota: { remainingTokens: 0 } });
    expect((await invoke("/api/admin/ai/members/admin/quota", "PUT", admin, { limitTokens: 5000 })).status).toBe(403);
  });
  it("uses per-member quotas and ignores caller-selected userId on member usage", async () => {
    await invoke("/api/admin/ai/provider", "PUT", admin, provider);
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 5000 });
    const reply = await invoke("/api/ai/chat", "POST", a, { requestId: "cloudflare-test-request", mode: "quick", messages: [{ role: "user", content: "你好" }] });
    expect(await reply.json()).toMatchObject({ usage: { totalTokens: 17 }, quota: { usedTokens: 17, remainingTokens: 4983 } });
    expect(await (await invoke("/api/ai/status", "GET", b)).json()).toMatchObject({ quota: { limitTokens: 0, usedTokens: 0 } });
    expect(await (await invoke("/api/ai/usage?userId=a", "GET", b)).json()).toEqual({ entries: [] });
  });
  it("returns and safely resumes only the authenticated member's persisted harness run", async () => {
    await invoke("/api/admin/ai/provider", "PUT", admin, provider);
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 5000 });
    const requestId = crypto.randomUUID();
    expect((await invoke("/api/ai/chat", "POST", a, { requestId, conversationId: "resume-route", mode: "quick", messages: [{ role: "user", content: "你好" }] })).status).toBe(200);
    const calls = transport.mock.calls.length;
    const trace = await (await invoke(`/api/ai/runs/${requestId}`, "GET", a)).json() as { trace: Record<string, unknown> };
    const resumed = await (await invoke(`/api/ai/runs/${requestId}/resume`, "POST", a)).json();
    expect(resumed).toEqual(trace);
    expect(trace.trace).toMatchObject({ strategy: "direct", status: "succeeded", nextAction: "none", toolBudget: { used: 0, max: 1, remaining: 1 } });
    expect((await invoke(`/api/ai/runs/${requestId}`, "GET", b)).status).toBe(404);
    expect((await invoke(`/api/ai/runs/${requestId}/resume`, "POST", admin)).status).toBe(403);
    expect(transport).toHaveBeenCalledTimes(calls);
  });
  it("bounds JSON bodies even without content-length headers", async () => {
    const response = await invoke("/api/admin/ai/provider", "PUT", admin, { apiKey: "x".repeat(800000) });
    expect(response.status).toBe(413);
    expect(transport).not.toHaveBeenCalled();
  });
  it("blocks configuring or testing the service itself", async () => {
    expect((await invoke("/api/admin/ai/provider", "PUT", admin, { ...provider, baseUrl: "https://tongpin.example.com" })).status).toBe(400);
    expect((await invoke("/api/admin/ai/provider/test", "POST", admin, { ...provider, baseUrl: "https://tongpin.example.com" })).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it("additive AI schema can initialize after a legacy migration has already completed", () => {
    database.exec("CREATE TABLE users(id TEXT); INSERT INTO users VALUES('existing-user'); CREATE TABLE _sql_schema_migrations(id INTEGER PRIMARY KEY); INSERT INTO _sql_schema_migrations VALUES(6);");
    store.initialize(); store.initialize();
    expect(database.prepare("SELECT id FROM users").get()).toMatchObject({ id: "existing-user" });
    service.setQuota("existing-user", "admin", { limitTokens: 5000 });
    expect(service.quota("existing-user").limitTokens).toBe(5000);
  });
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  it.each(["gateway", "permission", "unknown"])("persists sanitized %s 403 diagnostics without logout, quota loss or automatic replay", async kind => {
    await invoke("/api/admin/ai/provider", "PUT", admin, provider);
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 10000 });
    transport.mockResolvedValueOnce(kind === "gateway"
      ? new Response("<html>private-test-key private-prompt</html>", { status: 403, headers: { "cf-mitigated": "challenge", "cf-ray": "a37be7f308e2b9b6-HKG" } })
      : Response.json({ error: { ...(kind === "permission" ? { code: "permission_denied" } : {}), message: "private-test-key private-prompt" } }, { status: 403 }));
    const request = { requestId: crypto.randomUUID(), mode: "deep", messages: [{ role: "user", content: "private-prompt" }] };
    const response = await invoke("/api/ai/chat", "POST", a, request);
    expect(response.status).toBe(502);
    const failure = await response.json() as { error: { diagnostic: unknown } };
    expect(failure.error.diagnostic).toMatchObject({ operation: "chat", httpStatus: 403, category: kind === "gateway" ? "gateway_block" : kind === "permission" ? "permission" : "access_denied", billing: "rejected" });
    const ledger = await (await invoke("/api/admin/ai/usage?userId=a", "GET", admin)).text();
    expect(JSON.parse(ledger)).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ requestId: request.requestId, diagnostic: failure.error.diagnostic, totalTokens: 0, status: "failed" })]) });
    expect(JSON.stringify(failure) + ledger).not.toMatch(/private-test-key|private-prompt/);
    expect((await invoke(`/api/ai/requests/${request.requestId}`, "GET", b)).status).toBe(404);
    const restored = new AiService(store, () => createSecretBox("test-encryption-secret-with-at-least-32-bytes"), transport);
    await expect(restored.chat(a.id, request)).rejects.toMatchObject({ diagnostic: failure.error.diagnostic });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(service.quota(a.id)).toMatchObject({ usedTokens: 0, reservedTokens: 0, remainingTokens: 10000 });
  });
  it("exposes safe image failure metadata and preserves uncertain quota without replaying or leaking to another account", async () => {
    await invoke("/api/admin/ai/provider", "PUT", admin, { ...provider, imageModel: "gpt-image-2", imageQuotaTokens: 1000 });
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 10000 });
    transport.mockResolvedValueOnce(Response.json({ error: { code: "server_error", message: "private-test-key private-prompt" } }, { status: 502 }));
    const prompt = "私有图片";
    const request = { requestId: crypto.randomUUID(), prompt, planRequestId: saveToolPlan(a, { kind: "image", prompt }) };
    const failure = await invoke("/api/ai/images", "POST", a, request);
    expect(failure.status).toBe(502); expect(failure.headers.get("cache-control")).toBe("no-store");
    const body = await failure.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "AI_PROVIDER_UNAVAILABLE", diagnostic: { operation: "image", httpStatus: 502, billing: "unknown", code: "server_error" } } });
    expect(body).not.toMatch(/private-test-key|private-prompt/);
    expect(await (await invoke(`/api/ai/requests/${request.requestId}`, "GET", a)).json()).toMatchObject({ status: "uncertain", error: { diagnostic: { httpStatus: 502 } } });
    expect((await invoke(`/api/ai/requests/${request.requestId}`, "GET", b)).status).toBe(404);
    expect((await invoke(`/api/ai/requests/${request.requestId}`, "GET", a, undefined, { "X-Tongpin-Account": b.id })).status).toBe(409);
    await invoke("/api/ai/images", "POST", a, request);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(service.quota(a.id)).toMatchObject({ usedTokens: 1000, reservedTokens: 0 });
    expect(await (await invoke("/api/admin/ai/usage?userId=a", "GET", admin)).json()).toMatchObject({ entries: [expect.objectContaining({ diagnostic: { operation: "image", httpStatus: 502, category: "upstream_unavailable", billing: "unknown", code: "server_error", responseKind: "json" } }), expect.anything()] });
  });
  async function generateOwnedImage() {
    await invoke("/api/admin/ai/provider", "PUT", admin, { ...provider, imageModel: "image-model", imageQuotaTokens: 1000 });
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 10000 });
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const requestId = crypto.randomUUID();
    const prompt = "仅属于成员甲的图片";
    const response = await invoke("/api/ai/images", "POST", a, { requestId, prompt, planRequestId: saveToolPlan(a, { kind: "image", prompt }), userId: b.id }, { "X-Tongpin-Account": a.id });
    expect(response.status).toBe(200);
    const result = await response.json() as { images: Array<{ assetId: string }>; usage: { totalTokens: number } };
    return { assetId: result.images[0].assetId, requestId, result };
  }
  it("keeps generated assets and request recovery owner-only despite caller-selected user ids", async () => {
    const { assetId, requestId, result } = await generateOwnedImage();
    expect(result.usage.totalTokens).toBe(1000);
    expect(JSON.stringify(result)).not.toContain(PNG); expect(JSON.stringify(result)).not.toContain(provider.apiKey);
    expect(service.quota(b.id).usedTokens).toBe(0);
    const asset = await invoke(`/api/ai/assets/${assetId}`, "GET", a);
    expect(asset.headers.get("cache-control")).toBe("no-store");
    expect(await asset.json()).toMatchObject({ assetId, mimeType: "image/png", base64: PNG });
    const cached = await invoke(`/api/ai/requests/${requestId}`, "GET", a);
    expect(await cached.json()).toMatchObject({ status: "completed", imageResult: { images: [{ assetId }] } });
    for (const path of [`/api/ai/assets/${assetId}?userId=a`, `/api/ai/requests/${requestId}?userId=a`]) {
      const response = await invoke(path, "GET", b); expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(PNG);
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("prohibits administrators from personal generation, asset and request APIs", async () => {
    for (const actor of [admin]) {
      expect((await invoke("/api/ai/images", "POST", actor, { requestId: crypto.randomUUID(), prompt: "不应发出" })).status).toBe(403);
      expect((await invoke("/api/ai/assets/unknown", "GET", actor)).status).toBe(403);
      expect((await invoke("/api/ai/requests/unknown", "GET", actor)).status).toBe(403);
      expect((await invoke("/api/ai/assets/unknown", "DELETE", actor)).status).toBe(403);
    }
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires an explicit boss grant and isolates its conversations, assets and quota from members", async () => {
    const { assetId: memberAsset, requestId: memberRequest } = await generateOwnedImage();
    expect((await invoke("/api/ai/chat", "POST", boss, { requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "未开通" }] })).status).toBe(403);
    expect((await invoke("/api/admin/ai/members/boss/quota", "PUT", boss, { limitTokens: 10000 })).status).toBe(403);
    expect((await invoke("/api/admin/ai/members/boss/quota", "PUT", admin, { limitTokens: 10000 })).status).toBe(200);
    const requestId = crypto.randomUUID();
    const result = await invoke("/api/ai/chat", "POST", boss, { requestId, mode: "quick", messages: [{ role: "user", content: "老板自己的消息" }], userId: a.id });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ quota: { limitTokens: 10000, usedTokens: 17 } });
    expect(service.quota(a.id).usedTokens).toBe(1000);
    expect((await invoke(`/api/ai/requests/${requestId}`, "GET", boss)).status).toBe(200);
    expect((await invoke(`/api/ai/requests/${requestId}`, "GET", a)).status).toBe(404);
    expect((await invoke(`/api/ai/requests/${memberRequest}?userId=a`, "GET", boss)).status).toBe(404);
    expect((await invoke(`/api/ai/assets/${memberAsset}?userId=a`, "GET", boss)).status).toBe(404);
    expect((await invoke(`/api/ai/assets/${memberAsset}`, "DELETE", boss)).status).toBe(404);
    expect((await invoke("/api/ai/status", "GET", boss, undefined, { "X-Tongpin-Account": a.id })).status).toBe(409);
    expect((await invoke("/api/ai/status", "GET", { ...boss, status: "disabled" })).status).toBe(401);
  });
  it("preflights search locally and returns the same safe structured budget when an actual send is denied", async () => {
    await invoke("/api/admin/ai/provider", "PUT", admin, { ...provider, webSearchEnabled: true, webSearchQuotaTokens: 100 });
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 10000 });
    const body = { requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "你好" }], webSearch: true, userId: b.id };
    const checked = await invoke("/api/ai/preflight", "POST", a, body, { "X-Tongpin-Account": a.id });
    expect(checked.status).toBe(200); expect(checked.headers.get("cache-control")).toBe("no-store");
    const preflight = await checked.json();
    expect(preflight).toMatchObject({ canSend: false, reason: "search_quota_insufficient", quota: { remainingTokens: 10000 }, withoutWebSearch: { canSend: true } });
    const sent = await invoke("/api/ai/chat", "POST", a, body);
    expect(sent.status).toBe(402);
    expect(await sent.json()).toMatchObject({ error: { code: "AI_SEARCH_QUOTA_INSUFFICIENT", details: preflight } });
    expect((await invoke("/api/ai/preflight", "POST", a, body, { "X-Tongpin-Account": b.id })).status).toBe(409);
    expect((await invoke("/api/ai/preflight", "POST", b, body)).status).toBe(403);
    expect((await invoke("/api/ai/preflight", "POST", admin, body)).status).toBe(403);
    expect((await invoke("/api/ai/preflight", "POST", a, { ...body, mode: "forged" })).status).toBe(400);
    expect((await invoke("/api/ai/preflight", "POST", a, { ...body, extra: "x".repeat(1700 * 1024) })).status).toBe(413);
    expect(JSON.stringify(preflight)).not.toContain(provider.apiKey);
    expect(service.quota(a.id)).toMatchObject({ usedTokens: 0, reservedTokens: 0, remainingTokens: 10000 });
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["other-account", ""])("rejects changed or empty account binding %j before accessing tools or spending quota", async boundAccount => {
    const headers = { "X-Tongpin-Account": boundAccount };
    for (const [path, method] of [["/api/ai/images", "POST"], ["/api/ai/assets/unknown", "GET"], ["/api/ai/requests/unknown", "GET"], ["/api/ai/assets/unknown", "DELETE"]]) {
      const response = await invoke(path, method, a, method === "POST" ? { requestId: crypto.randomUUID(), prompt: "不能跨账号执行" } : undefined, headers);
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "AI_ACCOUNT_CHANGED" } });
    }
    expect(transport).not.toHaveBeenCalled(); expect(service.quota(a.id).usedTokens).toBe(0);
  });
  it("allows only the owner to remove an image and does not refund completed generation", async () => {
    const { assetId, requestId } = await generateOwnedImage();
    expect((await invoke(`/api/ai/assets/${assetId}`, "DELETE", b)).status).toBe(404);
    expect((await invoke(`/api/ai/assets/${assetId}`, "GET", a)).status).toBe(200);
    expect((await invoke(`/api/ai/assets/${assetId}`, "DELETE", a, undefined, { "X-Tongpin-Account": b.id })).status).toBe(409);
    expect((await invoke(`/api/ai/assets/${assetId}`, "DELETE", a)).status).toBe(200);
    expect((await invoke(`/api/ai/assets/${assetId}`, "GET", a)).status).toBe(404);
    expect(service.quota(a.id).usedTokens).toBe(1000);
    expect((await invoke(`/api/ai/requests/${requestId}`, "GET", a)).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("recovers completed text requests without exposing original prompts, secrets, or another member's result", async () => {
    await invoke("/api/admin/ai/provider", "PUT", admin, provider);
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 10000 });
    const requestId = crypto.randomUUID(); const prompt = "仅属于成员甲的私密测试输入";
    expect((await invoke("/api/ai/chat", "POST", a, { requestId, mode: "quick", messages: [{ role: "user", content: prompt }] })).status).toBe(200);
    const recovered = await invoke(`/api/ai/requests/${requestId}`, "GET", a);
    const text = await recovered.text(); expect(text).not.toContain(prompt); expect(text).not.toContain(provider.apiKey);
    expect(JSON.parse(text)).toMatchObject({ status: "completed", result: { usage: { totalTokens: 17 } } });
    expect((await invoke(`/api/ai/requests/${requestId}`, "GET", b)).status).toBe(404);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
