import type { AiQuota, AiUsage } from "../../shared/ai";
import {
  AI_VOICE_LIMITS,
  AI_VOICE_WHISPER_MODEL,
  countSpeechCharacters,
  voiceSpeechPoints,
  voiceTranscriptionPoints,
  type AiTranscriptionResponse,
  type AiVoiceMemberSettings,
  type AiVoiceSettings,
  type AiVoiceSttEngine,
  type AiVoiceTtsEngine,
} from "../../shared/aiVoice";
import { legacyHarnessDraft } from "./harnessMigration";
import { isProviderRejection, object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";
import { AiError, type SecretBox } from "./security";
import type { AiSql, AiStore } from "./storage";
import { tenantStorageKey } from "./tenant";
import {
  AUDIO_CONTAINER_FORMATS,
  audioBase64,
  audioDurationMs,
  audioMimeEssence,
  declaredAudioContainer,
  encodeMultipartForm,
  sniffAudioContainer,
  validatedLanguageCode,
  type VoiceTranscriptionUpload,
} from "./voiceAudio";

/**
 * Speech-to-text and external text-to-speech. Transcription runs either on
 * OpenAI's open-source Whisper model (https://github.com/openai/whisper,
 * `@cf/openai/whisper-large-v3-turbo`) through the Worker's Cloudflare Workers
 * AI binding — no provider key — or through an administrator-chosen
 * OpenAI-compatible provider connection of the AI harness. The provider path
 * is adapted from LibreChat v0.8.7 `api/server/services/Files/Audio/STTService.js`
 * (`openAIProvider`, `sttRequest`) and `TTSService.js` (`openAIProvider`,
 * `ttsRequest`). Both engines share Tongpin's tenant scope, one-time request
 * ids, quota reservation/settlement and sanitized diagnostics. Audio and text
 * are never persisted or logged; only the transcript is kept for an
 * idempotent replay of the same request id.
 */

const REQUEST_ID = /^[a-zA-Z0-9_-]{16,100}$/;
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,47}$/;
const VOICE_ID = /^[A-Za-z0-9_.:/-]{1,128}$/;
const MAX_POINTS = 10_000_000;
const MAX_PENDING_PER_USER = 3;
const TRANSCRIPTION_TIMEOUT_MS = 90_000;
const SPEECH_TIMEOUT_MS = 60_000;
/** A recording whose duration cannot be read is accepted only while it is
 * small enough to be at most about a minute of compressed speech. */
const UNVERIFIED_AUDIO_MAX_BYTES = 1_500_000;
const RECORD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Recorded as the request's provider for Whisper transcriptions. */
const WHISPER_PROVIDER_ID = "workers-ai";
/** Steers Whisper to Simplified Chinese with punctuation for Mandarin speech. */
const WHISPER_MANDARIN_PROMPT = "以下是普通话的句子，使用简体中文。";
const WHISPER_UNAVAILABLE = "Whisper 语音转写只能在云端服务使用，请在管理后台改用接口转写";

const DEFAULT_SETTINGS: AiVoiceSettings = {
  inputEnabled: false, sttEngine: "whisper", sttProviderId: "", sttModelId: "", sttPointsPerMinute: 0,
  ttsEngine: "browser", ttsProviderId: "", ttsModelId: "", ttsVoice: "", ttsPointsPer1kChars: 0,
  updatedAt: null,
};

/** Workers AI `@cf/openai/whisper-large-v3-turbo` input for one recording. */
export interface AiWhisperInput {
  /** Base64 of the uploaded recording as-is (WebM/Opus, Ogg, WAV or M4A). */
  audio: string;
  task: "transcribe";
  language: string;
  vad_filter: boolean;
  initial_prompt?: string;
  condition_on_previous_text: boolean;
}

/** Runs Whisper once. Only the Worker supplies one (from `env.AI`); the Node
 * server has none, so Whisper there is reported unavailable and never falls
 * back to a paid provider. The signal aborts the run at the timeout. */
export type AiWhisperRunner = (input: AiWhisperInput, signal: AbortSignal) => Promise<unknown>;

function whisperInput(audio: Uint8Array, language: string | undefined): AiWhisperInput {
  const code = language ?? "zh";
  return {
    audio: audioBase64(audio), task: "transcribe", language: code,
    // Voice activity detection keeps silence and noise from becoming stock
    // captions ("字幕志愿者 …", "感谢观看"). The Mandarin prompt only fits zh.
    vad_filter: true, ...(code === "zh" ? { initial_prompt: WHISPER_MANDARIN_PROMPT } : {}), condition_on_previous_text: false,
  };
}

/**
 * Whisper's stock phrases for silence or noise: subtitle credits and video
 * outros learned from web video, in both Simplified and Traditional forms.
 */
