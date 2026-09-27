import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_VOICE_LIMITS, type AiTranscriptionResponse } from "../../../shared/aiVoice";
import { pcmWav } from "../../../server/testSupport/voiceFixtures";

const TEST_ADMIN = "voice-admin@workerd.example.com";
const TEST_MEMBER = "voice-member@workerd.example.com";
const TEST_PASSWORD = "WorkerdVoice20260926!";
const TEST_API_KEY = "test-workerd-voice-provider-not-real";
const WORKER_NAME = "tongpin-ai-voice-workerd-test";
type Session = { accessToken: string; user: { id: string; email: string; role: string } };

/** The bundled Worker entry and SQLite Durable Object under workerd. Every
 * outbound request is answered by the fixture below; nothing leaves the test. */
describe.sequential("voice routes in the production Worker and Durable Object", () => {
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  const posts: Array<{ path: string; model: unknown; fileName?: string; fileBytes?: number; body?: unknown }> = [];
  const outbound: V4FetchHandler = async request => {
    const url = new URL(request.url);
    if (url.hostname === "cloudflare-dns.com") return MfResponse.json({ Status: 0, Answer: url.searchParams.get("type") === "A" ? [{ type: 1, data: "1.1.1.1" }] : [] });
    expect(url.hostname).toBe("ai-fixture.example.com");
    expect(request.headers.get("Authorization")).toBe(`Bearer ${TEST_API_KEY}`);
    if (url.pathname === "/v1/models") return MfResponse.json({ data: [{ id: "fixture-chat" }, { id: "whisper-1" }, { id: "tts-1" }] });
    if (url.pathname === "/v1/audio/transcriptions") {
      const form = await request.formData();
      const file = form.get("file") as unknown as { name: string; arrayBuffer(): Promise<ArrayBuffer> };
      posts.push({ path: url.pathname, model: form.get("model"), fileName: file.name, fileBytes: (await file.arrayBuffer()).byteLength });
      return MfResponse.json({ text: "workerd 语音转写" });
    }
    if (url.pathname === "/v1/audio/speech") {
      const body = await request.json() as { model: string };
      posts.push({ path: url.pathname, model: body.model, body });
      return new MfResponse(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0, 0xff, 0xfb, 0x90, 0x64]), { headers: { "Content-Type": "audio/mpeg" } });
    }
    throw new Error(`unexpected outbound ${url}`);
  };
  const call = async (pathname: string, session: Session | undefined, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
    mf.dispatchFetch(`http://tongpin-fixture.local${pathname}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(session ? { Authorization: `Bearer ${session.accessToken}`, "X-Tongpin-Account": session.user.id } : {}), ...init.headers },
      ...(init.body === undefined ? {} : { body: init.body as never }),
    });
  const api = async <T>(pathname: string, session: Session | undefined, body?: unknown, method = body === undefined ? "GET" : "POST", expected = 200): Promise<T> => {
    const response = await call(pathname, session, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) });
    const payload = await response.json() as T;
    expect(response.status, `${method} ${pathname}: ${JSON.stringify(payload)}`).toBe(expected);
    return payload;
  };
  const register = async (email: string, name: string) => {
    const registered = await api<{ debugCode: string }>("/api/auth/register", undefined, { email, name, password: TEST_PASSWORD }, "POST", 201);
    await api("/api/auth/verify-email", undefined, { email, code: registered.debugCode });
  };
  const login = (email: string) => api<Session>("/api/auth/login", undefined, { email, password: TEST_PASSWORD });
  const recording = async (requestId: string, durationMs: number, audio: Uint8Array<ArrayBuffer>) => {
    const form = new FormData();
    form.append("requestId", requestId);
    form.append("durationMs", String(durationMs));
    form.append("audio", new Blob([audio], { type: "audio/wav" }), "voice.wav");
    const encoded = new Response(form);
    return { body: new Uint8Array(await encoded.arrayBuffer()), headers: { "Content-Type": encoded.headers.get("content-type")! } };
  };

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-voice-workerd-"));
    const bundled = await build({ entryPoints: ["cloudflare/src/index.ts"], bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"] });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER_NAME, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "workerd-voice-fixture-secret-".repeat(4), BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN,
        DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-fixture.local",
        AI_ALLOWED_HOSTS: "ai-fixture.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register(TEST_ADMIN, "语音验收管理员");
    admin = await login(TEST_ADMIN);
    await register(TEST_MEMBER, "语音验收成员");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    await api(`/api/admin/users/${users.users.find(item => item.email === TEST_MEMBER)!.id}/access`, admin, { status: "active" }, "PATCH");
    member = await login(TEST_MEMBER);
    const route = { providerId: "primary", modelId: "fixture-chat", protocol: "chat_completions", maxOutputTokens: 1024, reasoningEffort: "", capabilities: ["chat"], enabled: true };
    await api("/api/admin/ai/harness", admin, {
      providers: [{ id: "primary", name: "Fixture", baseUrl: "https://ai-fixture.example.com/v1", protocol: "chat_completions", apiKey: TEST_API_KEY, enabled: true }],
      tiers: { quick: route, standard: route, deep: route, pro: route },
      policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false },
    }, "PUT");
    await api("/api/admin/ai/harness/providers/primary/discover", admin, {});
    await api(`/api/admin/ai/members/${member.user.id}/quota`, admin, { limitTokens: 1000 }, "PUT");
  }, 60_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("saves voice settings through the admin API without exposing the provider key", async () => {
    await api("/api/admin/ai/voice", member, { inputEnabled: false }, "PUT", 403);
    const saved = await api<{ settings: unknown; readiness: { input: { ready: boolean } } }>("/api/admin/ai/voice", admin, {
      inputEnabled: true, sttEngine: "provider", sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60,
      ttsEngine: "external", ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: 10,
    }, "PUT");
    expect(saved.readiness.input.ready).toBe(true);
    expect(JSON.stringify(saved)).not.toContain(TEST_API_KEY);
    expect(await api("/api/ai/voice", member)).toMatchObject({ settings: { input: { enabled: true, pointsPerMinute: 60 }, speech: { engine: "external" } } });
  });

  it("accepts a multipart recording larger than the general API body bound and bills it once", async () => {
    // 56 s of 8 kHz PCM is ~0.9 MB: above the 768 KiB default, within the voice bound.
    const audio = pcmWav({ durationMs: 56_000 });
    expect(audio.byteLength).toBeGreaterThan(768 * 1024);
    const requestId = `voice-${crypto.randomUUID()}`;
    const upload = await recording(requestId, 56_000, audio);
    const response = await call("/api/ai/audio/transcriptions", member, { method: "POST", body: upload.body, headers: upload.headers });
    const result = await response.json() as AiTranscriptionResponse;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ requestId, text: "workerd 语音转写", durationMs: 56_000, usage: { totalTokens: 56 }, quota: { usedTokens: 56, reservedTokens: 0 } });
    expect(posts.filter(item => item.path === "/v1/audio/transcriptions")).toEqual([{ path: "/v1/audio/transcriptions", model: "whisper-1", fileName: "audio.wav", fileBytes: audio.byteLength }]);
    // The same request id replays the transcript without another provider call.
    const replay = await call("/api/ai/audio/transcriptions", member, { method: "POST", body: upload.body, headers: upload.headers });
    expect((await replay.json() as AiTranscriptionResponse).text).toBe("workerd 语音转写");
    expect(posts.filter(item => item.path === "/v1/audio/transcriptions")).toHaveLength(1);
  });

  it("refuses an oversized upload at the outer Worker before the Durable Object or provider", async () => {
    const before = posts.length;
    const upload = await recording(`voice-${crypto.randomUUID()}`, 1000, new Uint8Array(AI_VOICE_LIMITS.uploadBytes + 1));
    const response = await call("/api/ai/audio/transcriptions", member, { method: "POST", body: upload.body, headers: upload.headers });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "PAYLOAD_TOO_LARGE" } });
    expect(posts.length).toBe(before);
  });

  it("returns external speech audio through the Worker", async () => {
    const response = await call("/api/ai/audio/speech", member, { method: "POST", body: JSON.stringify({ requestId: `voice-${crypto.randomUUID()}`, text: "workerd 朗读测试" }), headers: { "Content-Type": "application/json" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("audio/mpeg");
    expect((await response.arrayBuffer()).byteLength).toBe(14);
    expect(posts.at(-1)).toMatchObject({ path: "/v1/audio/speech", model: "tts-1", body: { voice: "alloy", input: "workerd 朗读测试" } });
    const status = await api<{ quota: { usedTokens: number } }>("/api/ai/status", member);
    expect(status.quota.usedTokens).toBe(57);
  });
});
