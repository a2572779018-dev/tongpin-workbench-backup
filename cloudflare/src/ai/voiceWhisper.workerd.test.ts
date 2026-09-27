import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare, Response as MfResponse, type V4FetchHandler } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AiTranscriptionResponse } from "../../../shared/aiVoice";
import { pcmWav } from "../../../server/testSupport/voiceFixtures";

const TEST_ADMIN = "whisper-admin@workerd.example.com";
const TEST_MEMBER = "whisper-member@workerd.example.com";
const TEST_PASSWORD = "WorkerdWhisper20260927!";
const WORKER_NAME = "tongpin-ai-whisper-workerd-test";
const AI_FIXTURE = "https://workers-ai-fixture.example.com/run";
type Session = { accessToken: string; user: { id: string; email: string; role: string } };
type WhisperRun = { model: string; input: Record<string, unknown>; signal: boolean; optionKeys: string[] };

/** The production entry and Durable Object, bundled unchanged; only the `AI`
 * binding is replaced by an in-isolate stand-in that forwards each run to the
 * outbound fixture below, so no Workers AI model, account or network is used. */
const ENTRY = `
import worker, { TongpinCore as ProductionCore } from "./cloudflare/src/index.ts";
const fixtureAi = {
  async run(model, input, options) {
    const response = await fetch(${JSON.stringify(AI_FIXTURE)}, {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: options?.signal,
      body: JSON.stringify({ model, input, signal: options?.signal instanceof AbortSignal, optionKeys: Object.keys(options ?? {}) }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    return body;
  },
};
export class TongpinCore extends ProductionCore {
  constructor(ctx, env) { super(ctx, { ...env, AI: fixtureAi }); }
}
export default worker;
`;