const WHISPER_STOCK_PHRASES = [
  "感谢观看", "谢谢观看", "感谢收看", "谢谢收看", "谢谢大家", "欢迎订阅", "明镜与点点",
  "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", "字幕由Amara.org社区提供", "优优独播剧场——YoYo Television Series Exclusive",
  "感謝觀看", "謝謝觀看", "感謝收看", "謝謝收看", "謝謝大家", "歡迎訂閱", "明鏡與點點",
  "請不吝點贊 訂閱 轉發 打賞支持明鏡與點點欄目", "字幕由Amara.org社區提供", "優優獨播劇場——YoYo Television Series Exclusive",
  "Thank you for watching", "Thanks for watching",
];
/** Video outros Whisper appends after real speech ("帮我生成一张图片。感谢观看"). */
const WHISPER_OUTROS = ["感谢观看", "谢谢观看", "感谢收看", "谢谢收看", "欢迎订阅", "感謝觀看", "謝謝觀看", "感謝收看", "謝謝收看", "歡迎訂閱", "thank you for watching", "thanks for watching"];
/** A cough transcribed as speech ("咳咳咳"). */
const WHISPER_COUGH = /^咳+$/u;
/** "字幕志愿者 杨茜茜": the volunteer credit followed by at most a short name. */
const WHISPER_CREDIT_PREFIXES = ["字幕志愿者", "字幕志願者"];
const WHISPER_CREDIT_NAME_MAX = 6;
/** One 1–4 character unit repeated at least 8 times in a row (a decoding loop). */
const WHISPER_RUNAWAY_REPEAT = /([^]{1,4}?)\1{7,}/gu;

/** Letters and digits only: punctuation, symbols, spaces and control
 * characters removed, full-width forms folded, case ignored. */
function comparableTranscript(text: string): string {
  return text.normalize("NFKC").replace(/[\p{P}\p{S}\p{Z}\p{Cc}\p{Cf}]+/gu, "").toLowerCase();
}
const WHISPER_STOCK = [...new Set(WHISPER_STOCK_PHRASES.map(comparableTranscript))];
const WHISPER_CREDITS = WHISPER_CREDIT_PREFIXES.map(comparableTranscript);

/**
 * True when a Whisper transcript is not speech but a known hallucination: the
 * whole text (ignoring punctuation, whitespace, width and case) is a stock
 * phrase, possibly repeated, or a subtitle-volunteer credit, or it is only
 * punctuation ("……"); or it contains a runaway repetition of one 1–4
 * character unit with a letter in it (digits alone, like "13800000000", are
 * never a loop).
 */
export function isWhisperHallucination(transcript: string): boolean {
  const text = comparableTranscript(transcript);
  if (!text) return transcript.trim().length > 0;
  if (WHISPER_STOCK.some(phrase => text.length % phrase.length === 0 && phrase.repeat(text.length / phrase.length) === text)) return true;
  if (WHISPER_CREDITS.some(prefix => text.startsWith(prefix) && [...text.slice(prefix.length)].length <= WHISPER_CREDIT_NAME_MAX)) return true;
  if (WHISPER_COUGH.test(text)) return true;
  for (const match of text.matchAll(WHISPER_RUNAWAY_REPEAT)) if (/\p{L}/u.test(match[1])) return true;
  return false;
}

/** Real speech with a stock video outro appended at its very end loses the outro. */
export function withoutWhisperOutro(transcript: string): string {
  let text = transcript;
  for (let changed = true; changed;) {
    changed = false;
    const trimmed = text.replace(/[\s\p{P}]+$/u, "");
    for (const outro of WHISPER_OUTROS) {
      if (trimmed.length > outro.length && trimmed.toLowerCase().endsWith(outro)) {
        text = trimmed.slice(0, trimmed.length - outro.length).replace(/[\s,，、]+$/u, "");
        changed = true;
        break;
      }
    }
  }
  return text;
}

/** The transcript of a Workers AI Whisper answer; "" when there was no clear speech. */
function whisperTranscript(output: unknown): string {
  const value = output && typeof output === "object" && !Array.isArray(output) ? (output as { text?: unknown }).text : undefined;
  if (typeof value !== "string") throw new AiError(502, "AI_VOICE_TRANSCRIPT_INVALID", "语音转写没有返回可用文字，请稍后重试");
  const raw = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (isWhisperHallucination(raw)) return "";
  const text = withoutWhisperOutro(raw);
  if (text.length > AI_VOICE_LIMITS.maxTranscriptCharacters) throw new AiError(502, "AI_VOICE_TRANSCRIPT_INVALID", "语音转写返回的文字过长，请分段录制后重试");
  return text;
}

/** A fixed member-safe error; Workers AI's own message is never kept or returned. */
function whisperFailure(error: unknown): AiError {
  if (error instanceof AiError) return error;
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : "";
  if (name === "TimeoutError" || name === "AbortError") return new AiError(502, "AI_CONNECTION_FAILED", "语音转写超时，请稍后重试");
  // Workers AI prefixes errors with a numeric code, e.g. "4006: you have used up your daily free allocation …".
  const code = /^\s*(\d{4})\s*:/.exec(message)?.[1];
  if (code === "4006" || /daily free allocation/i.test(message)) return new AiError(502, "AI_PROVIDER_LIMIT", "今天的免费语音转写额度已用完，请明天再试或联系管理员");
  if (code === "3040" || /capacity/i.test(message)) return new AiError(502, "AI_PROVIDER_LIMIT", "语音转写服务繁忙，请稍后重试");
  return new AiError(502, "AI_PROVIDER_UNAVAILABLE", "语音转写暂时不可用，请稍后重试");
}

