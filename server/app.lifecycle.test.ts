import { mkdtemp, rename, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntime, type AppRuntime } from "./app";
import { loadConfig, type AppConfig } from "./config";
import { issueAccessToken } from "./security";
import type { AiTransport } from "./ai/provider";

describe("Node application resource lifecycle", () => {
  let directory: string;
  let config: AppConfig;
  let runtime: AppRuntime;
  let releaseGeneration: (() => void) | undefined;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-lifecycle-"));
    config = loadConfig({
      dataFile: path.join(directory, "database.json"), jwtSecret: "lifecycle-fixture-secret-with-thirty-two-characters",
      bootstrapAdminEmail: "lifecycle-admin@example.com", bootstrapAdminPassword: "FixturePassword123!", bootstrapAdminName: "测试管理员",
      isProduction: false, devEmailPreview: false,
    });
    releaseGeneration = undefined;
    transport.mockReset();
    runtime = await createRuntime(config, { attachSockets: false, startLoraCollector: false, aiTransport: transport });
  });
  afterEach(async () => {
    releaseGeneration?.();
    if (runtime) await runtime.close();
    if (directory) await rm(directory, { recursive: true });
  });
  async function listen(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      runtime.server.once("error", reject);
      runtime.server.listen(0, "127.0.0.1", () => { runtime.server.off("error", reject); resolve(); });
    });
    return `http://127.0.0.1:${(runtime.server.address() as AddressInfo).port}`;
  }

  it.each([false, true])("closes SQLite idempotently with server listening=%s and releases the Windows file handle", async listening => {
    if (listening) await listen();
    expect(runtime.aiStore.quota("member").usedTokens).toBe(0);
    const closing = runtime.close();
    expect(runtime.close()).toBe(closing);
    await closing;
    await runtime.close();
    expect(runtime.server.listening).toBe(false);
    expect(() => runtime.aiStore.quota("member")).toThrow();
    // Rename fails with EBUSY on Windows if DatabaseSync still owns the file.
    await rename(`${config.dataFile}.ai.sqlite`, `${config.dataFile}.ai.sqlite.closed`);
  });

  it("lets an active paid request settle once before closing the AI database", async () => {
    const admin = await runtime.store.read(db => db.users.find(user => user.role === "admin")!);
    const member = { ...admin, id: "lifecycle-member", email: "lifecycle-member@example.com", role: "member" as const };
    await runtime.store.mutate(db => { db.users.push(member); });
    const adminAuth = { Authorization: `Bearer ${issueAccessToken(admin, config)}` };
    await request(runtime.app).put("/api/admin/ai/provider").set(adminAuth).send({
      name: "Fixture", baseUrl: "https://provider.example.com", apiKey: "lifecycle-fixture-not-real", protocol: "responses", quickModel: "quick", deepModel: "deep",
      maxOutputTokens: 1024, reasoningEffort: "", enabled: true,
    }).expect(200);
    await request(runtime.app).put(`/api/admin/ai/members/${member.id}/quota`).set(adminAuth).send({ limitTokens: 50_000 }).expect(200);
    transport.mockImplementation(async () => {
      await new Promise<void>(resolve => { releaseGeneration = resolve; });
      return Response.json({ status: "completed", output_text: "完整回复", usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
    });
    const origin = await listen();
    const result = fetch(`${origin}/api/ai/chat`, {
      method: "POST", headers: { Authorization: `Bearer ${issueAccessToken(member, config)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "你好" }] }),
    }).then(async response => ({ status: response.status, body: await response.json() }));
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    let closed = false;
    const closing = runtime.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(runtime.aiStore.quota(member.id).reservedTokens).toBeGreaterThan(0);
    releaseGeneration!();
    expect(await result).toMatchObject({ status: 200, body: { content: "完整回复", quota: { usedTokens: 15, reservedTokens: 0 } } });
    await closing;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(() => runtime.aiStore.quota(member.id)).toThrow();
  });
});
