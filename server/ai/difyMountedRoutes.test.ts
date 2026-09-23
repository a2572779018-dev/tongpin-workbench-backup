import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRuntime, type AppRuntime } from "../app";
import { loadConfig } from "../config";
import { issueAccessToken } from "../security";
import type { AiTransport } from "./provider";
import { createNodeAi } from "./node";
import { DifyToolRuntime } from "./difyRuntime";
import { toolPlanContextFingerprint } from "./toolPlans";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const SERVICE_SECRET = "mounted-dify-service-credential-at-least-32-bytes";
const execFileAsync = promisify(execFile);

describe.sequential("mounted Dify routes with real Node authentication", () => {
  let directory: string;
  let runtime: AppRuntime;
  let adminAuthorization: string;
  let memberAuthorization: string;
  let memberId: string;
  const transport = vi.fn<AiTransport>();

  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-dify-mounted-"));
    const config = loadConfig({
      dataFile: path.join(directory, "data.json"),
      jwtSecret: "dify-mounted-route-fixture-secret-at-least-32-bytes",
      bootstrapAdminEmail: "dify-admin@tongpin.test",
      bootstrapAdminPassword: "DifyMountedFixture2026!",
      isProduction: false,
    });
    transport.mockResolvedValue(Response.json({ data: [{ b64_json: PNG }] }));
    runtime = await createRuntime(config, {
      attachSockets: false, startLoraCollector: false, startAiAgentScheduler: false,
      aiTransport: transport, difyConfig: { enabled: true, appId: "mounted-fixture-app" }, difyServiceSecret: SERVICE_SECRET,
    });
    const admin = await runtime.store.read(database => database.users.find(user => user.role === "admin")!);
    memberId = crypto.randomUUID();
    const member = { ...admin, id: memberId, email: "dify-member@tongpin.test", role: "member" as const };
    await runtime.store.mutate(database => { database.users.push(member); });
    adminAuthorization = `Bearer ${issueAccessToken(admin, config)}`;
    memberAuthorization = `Bearer ${issueAccessToken(member, config)}`;
    await request(runtime.app).put("/api/admin/ai/provider").set("Authorization", adminAuthorization).send({
      name: "Fixture", baseUrl: "https://provider.example.com", apiKey: "fixture-not-real", protocol: "responses",
      quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true,
      imageModel: "fixture-image", imageQuotaTokens: 100,
    }).expect(200);
    await request(runtime.app).put(`/api/admin/ai/members/${memberId}/quota`).set("Authorization", adminAuthorization).send({ limitTokens: 1000 }).expect(200);
  });
  afterAll(async () => {
    if (runtime) await runtime.close();
    if (directory) await rm(directory, { recursive: true });
  });

  it("authorizes a saved member plan and invokes its callback without a browser session exactly once", async () => {
    const planRequestId = crypto.randomUUID(), requestId = crypto.randomUUID();
    runtime.aiStore.saveRequest({ requestId: planRequestId, userId: memberId, conversationId: "mounted-conversation", hash: "fixture", kind: "chat", status: "completed", model: "quick", mode: "quick", inputReserve: 0, outputReserve: 0, createdAt: new Date().toISOString(), expiresAt: Date.now() + 60_000, toolPlanExpiresAt: Date.now() + 600_000, toolPlanContextFingerprint: await toolPlanContextFingerprint(),
      result: { requestId: planRequestId, content: "Saved plan", model: "quick", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "image", summary: "fixture", prompt: "one image" } } });
    const approval = { planRequestId, requestId, maxPoints: 100 };
    await request(runtime.app).post("/api/ai/dify/grants").send(approval).expect(401);
    await request(runtime.app).post("/api/ai/dify/grants").set("Authorization", adminAuthorization).send(approval).expect(403);
    await request(runtime.app).post("/api/ai/dify/grants").set("Authorization", memberAuthorization).set("X-Tongpin-Account", "another-member").send(approval).expect(409);
    await request(runtime.app).post("/api/ai/dify/grants").set("Authorization", memberAuthorization).send(approval).expect(404);
    await request(runtime.app).get("/api/ai/dify/grants").set("Authorization", memberAuthorization).expect(404);
    const internal = await createNodeAi(path.join(directory, "data.json"), transport);
    let approved: Awaited<ReturnType<DifyToolRuntime["issueGrant"]>>;
    try {
      approved = await new DifyToolRuntime(internal.service, { enabled: true, appId: "mounted-fixture-app" }, (tenantId, userId) => tenantId === "default" && userId === memberId).issueGrant({ tenantId: "default", userId: memberId }, approval);
    } finally { internal.close(); }
    expect(approved.claims).toMatchObject({ tenantId: "default", userId: memberId, conversationId: "mounted-conversation", maxPoints: 100 });
    const { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds } = approved.claims;
    const callback = { tenantId, userId, conversationId, runId, attemptId, sourceAssetIds, toolCallId: `call-${requestId}`, toolName: "image.generate", input: approved.input };
    await request(runtime.app).post("/api/dify/tools/invoke").send(callback).expect(401);
    await request(runtime.app).post("/api/dify/tools/invoke").set("Authorization", `Bearer ${approved.authorization}`).set("X-Dify-Tool-Secret", "wrong-service-credential-at-least-32-bytes").send(callback).expect(401);
    await request(runtime.app).post("/api/dify/tools/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).send(callback).expect(401);
    await request(runtime.app).post("/api/dify/tools/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).set("Authorization", `Bearer ${"a".repeat(64)}`).send(callback).expect(403);
    expect(transport).not.toHaveBeenCalled();
    const first = await request(runtime.app).post("/api/dify/tools/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).set("Authorization", `Bearer ${approved.authorization}`).send(callback).expect(200);
    expect(first.body).toMatchObject({ output: { requestId, status: "completed" }, ledger: { chargedPoints: 100, userId: memberId } });
    const server = await new Promise<import("node:http").Server>((resolve, reject) => {
      const listener = runtime.app.listen(0, "127.0.0.1", () => resolve(listener));
      listener.once("error", reject);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Local callback listener has no TCP port");
      const code = "import json,sys; from tools.gateway_client import invoke_gateway; print(json.dumps(invoke_gateway(sys.argv[1],sys.argv[2],json.loads(sys.argv[3]))))";
      const { stdout } = await execFileAsync("python3", ["-c", code, `http://127.0.0.1:${address.port}/api/dify/tools/invoke`, SERVICE_SECRET, JSON.stringify({ ...callback, authorization: approved.authorization })], {
        cwd: path.resolve("deploy/dify/plugins/tongpin_gateway"), timeout: 10_000,
      });
      expect(JSON.parse(stdout)).toEqual(first.body);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const replay = await request(runtime.app).post("/api/dify/tools/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).set("Authorization", `Bearer ${approved.authorization}`).send(callback).expect(200);
    expect(replay.body).toEqual(first.body);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.aiStore.quota(memberId)).toMatchObject({ usedTokens: 100, reservedTokens: 0 });
    await request(runtime.app).post("/api/dify/tools/invoke").set("Authorization", `Bearer ${approved.authorization}`).send({ padding: "x".repeat(17_000) }).expect(413);
    await runtime.store.mutate(database => { database.users.find(user => user.id === memberId)!.status = "disabled"; });
    const inactive = await request(runtime.app).post("/api/dify/tools/invoke").set("X-Dify-Tool-Secret", SERVICE_SECRET).set("Authorization", `Bearer ${approved.authorization}`).send(callback).expect(403);
    expect(inactive.body.error.code).toBe("DIFY_TOOL_SCOPE_MISMATCH");
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
