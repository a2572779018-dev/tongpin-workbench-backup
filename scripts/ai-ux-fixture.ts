/** Loopback-only, disposable UX fixture. Real auth/quota/storage; model transport is simulated. Never deploy. */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { createRuntime } from "../server/app";
import type { AppConfig } from "../server/config";
import { AiPersonaRepository } from "../server/ai/persona";
import { AiWorkspaceRepository } from "../server/ai/workspace";
import { emptyQuota } from "../server/ai/storage";
import { defaultAiPersonaProfile } from "../shared/aiPersona";
import type { AiWorkspaceState } from "../shared/aiWorkspace";

const directory = await mkdtemp(path.join(tmpdir(), "tongpin-ai-ux-"));
const fixturePort = Number(process.env.TONGPIN_FIXTURE_PORT || 4318);
const fixtureOrigin = process.env.TONGPIN_FIXTURE_ORIGIN || "http://127.0.0.1:5173";
if (![4318, 4319].includes(fixturePort) || !/^http:\/\/127\.0\.0\.1:(5173|5174)$/.test(fixtureOrigin)) throw new Error("Only dedicated loopback fixture ports are permitted");
const fixtureApi = `http://127.0.0.1:${fixturePort}`;
const config: AppConfig = {
  host: "127.0.0.1", port: fixturePort, dataFile: path.join(directory, "fixture.json"),
  jwtSecret: crypto.randomUUID() + crypto.randomUUID(), clientOrigins: [fixtureOrigin],
  bootstrapAdminEmail: "admin@tongpin.test", bootstrapAdminPassword: "Fixture123!", bootstrapAdminName: "本地验收管理员",
  devEmailPreview: true, isProduction: false, loraExplorerApi: "", loraRpcUrl: "",
  resend: { apiKey: "", from: "" }, smtp: { host: "", port: 587, secure: false, user: "", pass: "", from: "" },
};
const runtime = await createRuntime(config, {
  startLoraCollector: false,
  aiTransport: async () => Response.json({ status: "completed", output_text: "【本地模拟回复，不调用真实模型】\n\n先给结论：将目标、输入资料和交付要求写清楚，能更快得到可用结果。\n\n" + "把工作拆成明确的小步骤，每一步都保留来源与检查记录。遇到不确定的信息先说明，再继续核实。\n".repeat(30), usage: { input_tokens: 100, output_tokens: 400, total_tokens: 500 } }),
});
const now = new Date().toISOString();
const passwordHash = await bcrypt.hash("Fixture123!", 10);
const personas = new AiPersonaRepository(runtime.aiStore.sql);
const workspaces = new AiWorkspaceRepository(runtime.aiStore.sql);
for (const kind of ["locked", "setup", "ready", "long", "exhausted", "boss", "search"]) {
  const id = crypto.randomUUID();
  await runtime.store.mutate(db => { db.users.push({ id, email: `${kind}@tongpin.test`, name: `本地验收 · ${kind}`, passwordHash, role: kind === "boss" ? "boss" : "member", status: "active", jobTitle: "隔离测试账号", avatarSeed: 1, avatarVersion: 0, avatarDataUrl: null, emailVerifiedAt: now, lastLoginAt: null, createdAt: now, updatedAt: now }); });
  if (kind === "locked") continue;
  runtime.aiStore.saveQuota(id, { ...emptyQuota(), limitTokens: ["boss", "search"].includes(kind) ? 10000 : 100000, usedTokens: kind === "exhausted" ? 100000 : 0 });
  if (kind === "setup") continue;
  personas.save(id, { expectedRevision: 0, profile: { ...defaultAiPersonaProfile(), name: "小频", tone: "concise", preferences: "用中文，先给结论。", onboardingComplete: true } });
  if (kind === "long") {
    const conversationId = crypto.randomUUID();
    const state: AiWorkspaceState = { view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, activeConversationId: conversationId, activeProjectId: null, enabledSkillIds: [], conversations: [{ id: conversationId, title: "长对话性能验收 · 160 条模拟消息", timeLabel: "今天", messages: Array.from({ length: 160 }, (_, index) => ({ id: crypto.randomUUID(), role: index % 2 ? "assistant" : "user", content: `第 ${index + 1} 条模拟记录。` + "这里是仅用于性能验收的长文本，不包含真实客户信息。".repeat(30), time: "10:00", status: "ready" })) }] };
    await workspaces.save(id, { expectedRevision: 0, mutationId: crypto.randomUUID(), state });
  }
}
await new Promise<void>(resolve => runtime.server.listen(config.port, config.host, resolve));
const adminResponse = await fetch(`${fixtureApi}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: config.bootstrapAdminEmail, password: "Fixture123!" }) });
const admin = await adminResponse.json() as { accessToken: string };
const configured = await fetch(`${fixtureApi}/api/admin/ai/provider`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin.accessToken}` }, body: JSON.stringify({ name: "本地模拟模型", baseUrl: "https://fixture.example.com/v1", protocol: "responses", apiKey: "fixture-key-not-a-real-secret", quickModel: "fixture-model", deepModel: "fixture-model", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100 }) });
if (!configured.ok) throw new Error(`Fixture provider setup failed: ${configured.status}`);
console.log("Local UX fixture listening on", fixtureApi, "; isolated data:", directory);
console.log("Accounts: locked/setup/ready/long/exhausted/boss/search@tongpin.test; password: Fixture123!; model is simulated, no external AI calls.");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void runtime.close().finally(() => process.exit(0)); });
