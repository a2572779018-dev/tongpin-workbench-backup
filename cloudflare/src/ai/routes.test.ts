import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import { AiService } from "../../../server/ai/service";
import { createSecretBox } from "../../../server/ai/security";
import type { AiTransport } from "../../../server/ai/provider";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";
import { AiPersonaRepository } from "../../../server/ai/persona";

describe("Cloudflare AI route contract with shared transactional service", () => {
  let database: DatabaseSync;
  let store: AiStore;
  let service: AiService;
  const transport = vi.fn<AiTransport>();
  const user = (id: string, role: UserRow["role"] = "member"): UserRow => ({ id, name: id, role, status: "active", email: `${id}@example.com`, password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0, avatar_data_url: null, email_verified_at: "2026-09-05T00:00:00Z", last_login_at: null, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" });
  const admin = user("admin", "admin"), a = user("a"), b = user("b"), boss = user("boss", "boss");
  const provider = { name: "Test", baseUrl: "https://provider.example.com", apiKey: "private-test-key", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true };
  const invoke = (path: string, method: string, actor = admin, body?: unknown, headers: Record<string, string> = {}) => handleAiRequest(new Request(`https://tongpin.example.com${path}`, { method, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), service, actor, () => [admin, a, b, boss]);
  beforeEach(() => {
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
  it("enforces role boundaries before touching AI service", async () => {
    expect((await invoke("/api/admin/ai/provider", "GET", a)).status).toBe(403);
    expect((await invoke("/api/ai/status", "GET", admin)).status).toBe(403);
    expect((await invoke("/api/ai/status", "GET", boss)).status).toBe(403);
    expect(transport).not.toHaveBeenCalled();
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
  it("lists only member identities and never password hashes", async () => {
    const response = await invoke("/api/admin/ai/members", "GET");
    const text = await response.text();
    expect(text).not.toContain("never-return-password");
    expect(JSON.parse(text).members.map((member: { id: string }) => member.id)).toEqual(["a", "b"]);
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
  async function generateOwnedImage() {
    await invoke("/api/admin/ai/provider", "PUT", admin, { ...provider, imageModel: "image-model", imageQuotaTokens: 1000 });
    await invoke("/api/admin/ai/members/a/quota", "PUT", admin, { limitTokens: 10000 });
    transport.mockResolvedValueOnce(Response.json({ data: [{ b64_json: PNG }] }));
    const requestId = crypto.randomUUID();
    const response = await invoke("/api/ai/images", "POST", a, { requestId, prompt: "仅属于成员甲的图片", userId: b.id }, { "X-Tongpin-Account": a.id });
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
  it("prohibits administrators and bosses from member generation, asset and request APIs", async () => {
    for (const actor of [admin, boss]) {
      expect((await invoke("/api/ai/images", "POST", actor, { requestId: crypto.randomUUID(), prompt: "不应发出" })).status).toBe(403);
      expect((await invoke("/api/ai/assets/unknown", "GET", actor)).status).toBe(403);
      expect((await invoke("/api/ai/requests/unknown", "GET", actor)).status).toBe(403);
      expect((await invoke("/api/ai/assets/unknown", "DELETE", actor)).status).toBe(403);
    }
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
