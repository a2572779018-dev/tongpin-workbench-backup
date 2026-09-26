import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiHarnessInput, AiStatus } from "../../../shared/ai";
import type { AiRunEvent } from "../../../shared/aiRunEvents";

/** Pro 多 Agent 协作 in the real bundled Worker and SQLite Durable Object under
 * workerd. Every outbound request is answered by the local fixture below: no
 * production account, API key, DNS resolver or paid provider is used. */
describe.sequential("Pro 多 Agent 协作 in the bundled Worker", () => {
  const WORKER = "tongpin-multi-agent-workerd";
  const HOST = "http://tongpin-multi-agent.local";
  const PROVIDER_HOST = "ai-fixture.example.com";
  const KEY = "workerd-multi-agent-fixture-not-real";
  const PASSWORD = "MultiAgentWorkerd20260926!";
  type Session = { accessToken: string; user: { id: string; email: string; role: string } };
  type Role = "coordinator" | "subagent" | "synthesis" | "other";
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  const calls: Array<{ role: Role; title?: string }> = [];
  const gates = new Map<string, () => void>();
  let active = 0, peak = 0;

  const sse = (text: string, usage: { input: number; output: number }) => new MfResponse([
    { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text },
    { type: "response.completed", response: { status: "completed", usage: { input_tokens: usage.input, output_tokens: usage.output, total_tokens: usage.input + usage.output },
      output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }] } },
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });

  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com" && url.pathname === "/dns-query") {
      expect(url.searchParams.get("name")).toBe(PROVIDER_HOST);
      return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    }
    // No network fallthrough: any other destination fails the test.
    expect(url.hostname).toBe(PROVIDER_HOST);
    expect(request.headers.get("Authorization")).toBe(`Bearer ${KEY}`);
    if (url.pathname === "/v1/models") return MfResponse.json({ data: [{ id: "fixture-fast" }, { id: "fixture-pro" }] });
    expect(url.pathname).toBe("/v1/responses");
    const body = await request.json() as { instructions?: string; input?: Array<{ role: string; content: unknown }>; max_output_tokens?: number };
    const instructions = String(body.instructions ?? "");
    const role: Role = instructions.includes("【多 Agent 协作 · 协调者】") ? "coordinator" : instructions.includes("【多 Agent 协作 · 子 Agent】") ? "subagent"
      : instructions.includes("【多 Agent 协作 · 结果综合】") ? "synthesis" : "other";
    const user = (body.input ?? []).filter(turn => turn.role === "user").map(turn => typeof turn.content === "string" ? turn.content : JSON.stringify(turn.content)).join("\n");
    const title = /子任务：(.+)/.exec(user)?.[1];
    calls.push({ role, ...(title ? { title } : {}) });
    if (role === "coordinator") {
      return sse(JSON.stringify({ subtasks: [1, 2, 3].map(index => ({ role: index === 3 ? "核对员" : "研究员", title: `方面${index}`, task: `请只分析方案的第 ${index} 个方面。`, search: false })) }), { input: 60, output: 30 });
    }
    if (role === "subagent") {
      expect(body.max_output_tokens).toBe(512);
      active += 1; peak = Math.max(peak, active);
      await new Promise<void>(resolve => gates.set(title!, resolve));
      active -= 1;
      return sse(`摘要：${title} 已完成。\n\n- 依据`, { input: 30, output: 12 });
    }
    if (role === "synthesis") return sse("综合回答：三个方面都已核对。", { input: 150, output: 25 });
    return sse("直接回答", { input: 10, output: 5 });
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
  /** Opens the member's stream and returns a reader that collects parsed events. */
  async function openStream(requestId: string) {
    const response = await mf.dispatchFetch(`${HOST}/api/ai/chat/stream`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${member.accessToken}`, "X-Tongpin-Account": member.user.id },
      body: JSON.stringify({ requestId, conversationId: "conversation-pro", mode: "pro", outputFormat: "text", liveProgress: true, subagentEvents: true,
        messages: [{ role: "user", content: "请从三个方面比较方案 A 和方案 B" }] }),
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader(), decoder = new TextDecoder();
    let buffer = "";
    const events: AiRunEvent[] = [];
    const drain = async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
          if (data) events.push(JSON.parse(data) as AiRunEvent);
        }
      }
      return events;
    };
    return { events, done: drain() };
  }
  const subagentPhases = (events: AiRunEvent[]) => events.flatMap(event => event.type === "subagent_update" ? [event.data.phase] : []);

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-multi-agent-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "multi-agent-workerd-secret-".repeat(4), BOOTSTRAP_ADMIN_EMAIL: "admin@multi-agent.example.com",
        DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: HOST, AI_ALLOWED_HOSTS: PROVIDER_HOST,
        LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register("admin@multi-agent.example.com");
    admin = await login("admin@multi-agent.example.com");
    await register("member@multi-agent.example.com");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    await api(`/api/admin/users/${users.users.find(user => user.email === "member@multi-agent.example.com")!.id}/access`, admin, { status: "active" }, "PATCH");
    member = await login("member@multi-agent.example.com");
    const route = (modelId: string) => ({ providerId: "primary", modelId, protocol: "responses" as const, maxOutputTokens: 2048, reasoningEffort: "" as const, capabilities: ["chat" as const], enabled: true });
    const harness: AiHarnessInput = {
      providers: [{ id: "primary", name: "Fixture", baseUrl: `https://${PROVIDER_HOST}/v1`, protocol: "responses", apiKey: KEY, enabled: true }],
      tiers: { quick: route("fixture-fast"), standard: route("fixture-fast"), deep: route("fixture-pro"),
        pro: { ...route("fixture-pro"), multiAgent: { maxConcurrency: 2, subAgentMaxOutputTokens: 512 } } },
      policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
    };
    const saved = await api<{ harness: { tiers: AiHarnessInput["tiers"] } }>("/api/admin/ai/harness", admin, harness, "PUT");
    expect(saved.harness.tiers.pro.multiAgent).toEqual({ maxConcurrency: 2, subAgentMaxOutputTokens: 512 });
    expect(JSON.stringify(saved)).not.toContain(KEY);
    await api("/api/admin/ai/harness/providers/primary/discover", admin, {});
    await api(`/api/admin/ai/members/${member.user.id}/quota`, admin, { limitTokens: 200_000 }, "PUT");
  }, 60_000);
  afterAll(async () => { for (const release of gates.values()) release(); if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("decomposes, keeps at most two sub-agents in flight, streams their progress and settles one bill", async () => {
    calls.length = 0; gates.clear(); peak = 0;
    const requestId = crypto.randomUUID();
    const stream = await openStream(requestId);
    await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(2), { timeout: 10_000 });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(calls.filter(call => call.role === "subagent")).toHaveLength(2);
    gates.get("方面1")!();
    await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(3), { timeout: 10_000 });
    gates.get("方面2")!(); gates.get("方面3")!();
    const events = await stream.done;
    expect(peak).toBe(2);
    expect(calls.map(call => call.role)).toEqual(["coordinator", "subagent", "subagent", "subagent", "synthesis"]);
    const phases = subagentPhases(events);
    expect(phases.slice(0, 2)).toEqual(["planning", "plan"]);
    expect(phases.filter(phase => phase === "start")).toHaveLength(3);
    expect(phases.filter(phase => phase === "stop")).toHaveLength(3);
    expect(phases.slice(-2)).toEqual(["synthesis", "finish"]);
    const plan = events.find(event => event.type === "subagent_update" && event.data.phase === "plan");
    expect(plan?.type === "subagent_update" && plan.data.phase === "plan" ? plan.data.subtasks.map(item => [item.id, item.role, item.title]) : []).toEqual([
      ["agent-1", "研究员", "方面1"], ["agent-2", "研究员", "方面2"], ["agent-3", "核对员", "方面3"]]);
    const finished = events.at(-1);
    expect(finished?.type).toBe("run_finished");
    const response = finished?.type === "run_finished" ? finished.data.response : undefined;
    expect(response?.content).toBe("综合回答：三个方面都已核对。");
    expect(response?.usage).toMatchObject({ inputTokens: 60 + 3 * 30 + 150, outputTokens: 30 + 3 * 12 + 25, totalTokens: 90 + 3 * 42 + 175, estimated: false });
    const status = await api<AiStatus>("/api/ai/status", member);
    expect(status.quota).toMatchObject({ usedTokens: 90 + 3 * 42 + 175, reservedTokens: 0 });
    // The journal keeps the same lifecycle for replay and the persisted process.
    const replay = await api<{ events: AiRunEvent[] }>(`/api/ai/requests/${requestId}/events?after=0`, member);
    expect(subagentPhases(replay.events)).toEqual(phases);
  }, 30_000);

  it("停止 aborts the in-flight sub-agents through the cancel route and releases the reservation", async () => {
    calls.length = 0; gates.clear();
    const before = (await api<AiStatus>("/api/ai/status", member)).quota.usedTokens;
    const requestId = crypto.randomUUID();
    const stream = await openStream(requestId);
    await vi.waitFor(() => expect(calls.filter(call => call.role === "subagent")).toHaveLength(2), { timeout: 10_000 });
    expect((await api<AiStatus>("/api/ai/status", member)).quota.reservedTokens).toBeGreaterThan(0);
    expect(await api<{ cancelled: boolean }>(`/api/ai/requests/${encodeURIComponent(requestId)}/cancel`, member, {})).toEqual({ cancelled: true });
    const events = await stream.done;
    const failed = events.at(-1);
    expect(failed?.type === "run_failed" ? failed.data.error.code : failed?.type).toBe("AI_RUN_CANCELLED");
    expect(subagentPhases(events).at(-1)).toBe("finish");
    expect(calls.map(call => call.role)).toEqual(["coordinator", "subagent", "subagent"]);
    const status = await api<AiStatus>("/api/ai/status", member);
    expect(status.quota.reservedTokens).toBe(0);
    // Unknown outcome of the aborted calls is settled conservatively, never above the reservation.
    expect(status.quota.usedTokens).toBeGreaterThanOrEqual(before + 90);
    expect(await api<{ cancelled: boolean }>(`/api/ai/requests/${encodeURIComponent(requestId)}/cancel`, member, {})).toEqual({ cancelled: false });
    for (const release of gates.values()) release();
  }, 30_000);
});
