import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiHarnessInput } from "../../../shared/ai";
import type { AiRunGuidanceItem } from "../../../shared/aiRunGuidance";
import type { ComputerDecisionRequest, ComputerTaskResponse } from "../../../shared/computerAgent";

/** Mid-run guidance reaching the Pro 多 Agent 协作 run and the unified computer
 * executor inside the bundled Worker + SQLite Durable Object (createWorkerAi
 * wiring). Every outbound request is a local fixture: no real account, DNS
 * resolver, provider, Jev key or paid call. */
describe.sequential("mid-run guidance wiring in the production Worker", () => {
  const WORKER = "tongpin-guidance-wiring-workerd";
  const HOST = "http://tongpin-guidance-wiring.local";
  const PROVIDER_HOST = "ai-fixture.example.com";
  const KEY = "guidance-wiring-workerd-provider-not-real";
  const JEV_KEY = "guidance-wiring-workerd-jev-not-real";
  const PASSWORD = "GuidanceWiring20260927!";
  type Session = { accessToken: string; user: { id: string; email: string; role: string } };
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  const calls: Array<{ role: string; user: string }> = [];
  const jevGuidance: string[][] = [];
  const gates: Array<() => void> = [];
  const TASK = {
    kind: "computer_task",
    goal: "在微信中给联系人「姐姐」发送消息「中秋快乐」",
    apps: [{ name: "微信", bundleId: "com.tencent.xinWeChat" }],
    parameters: [{ id: "p1", role: "recipient", label: "联系人", value: "姐姐" }, { id: "p2", role: "message", label: "消息内容", value: "中秋快乐" }],
    successCheck: "与「姐姐」的聊天记录中出现刚发送的「中秋快乐」",
    irreversible: { kind: "send_message", summary: "发送消息给「姐姐」：中秋快乐", recipient: "姐姐", content: "中秋快乐" },
    actionKinds: ["activate_app", "click", "type", "key", "scroll"],
  };

  const sse = (text: string) => new MfResponse([
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: 40, output_tokens: 10, total_tokens: 50 }, output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
      expect([PROVIDER_HOST, "api.typesafe.ai"]).toContain(url.searchParams.get("name"));
      return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    }
    if (url.hostname === "api.typesafe.ai") {
      expect(request.headers.get("Authorization")).toBe(`Bearer ${JEV_KEY}`);
      expect(url.pathname).toBe("/v1/systemone");
      const body = await request.json() as { state: { user_guidance: string[] }; questions: Record<string, { type: string; criteria?: Record<string, unknown> }> };
      jevGuidance.push(body.state.user_guidance);
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, question.type === "choice"
        ? { type: "choice", choice: "open_search", confidence: 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria!).map(option => [option, option === "open_search" ? 1 : 0])) }
        : { type: "noul", noul: 0.1 }]));
      return MfResponse.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 2000, output_tokens: 40 } });
    }
    // No network fallthrough: any other destination fails the test.
    expect(url.hostname).toBe(PROVIDER_HOST);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    if (url.pathname === "/v1/models") return MfResponse.json({ data: [{ id: "fixture-fast" }, { id: "fixture-pro" }] });
    expect(url.pathname).toBe("/v1/responses");
    const body = await request.json() as { instructions?: string; input?: Array<{ role: string; content: unknown }> };
    const instructions = String(body.instructions ?? "");
    const role = instructions.includes("【多 Agent 协作 · 协调者】") ? "coordinator" : instructions.includes("【多 Agent 协作 · 子 Agent】") ? "subagent"
      : instructions.includes("【多 Agent 协作 · 结果综合】") ? "synthesis" : "other";
    calls.push({ role, user: (body.input ?? []).filter(turn => turn.role === "user").map(turn => typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content)).join("\n") });
    if (role === "coordinator") return sse(JSON.stringify({ subtasks: [1, 2].map(index => ({ role: "研究员", title: `方面${index}`, task: `请只分析方案的第 ${index} 个方面。`, search: false })) }));
    if (role === "subagent") { await new Promise<void>(resolve => gates.push(resolve)); return sse("摘要：已完成。\n\n- 依据"); }
    if (role === "synthesis") return sse("综合回答");
    return sse(JSON.stringify(TASK));
  };

  async function api<T>(route: string, session?: Session, body?: unknown, method = body === undefined ? "GET" : "POST", expectedStatus = 200): Promise<T> {
    const response = await mf.dispatchFetch(`${HOST}${route}`, {
      method, headers: { "Content-Type": "application/json", ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json() as T;
    expect(response.status, `${method} ${route}: ${JSON.stringify(payload).slice(0, 300)}`).toBe(expectedStatus);
    return payload;
  }
  async function register(email: string) {
    const registered = await api<{ debugCode: string }>("/api/auth/register", undefined, { email, name: email.split("@")[0], password: PASSWORD }, "POST", 201);
    await api("/api/auth/verify-email", undefined, { email, code: registered.debugCode });
  }
  const login = (email: string) => api<Session>("/api/auth/login", undefined, { email, password: PASSWORD });
  const guidance = (runId: string, id: string, text: string, expectedStatus = 200) => api<{ guidance: AiRunGuidanceItem; created: boolean } & { error?: { code: string } }>(
    `/api/ai/requests/${encodeURIComponent(runId)}/guidance`, member, { id, text }, "POST", expectedStatus);
  const statuses = async (runId: string) => (await api<{ guidance: AiRunGuidanceItem[] }>(`/api/ai/requests/${encodeURIComponent(runId)}/guidance`, member)).guidance.map(item => item.status);

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-guidance-wiring-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "guidance-wiring-workerd-secret-".repeat(3), BOOTSTRAP_ADMIN_EMAIL: "admin@guidance-wiring.example.com",
        DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: HOST, AI_ALLOWED_HOSTS: `${PROVIDER_HOST},api.typesafe.ai`,
        LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register("admin@guidance-wiring.example.com");
    admin = await login("admin@guidance-wiring.example.com");
    await register("member@guidance-wiring.example.com");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    const memberId = users.users.find(user => user.email === "member@guidance-wiring.example.com")!.id;
    await api(`/api/admin/users/${memberId}/access`, admin, { status: "active" }, "PATCH");
    member = await login("member@guidance-wiring.example.com");
    const route = (modelId: string, computer = false) => ({ providerId: "primary", modelId, protocol: "responses" as const, maxOutputTokens: 2048, reasoningEffort: "" as const,
      capabilities: computer ? ["chat" as const, "computer" as const] : ["chat" as const], enabled: true });
    const harness: AiHarnessInput = {
      providers: [{ id: "primary", name: "Fixture", baseUrl: `https://${PROVIDER_HOST}/v1`, protocol: "responses", apiKey: KEY, enabled: true }],
      tiers: { quick: route("fixture-fast"), standard: route("fixture-fast"), deep: route("fixture-pro", true),
        pro: { ...route("fixture-pro"), multiAgent: { maxConcurrency: 2, subAgentMaxOutputTokens: 512 } } },
      policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: false },
    };
    await api("/api/admin/ai/harness", admin, harness, "PUT");
    await api("/api/admin/ai/harness/providers/primary/discover", admin, {});
    await api(`/api/admin/ai/members/${memberId}/quota`, admin, { limitTokens: 500_000 }, "PUT");
    await api("/api/admin/ai/computer", admin, { enabled: true, apiKey: JEV_KEY, inputPointsPer1k: 500, outputPointsPer1k: 1000, maxSteps: 4, maxMinutes: 6, minConfidence: 0.5 }, "PUT");
  }, 60_000);
  afterAll(async () => { for (const release of gates) release(); if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("hands guidance posted while sub-agents work to the synthesis step of a Pro multi-agent run", async () => {
    calls.length = 0; gates.length = 0;
    const requestId = crypto.randomUUID();
    const reply = mf.dispatchFetch(`${HOST}/api/ai/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${member.accessToken}`, "X-Tongpin-Account": member.user.id },
      body: JSON.stringify({ requestId, conversationId: "conversation-pro", mode: "pro", outputFormat: "text", messages: [{ role: "user", content: "比较方案 A 和方案 B" }] }),
    });
    await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(2), { timeout: 10_000 });
    expect((await guidance(requestId, "guidance-wiring-ma-01", "改用表格对比")).created).toBe(true);
    expect((await guidance(requestId, "guidance-wiring-ma-02", "重点看成本")).created).toBe(true);
    for (const release of gates) release();
    const response = await reply;
    expect(response.status).toBe(200);
    expect((await response.json() as { content: string }).content).toBe("综合回答");
    expect(calls.find(call => call.role === "synthesis")!.user).toContain('"guidance":["改用表格对比","重点看成本"]');
    expect(await statuses(requestId)).toEqual(["delivered", "delivered"]);
    expect((await guidance(requestId, "guidance-wiring-ma-03", "晚了", 409)).error?.code).toBe("AI_RUN_NOT_ACTIVE");
  }, 30_000);

  it("accepts guidance for a live computer run and adds it to the next Jev decision", async () => {
    const created = await api<ComputerTaskResponse>("/api/ai/computer/tasks", member, { requestId: crypto.randomUUID(), mode: "deep", conversationId: "conversation-computer", instruction: "给姐姐发一个中秋快乐" });
    if (created.kind !== "run") throw new Error("expected a computer run");
    const runId = created.run.runId;
    expect((await guidance(runId, "guidance-wiring-cr-01", "联系人备注是“姐姐（家）”")).guidance.status).toBe("pending");
    await api(`/api/ai/requests/${encodeURIComponent(`cr_${"0".repeat(32)}`)}/guidance`, member, { id: "guidance-wiring-cr-02", text: "不存在" }, "POST", 404);
    const decision: ComputerDecisionRequest = {
      step: 1, observationId: "obs_wiring_0001",
      observation: { trust: "untrusted_screen_content", app: "微信", windowTitle: "微信", axSparse: false, elementsTotal: 1, elements: [{ ref: "e1", role: "text_area", label: "搜索", editable: true, searchBox: true }], texts: ["姐姐"] },
      candidates: [
        { id: "open_search", description: "Press Command+F in the 微信 window to focus its search box.", risk: "none" },
        { id: "reobserve", description: "Do not act; take a fresh observation.", risk: "none" },
        { id: "abstain", description: "Stop without acting.", risk: "none" },
        { id: "done", description: "Stop because the goal is achieved.", risk: "none" },
      ],
      facts: { focus: "none", irreversibleDone: false }, history: [],
    };
    await api(`/api/ai/computer/runs/${runId}/decide`, member, decision);
    expect(jevGuidance.at(-1)).toEqual(["联系人备注是“姐姐（家）”"]);
    expect(await statuses(runId)).toEqual(["delivered"]);
    await api(`/api/ai/computer/runs/${runId}/finish`, member, { outcome: "abstained", reason: "user_stopped", summary: "已停止。" });
    expect((await guidance(runId, "guidance-wiring-cr-03", "结束了", 409)).error?.code).toBe("AI_RUN_NOT_ACTIVE");
  }, 30_000);
});
