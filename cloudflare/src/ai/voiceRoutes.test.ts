import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiStore, type AiSql } from "../../../server/ai/storage";
import { AiService } from "../../../server/ai/service";
import { createSecretBox } from "../../../server/ai/security";
import type { AiTransport } from "../../../server/ai/provider";
import { chromeLikeWebm } from "../../../server/testSupport/voiceFixtures";
import type { UserRow } from "../platform";
import { handleAiRequest } from "./routes";

const VOICE = {
  inputEnabled: true, sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 30,
  ttsEngine: "external", ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: 10,
};

describe("Worker voice routes on the shared service", () => {
  let database: DatabaseSync;
  let service: AiService;
  const transport = vi.fn<AiTransport>();
  const user = (id: string, role: UserRow["role"] = "member"): UserRow => ({ id, name: id, role, status: "active", email: `${id}@example.com`, password_hash: "never-return-password", job_title: "", avatar_seed: 1, avatar_version: 0, avatar_data_url: null, email_verified_at: "2026-09-05T00:00:00Z", last_login_at: null, created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z" });
  const admin = user("admin", "admin"), member = user("member");
  const invoke = (path: string, method: string, actor: UserRow, body?: BodyInit, headers: Record<string, string> = {}) =>
    handleAiRequest(new Request(`https://tongpin.example.com${path}`, { method, headers, ...(body === undefined ? {} : { body }) }), service, actor, () => [admin, member]);
  const jsonBody = (value: unknown) => [JSON.stringify(value), { "content-type": "application/json" }] as const;
  const multipart = async (fields: Record<string, string>, audio: Uint8Array<ArrayBuffer>) => {
    const form = new FormData();
    for (const [name, value] of Object.entries(fields)) form.append(name, value);
    form.append("audio", new Blob([audio], { type: "audio/webm;codecs=opus" }), "voice.webm");
    const encoded = new Response(form);
    return { body: await encoded.arrayBuffer(), headers: { "content-type": encoded.headers.get("content-type")! } };
  };

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    const store = new AiStore(sql); store.initialize();
    transport.mockReset();
    transport.mockImplementation(async url => url.endsWith("/models") ? Response.json({ data: [{ id: "chat-model" }, { id: "whisper-1" }, { id: "tts-1" }] })
      : url.endsWith("/audio/transcriptions") ? Response.json({ text: "Worker 转写" })
        : new Response(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb]), { headers: { "content-type": "audio/mpeg" } }));
    service = new AiService(store, () => createSecretBox("worker-voice-route-secret-with-32-bytes"), transport);
    const route = { providerId: "primary", modelId: "chat-model", protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities: ["chat" as const], enabled: true };
    await service.saveHarness({
      providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey: "worker-voice-provider-key", enabled: true }],
      tiers: { quick: route, standard: route, deep: route, pro: route },
      policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
    });
    await service.discoverHarnessProvider("primary");
    service.setQuota("member", "admin", { limitTokens: 100 });
    transport.mockClear();
  });
  afterEach(() => database.close());

  it("routes admin and member voice paths only behind their role checks", async () => {
    const [body, headers] = jsonBody(VOICE);
    expect((await invoke("/api/admin/ai/voice", "PUT", member, body, headers)).status).toBe(403);
    const saved = await invoke("/api/admin/ai/voice", "PUT", admin, body, headers);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect(await saved.json()).toMatchObject({ settings: { sttModelId: "whisper-1" }, readiness: { input: { ready: true } } });
    expect((await invoke("/api/admin/ai/voice", "DELETE", admin)).status).toBe(404);
    expect((await invoke("/api/ai/voice", "GET", admin)).status).toBe(403);
    expect(await (await invoke("/api/ai/voice", "GET", member)).json()).toMatchObject({ settings: { input: { enabled: true, pointsPerMinute: 30 }, speech: { engine: "external" } } });
    expect((await invoke("/api/ai/voice", "GET", member, undefined, { "X-Tongpin-Account": "admin" })).status).toBe(409);
  });

  it("parses a multipart recording inside the Worker handler and bills the member", async () => {
    const [body, headers] = jsonBody(VOICE);
    await invoke("/api/admin/ai/voice", "PUT", admin, body, headers);
    const requestId = `voice-${crypto.randomUUID()}`;
    const upload = await multipart({ requestId, durationMs: "4000" }, chromeLikeWebm({ durationMs: 4000 }));
    const response = await invoke("/api/ai/audio/transcriptions", "POST", member, upload.body, upload.headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ requestId, text: "Worker 转写", durationMs: 4000, usage: { totalTokens: 2 }, quota: { usedTokens: 2 } });
    const wrongType = await invoke("/api/ai/audio/transcriptions", "POST", member, "{}", { "content-type": "application/json" });
    expect([wrongType.status, (await wrongType.json() as { error: { code: string } }).error.code]).toEqual([415, "AI_VOICE_UPLOAD_INVALID"]);
    expect(transport.mock.calls.filter(([url]) => url.endsWith("/audio/transcriptions"))).toHaveLength(1);
  });

  it("returns speech audio from the Worker handler", async () => {
    const [body, headers] = jsonBody(VOICE);
    await invoke("/api/admin/ai/voice", "PUT", admin, body, headers);
    const [speechBody, speechHeaders] = jsonBody({ requestId: `voice-${crypto.randomUUID()}`, text: "Worker 朗读" });
    const response = await invoke("/api/ai/audio/speech", "POST", member, speechBody, speechHeaders);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect((await response.arrayBuffer()).byteLength).toBe(12);
  });
});
