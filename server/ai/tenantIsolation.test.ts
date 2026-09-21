import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiUsageEntry } from "../../shared/ai";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiPersonaRepository } from "./persona";
import { providerIdempotencyKey } from "./service";
import { createSecretBox } from "./security";
import { AiStore, emptyQuota, type AiSql, type StoredHarnessConfig } from "./storage";
import { aiTenantIdFromPrincipal, DEFAULT_AI_TENANT_ID, tenantStorageKey } from "./tenant";
import { AiVideoService } from "./videoService";
import { AiWorkspaceRepository } from "./workspace";

const workerWorkspaceModulePath = "../../cloudflare/src/ai/workspaceRoutes";
const { handleAiWorkspaceRequest } = await import(workerWorkspaceModulePath) as {
  handleAiWorkspaceRequest(request: Request, repository: AiWorkspaceRepository, user: { id: string; role: string; status: string }): Promise<Response>;
};

function adapter(database: DatabaseSync): AiSql {
  return {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T { database.exec("BEGIN IMMEDIATE"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
  };
}

const workspace = (content: string): AiWorkspaceState => ({
  view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, enabledSkillIds: [],
  activeConversationId: "conversation", activeProjectId: null,
  conversations: [{ id: "conversation", title: content, timeLabel: "刚刚", messages: [{ id: "message", role: "user", content, time: "10:00" }] }],
});

const usage = (reason: string): AiUsageEntry => ({
  id: "same-ledger-id", userId: "same-user", requestId: "same-request", kind: "chat", status: "completed",
  model: "model", mode: "quick", createdAt: "2026-09-21T00:00:00.000Z", reason,
  inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false, limitTokens: null, actorId: null,
});

const harness = (name: string): StoredHarnessConfig => ({
  providers: [{ id: "provider", name, baseUrl: "https://api.example.com/v1", protocol: "chat_completions", enabled: true, apiKeyConfigured: true, modelsVerified: false, availableModels: [], modelsVerifiedAt: null, encryptedKey: `encrypted-${name}`, configVersion: "config", keyVersion: "key" }],
  tiers: Object.fromEntries(["quick", "standard", "deep", "pro"].map(tier => [tier, { providerId: "provider", modelId: "model", protocol: "chat_completions", maxOutputTokens: 100, reasoningEffort: "", capabilities: ["chat"], enabled: true }])) as StoredHarnessConfig["tiers"],
  policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false }, updatedAt: "2026-09-21T00:00:00.000Z", migratedFromLegacy: false,
});

describe("AI tenant isolation foundation", () => {
  let database: DatabaseSync | undefined;
  afterEach(() => { database?.close(); database = undefined; });

  it("backfills legacy single-tenant rows into the deterministic default tenant", () => {
    database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE ai_quotas(user_id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE ai_usage(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL)");
    database.prepare("INSERT INTO ai_quotas(user_id,data) VALUES(?,?)").run("legacy-user", JSON.stringify({ ...emptyQuota(), limitTokens: 50 }));
    const legacyUsage = { ...usage("legacy"), id: "legacy-entry", userId: "legacy-user" };
    database.prepare("INSERT INTO ai_usage(id,user_id,created_at,data) VALUES(?,?,?,?)").run(legacyUsage.id, legacyUsage.userId, legacyUsage.createdAt, JSON.stringify(legacyUsage));
    const store = new AiStore(adapter(database));
    store.initialize();
    expect(store.tenantId).toBe(DEFAULT_AI_TENANT_ID);
    expect(store.quota("legacy-user").limitTokens).toBe(50);
    expect(store.usage("legacy-user")).toEqual([legacyUsage]);
    expect(database.prepare("SELECT DISTINCT tenant_id FROM ai_usage").all()).toEqual([{ tenant_id: DEFAULT_AI_TENANT_ID }]);
  });

  it("preserves legacy default video rows and capability URLs during the additive migration", async () => {
    database = new DatabaseSync(":memory:");
    database.exec("CREATE TABLE ai_settings(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE ai_video_jobs(user_id TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(user_id,id)); CREATE TABLE ai_video_references(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL,data TEXT NOT NULL)");
    database.prepare("INSERT INTO ai_settings(id,data) VALUES('video',?)").run(JSON.stringify({ enabled: true, quotaPoints: 321 }));
    const referenceId = "a".repeat(64);
    const box = await createSecretBox("tenant-video-isolation-test-secret-32-bytes");
    const dataUrl = "data:image/jpeg;base64,/9j/AAAA";
    database.prepare("INSERT INTO ai_video_references(id,user_id,expires_at,data) VALUES(?,?,?,?)").run(referenceId, "legacy-user", Date.now() + 60_000, JSON.stringify({ chunks: [await box.encrypt(dataUrl)] }));
    const store = new AiStore(adapter(database)); store.initialize();
    const video = new AiVideoService(store, async () => box, async () => new Response(null, { status: 500 }));
    expect(video.settings()).toMatchObject({ enabled: true, quotaPoints: 321 });
    expect(database.prepare("SELECT tenant_id,public_id FROM ai_video_references WHERE id=?").get(referenceId)).toEqual({ tenant_id: DEFAULT_AI_TENANT_ID, public_id: referenceId });
    expect((await video.referenceContent(referenceId)).status).toBe(200);
  });

  it("isolates colliding video settings, user/job/reference ids and administrator settlement across tenants", async () => {
    database = new DatabaseSync(":memory:");
    const sql = adapter(database);
    const alpha = new AiStore(sql, "tenant-alpha"), beta = new AiStore(sql, "tenant-beta");
    alpha.initialize();
    const box = await createSecretBox("tenant-video-isolation-test-secret-32-bytes");
    const transport = async () => { throw new Error("provider must not be called"); };
    const alphaVideo = new AiVideoService(alpha, async () => box, transport);
    const betaVideo = new AiVideoService(beta, async () => box, transport);
    await alphaVideo.configure({ enabled: true, quotaPoints: 1000, apiKey: "alpha-key" });
    await betaVideo.configure({ enabled: true, quotaPoints: 2000, apiKey: "beta-key" });
    expect(alphaVideo.settings().quotaPoints).toBe(1000);
    expect(betaVideo.settings().quotaPoints).toBe(2000);

    const userId = "same-user", jobId = "same-video-job-id", referenceId = "b".repeat(64);
    const now = new Date().toISOString();
    alpha.saveQuota(userId, { ...emptyQuota(), limitTokens: 5000, reservedTokens: 1000 });
    beta.saveQuota(userId, { ...emptyQuota(), limitTokens: 5000, reservedTokens: 2000 });
    const job = (quotaPoints: number, tenant: string) => ({
      id: jobId, userId, conversationId: "same-conversation", prompt: `${tenant} private`, seconds: 15, resolution: "768p", aspectRatio: "16:9",
      status: "uncertain", progress: 0, createdAt: now, updatedAt: now, quotaPoints, reserved: true, encryptedKey: "not-read", pollAt: 0,
    });
    sql.exec("INSERT INTO ai_video_jobs(user_id,id,tenant_id,data) VALUES(?,?,?,?)", tenantStorageKey(alpha.tenantId, userId), jobId, alpha.tenantId, JSON.stringify(job(1000, "alpha")));
    sql.exec("INSERT INTO ai_video_jobs(user_id,id,tenant_id,data) VALUES(?,?,?,?)", tenantStorageKey(beta.tenantId, userId), jobId, beta.tenantId, JSON.stringify(job(2000, "beta")));

    const alphaCapability = "c".repeat(64), betaCapability = "d".repeat(64);
    const reference = async (store: AiStore, publicId: string, marker: string) => {
      const dataUrl = `data:image/jpeg;base64,/9j/${marker}`;
      sql.exec("INSERT INTO ai_video_references(id,tenant_id,public_id,user_id,expires_at,data) VALUES(?,?,?,?,?,?)", tenantStorageKey(store.tenantId, referenceId), store.tenantId, publicId, tenantStorageKey(store.tenantId, userId), Date.now() + 60_000, JSON.stringify({ chunks: [await box.encrypt(dataUrl)], fingerprint: `sha256:${"0".repeat(64)}` }));
      return dataUrl;
    };
    const alphaData = await reference(alpha, alphaCapability, "AAAA"), betaData = await reference(beta, betaCapability, "BBBB");
    expect(sql.all("SELECT tenant_id FROM ai_video_references WHERE id IN (?,?) ORDER BY tenant_id", tenantStorageKey(alpha.tenantId, referenceId), tenantStorageKey(beta.tenantId, referenceId))).toEqual([{ tenant_id: alpha.tenantId }, { tenant_id: beta.tenantId }]);
    expect(Buffer.from(await (await alphaVideo.referenceContent(alphaCapability)).arrayBuffer()).toString("base64")).toBe(alphaData.split(",")[1]);
    expect(Buffer.from(await (await betaVideo.referenceContent(betaCapability)).arrayBuffer()).toString("base64")).toBe(betaData.split(",")[1]);

    expect(alphaVideo.adminPending()).toEqual([expect.objectContaining({ id: jobId, userId, quotaPoints: 1000 })]);
    expect(betaVideo.adminPending()).toEqual([expect.objectContaining({ id: jobId, userId, quotaPoints: 2000 })]);
    alphaVideo.reconcile(userId, jobId, "alpha-admin", { action: "release" });
    expect(alpha.quota(userId)).toMatchObject({ reservedTokens: 0, usedTokens: 0 });
    expect(beta.quota(userId)).toMatchObject({ reservedTokens: 2000, usedTokens: 0 });
    expect(alphaVideo.adminPending()).toEqual([]);
    expect(betaVideo.adminPending()).toHaveLength(1);
    expect(alpha.usage(userId)).toEqual([expect.objectContaining({ requestId: jobId, actorId: "alpha-admin", status: "failed" })]);
    expect(beta.usage(userId)).toEqual([]);
  });

  it("submits each tenant's colliding paid video job once while replaying duplicates without another provider call", async () => {
    database = new DatabaseSync(":memory:");
    const sql = adapter(database);
    const alpha = new AiStore(sql, "tenant-alpha"), beta = new AiStore(sql, "tenant-beta");
    alpha.initialize();
    const box = await createSecretBox("tenant-video-idempotency-test-secret-32-bytes");
    const transport = vi.fn(async () => Response.json({ id: "same-provider-task", status: "queued", progress: 0 }));
    const alphaVideo = new AiVideoService(alpha, async () => box, transport);
    const betaVideo = new AiVideoService(beta, async () => box, transport);
    for (const [store, video, points, key] of [[alpha, alphaVideo, 1000, "alpha-key"], [beta, betaVideo, 2000, "beta-key"]] as const) {
      await video.configure({ enabled: true, quotaPoints: points, apiKey: key });
      const settingId = tenantStorageKey(store.tenantId, "video");
      const row = sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE tenant_id=? AND id=?", store.tenantId, settingId)[0];
      const saved = JSON.parse(row.data);
      sql.exec("UPDATE ai_settings SET data=? WHERE tenant_id=? AND id=?", JSON.stringify({ ...saved, verifiedConfigVersion: saved.configVersion, verifiedKeyVersion: saved.keyVersion, verifiedModels: ["minimax_h3"] }), store.tenantId, settingId);
      store.saveQuota("same-user", { ...emptyQuota(), limitTokens: 5000 });
      store.saveRequest({
        requestId: "same-plan-request-id", userId: "same-user", hash: "same-plan", status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000,
        inputReserve: 0, outputReserve: 0, convertedReserve: 0, kind: "chat", model: "planner", mode: "quick",
        result: { requestId: "same-plan-request-id", content: "已整理", model: "planner", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "video", summary: "方案", prompt: "same prompt", videoParameters: { model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9", referenceCount: 0, referenceFingerprints: [] } } },
      });
    }
    const input = { requestId: "same-video-job-id", planRequestId: "same-plan-request-id", prompt: "same prompt", model: "minimax_h3", seconds: 15, resolution: "768p", aspectRatio: "16:9" };
    await alphaVideo.submit("same-user", input); await betaVideo.submit("same-user", input);
    await alphaVideo.submit("same-user", input); await betaVideo.submit("same-user", input);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(alphaVideo.list("same-user").jobs).toEqual([expect.objectContaining({ id: input.requestId, reserved: true })]);
    expect(betaVideo.list("same-user").jobs).toEqual([expect.objectContaining({ id: input.requestId, reserved: true })]);
    expect(alpha.quota("same-user")).toMatchObject({ reservedTokens: 1000, usedTokens: 0 });
    expect(beta.quota("same-user")).toMatchObject({ reservedTokens: 2000, usedTokens: 0 });
  });

  it("isolates workspaces, embedded conversations/messages, usage, harness config and run permissions even when ids collide", async () => {
    database = new DatabaseSync(":memory:");
    const sql = adapter(database);
    const alpha = new AiStore(sql, "tenant-alpha");
    const beta = new AiStore(sql, "tenant-beta");
    alpha.initialize();
    const repository = new AiWorkspaceRepository(sql); repository.initialize();
    const personas = new AiPersonaRepository(sql); personas.initialize();
    for (const store of [alpha, beta]) store.saveQuota("same-user", { ...emptyQuota(), limitTokens: 100 });

    const mutationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await repository.save("same-user", { expectedRevision: 0, mutationId, state: workspace("alpha secret") }, alpha.tenantId);
    await repository.save("same-user", { expectedRevision: 0, mutationId, state: workspace("beta secret") }, beta.tenantId);
    expect(repository.read("same-user", alpha.tenantId).state?.conversations[0].messages[0].content).toBe("alpha secret");
    expect(repository.read("same-user", beta.tenantId).state?.conversations[0].messages[0].content).toBe("beta secret");
    const authenticatedAlpha = { id: "same-user", role: "member", status: "active", tenant_id: alpha.tenantId };
    const spoofedHeader = await handleAiWorkspaceRequest(new Request("https://tongpin.example/api/ai/workspace", { headers: { "X-Tongpin-Tenant": beta.tenantId } }), repository, authenticatedAlpha);
    expect((await spoofedHeader.json() as { state: AiWorkspaceState }).state.conversations[0].messages[0].content).toBe("alpha secret");

    alpha.addUsage(usage("alpha usage")); beta.addUsage(usage("beta usage"));
    expect(alpha.usage().map(entry => entry.reason)).toEqual(["alpha usage"]);
    expect(beta.usage().map(entry => entry.reason)).toEqual(["beta usage"]);

    alpha.saveHarness(harness("alpha harness")); beta.saveHarness(harness("beta harness"));
    expect(alpha.harness()?.providers[0].name).toBe("alpha harness");
    expect(beta.harness()?.providers[0].name).toBe("beta harness");
    const run = { id: "same-run", requestId: "same-run-request", userId: "same-user", conversationId: "conversation", tier: "quick" as const, providerId: "provider", capability: "chat" as const, goalKind: "chat" as const, goalSummary: "完成当前对话任务。", status: "running" as const, reasoningSummary: "running", startedAt: 1, updatedAt: 1 };
    alpha.createHarnessRun(run, []); beta.createHarnessRun({ ...run, reasoningSummary: "beta running" }, []);
    expect(alpha.harnessRun("same-user", run.requestId)?.reasoningSummary).toBe("running");
    expect(beta.harnessRun("same-user", run.requestId)?.reasoningSummary).toBe("beta running");

    const profile = { name: "alpha", tone: "concise", customStyle: "", preferences: "private", onboardingComplete: true };
    personas.save("same-user", { expectedRevision: 0, profile }, alpha.tenantId);
    expect(personas.read("same-user", beta.tenantId).profile.name).not.toBe("alpha");
  });

  it("rejects invalid or conflicting authenticated tenant claims and never reads a request header", () => {
    expect(aiTenantIdFromPrincipal({ id: "user" })).toBe(DEFAULT_AI_TENANT_ID);
    expect(aiTenantIdFromPrincipal({ tenantId: "tenant-a", headers: { "X-Tongpin-Tenant": "tenant-b" } })).toBe("tenant-a");
    expect(() => aiTenantIdFromPrincipal({ tenantId: "tenant-a", org_id: "tenant-b" })).toThrow(expect.objectContaining({ code: "AI_TENANT_AMBIGUOUS" }));
    expect(() => aiTenantIdFromPrincipal({ tenantId: "../escape" })).toThrow(expect.objectContaining({ code: "AI_TENANT_INVALID" }));
  });

  it("partitions provider idempotency across tenant and operation boundaries", async () => {
    const alphaChat = await providerIdempotencyKey("tenant-alpha", "same-user", "same-request", "chat");
    const betaChat = await providerIdempotencyKey("tenant-beta", "same-user", "same-request", "chat");
    const alphaImage = await providerIdempotencyKey("tenant-alpha", "same-user", "same-request", "image");
    expect(alphaChat).toMatch(/^tongpin-[a-f0-9]{64}$/);
    expect(new Set([alphaChat, betaChat, alphaImage]).size).toBe(3);
  });
});
