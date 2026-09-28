import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessInput } from "../../shared/ai";
import { AI_VOICE_WHISPER_MODEL, type AiVoiceSettingsInput } from "../../shared/aiVoice";
import type { AiTransport, AiTransportInit } from "./provider";
import { AiError, createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";
import { isWhisperHallucination, withoutWhisperOutro, type AiWhisperRunner } from "./voice";
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
  inputEnabled: true, sttEngine: "provider", sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60,
  ttsEngine: "external", ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: 20,
};

const WHISPER_VOICE = { inputEnabled: true, sttEngine: "whisper", sttPointsPerMinute: 60, ttsEngine: "browser" } as const;
const MANDARIN_PROMPT = "以下是普通话的句子，使用简体中文。";

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

  describe("Whisper engine (Workers AI)", () => {
    let whisperOutput: unknown;
    let whisperError: unknown;
    const whisperRun = vi.fn<AiWhisperRunner>();
    /** The Worker's service: same store, plus the env.AI runner. */
    const withWhisper = () => new AiService(store, () => createSecretBox("voice-service-test-secret-with-32-bytes"), transport, undefined, undefined, whisperRun);
    const lastInput = () => whisperRun.mock.calls.at(-1)![0];
    const requestRecord = (requestId: unknown) => JSON.parse((database.prepare("SELECT data FROM ai_voice_requests WHERE request_id=?").get(String(requestId)) as { data: string }).data) as Record<string, unknown>;
    const thrown = (action: () => void) => { try { action(); } catch (error) { return error as AiError; } throw new Error("expected a failure"); };

    beforeEach(() => {
      whisperOutput = { text: " 你好，同频。", word_count: 2, segments: [], vtt: "WEBVTT", transcription_info: { language: "zh", language_probability: 0.98, duration: 2.4, duration_after_vad: 2.1 }, usage: {} };
      whisperError = undefined;
      whisperRun.mockReset();
      whisperRun.mockImplementation(async () => {
        if (whisperError !== undefined) throw whisperError;
        return whisperOutput;
      });
    });

    it("is the default, also for settings saved before the engine choice existed", async () => {
      const whisper = withWhisper();
      expect(whisper.voice.settings()).toMatchObject({ inputEnabled: false, sttEngine: "whisper" });
      // A row written by the previous release: provider fields, no engine.
      database.prepare("INSERT INTO ai_settings(id,tenant_id,data) VALUES('voice','default',?)").run(JSON.stringify({
        inputEnabled: true, sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60,
        ttsEngine: "browser", ttsProviderId: "", ttsModelId: "", ttsVoice: "", ttsPointsPer1kChars: 0, updatedAt: "2026-09-26T00:00:00.000Z",
      }));
      expect(whisper.voice.settings()).toMatchObject({ sttEngine: "whisper", sttProviderId: "primary", sttModelId: "whisper-1" });
      expect(whisper.voice.readiness().input).toEqual({ ready: true, message: expect.stringContaining("Whisper") });
      expect(whisper.voice.memberSettings().input).toMatchObject({ enabled: true, pointsPerMinute: 60 });
      await whisper.voice.transcribe("member", recording());
      expect(whisperRun).toHaveBeenCalledTimes(1);
      expect(providerPosts()).toHaveLength(0);
      // Anything unknown is read as Whisper as well.
      database.prepare("UPDATE ai_settings SET data=json_set(data,'$.sttEngine','cloud') WHERE id='voice'").run();
      expect(whisper.voice.settings().sttEngine).toBe("whisper");
    });

    it("needs no service connection, keeps a saved one for switching back, and keeps the engine for older admin clients", async () => {
      const whisper = withWhisper();
      expect(await whisper.voice.configure(WHISPER_VOICE)).toMatchObject({ inputEnabled: true, sttEngine: "whisper", sttProviderId: "", sttModelId: "", sttPointsPerMinute: 60 });
      expect((await failure(whisper.voice.configure({ ...WHISPER_VOICE, sttPointsPerMinute: 0 }))).code).toBe("AI_VOICE_PRICE_REQUIRED");
      expect((await failure(whisper.voice.configure({ ...WHISPER_VOICE, sttEngine: "cloud" }))).code).toBe("AI_VOICE_SETTINGS_INVALID");
      // A saved connection that has since been removed neither blocks Whisper nor is dropped.
      const kept = await whisper.voice.configure({ ...WHISPER_VOICE, sttProviderId: "retired", sttModelId: "whisper-1" });
      expect(kept).toMatchObject({ sttEngine: "whisper", sttProviderId: "retired", sttModelId: "whisper-1" });
      expect(whisper.voice.readiness().input.ready).toBe(true);
      expect((await failure(whisper.voice.configure({ ...kept, sttEngine: "provider" }))).code).toBe("AI_VOICE_PROVIDER_MISSING");
      await whisper.voice.configure(VOICE);
      const { sttEngine: _omitted, ...legacyClient } = VOICE;
      expect((await whisper.voice.configure(legacyClient)).sttEngine).toBe("provider");
      await whisper.voice.configure(WHISPER_VOICE);
      expect((await whisper.voice.configure({ ...legacyClient, sttProviderId: "", sttModelId: "" })).sttEngine).toBe("whisper");
    });

    it("sends the upload as-is with the exact Whisper inputs, bills by duration and records the model", async () => {
      const whisper = withWhisper();
      await whisper.voice.configure(WHISPER_VOICE);
      const upload = recording();
      const result = await whisper.voice.transcribe("member", upload);
      expect(result).toMatchObject({
        requestId: upload.requestId, text: "你好，同频。", durationMs: 2400,
        usage: { totalTokens: 3, convertedTokens: 3, estimated: false, billingKind: "speech_to_text_conversion" }, quota: { usedTokens: 3, reservedTokens: 0 },
      });
      expect(whisperRun).toHaveBeenCalledTimes(1);
      const [input, signal] = whisperRun.mock.calls[0];
      expect(input).toEqual({
        audio: Buffer.from(upload.audio).toString("base64"), task: "transcribe", language: "zh",
        vad_filter: true, initial_prompt: MANDARIN_PROMPT, condition_on_previous_text: false,
      });
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      // No provider connection is contacted (nor its key decrypted for a request).
      expect(calls).toHaveLength(0);

      const ledger = store.usage("member").find(entry => entry.requestId === upload.requestId)!;
      expect(ledger).toMatchObject({ kind: "voice", status: "completed", model: AI_VOICE_WHISPER_MODEL, totalTokens: 3, billingKind: "speech_to_text_conversion" });
      expect(ledger.reason).toContain("Whisper");
      expect(JSON.stringify(ledger)).not.toContain("你好");
      expect(requestRecord(upload.requestId)).toMatchObject({ status: "completed", model: AI_VOICE_WHISPER_MODEL, providerId: "workers-ai", chargedPoints: 3 });
      expect(service.memberUsage("member").find(entry => entry.requestId === upload.requestId)?.model).toBe("语音输入");

      // The same request id replays without another run or charge.
      expect((await whisper.voice.transcribe("member", upload)).text).toBe("你好，同频。");
      expect(whisperRun).toHaveBeenCalledTimes(1);
      expect(store.quota("member")).toMatchObject({ usedTokens: 3, reservedTokens: 0 });
      // Other containers are passed through unconverted too.
      const wav = recording({ durationMs: "1500", audio: pcmWav({ durationMs: 1500 }), declaredType: "audio/wav" });
      await whisper.voice.transcribe("member", wav);
      expect(lastInput().audio).toBe(Buffer.from(wav.audio).toString("base64"));
    });

    it("uses a valid client language and otherwise asks for Mandarin", async () => {
      const whisper = withWhisper();
      await whisper.voice.configure(WHISPER_VOICE);
      await whisper.voice.transcribe("member", recording({ language: undefined }));
      expect(lastInput()).toMatchObject({ language: "zh", initial_prompt: MANDARIN_PROMPT, vad_filter: true, condition_on_previous_text: false });
      await whisper.voice.transcribe("member", recording({ language: "中文" }));
      expect(lastInput().language).toBe("zh");
      await whisper.voice.transcribe("member", recording({ language: "en-US" }));
      // The Mandarin prompt would mislead Whisper about another language.
      expect(lastInput()).toEqual({ audio: expect.any(String), task: "transcribe", language: "en", vad_filter: true, condition_on_previous_text: false });
    });

    it("returns no text for stock captions and runaway loops, billed like any empty result", async () => {
      const whisper = withWhisper();
      await whisper.voice.configure(WHISPER_VOICE);
      const heard: string[] = [];
      for (const text of ["字幕志愿者 杨茜茜", "感谢观看", "", "谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢", "今天感谢观看直播的朋友们"]) {
        whisperOutput = { text };
        const result = await whisper.voice.transcribe("member", recording());
        expect(result.usage.totalTokens).toBe(3);
        heard.push(result.text);
      }
      expect(heard).toEqual(["", "", "", "", "今天感谢观看直播的朋友们"]);
      expect(store.quota("member")).toMatchObject({ usedTokens: 15, reservedTokens: 0 });
      const entries = store.usage("member").filter(entry => entry.kind === "voice");
      expect(entries.filter(entry => entry.reason.includes("未识别到清晰语音"))).toHaveLength(4);
      expect(JSON.stringify(entries)).not.toMatch(/杨茜茜|感谢观看/);
    });

    it("releases the reservation and returns a fixed message when Workers AI fails", async () => {
      const whisper = withWhisper();
      await whisper.voice.configure(WHISPER_VOICE);
      whisperError = new Error("3010: Invalid or incomplete input for the model: audio 'GkXfo59Ch' secret-upstream-detail");
      const upload = recording();
      const failed = await failure(whisper.voice.transcribe("member", upload));
      expect([failed.status, failed.code, failed.message]).toEqual([502, "AI_PROVIDER_UNAVAILABLE", "语音转写暂时不可用，请稍后重试"]);
      expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
      expect(store.usage("member")[0]).toMatchObject({ kind: "voice", status: "failed", totalTokens: 0, model: AI_VOICE_WHISPER_MODEL });
      expect(requestRecord(upload.requestId)).toMatchObject({ status: "failed", chargedPoints: 0, providerId: "workers-ai" });
      expect(JSON.stringify([store.usage("member"), requestRecord(upload.requestId)])).not.toMatch(/secret-upstream-detail|GkXfo59Ch/);
      // The same id replays the stored failure; it is not run again.
      expect((await failure(whisper.voice.transcribe("member", upload))).code).toBe("AI_PROVIDER_UNAVAILABLE");
      expect(whisperRun).toHaveBeenCalledTimes(1);

      whisperError = new Error("4006: you have used up your daily free allocation of 10,000 neurons, please upgrade to Cloudflare's Workers Paid plan if you would like to continue usage.");
      const daily = await failure(whisper.voice.transcribe("member", recording()));
      expect([daily.code, daily.message]).toEqual(["AI_PROVIDER_LIMIT", "今天的免费语音转写额度已用完，请明天再试或联系管理员"]);
      whisperError = new Error("3040: Capacity temporarily exceeded, please try again.");
      expect((await failure(whisper.voice.transcribe("member", recording()))).message).toBe("语音转写服务繁忙，请稍后重试");
      whisperRun.mockImplementationOnce(() => { throw new TypeError("binding exploded synchronously"); });
      expect((await failure(whisper.voice.transcribe("member", recording()))).code).toBe("AI_PROVIDER_UNAVAILABLE");

      whisperError = undefined;
      whisperOutput = { response: "not a transcription" };
      expect((await failure(whisper.voice.transcribe("member", recording()))).code).toBe("AI_VOICE_TRANSCRIPT_INVALID");
      whisperOutput = { text: Array.from({ length: 20_001 }, (_, index) => String.fromCharCode(0x4e00 + index % 4000)).join("") };
      expect((await failure(whisper.voice.transcribe("member", recording()))).message).toContain("过长");
      expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
      expect(store.usage("member").filter(entry => entry.kind === "voice").map(entry => [entry.status, entry.totalTokens]))
        .toEqual(Array.from({ length: 6 }, () => ["failed", 0]));
    });

    it("stops waiting at the transcription timeout even if the run ignores the abort, and releases the reservation", async () => {
      const whisper = withWhisper();
      await whisper.voice.configure(WHISPER_VOICE);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let ignored: AbortSignal | undefined;
        whisperRun.mockImplementationOnce((_input, signal) => { ignored = signal; return new Promise(() => undefined); });
        const hanging = failure(whisper.voice.transcribe("member", recording()));
        await vi.waitFor(() => expect(ignored).toBeDefined());
        expect(store.quota("member").reservedTokens).toBe(3);
        await vi.advanceTimersByTimeAsync(89_000);
        expect(ignored!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(1_000);
        const timedOut = await hanging;
        expect([timedOut.status, timedOut.code, timedOut.message]).toEqual([502, "AI_CONNECTION_FAILED", "语音转写超时，请稍后重试"]);
        expect(ignored!.aborted).toBe(true);
        expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });

        // A run that honours the signal ends the same way.
        let honoured: AbortSignal | undefined;
        whisperRun.mockImplementationOnce((_input, signal) => new Promise((_resolve, reject) => {
          honoured = signal;
          signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
        }));
        const aborted = failure(whisper.voice.transcribe("member", recording()));
        await vi.waitFor(() => expect(honoured).toBeDefined());
        await vi.advanceTimersByTimeAsync(90_000);
        expect((await aborted).code).toBe("AI_CONNECTION_FAILED");
        expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
        expect(store.usage("member").slice(0, 2).map(entry => [entry.status, entry.totalTokens])).toEqual([["failed", 0], ["failed", 0]]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails closed without Workers AI (the Node server) and never falls back to the paid provider", async () => {
      // `service` has no Whisper runner, while the provider route is fully configured and verified.
      await service.voice.configure({ ...VOICE, sttEngine: "whisper" });
      expect(service.voice.readiness().input).toEqual({ ready: false, message: "Whisper 语音转写只能在云端服务使用，请在管理后台改用接口转写" });
      expect(service.voice.memberSettings().input).toMatchObject({ enabled: false, pointsPerMinute: 0 });
      const early = thrown(() => service.voice.assertInputAvailable("member"));
      expect([early.status, early.code]).toEqual([503, "AI_VOICE_NOT_CONFIGURED"]);
      const refused = await failure(service.voice.transcribe("member", recording()));
      expect([refused.status, refused.code]).toEqual([503, "AI_VOICE_NOT_CONFIGURED"]);
      expect(refused.message).toContain("只能在云端服务使用");
      expect(calls).toHaveLength(0);
      expect(store.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
      // 接口转写 works on this server once chosen.
      await service.voice.configure(VOICE);
      expect(service.voice.readiness().input.ready).toBe(true);
      expect((await service.voice.transcribe("member", recording())).text).toBe("你好，同频");
    });

    it("keeps the provider engine on its own path even where Workers AI exists", async () => {
      const whisper = withWhisper();
      await whisper.voice.configure(VOICE);
      expect(whisper.voice.readiness().input).toEqual({ ready: true, message: "成员可以使用语音输入" });
      expect((await whisper.voice.transcribe("member", recording())).text).toBe("你好，同频");
      expect(whisperRun).not.toHaveBeenCalled();
      expect(providerPosts()).toHaveLength(1);
      expect(store.usage("member")[0]).toMatchObject({ model: "whisper-1", status: "completed" });
    });

    it("carries the runner into every tenant's service", async () => {
      const alpha = withWhisper().forTenant("tenant-alpha");
      await alpha.voice.configure(WHISPER_VOICE);
      alpha.setQuota("member", "admin", { limitTokens: 100 });
      expect(alpha.voice.readiness().input.ready).toBe(true);
      expect((await alpha.voice.transcribe("member", recording())).usage.totalTokens).toBe(3);
      expect(whisperRun).toHaveBeenCalledTimes(1);
      expect(alpha.store.quota("member").usedTokens).toBe(3);
      expect(service.voice.settings().inputEnabled).toBe(false);
    });
  });
});