describe.sequential("Whisper voice input through the Worker's AI binding", () => {
  let directory: string;
  let mf: Miniflare;
  let admin: Session;
  let member: Session;
  const runs: WhisperRun[] = [];
  const unexpected: string[] = [];
  let answer: { text: string } | { error: string } = { text: "workerd 里的 Whisper 转写。" };
  const outbound: V4FetchHandler = async request => {
    if (request.url !== AI_FIXTURE) { unexpected.push(request.url); return new MfResponse("unexpected outbound request", { status: 599 }); }
    runs.push(await request.json() as WhisperRun);
    return "error" in answer ? MfResponse.json(answer, { status: 500 })
      : MfResponse.json({ ...answer, word_count: 1, segments: [], vtt: "WEBVTT", transcription_info: { language: "zh", duration: 2.4, duration_after_vad: 2 } });
  };
  const call = async (pathname: string, session: Session | undefined, init: { method?: string; body?: BodyInit; headers?: Record<string, string> } = {}) =>
    mf.dispatchFetch(`http://tongpin-whisper.local${pathname}`, {
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
  const transcribe = async (audio: Uint8Array<ArrayBuffer>, durationMs: number) => {
    const form = new FormData();
    form.append("requestId", `voice-${crypto.randomUUID()}`);
    form.append("durationMs", String(durationMs));
    form.append("language", "zh");
    form.append("audio", new Blob([audio], { type: "audio/wav" }), "voice.wav");
    const encoded = new Response(form);
    return call("/api/ai/audio/transcriptions", member, { method: "POST", body: new Uint8Array(await encoded.arrayBuffer()), headers: { "Content-Type": encoded.headers.get("content-type")! } });
  };
  const quota = async () => (await api<{ quota: { usedTokens: number; reservedTokens: number } }>("/api/ai/status", member)).quota;

  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-whisper-workerd-"));
    const bundled = await build({
      stdin: { contents: ENTRY, resolveDir: process.cwd(), sourcefile: "whisper-fixture-entry.ts", loader: "ts" },
      bundle: true, format: "esm", write: false, platform: "browser", conditions: ["workerd"], target: "es2022", external: ["cloudflare:*", "node:*"],
    });
    mf = new Miniflare({ ...convertV4MiniflareOptions({
      name: WORKER_NAME, modules: true, script: bundled.outputFiles[0].text,
      compatibilityDate: "2026-07-28", compatibilityFlags: ["nodejs_compat"],
      durableObjects: { TONGPIN_CORE: { className: "TongpinCore", useSQLite: true } },
      resourcePersistencePath: directory,
      bindings: {
        JWT_SECRET: "workerd-whisper-fixture-secret-".repeat(4), BOOTSTRAP_ADMIN_EMAIL: TEST_ADMIN,
        DEV_EMAIL_PREVIEW: "true", CLIENT_ORIGINS: "http://tongpin-whisper.local",
        AI_ALLOWED_HOSTS: "ai-fixture.example.com", LORA_EXPLORER_API: "https://unused.example.com", LORA_RPC_URL: "https://unused.example.com",
      },
      outboundService: outbound, log: new Log(LogLevel.ERROR),
    }), unsafeInspectDurableObjects: true });
    await mf.ready;
    await register(TEST_ADMIN, "Whisper 验收管理员");
    admin = await login(TEST_ADMIN);
    await register(TEST_MEMBER, "Whisper 验收成员");
    const users = await api<{ users: Array<{ id: string; email: string }> }>("/api/admin/users", admin);
    await api(`/api/admin/users/${users.users.find(item => item.email === TEST_MEMBER)!.id}/access`, admin, { status: "active" }, "PATCH");
    member = await login(TEST_MEMBER);
    await api(`/api/admin/ai/members/${member.user.id}/quota`, admin, { limitTokens: 1000 }, "PUT");
  }, 60_000);
  afterAll(async () => { if (mf) await mf.dispose(); if (directory) await rm(directory, { recursive: true }); });

  it("offers Whisper with no AI service connection configured at all", async () => {
    const saved = await api<{ settings: Record<string, unknown>; readiness: { input: { ready: boolean; message: string } } }>("/api/admin/ai/voice", admin,
      { inputEnabled: true, sttEngine: "whisper", sttPointsPerMinute: 60, ttsEngine: "browser" }, "PUT");
    expect(saved.settings).toMatchObject({ inputEnabled: true, sttEngine: "whisper", sttProviderId: "", sttModelId: "" });
    expect(saved.readiness.input).toMatchObject({ ready: true, message: expect.stringContaining("Whisper") });
    expect(await api("/api/ai/voice", member)).toMatchObject({ settings: { input: { enabled: true, pointsPerMinute: 60 } } });
  });

  it("transcribes the uploaded recording with Whisper through env.AI in the Durable Object and bills it once", async () => {
    const audio = pcmWav({ durationMs: 2400 });
    const response = await transcribe(audio, 2400);
    const result = await response.json() as AiTranscriptionResponse;
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result).toMatchObject({ text: "workerd 里的 Whisper 转写。", durationMs: 2400, usage: { totalTokens: 3 }, quota: { usedTokens: 3, reservedTokens: 0 } });
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run.model).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(run.input).toEqual({
      audio: Buffer.from(audio).toString("base64"), task: "transcribe", language: "zh",
      vad_filter: true, initial_prompt: "以下是普通话的句子，使用简体中文。", condition_on_previous_text: false,
    });
    expect([run.signal, run.optionKeys]).toEqual([true, ["signal"]]);
    expect(unexpected).toEqual([]);
  });

  it("returns no text for a stock caption, and releases the reservation when Workers AI fails", async () => {
    answer = { text: "字幕志愿者 杨茜茜" };
    const silent = await transcribe(pcmWav({ durationMs: 2400 }), 2400);
    expect(await silent.json()).toMatchObject({ text: "", usage: { totalTokens: 3 }, quota: { usedTokens: 6 } });
    answer = { error: "3040: Capacity temporarily exceeded, please try again." };
    const busy = await transcribe(pcmWav({ durationMs: 2400 }), 2400);
    expect(busy.status).toBe(502);
    expect(await busy.json()).toMatchObject({ error: { code: "AI_PROVIDER_LIMIT", message: "语音转写服务繁忙，请稍后重试" } });
    expect(await quota()).toMatchObject({ usedTokens: 6, reservedTokens: 0 });
    expect(runs).toHaveLength(3);
    expect(unexpected).toEqual([]);
  });
});