/** Whisper with the transcription timeout enforced even if the runner ignores the signal. */
async function runWhisper(run: AiWhisperRunner, input: AiWhisperInput): Promise<unknown> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const timeout = new AiError(502, "AI_CONNECTION_FAILED", "语音转写超时，请稍后重试");
      reject(timeout);
      controller.abort(timeout);
    }, TRANSCRIPTION_TIMEOUT_MS);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => run(input, controller.signal)), expired]);
  } finally {
    clearTimeout(timer);
  }
}

const VOICE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_voice_requests (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, request_id TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(tenant_id,user_id,request_id));
CREATE INDEX IF NOT EXISTS ai_voice_requests_status ON ai_voice_requests(tenant_id,user_id,status);
`;
const readySchemas = new WeakSet<AiSql>();

type VoiceKind = "transcription" | "speech";
interface StoredVoiceRequest {
  requestId: string;
  userId: string;
  kind: VoiceKind;
  hash: string;
  status: "pending" | "completed" | "failed" | "uncertain";
  createdAt: string;
  expiresAt: number;
  reservedPoints: number;
  chargedPoints: number;
  model: string;
  providerId: string;
  durationMs?: number;
  characters?: number;
  result?: { text: string; durationMs: number };
  error?: { status: number; code: string; message: string };
}

interface VoiceRoute { providerId: string; baseUrl: string; encryptedKey: string; modelId: string }
export interface AiVoiceReadiness { ready: boolean; message: string }

async function sha256(value: Uint8Array<ArrayBuffer> | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function invalid(message: string): never { throw new AiError(400, "AI_VOICE_SETTINGS_INVALID", message); }

function providerIdField(value: unknown, label: string): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || !PROVIDER_ID.test(value.trim().toLowerCase())) invalid(`${label}格式不正确`);
  return value.trim().toLowerCase();
}
function textField(value: unknown, label: string, max: number): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.trim().length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label}格式不正确`);
  return value.trim();
}
function pointsField(value: unknown, label: string): number {
  const points = value === undefined || value === null || value === "" ? 0 : value;
  if (!Number.isSafeInteger(points) || Number(points) < 0 || Number(points) > MAX_POINTS) invalid(`${label}需为 0 到 1000 万之间的整数`);
  return Number(points);
}

function transcriptText(value: unknown): string {
  if (typeof value !== "string") throw new AiError(502, "AI_VOICE_TRANSCRIPT_INVALID", "语音服务没有返回可用文字，用量待管理员核对");
  const text = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  if (text.length > AI_VOICE_LIMITS.maxTranscriptCharacters) throw new AiError(502, "AI_VOICE_TRANSCRIPT_INVALID", "语音服务返回的文字过长，用量待管理员核对");
  return text;
}

/** Canonical type of a synthesized audio body; null when it is not audio. */
export function sniffSpeechAudio(bytes: Uint8Array): string | null {
  const text = (offset: number, value: string) => value.split("").every((character, index) => bytes[offset + index] === character.charCodeAt(0));
  if (bytes.length < 4) return null;
  if (text(0, "ID3")) return "audio/mpeg";
  if (bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0) return "audio/aac";
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (text(0, "RIFF") && text(8, "WAVE")) return "audio/wav";
  if (text(0, "OggS")) return "audio/ogg";
  if (text(0, "fLaC")) return "audio/flac";
  return null;
}

