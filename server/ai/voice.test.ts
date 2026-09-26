import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessInput } from "../../shared/ai";
import type { AiVoiceSettingsInput } from "../../shared/aiVoice";
import type { AiTransport, AiTransportInit } from "./provider";
import { AiError, createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";
import type { VoiceTranscriptionUpload } from "./voiceAudio";
import { bytesFromBase64, chromeLikeWebm, FFMPEG_LIVE_WEBM_1200MS, MP3_BYTES, pcmWav } from "../testSupport/voiceFixtures";

const PROVIDER_KEY = "voice-provider-secret-never-return";
const MP3_AUDIO = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);

function harnessInput(): AiHarnessInput {
  const route = { providerId: "primary", modelId: "chat-model", protocol: "chat_completions" as const, maxOutputTokens: 1024, reasoningEffort: "" as const, capabilities: ["chat" as const], enabled: true };
  return {
    providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "chat_completions", apiKey: PROVIDER_KEY, enabled: true }],
    tiers: { quick: route, standard: route, deep: route, pro: route },
    policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
  };
}

const VOICE: AiVoiceSettingsInput = {
  inputEnabled: true, sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60,
  ttsEngine: "external", ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: 20,
};

describe("AI voice service", () => {
  let database: DatabaseSync;
  let store: AiStore;
  let service: AiService;
  let models: string[];
  let transcript: unknown;
  let providerFailure: Response | Error | undefined;
  let speechResponse: () => Response;
  const calls: Array<{ url: string; init: AiTransportInit }> = [];
  const transport = vi.fn<AiTransport>();
  const requestId = () => `voice-${crypto.randomUUID()}`;
  const recording = (overrides: Partial<VoiceTranscriptionUpload> = {}): VoiceTranscriptionUpload => ({
    requestId: requestId(), durationMs: "2400", language: "zh-CN", declaredType: "audio/webm;codecs=opus", audio: chromeLikeWebm({ durationMs: 2400 }), ...overrides,
  });
  const failure = async (action: Promise<unknown>) => { try { await action; } catch (error) { return error as AiError; } throw new Error("expected a failure"); };
  const providerPosts = () => calls.filter(call => call.init.method === "POST");

  beforeEach(async () => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    store = new AiStore(sql); store.initialize();
    models = ["chat-model", "whisper-1", "tts-1"];
    transcript = "你好，同频";
    providerFailure = undefined;
    speechResponse = () => new Response(MP3_AUDIO, { headers: { "content-type": "audio/mpeg" } });
    calls.length = 0;
    transport.mockReset();
    transport.mockImplementation(async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/models")) return Response.json({ data: models.map(id => ({ id })) });
      if (providerFailure instanceof Error) throw providerFailure;
      if (providerFailure) return providerFailure;
      if (url.endsWith("/audio/transcriptions")) return Response.json({ text: transcript });
      if (url.endsWith("/audio/speech")) return speechResponse();
      throw new Error(`unexpected ${url}`);
    });
    service = new AiService(store, () => createSecretBox("voice-service-test-secret-with-32-bytes"), transport);
    await service.saveHarness(harnessInput());
    await service.discoverHarnessProvider("primary");
    service.setQuota("member", "admin", { limitTokens: 1000 });
    calls.length = 0;
  });
  afterEach(() => database.close());

  it("validates administrator settings and reports member readiness without secrets", async () => {
    expect(service.voice.memberSettings()).toMatchObject({ input: { enabled: false }, speech: { engine: "browser", pointsPer1kChars: 0 } });
    expect((await failure(service.voice.configure({ ...VOICE, sttProviderId: "missing" }))).code).toBe("AI_VOICE_PROVIDER_MISSING");
    expect((await failure(service.voice.configure({ ...VOICE, sttModelId: "" }))).code).toBe("AI_VOICE_MODEL_REQUIRED");
    expect((await failure(service.voice.configure({ ...VOICE, sttPointsPerMinute: 0 }))).code).toBe("AI_VOICE_PRICE_REQUIRED");
    expect((await failure(service.voice.configure({ ...VOICE, sttPointsPerMinute: 1.5 }))).code).toBe("AI_VOICE_SETTINGS_INVALID");
    expect((await failure(service.voice.configure({ ...VOICE, ttsVoice: "" }))).code).toBe("AI_VOICE_SETTINGS_INVALID");
    expect((await failure(service.voice.configure({ ...VOICE, ttsVoice: "al loy" }))).code).toBe("AI_VOICE_SETTINGS_INVALID");
    expect((await failure(service.voice.configure({ ...VOICE, ttsPointsPer1kChars: 0 }))).code).toBe("AI_VOICE_PRICE_REQUIRED");
    expect((await failure(service.voice.configure({ ...VOICE, ttsEngine: "cloud" }))).code).toBe("AI_VOICE_SETTINGS_INVALID");
    // Browser speech and a disabled microphone need no provider at all.
    const minimal = await service.voice.configure({ inputEnabled: false, ttsEngine: "browser" });
    expect(minimal).toMatchObject({ inputEnabled: false, ttsEngine: "browser", sttPointsPerMinute: 0 });

    const saved = await service.voice.configure(VOICE);
    expect(saved).toMatchObject({ ...VOICE, updatedAt: expect.any(String) });
    expect(JSON.stringify(saved)).not.toContain(PROVIDER_KEY);
    expect(service.voice.readiness()).toMatchObject({ input: { ready: true }, speech: { ready: true } });
    expect(service.voice.memberSettings()).toEqual({
      input: { enabled: true, pointsPerMinute: 60, maxSeconds: 60, maxBytes: 10 * 1024 * 1024 },
      speech: { engine: "external", pointsPer1kChars: 20, maxCharacters: 1000 },
    });
    expect(JSON.stringify(service.voice.memberSettings())).not.toMatch(/primary|whisper|tts-1|alloy/);
  });

  it("fails closed until the chosen models are in the key's verified model list", async () => {
    models = ["chat-model"];
    await service.discoverHarnessProvider("primary");
    await service.voice.configure(VOICE);
    expect(service.voice.readiness().input).toMatchObject({ ready: false, message: expect.stringContaining("模型列表") });
    expect(service.voice.memberSettings()).toMatchObject({ input: { enabled: false }, speech: { engine: "browser" } });
    const error = await failure(service.voice.transcribe("member", recording()));
    expect([error.status, error.code]).toEqual([503, "AI_VOICE_NOT_CONFIGURED"]);
    expect(providerPosts()).toHaveLength(0);
    expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });

  it("transcribes through the harness connection, bills per started second and replays the same request id", async () => {
    await service.voice.configure(VOICE);
    const upload = recording();
    const result = await service.voice.transcribe("member", upload);
    expect(result).toMatchObject({ requestId: upload.requestId, text: "你好，同频", durationMs: 2400, usage: { totalTokens: 3, convertedTokens: 3, billingKind: "speech_to_text_conversion" }, quota: { usedTokens: 3, reservedTokens: 0 } });
    const [call] = providerPosts();
    expect(call.url).toBe("https://gateway.example.com/v1/audio/transcriptions");
    expect(call.init.headers.Authorization).toBe(`Bearer ${PROVIDER_KEY}`);
    expect(call.init.headers["Idempotency-Key"]).toMatch(/^tongpin-[a-f0-9]{64}$/);
    expect(call.init.body).toBeUndefined();
    const form = await new Request("https://provider.test", { method: "POST", headers: { "content-type": call.init.headers["Content-Type"] }, body: call.init.binaryBody as Uint8Array<ArrayBuffer> }).formData();
    expect([form.get("model"), form.get("response_format"), form.get("language")]).toEqual(["whisper-1", "json", "zh"]);
    expect(new Uint8Array(await (form.get("file") as File).arrayBuffer())).toEqual(upload.audio);
    expect((form.get("file") as File).name).toBe("audio.webm");

    const ledger = store.usage("member").find(entry => entry.requestId === upload.requestId)!;
    expect(ledger).toMatchObject({ kind: "voice", status: "completed", model: "whisper-1", totalTokens: 3, billingKind: "speech_to_text_conversion" });
    expect(JSON.stringify(ledger)).not.toContain("你好");
    expect(service.memberUsage("member").find(entry => entry.requestId === upload.requestId)?.model).toBe("语音输入");

    const replayed = await service.voice.transcribe("member", upload);
    expect(replayed.text).toBe("你好，同频");
    expect(providerPosts()).toHaveLength(1);
    expect(store.quota("member").usedTokens).toBe(3);
    const conflict = await failure(service.voice.transcribe("member", { ...upload, audio: chromeLikeWebm({ durationMs: 3000 }) }));
    expect([conflict.status, conflict.code]).toEqual([409, "AI_REQUEST_CONFLICT"]);
  });

  it("bills the measured duration when a client under-reports it, and refuses audio over the cap before any call", async () => {
    await service.voice.configure(VOICE);
    const underReported = await service.voice.transcribe("member", recording({ durationMs: "600", audio: bytesFromBase64(FFMPEG_LIVE_WEBM_1200MS) }));
    expect(underReported.durationMs).toBeGreaterThanOrEqual(1180);
    expect(underReported.usage.totalTokens).toBe(2);
    const tooLong = await failure(service.voice.transcribe("member", recording({ durationMs: "30000", audio: chromeLikeWebm({ durationMs: 75_000, clusterMs: 30_000 }) })));
    expect([tooLong.status, tooLong.code]).toEqual([413, "AI_VOICE_AUDIO_TOO_LONG"]);
    expect((await failure(service.voice.transcribe("member", recording({ durationMs: "61001" })))).code).toBe("AI_VOICE_AUDIO_TOO_LONG");
    expect((await failure(service.voice.transcribe("member", recording({ durationMs: "300", audio: pcmWav({ durationMs: 300 }), declaredType: "audio/wav" })))).code).toBe("AI_VOICE_AUDIO_TOO_SHORT");
    expect((await failure(service.voice.transcribe("member", recording({ durationMs: "abc" })))).code).toBe("AI_VOICE_DURATION_INVALID");
    expect(providerPosts()).toHaveLength(1);
    expect(store.quota("member")).toMatchObject({ usedTokens: 2, reservedTokens: 0 });
  });

  it("refuses unsupported or mislabeled audio and invalid ids without reserving", async () => {
    await service.voice.configure(VOICE);
    expect((await failure(service.voice.transcribe("member", recording({ audio: new Uint8Array(MP3_BYTES), declaredType: "audio/mpeg" })))).status).toBe(415);
    expect((await failure(service.voice.transcribe("member", recording({ declaredType: "audio/mpeg" })))).code).toBe("AI_VOICE_AUDIO_UNSUPPORTED");
    expect((await failure(service.voice.transcribe("member", recording({ declaredType: "audio/wav" })))).code).toBe("AI_VOICE_AUDIO_UNSUPPORTED");
    expect((await failure(service.voice.transcribe("member", recording({ requestId: "short" })))).code).toBe("AI_REQUEST_ID_INVALID");
    // A container whose duration cannot be read is accepted only while small.
    const opaque = new Uint8Array(1_600_000);
    opaque.set([0x1a, 0x45, 0xdf, 0xa3, 0x80], 0);
    expect((await failure(service.voice.transcribe("member", recording({ audio: opaque })))).code).toBe("AI_VOICE_AUDIO_UNVERIFIED");
    expect(providerPosts()).toHaveLength(0);
    expect(store.quota("member").reservedTokens).toBe(0);
  });

  it("enforces access, the admin switch and quota before contacting the provider", async () => {
    expect((await failure(service.voice.transcribe("member", recording()))).code).toBe("AI_VOICE_INPUT_DISABLED");
    await service.voice.configure(VOICE);
    const noAccess = await failure(service.voice.transcribe("stranger", recording()));
    expect([noAccess.status, noAccess.code]).toEqual([403, "AI_ACCESS_NOT_GRANTED"]);
    expect(() => service.voice.assertInputAvailable("stranger")).toThrow(AiError);
    service.setQuota("poor", "admin", { limitTokens: 2 });
    const poor = await failure(service.voice.transcribe("poor", recording()));
    expect([poor.status, poor.code]).toEqual([402, "AI_QUOTA_INSUFFICIENT"]);
    expect(providerPosts()).toHaveLength(0);
    expect(store.quota("poor")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });

  it("releases a rejected request, but keeps an uncertain one conservatively charged", async () => {
    await service.voice.configure(VOICE);
    providerFailure = Response.json({ error: { message: PROVIDER_KEY, code: "invalid_api_key" } }, { status: 401 });
    const rejected = await failure(service.voice.transcribe("member", recording()));
    expect(rejected.code).toBe("AI_PROVIDER_AUTH");
    expect(rejected.message).toContain("语音服务");
    expect(rejected.message).not.toContain(PROVIDER_KEY);
    expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
    expect(store.usage("member")[0]).toMatchObject({ kind: "voice", status: "failed", totalTokens: 0, diagnostic: { operation: "audio", httpStatus: 401 } });

    providerFailure = new Response("upstream", { status: 502 });
    expect((await failure(service.voice.transcribe("member", recording()))).code).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(store.quota("member")).toMatchObject({ usedTokens: 3, reservedTokens: 0 });
    expect(store.usage("member")[0]).toMatchObject({ status: "uncertain", totalTokens: 3, estimated: true });

    providerFailure = new TypeError("socket hang up");
    expect((await failure(service.voice.transcribe("member", recording()))).code).toBe("AI_CONNECTION_FAILED");
    expect(store.quota("member")).toMatchObject({ usedTokens: 6, reservedTokens: 0 });

    providerFailure = undefined;
    transcript = { not: "text" };
    expect((await failure(service.voice.transcribe("member", recording()))).code).toBe("AI_VOICE_TRANSCRIPT_INVALID");
    expect(store.quota("member").usedTokens).toBe(9);
  });

  it("settles an interrupted request once on the member's next voice call", async () => {
    await service.voice.configure(VOICE);
    let release!: () => void;
    transport.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; }); return Response.json({ text: "迟到的结果" }); });
    const upload = recording();
    const pending = service.voice.transcribe("member", upload);
    await vi.waitFor(() => expect(store.quota("member").reservedTokens).toBe(3));
    // Simulate a process that died mid-request: its row expires unanswered.
    database.prepare("UPDATE ai_voice_requests SET expires_at=?, data=json_set(data,'$.expiresAt',?)").run(Date.now() - 1, Date.now() - 1);
    await service.voice.transcribe("member", recording());
    expect(store.quota("member")).toMatchObject({ usedTokens: 6, reservedTokens: 0 });
    expect(store.usage("member").find(entry => entry.requestId === upload.requestId)).toMatchObject({ status: "uncertain", totalTokens: 3 });
    release();
    // The late answer cannot bill or settle a second time.
    const late = await pending;
    expect(late.text).toBe("迟到的结果");
    expect(store.quota("member")).toMatchObject({ usedTokens: 6, reservedTokens: 0 });
  });

  it("synthesizes speech only for the external engine, returns audio and bills per 1,000 characters", async () => {
    await service.voice.configure({ ...VOICE, ttsEngine: "browser" });
    const local = await failure(service.voice.speech("member", { requestId: requestId(), text: "你好" }));
    expect([local.status, local.code]).toEqual([409, "AI_VOICE_SPEECH_LOCAL"]);
    await service.voice.configure(VOICE);
    const id = requestId();
    const text = "同频朗读测试。".repeat(10);
    const response = await service.voice.speech("member", { requestId: id, text });
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(MP3_AUDIO);
    const [call] = providerPosts();
    expect(call.url).toBe("https://gateway.example.com/v1/audio/speech");
    expect(JSON.parse(call.init.body!)).toEqual({ model: "tts-1", input: text, voice: "alloy", response_format: "mp3" });
    expect(store.quota("member").usedTokens).toBe(2);
    expect(store.usage("member")[0]).toMatchObject({ kind: "voice", status: "completed", totalTokens: 2, billingKind: "text_to_speech_conversion", model: "tts-1" });
    expect(service.memberUsage("member")[0].model).toBe("语音朗读");
    expect((await failure(service.voice.speech("member", { requestId: id, text }))).code).toBe("AI_REQUEST_CONFLICT");
    expect((await failure(service.voice.speech("member", { requestId: requestId(), text: "字".repeat(1001) }))).code).toBe("AI_VOICE_TEXT_TOO_LONG");
    expect((await failure(service.voice.speech("member", { requestId: requestId(), text: "  " }))).code).toBe("AI_VOICE_TEXT_INVALID");
    expect(providerPosts()).toHaveLength(1);
  });

  it("does not pass a non-audio speech answer to the member", async () => {
    await service.voice.configure(VOICE);
    speechResponse = () => Response.json({ error: "not audio" });
    expect((await failure(service.voice.speech("member", { requestId: requestId(), text: "测试" }))).code).toBe("AI_VOICE_SPEECH_INVALID");
    speechResponse = () => new Response(new TextEncoder().encode("<html>blocked</html>"), { headers: { "content-type": "application/octet-stream" } });
    expect((await failure(service.voice.speech("member", { requestId: requestId(), text: "测试" }))).code).toBe("AI_VOICE_SPEECH_INVALID");
    expect(store.usage("member").slice(0, 2).map(entry => entry.status)).toEqual(["uncertain", "uncertain"]);
  });

  it("keeps settings and requests inside the authenticated tenant", async () => {
    const alpha = service.forTenant("tenant-alpha");
    const beta = service.forTenant("tenant-beta");
    await alpha.saveHarness(harnessInput());
    await alpha.discoverHarnessProvider("primary");
    await alpha.voice.configure(VOICE);
    expect(alpha.voice.memberSettings().input.enabled).toBe(true);
    expect(beta.voice.settings()).toMatchObject({ inputEnabled: false, ttsEngine: "browser" });
    expect(service.voice.settings().inputEnabled).toBe(false);
    alpha.setQuota("member", "admin", { limitTokens: 100 });
    const upload = recording();
    await alpha.voice.transcribe("member", upload);
    beta.setQuota("member", "admin", { limitTokens: 100 });
    expect((await failure(beta.voice.transcribe("member", upload))).code).toBe("AI_VOICE_INPUT_DISABLED");
    expect(alpha.store.quota("member").usedTokens).toBe(3);
    expect(beta.store.quota("member").usedTokens).toBe(0);
  });
});