describe("Whisper hallucination guard", () => {
  it("recognizes Whisper's stock captions, alone or repeated, in either script", () => {
    for (const text of [
      "字幕志愿者 杨茜茜", "字幕志愿者：李宗盛", "字幕志愿者", "感谢观看", "谢谢观看。", "谢谢大家！", "欢迎订阅", "明镜与点点",
      "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", "字幕由Amara.org社区提供", "优优独播剧场——YoYo Television Series Exclusive",
      "优优独播剧场 —— ＹｏＹｏ Television Series Exclusive", "谢谢观看 谢谢观看", "感謝觀看", "字幕志願者 楊茜茜", "Thank you for watching!",
    ]) expect(isWhisperHallucination(text), text).toBe(true);
  });

  it("treats a punctuation-only result as no speech", () => {
    for (const text of ["……", "。", " ... ", "？！"]) expect(isWhisperHallucination(text), text).toBe(true);
  });

  it("recognizes a runaway repetition of a short unit", () => {
    for (const text of ["我我我我我我我我", "谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢谢", "嗯，嗯，嗯，嗯，嗯，嗯，嗯，嗯", "你好你好你好你好你好你好你好你好", "ha ha ha ha ha ha ha ha", "今天开会啊啊啊啊啊啊啊啊啊"]) {
      expect(isWhisperHallucination(text), text).toBe(true);
    }
  });

  it("treats a transcribed cough as no speech", () => {
    for (const text of ["咳咳咳", "咳，咳。", "咳"]) expect(isWhisperHallucination(text), text).toBe(true);
    expect(isWhisperHallucination("咳嗽了一整天")).toBe(false);
  });

  it("drops a video outro appended to real speech, and nothing else", () => {
    expect(withoutWhisperOutro("帮我生成一张图片。 感谢观看")).toBe("帮我生成一张图片。");
    expect(withoutWhisperOutro("帮我生成一张图片，谢谢观看！")).toBe("帮我生成一张图片");
    expect(withoutWhisperOutro("明天开会 Thanks for watching.")).toBe("明天开会");
    for (const text of ["今天感谢观看直播的朋友们", "今天就到这里，谢谢大家", "感谢观看", "你好"]) expect(withoutWhisperOutro(text), text).toBe(text);
  });

  it("keeps real speech, including sentences that merely contain a stock phrase, numbers and short repeats", () => {
    for (const text of [
      "", "你好，同频。", "谢谢", "今天感谢观看直播的朋友们", "字幕志愿者招募的事情我们明天再讨论一下", "对对对，就是这样",
      "我的电话是13800000000", "预算一共100000000元", "哈哈哈哈哈哈哈", "Thank you", "Hello, how are you?", "……好的",
    ]) expect(isWhisperHallucination(text), text).toBe(false);
  });
});