async function readAudioBody(response: Response, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) throw new AiError(502, "AI_VOICE_SPEECH_INVALID", "语音服务没有返回音频，用量待管理员核对");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AiError(502, "AI_VOICE_SPEECH_TOO_LARGE", "朗读音频超出大小上限，用量待管理员核对"); }
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Keep the original bounded error. */ }
    if (error instanceof AiError) throw error;
    throw new AiError(502, "AI_VOICE_SPEECH_INVALID", "朗读音频传输中断，用量待管理员核对");
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export class AiVoiceService {
  constructor(private readonly store: AiStore, private readonly box: () => Promise<SecretBox>, private readonly transport: AiTransport, private readonly whisper?: AiWhisperRunner) {}

  private settingKey(): string { return tenantStorageKey(this.store.tenantId, "voice"); }
  private userKey(userId: string): string { return tenantStorageKey(this.store.tenantId, userId); }

  private ensureSchema(): void {
    if (readySchemas.has(this.store.sql)) return;
    this.store.sql.exec(VOICE_SCHEMA);
    readySchemas.add(this.store.sql);
  }

  settings(): AiVoiceSettings {
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE tenant_id=? AND id=?", this.store.tenantId, this.settingKey())[0];
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      const stored = { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) as Partial<AiVoiceSettings> };
      // Settings saved before the engine choice existed (or anything unknown) mean Whisper.
      return { ...stored, sttEngine: stored.sttEngine === "provider" ? "provider" : "whisper" };
    } catch { return { ...DEFAULT_SETTINGS }; }
  }

  /** The Whisper runner, or a fail-closed error where this server has none. */
  private whisperRunner(): AiWhisperRunner {
    if (!this.whisper) throw new AiError(503, "AI_VOICE_NOT_CONFIGURED", "语音服务暂不可用：Whisper 语音转写只能在云端服务使用，请管理员在管理后台改用接口转写", true);
    return this.whisper;
  }

  private providers() {
    return (this.store.harness() ?? legacyHarnessDraft(this.store))?.providers ?? [];
  }

  private routeIssue(providerId: string, modelId: string): string | null {
    if (!providerId || !modelId) return "尚未选择服务连接和模型";
    const provider = this.providers().find(item => item.id === providerId);
    if (!provider) return "所选服务连接已不存在，请重新选择";
    if (!provider.enabled) return "所选服务连接已停用";
    if (!provider.encryptedKey) return "所选服务连接缺少 API 密钥";
    const verified = provider.verifiedConfigVersion === provider.configVersion && provider.verifiedKeyVersion === provider.keyVersion;
    if (!verified || !provider.availableModels.includes(modelId)) return "所选模型不在该连接当前密钥已读取的模型列表中，请在「服务与模型」重新读取模型列表";
    return null;
  }

  /** Fails closed exactly like tier routing: no unverified model receives paid work. */
  private route(providerId: string, modelId: string): VoiceRoute {
    const issue = this.routeIssue(providerId, modelId);
    if (issue) throw new AiError(503, "AI_VOICE_NOT_CONFIGURED", `语音服务暂不可用：${issue}`, true);
    const provider = this.providers().find(item => item.id === providerId)!;
    return { providerId: provider.id, baseUrl: provider.baseUrl, encryptedKey: provider.encryptedKey, modelId };
  }

  readiness(): { input: AiVoiceReadiness; speech: AiVoiceReadiness } {
    const settings = this.settings();
    const whisper = settings.sttEngine === "whisper";
    const inputIssue = !settings.inputEnabled ? "未开启" : settings.sttPointsPerMinute < 1 ? "尚未设置每分钟折算的同频点"
      : whisper ? (this.whisper ? null : WHISPER_UNAVAILABLE) : this.routeIssue(settings.sttProviderId, settings.sttModelId);
    const speechIssue = settings.ttsEngine === "browser" ? null
      : settings.ttsPointsPer1kChars < 1 ? "尚未设置每千字折算的同频点"
        : !settings.ttsVoice ? "尚未填写音色" : this.routeIssue(settings.ttsProviderId, settings.ttsModelId);
    return {
      input: { ready: !inputIssue, message: inputIssue ?? (whisper ? "成员可以使用语音输入（Whisper 开源模型，Cloudflare 运行）" : "成员可以使用语音输入") },
      speech: { ready: !speechIssue, message: settings.ttsEngine === "browser" ? "使用成员电脑的系统语音朗读，免费" : speechIssue ? `${speechIssue}；成员端暂时改用系统语音朗读` : "成员朗读使用外部语音服务" },
    };
  }

  memberSettings(): AiVoiceMemberSettings {
    const settings = this.settings();
    const readiness = this.readiness();
    const external = settings.ttsEngine === "external" && readiness.speech.ready;
    return {
      input: { enabled: readiness.input.ready, pointsPerMinute: readiness.input.ready ? settings.sttPointsPerMinute : 0, maxSeconds: AI_VOICE_LIMITS.maxAudioMs / 1000, maxBytes: AI_VOICE_LIMITS.maxAudioBytes },
      speech: { engine: external ? "external" : "browser", pointsPer1kChars: external ? settings.ttsPointsPer1kChars : 0, maxCharacters: AI_VOICE_LIMITS.maxSpeechCharacters },
    };
  }

  async configure(value: unknown): Promise<AiVoiceSettings> {
    const input = object(value);
    if (typeof input.inputEnabled !== "boolean") invalid("请选择是否开启语音输入");
    // An administrator client that predates the engine choice keeps the saved engine.
    const sttEngine = input.sttEngine ?? this.settings().sttEngine;
    if (sttEngine !== "whisper" && sttEngine !== "provider") invalid("请选择语音转写引擎");
    const ttsEngine = input.ttsEngine ?? "browser";
    if (ttsEngine !== "browser" && ttsEngine !== "external") invalid("请选择朗读方式");
    const next: AiVoiceSettings = {
      inputEnabled: input.inputEnabled,
      sttEngine: sttEngine as AiVoiceSttEngine,
      sttProviderId: providerIdField(input.sttProviderId, "语音转文字服务"),
      sttModelId: textField(input.sttModelId, "语音转文字模型", 160),
      sttPointsPerMinute: pointsField(input.sttPointsPerMinute, "每分钟折算同频点"),
      ttsEngine: ttsEngine as AiVoiceTtsEngine,
      ttsProviderId: providerIdField(input.ttsProviderId, "朗读服务"),
      ttsModelId: textField(input.ttsModelId, "朗读模型", 160),
      ttsVoice: textField(input.ttsVoice, "音色", 128),
      ttsPointsPer1kChars: pointsField(input.ttsPointsPer1kChars, "每千字折算同频点"),
      updatedAt: new Date().toISOString(),
    };
    if (next.ttsVoice && !VOICE_ID.test(next.ttsVoice)) invalid("音色只能包含字母、数字和 _ . : / -");
    const providerIds = new Set(this.providers().map(provider => provider.id));
    if (next.inputEnabled) {
      // Whisper needs no service connection; a saved one is kept for switching back.
      if (next.sttEngine === "provider") {
        if (!next.sttProviderId || !providerIds.has(next.sttProviderId)) throw new AiError(400, "AI_VOICE_PROVIDER_MISSING", "请选择一个已接入的服务连接用于语音转文字");
        if (!next.sttModelId) throw new AiError(400, "AI_VOICE_MODEL_REQUIRED", "请选择语音转文字模型");
      }
      if (next.sttPointsPerMinute < 1) throw new AiError(400, "AI_VOICE_PRICE_REQUIRED", "开启语音输入前，请设置每分钟折算的同频点（1 到 1000 万）");
    }
    if (next.ttsEngine === "external") {
      if (!next.ttsProviderId || !providerIds.has(next.ttsProviderId)) throw new AiError(400, "AI_VOICE_PROVIDER_MISSING", "请选择一个已接入的服务连接用于朗读");
      if (!next.ttsModelId) throw new AiError(400, "AI_VOICE_MODEL_REQUIRED", "请选择朗读模型");
      if (!next.ttsVoice) throw new AiError(400, "AI_VOICE_SETTINGS_INVALID", "请填写朗读音色，例如 alloy");
      if (next.ttsPointsPer1kChars < 1) throw new AiError(400, "AI_VOICE_PRICE_REQUIRED", "使用外部朗读前，请设置每千字折算的同频点（1 到 1000 万）");
    }
    this.store.sql.transaction(() => {
      this.store.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", this.settingKey(), this.store.tenantId, JSON.stringify(next));
    });
    return this.settings();
  }

  private readRequest(userId: string, requestId: string): StoredVoiceRequest | undefined {
    const row = this.store.sql.all<{ data: string }>("SELECT data FROM ai_voice_requests WHERE tenant_id=? AND user_id=? AND request_id=?", this.store.tenantId, this.userKey(userId), requestId)[0];
    return row ? JSON.parse(row.data) as StoredVoiceRequest : undefined;
  }

  private writeRequest(record: StoredVoiceRequest): void {
    this.store.sql.exec(
      "INSERT INTO ai_voice_requests(tenant_id,user_id,request_id,status,expires_at,created_at,data) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,request_id) DO UPDATE SET status=excluded.status,expires_at=excluded.expires_at,data=excluded.data",
      this.store.tenantId, this.userKey(record.userId), record.requestId, record.status, record.expiresAt, Date.parse(record.createdAt), JSON.stringify(record),
    );
  }

  private settle(record: StoredVoiceRequest, status: "completed" | "failed" | "uncertain", charged: number, reason: string, extras: { result?: StoredVoiceRequest["result"]; error?: AiError } = {}): AiUsage | null {
    const current = this.readRequest(record.userId, record.requestId);
    if (current?.status !== "pending") return null;
    const quota = this.store.quota(record.userId);
    quota.reservedTokens = Math.max(0, quota.reservedTokens - current.reservedPoints);
    quota.usedTokens += charged;
    this.store.saveQuota(record.userId, quota);
    const usage: AiUsage = {
      inputTokens: 0, outputTokens: 0, totalTokens: charged, estimated: status === "uncertain", convertedTokens: charged,
      billingKind: current.kind === "transcription" ? "speech_to_text_conversion" : "text_to_speech_conversion",
    };
    this.writeRequest({
      ...current, status, chargedPoints: charged,
      ...(extras.result ? { result: extras.result } : {}),
      ...(extras.error ? { error: { status: extras.error.status, code: extras.error.code, message: extras.error.message } } : {}),
    });
    this.store.addUsage({
      id: crypto.randomUUID(), userId: record.userId, actorId: null, requestId: record.requestId, kind: "voice", status,
      model: current.model, mode: null, createdAt: new Date().toISOString(), reason, limitTokens: null, ...usage,
      ...(extras.error?.diagnostic ? { diagnostic: extras.error.diagnostic } : {}),
    });
    return usage;
  }

  /** An interrupted request is settled once, conservatively, like chat. */
  private recover(userId: string): void {
    this.store.sql.transaction(() => {
      const rows = this.store.sql.all<{ data: string }>("SELECT data FROM ai_voice_requests WHERE tenant_id=? AND user_id=? AND status='pending' AND expires_at<?", this.store.tenantId, this.userKey(userId), Date.now());
      for (const row of rows) {
        const record = JSON.parse(row.data) as StoredVoiceRequest;
        this.settle(record, "uncertain", record.reservedPoints, "语音请求中断，结果未知，按预留同频点保守计入；请管理员核对服务商记录",
          { error: new AiError(502, "AI_REQUEST_UNCERTAIN", "上次语音请求状态不确定，已按预留记录，请联系管理员核对") });
      }
      this.store.sql.exec("DELETE FROM ai_voice_requests WHERE rowid IN (SELECT rowid FROM ai_voice_requests WHERE tenant_id=? AND user_id=? AND status<>'pending' AND created_at<? LIMIT 200)",
        this.store.tenantId, this.userKey(userId), Date.now() - RECORD_RETENTION_MS);
    });
  }

  private pendingCount(userId: string): number {
    return this.store.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_voice_requests WHERE tenant_id=? AND user_id=? AND status='pending'", this.store.tenantId, this.userKey(userId))[0]?.count ?? 0;
  }

  private async idempotencyKey(userId: string, requestId: string, operation: VoiceKind): Promise<string> {
    return `tongpin-${await sha256(JSON.stringify({ version: 1, tenantId: this.store.tenantId, userId, requestId, operation: `audio_${operation}` }))}`;
  }

  private reserve(userId: string, record: Omit<StoredVoiceRequest, "status" | "chargedPoints">): StoredVoiceRequest {
    return this.store.sql.transaction(() => {
      if (this.readRequest(userId, record.requestId)) throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "这条语音请求正在处理，请稍候", true);
      if (this.pendingCount(userId) >= MAX_PENDING_PER_USER) throw new AiError(409, "AI_VOICE_BUSY", "语音请求较多，请等当前转写或朗读完成后再试", true);
      const quota: AiQuota = this.store.quota(userId);
      if (quota.remainingTokens < record.reservedPoints) {
        throw new AiError(402, quota.remainingTokens <= 0 ? "AI_QUOTA_EXHAUSTED" : "AI_QUOTA_INSUFFICIENT",
          record.kind === "transcription" ? "同频点不足以完成这段语音转写，请联系管理员增加额度" : "同频点不足以朗读这段内容，请联系管理员增加额度", true);
      }
      quota.reservedTokens += record.reservedPoints;
      this.store.saveQuota(userId, quota);
      const pending: StoredVoiceRequest = { ...record, status: "pending", chargedPoints: 0 };
      this.writeRequest(pending);
      return pending;
    });
  }

  private requestId(value: unknown): string {
    if (typeof value !== "string" || !REQUEST_ID.test(value)) throw new AiError(400, "AI_REQUEST_ID_INVALID", "请求标识无效，请重新录制或重新朗读");
    return value;
  }

  private replay(userId: string, record: StoredVoiceRequest, hash: string): AiTranscriptionResponse {
    if (record.hash !== hash || record.kind !== "transcription") throw new AiError(409, "AI_REQUEST_CONFLICT", "相同请求标识不能用于不同的录音");
    // An "uncertain" record may still carry a transcript that arrived after recovery settled it.
    if ((record.status === "completed" || record.status === "uncertain") && record.result) {
      return {
        requestId: record.requestId, text: record.result.text, durationMs: record.result.durationMs,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: record.chargedPoints, estimated: record.status === "uncertain", convertedTokens: record.chargedPoints, billingKind: "speech_to_text_conversion" },
        quota: this.store.quota(userId),
      };
    }
    if (record.error) throw new AiError(record.error.status, record.error.code, record.error.message);
    throw new AiError(409, "AI_REQUEST_IN_PROGRESS", "这段录音正在转写，请稍候");
  }

  /** Cheap checks that run before a (possibly 10 MB) upload body is read. */
  assertInputAvailable(userId: string): void {
    this.store.assertAccess(userId);
    const settings = this.settings();
    if (!settings.inputEnabled) throw new AiError(403, "AI_VOICE_INPUT_DISABLED", "管理员尚未开启语音输入", true);
    if (settings.sttEngine === "whisper") this.whisperRunner();
  }

  /** Settles a delivered transcript once; a request that recovery already
   * settled conservatively gets its late transcript without a second charge. */
  private deliverTranscript(userId: string, pending: StoredVoiceRequest, result: { text: string; durationMs: number }, hash: string, reason: string): AiTranscriptionResponse {
    const settled = this.store.sql.transaction(() => this.settle(pending, "completed", pending.reservedPoints, reason, { result }));
    if (!settled) {
      const late = this.store.sql.transaction(() => {
        const stored = this.readRequest(userId, pending.requestId)!;
        if (stored.status === "uncertain" && !stored.result) this.writeRequest({ ...stored, result });
        return this.readRequest(userId, pending.requestId)!;
      });
      return this.replay(userId, late, hash);
    }
    return { requestId: pending.requestId, text: result.text, durationMs: result.durationMs, usage: settled, quota: this.store.quota(userId) };
  }

  /** Workers AI Whisper: the uploaded bytes as-is, Mandarin by default. Every
   * failure releases the reservation — nothing reached the member and no
   * provider account needs reconciling. */
  private async transcribeWithWhisper(run: AiWhisperRunner, userId: string, request: {
    requestId: string; hash: string; audio: Uint8Array; language: string | undefined; durationMs: number; points: number; pointsPerMinute: number;
  }): Promise<AiTranscriptionResponse> {
    const { requestId, hash, durationMs, points } = request;
    const input = whisperInput(request.audio, request.language);
    const now = Date.now();
    const pending = this.reserve(userId, {
      requestId, userId, kind: "transcription", hash, createdAt: new Date(now).toISOString(), expiresAt: now + TRANSCRIPTION_TIMEOUT_MS + 30_000,
      reservedPoints: points, model: AI_VOICE_WHISPER_MODEL, providerId: WHISPER_PROVIDER_ID, durationMs,
    });
    let text: string;
    try {
      text = whisperTranscript(await runWhisper(run, input));
    } catch (error) {
      const safe = whisperFailure(error);
      this.store.sql.transaction(() => this.settle(pending, "failed", 0, `Whisper 语音转文字失败：${safe.message}；预留同频点已释放`, { error: safe }));
      throw safe;
    }
    return this.deliverTranscript(userId, pending, { text, durationMs }, hash,
      `Whisper 语音转文字 ${Math.ceil(durationMs / 1000)} 秒${text ? "" : "（未识别到清晰语音）"}，按管理员设定每分钟 ${request.pointsPerMinute} 同频点折算（按秒向上取整）`);
  }

  async transcribe(userId: string, upload: VoiceTranscriptionUpload): Promise<AiTranscriptionResponse> {
    this.store.assertAccess(userId);
    this.ensureSchema();
    this.recover(userId);
    const requestId = this.requestId(upload.requestId);
    const settings = this.settings();
    if (!settings.inputEnabled) throw new AiError(403, "AI_VOICE_INPUT_DISABLED", "管理员尚未开启语音输入", true);
    if (settings.sttPointsPerMinute < 1) throw new AiError(503, "AI_VOICE_NOT_CONFIGURED", "管理员尚未设置语音输入的折算同频点", true);
    // Whisper fails closed where there is no runner; it never falls back to a paid provider.
    const engine = settings.sttEngine === "whisper"
      ? { kind: "whisper" as const, run: this.whisperRunner() }
      : { kind: "provider" as const, route: this.route(settings.sttProviderId, settings.sttModelId) };

    const declared = Number(upload.durationMs);
    if (!Number.isFinite(declared) || declared <= 0) throw new AiError(400, "AI_VOICE_DURATION_INVALID", "录音时长无效，请重新录制");
    const longest = AI_VOICE_LIMITS.maxAudioMs + AI_VOICE_LIMITS.audioToleranceMs;
    if (declared > longest) throw new AiError(413, "AI_VOICE_AUDIO_TOO_LONG", "单次录音最长 60 秒，请分段录制");
    const bytes = upload.audio;
    if (!bytes.byteLength) throw new AiError(400, "AI_VOICE_AUDIO_EMPTY", "录音内容为空，请重新录制");
    if (bytes.byteLength > AI_VOICE_LIMITS.maxAudioBytes) throw new AiError(413, "AI_VOICE_AUDIO_TOO_LARGE", "录音文件过大，单次最多 10 MB、60 秒");
    const container = sniffAudioContainer(bytes);
    const declaredContainer = declaredAudioContainer(upload.declaredType);
    if (!container || !declaredContainer || declaredContainer !== "generic" && declaredContainer !== container) {
      throw new AiError(415, "AI_VOICE_AUDIO_UNSUPPORTED", "录音格式不受支持（支持 WebM、Ogg、WAV、M4A），请用同频桌面版重新录制");
    }
    const measured = audioDurationMs(bytes, container);
    if (measured !== null && measured > longest) throw new AiError(413, "AI_VOICE_AUDIO_TOO_LONG", "单次录音最长 60 秒，请分段录制");
    if (measured === null && bytes.byteLength > UNVERIFIED_AUDIO_MAX_BYTES) throw new AiError(415, "AI_VOICE_AUDIO_UNVERIFIED", "无法确认这段录音的时长，请重新录制");
    // Never bill less than the audio actually contains, nor more than the cap.
    const durationMs = Math.min(AI_VOICE_LIMITS.maxAudioMs, Math.round(Math.max(declared, measured ?? 0)));
    if (durationMs < AI_VOICE_LIMITS.minAudioMs) throw new AiError(400, "AI_VOICE_AUDIO_TOO_SHORT", "录音太短，请说完整后再停止");
    const language = validatedLanguageCode(upload.language);
    const points = voiceTranscriptionPoints(durationMs, settings.sttPointsPerMinute);
    const hash = await sha256(JSON.stringify({ version: 1, kind: "transcription", audio: await sha256(bytes), declared, language: language ?? null }));
    const prior = this.readRequest(userId, requestId);
    if (prior) return this.replay(userId, prior, hash);
    if (engine.kind === "whisper") {
      return this.transcribeWithWhisper(engine.run, userId, { requestId, hash, audio: bytes, language, durationMs, points, pointsPerMinute: settings.sttPointsPerMinute });
    }

    const { route } = engine;
    const key = await (await this.box()).decrypt(route.encryptedKey);
    const idempotencyKey = await this.idempotencyKey(userId, requestId, "transcription");
    const format = AUDIO_CONTAINER_FORMATS[container];
    const form = encodeMultipartForm(
      [["model", route.modelId], ["response_format", "json"], ...(language ? [["language", language] as const] : [])],
      { name: "file", filename: `audio.${format.extension}`, contentType: format.mimeType, bytes },
    );
    const now = Date.now();
    const pending = this.reserve(userId, {
      requestId, userId, kind: "transcription", hash, createdAt: new Date(now).toISOString(), expiresAt: now + TRANSCRIPTION_TIMEOUT_MS + 30_000,
      reservedPoints: points, model: route.modelId, providerId: route.providerId, durationMs,
    });
    let knownRejection = false;
    try {
      const response = await this.transport(`${route.baseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": form.contentType, Accept: "application/json", "Idempotency-Key": idempotencyKey },
        binaryBody: form.body, signal: AbortSignal.timeout(TRANSCRIPTION_TIMEOUT_MS), maxResponseBytes: 256_000,
      });
      if (!response.ok) { knownRejection = isProviderRejection(response.status); throw await readProviderHttpError(response, "audio"); }
      const text = transcriptText(object(await readBoundedJson(response, 256_000)).text);
      return this.deliverTranscript(userId, pending, { text, durationMs }, hash,
        `语音转文字 ${Math.ceil(durationMs / 1000)} 秒，按管理员设定每分钟 ${settings.sttPointsPerMinute} 同频点折算（按秒向上取整）`);
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "语音服务连接失败或超时；用量待管理员核对，请稍后重新录制");
      knownRejection ||= safe.definitelyNotSent;
      this.store.sql.transaction(() => this.settle(pending, knownRejection ? "failed" : "uncertain", knownRejection ? 0 : points,
        knownRejection ? "语音转文字请求未发出或被服务商拒绝，预留同频点已释放" : "语音转文字结果不确定，按预留同频点保守计入；请管理员核对", { error: safe }));
      throw safe;
    }
  }

  /** Synthesizes one bounded chunk and returns the audio itself; no audio is stored. */
  async speech(userId: string, value: unknown): Promise<Response> {
    this.store.assertAccess(userId);
    this.ensureSchema();
    this.recover(userId);
    const body = object(value);
    const requestId = this.requestId(body.requestId);
    if (typeof body.text !== "string") throw new AiError(400, "AI_VOICE_TEXT_INVALID", "请提供要朗读的文字");
    const text = body.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    if (!text) throw new AiError(400, "AI_VOICE_TEXT_INVALID", "没有可朗读的文字");
    const characters = countSpeechCharacters(text);
    if (characters > AI_VOICE_LIMITS.maxSpeechCharacters) throw new AiError(413, "AI_VOICE_TEXT_TOO_LONG", `单次朗读最多 ${AI_VOICE_LIMITS.maxSpeechCharacters} 字`);
    const settings = this.settings();
    if (settings.ttsEngine !== "external") throw new AiError(409, "AI_VOICE_SPEECH_LOCAL", "当前使用本机系统语音朗读，无需请求服务器", true);
    if (settings.ttsPointsPer1kChars < 1 || !settings.ttsVoice) throw new AiError(503, "AI_VOICE_NOT_CONFIGURED", "管理员尚未完成外部朗读配置", true);
    const route = this.route(settings.ttsProviderId, settings.ttsModelId);
    const points = voiceSpeechPoints(characters, settings.ttsPointsPer1kChars);
    const hash = await sha256(JSON.stringify({ version: 1, kind: "speech", text, voice: settings.ttsVoice }));
    // Synthesized audio is not kept, so a reused id is never replayed or billed twice.
    if (this.readRequest(userId, requestId)) throw new AiError(409, "AI_REQUEST_CONFLICT", "这段朗读请求已处理，请重新点击朗读");

    const key = await (await this.box()).decrypt(route.encryptedKey);
    const idempotencyKey = await this.idempotencyKey(userId, requestId, "speech");
    const now = Date.now();
    const pending = this.reserve(userId, {
      requestId, userId, kind: "speech", hash, createdAt: new Date(now).toISOString(), expiresAt: now + SPEECH_TIMEOUT_MS + 30_000,
      reservedPoints: points, model: route.modelId, providerId: route.providerId, characters,
    });
    let knownRejection = false;
    try {
      const response = await this.transport(`${route.baseUrl}/audio/speech`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "audio/mpeg, audio/*", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ model: route.modelId, input: text, voice: settings.ttsVoice, response_format: "mp3" }),
        signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS), maxResponseBytes: AI_VOICE_LIMITS.maxSpeechResponseBytes,
      });
      if (!response.ok) { knownRejection = isProviderRejection(response.status); throw await readProviderHttpError(response, "audio"); }
      const declaredType = audioMimeEssence(response.headers.get("content-type") ?? "");
      if (declaredType === "application/json" || declaredType.startsWith("text/")) {
        try { await response.body?.cancel(); } catch { /* The provider already answered. */ }
        throw new AiError(502, "AI_VOICE_SPEECH_INVALID", "语音服务没有返回音频，用量待管理员核对");
      }
      const audio = await readAudioBody(response, AI_VOICE_LIMITS.maxSpeechResponseBytes);
      const contentType = sniffSpeechAudio(audio);
      if (!contentType) throw new AiError(502, "AI_VOICE_SPEECH_INVALID", "语音服务返回的不是可播放的音频，用量待管理员核对");
      this.store.sql.transaction(() => this.settle(pending, "completed", points,
        `朗读 ${characters} 字，按管理员设定每千字 ${settings.ttsPointsPer1kChars} 同频点折算（每段向上取整）`));
      return new Response(audio, { headers: { "Content-Type": contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline" } });
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError(502, "AI_CONNECTION_FAILED", "语音服务连接失败或超时；用量待管理员核对");
      knownRejection ||= safe.definitelyNotSent;
      this.store.sql.transaction(() => this.settle(pending, knownRejection ? "failed" : "uncertain", knownRejection ? 0 : points,
        knownRejection ? "朗读请求未发出或被服务商拒绝，预留同频点已释放" : "朗读结果不确定，按预留同频点保守计入；请管理员核对", { error: safe }));
      throw safe;
    }
  }
}
