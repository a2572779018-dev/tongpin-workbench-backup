import express from "express";
import type { Server } from "node:http";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import { createDifyToolResponse, type DifyRouteOptions } from "./difyRuntimeRoutes";
import { DifySqlToolCallStore, DifyToolRuntime } from "./difyRuntime";
import { DifyEngineAdapter } from "./difyEngine";
import { toolPlanContextFingerprint } from "./toolPlans";
import { AiWorkspaceRepository } from "./workspace";
import type { AiTransport } from "./provider";
import type { AiUsageEntry } from "../../shared/ai";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SERVICE_SECRET = "local-dify-test-service-credential-32-bytes";
describe.sequential("Dify callback HTTP routes with real isolated SQLite and simulated providers", () => {
  let directory: string, file: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  let app: express.Express;
  let http: Server | undefined;
  const transport = vi.fn<AiTransport>();
  let options: DifyRouteOptions;
  let fingerprint: string;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-dify-routes-")); file = path.join(directory, "data.json");
    transport.mockReset(); transport.mockResolvedValue(Response.json({ data: [{ b64_json: PNG }] }));
    runtime = await createNodeAi(file, async (...args) => transport(...args));
    new AiWorkspaceRepository(runtime.store.sql).initialize();
    fingerprint = await toolPlanContextFingerprint();
    await runtime.service.saveProvider({ name: "fixture", baseUrl: "https://provider.example.com", apiKey: "fixture-not-real", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true, imageModel: "fixture-image", imageQuotaTokens: 100 });
    runtime.service.setQuota("member-a", "admin", { limitTokens: 10_000 });
    runtime.service.setQuota("member-b", "admin", { limitTokens: 10_000 });
    options = { config: { enabled: true, appId: "local-test-app" }, serviceSecret: SERVICE_SECRET, principalActive: (tenant, user) => tenant === "default" && ["member-a", "member-b"].includes(user) };
    app = express(); app.use(express.json());
    app.post("/invoke", async (req, res) => {
      const response = await createDifyToolResponse(runtime.service, new Request("http://localhost/api/dify/tools/invoke", { method: "POST", headers: { Authorization: req.headers.authorization ?? "", "X-Dify-Tool-Secret": String(req.headers["x-dify-tool-secret"] ?? "") }, body: JSON.stringify(req.body) }), options);
      res.status(response.status).json(await response.json());
    });
    http = await listenLoopback(app);
  });
  afterEach(async () => { await closeServer(http); http = undefined; vi.restoreAllMocks(); runtime.close(); await rm(directory, { recursive: true, force: true }); });
  function plan(userId = "member-a", kind: "image" | "video" = "image") {
    const requestId = crypto.randomUUID();
    runtime.store.saveRequest({ requestId, userId, conversationId: "conversation-a", hash: "fixture", kind: "chat", status: "completed", model: "quick", mode: "quick", inputReserve: 0, outputReserve: 0, createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000, toolPlanExpiresAt: Date.now() + 600_000, toolPlanContextFingerprint: fingerprint,
      result: { requestId, content: "Fixture saved plan", model: "quick", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind, summary: "fixture", prompt: "one test image", ...(kind === "video" ? { videoParameters: { model: "minimax_h3", seconds: 6, resolution: "768p", aspectRatio: "9:16", referenceCount: 0, referenceFingerprints: [] } } : {}) } } });
    return requestId;
  }
  const issueGrant = (value: unknown, userId = "member-a") => new DifyToolRuntime(runtime.service, options.config, options.principalActive).issueGrant({ tenantId: "default", userId }, value);
  const grant = (planRequestId = plan()) => issueGrant({ planRequestId, requestId: crypto.randomUUID(), maxPoints: 100 });
  function invoke(approved: Awaited<ReturnType<typeof grant>>, overrides: Record<string, unknown> = {}) {
    const { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds } = approved.claims;
    return request(http!).post("/invoke").set("Authorization", `Bearer ${approved.authorization}`).set("X-Dify-Tool-Secret", SERVICE_SECRET).send({ tenantId, userId, conversationId, runId, attemptId, sourceAssetIds, toolCallId: `call-${attemptId}`, toolName: "image.generate", input: approved.input, ...overrides });
  }
  it("fails closed without runtime config or active-account verifier and rejects missing callback auth", async () => {
    options = {};
    await expect(grant()).rejects.toMatchObject({ status: 503, code: "DIFY_RUNTIME_DISABLED" });
    await request(http!).post("/invoke").send({}).expect(503);
    expect(transport).not.toHaveBeenCalled();
  });
  it("requires both the plugin service credential and an approved per-run grant", async () => {
    const approved = await grant();
    expect(approved.toolBinding).toEqual({ approvedRequestId: approved.input.requestId, sourceAssetIds: approved.claims.sourceAssetIds });
    const { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds } = approved.claims;
    const callback = { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds, toolCallId: `call-${attemptId}`, toolName: "image.generate", input: approved.input };
    const post = () => request(http!).post("/invoke").set("Authorization", `Bearer ${approved.authorization}`).send(callback);
    expect((await post().expect(401)).body.error.code).toBe("DIFY_TOOL_AUTH_INVALID");
    expect((await post().set("X-Dify-Tool-Secret", "wrong-service-credential-32-characters").expect(401)).body.error.code).toBe("DIFY_TOOL_AUTH_INVALID");
    expect((await request(http!).post("/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).send(callback).expect(401)).body.error.code).toBe("DIFY_TOOL_AUTH_INVALID");
    expect((await request(http!).post("/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).set("Authorization", `Bearer ${"a".repeat(64)}`).send(callback).expect(403)).body.error.code).toMatch(/^DIFY_TOOL_AUTH_/);
    expect(transport).not.toHaveBeenCalled();
  });
  it("delivers the saved approval binding to Dify app inputs without placing it in the model query", async () => {
    const approved = await grant();
    let sent: Record<string, unknown> | undefined;
    const ids = { task_id: "remote-task", message_id: "remote-message", conversation_id: "remote-conversation" };
    const events = [
      { event: "message", ...ids, answer: "done" },
      { event: "message_end", ...ids },
    ];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const claims = approved.claims;
    await new DifyEngineAdapter({ baseUrl: "http://127.0.0.1:8080", apiKey: "fixture-app-key", fetchImpl }).run({
      tenantId: claims.tenantId, userId: claims.userId, conversationId: claims.conversationId,
      runId: claims.runId, attemptId: claims.attemptId, query: "已批准的测试任务",
      toolAuthorization: approved.authorization, ...approved.toolBinding,
    });
    expect(sent?.inputs).toMatchObject({
      tongpin_request_id: approved.input.requestId,
      tongpin_source_asset_ids_json: "[]",
      tongpin_tool_authorization: approved.authorization,
    });
    expect(sent?.query).toBe("已批准的测试任务");
    expect(JSON.stringify(sent?.query)).not.toContain(approved.authorization);
    expect(JSON.stringify(sent?.query)).not.toContain(approved.input.requestId);
    expect(transport).not.toHaveBeenCalled();
  });
  it("executes the existing image service once and replays its real ledger after reopening SQLite", async () => {
    const approved = await grant();
    const first = await invoke(approved).expect(200);
    expect(first.body.output).toMatchObject({ requestId: approved.input.requestId, status: "completed" });
    const entries = runtime.store.usage("member-a").filter(entry => entry.kind === "image");
    expect(entries).toHaveLength(1); expect(first.body.ledger).toMatchObject({ ledgerEntryId: entries[0].id, chargedPoints: 100 });
    runtime.close(); runtime = await createNodeAi(file, async (...args) => transport(...args));
    const duplicate = await invoke(approved).expect(200);
    expect(duplicate.body).toEqual(first.body); expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.quota("member-a")).toMatchObject({ usedTokens: 100, reservedTokens: 0 });
    await invoke(approved, { toolCallId: "call-2" }).expect(422);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("returns a changed saved status on a second request.get poll with the same toolCallId", async () => {
    const approved = await grant();
    const query = { toolName: "request.get", toolCallId: "same-status-poll" };
    const before = await invoke(approved, query).expect(200);
    expect(before.body).toMatchObject({ output: { status: "not_started" }, accounting: { kind: "read_only" } });
    await invoke(approved).expect(200);
    const after = await invoke(approved, query).expect(200);
    expect(after.body).toMatchObject({ output: { status: "completed" }, accounting: { kind: "read_only" } });
    expect(after.body.ledger).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.usage("member-a").filter(entry => entry.kind === "image")).toHaveLength(1);
  });
  it("freezes unknown provider outcomes durably while allowing a safe saved-result query", async () => {
    transport.mockRejectedValue(new Error("simulated disconnect after submission"));
    const approved = await grant();
    await invoke(approved).expect(409);
    const uncertain = runtime.store.usage("member-a").filter(entry => entry.kind === "image");
    expect(uncertain).toHaveLength(1);
    expect(uncertain[0]).toMatchObject({ status: "uncertain", totalTokens: 100 });
    expect(runtime.store.quota("member-a")).toMatchObject({ usedTokens: 100, reservedTokens: 0 });
    runtime.close(); runtime = await createNodeAi(file, async (...args) => transport(...args));
    const replay = await invoke(approved, { toolCallId: "another-call" }).expect(409);
    expect(replay.body.error.code).toBe("DIFY_RUN_OUTCOME_UNKNOWN");
    const queried = await invoke(approved, { toolCallId: "query-1", toolName: "request.get" }).expect(200);
    expect(queried.body).toMatchObject({ output: { status: "uncertain" }, accounting: { kind: "read_only" } });
    expect(queried.body.ledger).toBeUndefined(); expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.store.usage("member-a").filter(entry => entry.kind === "image")).toHaveLength(1);
    expect(runtime.store.quota("member-a")).toMatchObject({ usedTokens: 100, reservedTokens: 0 });
  });
  it("prevents a cancelled, already approved plan from starting or charging", async () => {
    const planId = plan();
    const timestamp = Date.now();
    runtime.store.createHarnessRun({ id: crypto.randomUUID(), requestId: planId, userId: "member-a", conversationId: "conversation-a", tier: "quick", providerId: "fixture", capability: "image", goalKind: "image", goalSummary: "test image", status: "waiting_approval", reasoningSummary: "awaiting member", startedAt: timestamp, updatedAt: timestamp }, []);
    const approved = await grant(planId);
    expect(runtime.service.cancelHarnessRun("member-a", planId).status).toBe("cancelled");
    const result = await invoke(approved).expect(422);
    expect(result.body.error.code).toBe("DIFY_TOOL_PLAN_MISMATCH");
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.store.usage("member-a").filter(entry => entry.kind === "image")).toHaveLength(0);
    expect(runtime.store.quota("member-a")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });
  it("rejects another account's plan, cross-account invocation, wrong conversation and changed input", async () => {
    await expect(issueGrant({ planRequestId: plan(), requestId: crypto.randomUUID(), maxPoints: 100 }, "member-b")).rejects.toMatchObject({ status: 403 });
    const approved = await grant();
    for (const override of [{ userId: "member-b" }, { tenantId: "other-tenant" }, { conversationId: "conversation-b" }, { input: { requestId: approved.input.requestId, prompt: "changed" } }, { sourceAssetIds: ["stolen-asset"] }, { toolCallId: undefined }]) await invoke(approved, override).expect(response => expect([400, 403]).toContain(response.status));
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects expired grants and disabled principals without reserving or charging", async () => {
    const approved = await grant();
    const clock = vi.spyOn(Date, "now").mockReturnValue(approved.claims.expiresAt + 1);
    const expired = await invoke(approved).expect(403); expect(expired.body.error.code).toBe("DIFY_TOOL_AUTH_EXPIRED"); clock.mockRestore();
    options.principalActive = () => false;
    await invoke(approved).expect(403); expect(transport).not.toHaveBeenCalled();
  });
  it("binds the grant to saved plan and configuration, rechecks available budget, and prevents repeated approval", async () => {
    const planId = plan(), approved = await grant(planId);
    await expect(issueGrant({ planRequestId: planId, requestId: crypto.randomUUID(), maxPoints: 100 })).rejects.toMatchObject({ status: 409, code: "DIFY_TOOL_GRANT_EXISTS" });
    const stored = runtime.store.request("member-a", planId)!;
    stored.result!.toolPlan!.prompt = "tampered plan"; runtime.store.saveRequest(stored);
    await invoke(approved).expect(422);
    const second = await grant();
    const provider = runtime.store.provider()!; runtime.store.saveProvider({ ...provider, imageQuotaTokens: 200 });
    await invoke(second).expect(422); runtime.store.saveProvider(provider);
    const third = await grant(); runtime.service.setQuota("member-a", "admin", { limitTokens: 50 });
    await invoke(third).expect(422);
    expect(transport).not.toHaveBeenCalled();
  });
  it("will not accept generated output without an account-and-request-matched ledger", async () => {
    const approved = await grant();
    const addUsage = runtime.store.addUsage.bind(runtime.store);
    vi.spyOn(runtime.store, "addUsage").mockImplementation((entry: AiUsageEntry) => addUsage(entry.kind === "image" ? { ...entry, userId: "member-b" } : entry));
    const result = await invoke(approved).expect(409);
    expect(result.body.error.code).toBe("DIFY_TOOL_LEDGER_INVALID");
    await invoke(approved, { toolCallId: "call-2" }).expect(409);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("stores real video quota reservation separately from settled billing and never calls queued delivery complete", async () => {
    await runtime.service.video.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-video-key", defaultModel: "minimax_h3" });
    const row = runtime.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id='video'")[0];
    const settings = JSON.parse(row.data); settings.verifiedConfigVersion = settings.configVersion; settings.verifiedKeyVersion = settings.keyVersion; settings.verifiedModels = ["minimax_h3"];
    runtime.store.sql.exec("UPDATE ai_settings SET data=? WHERE id='video'", JSON.stringify(settings));
    transport.mockResolvedValue(Response.json({ id: "task_1234567890123456", status: "queued", progress: 0 }));
    const approved = await grant(plan("member-a", "video"));
    const result = await invoke(approved, { toolName: "video.submit" });
    expect(result.body).not.toHaveProperty("error"); expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ output: { status: "queued" }, accounting: { kind: "reserved", requestId: approved.input.requestId, reservedPoints: 100 } });
    expect(result.body.ledger).toBeUndefined(); expect(runtime.store.usage("member-a").filter(entry => entry.kind === "video")).toHaveLength(0);
    expect(runtime.store.quota("member-a")).toMatchObject({ usedTokens: 0, reservedTokens: 100 });
    await invoke(approved, { toolName: "video.submit" }).expect(200); expect(transport).toHaveBeenCalledTimes(1);
  });
  it("uses atomic SQLite reservations across instances, freezing expired worker leases", async () => {
    let now = Date.now();
    const first = new DifySqlToolCallStore(runtime.store.sql, () => now);
    const second = new DifySqlToolCallStore(runtime.store.sql, () => now);
    expect(await first.reserve("a", "run", "hash-a")).toEqual({ kind: "reserved" });
    expect(await second.reserve("a", "run", "hash-a")).toEqual({ kind: "in_progress" });
    expect(await second.reserve("a", "run", "different")).toEqual({ kind: "conflict" });
    now += 180_001;
    expect(await second.reserve("b", "run", "hash-b")).toEqual({ kind: "run_blocked" });
    expect(await second.reserve("query", "run", "hash-q", { readOnly: true })).toEqual({ kind: "reserved" });
  });
  it("rejects another account's video reference, expired references and expired plans before authorization", async () => {
    await runtime.service.video.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-video-key" });
    const planId = plan("member-a", "video");
    const saved = runtime.store.request("member-a", planId)!;
    const referenceId = "a".repeat(64), contentHash = "b".repeat(64);
    saved.result!.toolPlan!.videoParameters!.referenceCount = 1;
    saved.result!.toolPlan!.videoParameters!.referenceFingerprints = [contentHash];
    runtime.store.saveRequest(saved);
    runtime.store.sql.exec("INSERT INTO ai_video_references(id,tenant_id,public_id,user_id,expires_at,data) VALUES(?,?,?,?,?,?)", referenceId, "default", referenceId, "member-b", Date.now() + 60_000, JSON.stringify({ chunks: [], fingerprint: contentHash }));
    const approve = () => issueGrant({ planRequestId: planId, requestId: crypto.randomUUID(), maxPoints: 100, referenceIds: [referenceId] });
    await expect(approve()).rejects.toMatchObject({ status: 403, code: "DIFY_TOOL_ASSET_SCOPE_MISMATCH" });
    runtime.store.sql.exec("UPDATE ai_video_references SET user_id='member-a',expires_at=? WHERE id=?", Date.now() - 1, referenceId);
    await expect(approve()).rejects.toMatchObject({ status: 403, code: "DIFY_TOOL_ASSET_SCOPE_MISMATCH" });
    runtime.store.sql.exec("UPDATE ai_video_references SET expires_at=? WHERE id=?", Date.now() + 60_000, referenceId);
    runtime.store.sql.exec("UPDATE ai_video_references SET data=? WHERE id=?", JSON.stringify({ chunks: [], fingerprint: contentHash, sourceVideo: { conversationId: "other-conversation", documentId: "source-video", name: "source.mp4", timeSeconds: 1, frameFingerprint: contentHash } }), referenceId);
    await expect(approve()).rejects.toMatchObject({ status: 409, code: "AI_VIDEO_SOURCE_CONVERSATION" });
    runtime.store.sql.exec("UPDATE ai_video_references SET data=? WHERE id=?", JSON.stringify({ chunks: [], fingerprint: contentHash, sourceVideo: { conversationId: "conversation-a", documentId: "source-video", name: "source.mp4", timeSeconds: 1, frameFingerprint: contentHash } }), referenceId);
    await expect(approve()).rejects.toMatchObject({ status: 404, code: "AI_VIDEO_SOURCE_NOT_FOUND" });
    runtime.store.sql.exec("UPDATE ai_video_references SET data=? WHERE id=?", JSON.stringify({ chunks: [], fingerprint: contentHash }), referenceId);
    saved.toolPlanExpiresAt = Date.now() - 1; runtime.store.saveRequest(saved);
    await expect(approve()).rejects.toMatchObject({ status: 409, code: "AI_TOOL_PLAN_EXPIRED" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("rechecks source-video ownership after approval and before any paid callback", async () => {
    await runtime.service.video.configure({ enabled: true, quotaPoints: 100, apiKey: "fixture-video-key" });
    const planId = plan("member-a", "video"), referenceId = "a".repeat(64), contentHash = "b".repeat(64);
    const saved = runtime.store.request("member-a", planId)!;
    saved.result!.toolPlan!.videoParameters!.referenceCount = 1;
    saved.result!.toolPlan!.videoParameters!.referenceFingerprints = [contentHash];
    runtime.store.saveRequest(saved);
    runtime.store.sql.exec("INSERT INTO ai_video_references(id,tenant_id,public_id,user_id,expires_at,data) VALUES(?,?,?,?,?,?)", referenceId, "default", referenceId, "member-a", Date.now() + 60_000, JSON.stringify({ chunks: [], fingerprint: contentHash }));
    const approved = await issueGrant({ planRequestId: planId, requestId: crypto.randomUUID(), maxPoints: 100, referenceIds: [referenceId] });
    runtime.store.sql.exec("UPDATE ai_video_references SET data=? WHERE id=?", JSON.stringify({ chunks: [], fingerprint: contentHash, sourceVideo: { conversationId: "conversation-a", documentId: "missing-video", name: "source.mp4", timeSeconds: 1, frameFingerprint: contentHash } }), referenceId);
    const blocked = await invoke(approved, { toolName: "video.submit" }).expect(422);
    expect(blocked.body.error.code).toBe("AI_VIDEO_SOURCE_NOT_FOUND");
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.store.quota("member-a")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
    expect(runtime.store.usage("member-a").filter(entry => entry.kind === "video")).toHaveLength(0);
  });
  it("handles simultaneous callbacks through one persisted reservation without duplicate provider submission", async () => {
    let release!: () => void, submitted!: () => void;
    const started = new Promise<void>(resolve => { submitted = resolve; });
    transport.mockImplementation(async () => { submitted(); await new Promise<void>(resolve => { release = resolve; }); return Response.json({ data: [{ b64_json: PNG }] }); });
    const approved = await grant();
    const first = invoke(approved).then(response => response);
    await started;
    const concurrent = await invoke(approved).expect(409);
    expect(concurrent.body.error.code).toBe("DIFY_TOOL_IN_PROGRESS");
    release(); expect((await first).status).toBe(200);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
