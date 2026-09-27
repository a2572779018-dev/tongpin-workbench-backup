import express, { type NextFunction, type Request, type Response } from "express";
import type { Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_VOICE_LIMITS } from "../../shared/aiVoice";
import { createAiRouter } from "../routes/ai";
import type { JsonStore } from "../store";
import type { PublicUser } from "../types";
import type { AiTransport } from "./provider";
import { createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";
import { closeServer, listenLoopback } from "../testSupport/loopbackServer";
import { chromeLikeWebm } from "../testSupport/voiceFixtures";

const VOICE = {
  inputEnabled: true, sttEngine: "provider", sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60,
  ttsEngine: "external", ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: 20,
};
const MP3_AUDIO = Buffer.from([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]);

describe("Node voice routes", () => {
  let database: DatabaseSync;
  let service: AiService;
  let http: Server | undefined;
  const transport = vi.fn<AiTransport>();
  const posts = () => transport.mock.calls.filter(([, init]) => init.method === "POST");
  const as = (id: string) => ({ "X-Test-User": id, "X-Tongpin-Account": id });

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
      : url.endsWith("/audio/transcriptions") ? Response.json({ text: "路由转写结果" })
        : new Response(MP3_AUDIO, { headers: { "content-type": "audio/mpeg" } }));
    service = new AiService(store, () => createSecretBox("node-voice-route-secret-with-32-bytes"), transport);
    const route = { providerId: "primary", modelId: "chat-model", protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities: ["chat" as const], enabled: true };
    await service.saveHarness({
      providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey: "node-voice-route-provider-key", enabled: true }],
      tiers: { quick: route, standard: route, deep: route, pro: route },
      policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
    });
    await service.discoverHarnessProvider("primary");
    service.setQuota("member", "admin", { limitTokens: 500 });
    transport.mockClear();
    const users = { read: async <T>(read: (value: { users: PublicUser[] }) => T) => read({ users: [] }) } as unknown as JsonStore;
    const requireAuth = async (incoming: Request, _response: Response, next: NextFunction) => {
      const id = incoming.get("X-Test-User") ?? "member";
      incoming.currentUser = { id, email: `${id}@example.test`, name: id, role: id === "admin" ? "admin" : "member", status: "active", jobTitle: "", avatarSeed: 1, avatarVersion: 0 } as PublicUser;
      next();
    };
    const app = express();
    app.use(express.json({ limit: "768kb" }));
    const auth = requireAuth as ReturnType<typeof import("../middleware").createRequireAuth>;
    app.use("/api/admin/ai", createAiRouter(service, users, auth, true));
    app.use("/api/ai", createAiRouter(service, users, auth, false));
    http = await listenLoopback(app);
  });
  afterEach(async () => { await closeServer(http); http = undefined; database.close(); });

  it("keeps voice configuration admin-only and the member view free of provider identity", async () => {
    await request(http!).put("/api/admin/ai/voice").set(as("member")).send(VOICE).expect(403);
    const saved = await request(http!).put("/api/admin/ai/voice").set(as("admin")).send(VOICE).expect(200);
    expect(saved.headers["cache-control"]).toContain("no-store");
    expect(saved.body).toMatchObject({ settings: { inputEnabled: true, sttModelId: "whisper-1" }, readiness: { input: { ready: true }, speech: { ready: true } } });
    expect(JSON.stringify(saved.body)).not.toContain("node-voice-route-provider-key");
    expect((await request(http!).get("/api/admin/ai/voice").set(as("admin")).expect(200)).body.settings.ttsVoice).toBe("alloy");
    await request(http!).get("/api/ai/voice").set(as("admin")).expect(403);
    const member = await request(http!).get("/api/ai/voice").set(as("member")).expect(200);
    expect(member.body).toEqual({ settings: { input: { enabled: true, pointsPerMinute: 60, maxSeconds: 60, maxBytes: AI_VOICE_LIMITS.maxAudioBytes }, speech: { engine: "external", pointsPer1kChars: 20, maxCharacters: 1000 } } });
    expect((await request(http!).put("/api/admin/ai/voice").set(as("admin")).send({ ...VOICE, sttProviderId: "nope" }).expect(400)).body.error.code).toBe("AI_VOICE_PROVIDER_MISSING");
  });

  it("transcribes a multipart recording for the authenticated member", async () => {
    await request(http!).put("/api/admin/ai/voice").set(as("admin")).send(VOICE).expect(200);
    const requestId = `voice-${crypto.randomUUID()}`;
    const response = await request(http!).post("/api/ai/audio/transcriptions").set(as("member"))
      .field("requestId", requestId).field("durationMs", "2400")
      .attach("audio", Buffer.from(chromeLikeWebm({ durationMs: 2400 })), { filename: "voice.webm", contentType: "audio/webm;codecs=opus" })
      .expect(200);
    expect(response.body).toMatchObject({ requestId, text: "路由转写结果", durationMs: 2400, quota: { usedTokens: 3 } });
    expect(posts()).toHaveLength(1);
    expect(posts()[0][0]).toBe("https://gateway.example.com/v1/audio/transcriptions");
  });

  it("rejects account mismatches, disabled input, non-multipart and oversized bodies before any provider call", async () => {
    const small = Buffer.from(chromeLikeWebm({ durationMs: 1000 }));
    const disabled = await request(http!).post("/api/ai/audio/transcriptions").set(as("member"))
      .field("requestId", `voice-${crypto.randomUUID()}`).field("durationMs", "1000").attach("audio", small, { filename: "a.webm", contentType: "audio/webm" }).expect(403);
    expect(disabled.body.error.code).toBe("AI_VOICE_INPUT_DISABLED");
    await request(http!).put("/api/admin/ai/voice").set(as("admin")).send(VOICE).expect(200);
    // AI_ACCOUNT_CHANGED is an ApiError rendered by the app-level error handler (not mounted here).
    await request(http!).post("/api/ai/audio/transcriptions").set({ "X-Test-User": "member", "X-Tongpin-Account": "someone-else" })
      .field("requestId", `voice-${crypto.randomUUID()}`).field("durationMs", "1000").attach("audio", small, { filename: "a.webm", contentType: "audio/webm" }).expect(409);
    const json = await request(http!).post("/api/ai/audio/transcriptions").set(as("member")).send({ audio: "AAAA" }).expect(415);
    expect(json.body.error.code).toBe("AI_VOICE_UPLOAD_INVALID");
    const huge = await request(http!).post("/api/ai/audio/transcriptions").set(as("member"))
      .field("requestId", `voice-${crypto.randomUUID()}`).field("durationMs", "1000")
      .attach("audio", Buffer.alloc(AI_VOICE_LIMITS.uploadBytes + 1024), { filename: "big.webm", contentType: "audio/webm" }).expect(413);
    expect(huge.body.error.code).toBe("AI_VOICE_AUDIO_TOO_LARGE");
    expect(posts()).toHaveLength(0);
  });

  it("reports Whisper unavailable on the Node server and refuses uploads without touching the provider", async () => {
    const saved = await request(http!).put("/api/admin/ai/voice").set(as("admin")).send({ inputEnabled: true, sttEngine: "whisper", sttPointsPerMinute: 60, ttsEngine: "browser" }).expect(200);
    expect(saved.body).toMatchObject({
      settings: { inputEnabled: true, sttEngine: "whisper", sttProviderId: "", sttModelId: "" },
      readiness: { input: { ready: false, message: "Whisper 语音转写只能在云端服务使用，请在管理后台改用接口转写" } },
    });
    expect((await request(http!).get("/api/ai/voice").set(as("member")).expect(200)).body.settings.input).toMatchObject({ enabled: false, pointsPerMinute: 0 });
    const refused = await request(http!).post("/api/ai/audio/transcriptions").set(as("member"))
      .field("requestId", `voice-${crypto.randomUUID()}`).field("durationMs", "1000").field("language", "zh")
      .attach("audio", Buffer.from(chromeLikeWebm({ durationMs: 1000 })), { filename: "a.webm", contentType: "audio/webm" }).expect(503);
    expect(refused.body.error.code).toBe("AI_VOICE_NOT_CONFIGURED");
    expect(posts()).toHaveLength(0);
    // Switching the engine to 接口转写 restores voice input here.
    await request(http!).put("/api/admin/ai/voice").set(as("admin")).send(VOICE).expect(200);
    expect((await request(http!).get("/api/ai/voice").set(as("member")).expect(200)).body.settings.input.enabled).toBe(true);
  });

  it("returns synthesized audio bytes with no-store caching", async () => {
    await request(http!).put("/api/admin/ai/voice").set(as("admin")).send({ ...VOICE, ttsEngine: "browser" }).expect(200);
    expect((await request(http!).post("/api/ai/audio/speech").set(as("member")).send({ requestId: `voice-${crypto.randomUUID()}`, text: "你好" }).expect(409)).body.error.code).toBe("AI_VOICE_SPEECH_LOCAL");
    await request(http!).put("/api/admin/ai/voice").set(as("admin")).send(VOICE).expect(200);
    const response = await request(http!).post("/api/ai/audio/speech").set(as("member"))
      .send({ requestId: `voice-${crypto.randomUUID()}`, text: "你好，这是朗读。" }).buffer(true).parse((res, done) => {
        const chunks: Buffer[] = []; res.on("data", (chunk: Buffer) => chunks.push(chunk)); res.on("end", () => done(null, Buffer.concat(chunks)));
      }).expect(200);
    expect(response.headers["content-type"]).toBe("audio/mpeg");
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(Buffer.compare(response.body as Buffer, MP3_AUDIO)).toBe(0);
    await request(http!).post("/api/ai/audio/speech").set(as("admin")).send({ requestId: `voice-${crypto.randomUUID()}`, text: "你好" }).expect(403);
  });
});
