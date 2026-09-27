import {
  AI_VOICE_LIMITS,
  AI_VOICE_SPEECH_PATH,
  AI_VOICE_TRANSCRIPTION_PATH,
  EMPTY_AI_VOICE_MEMBER_SETTINGS,
  type AiTranscriptionResponse,
  type AiVoiceMemberSettings,
} from "../../../../shared/aiVoice";
import { ApiRequestError } from "../../../lib/api";

/** The signed-in `api` from AuthContext (bearer token, refresh, timeouts). */
export type VoiceApi = <T>(path: string, init?: RequestInit, timeoutMs?: number, responseMode?: "json" | "blob" | "image" | "stream") => Promise<T>;

export function newVoiceRequestId(): string {
  return `voice-${crypto.randomUUID()}`;
}

// ---------------------------------------------------------------- member settings cache
interface SettingsEntry { accountId: string; settings: AiVoiceMemberSettings; loadedAt: number; failed: boolean; pending: Promise<AiVoiceMemberSettings> | null }
let entry: SettingsEntry | null = null;
const listeners = new Set<() => void>();
const RETRY_AFTER_FAILURE_MS = 10_000;

function normalizeSettings(value: unknown): AiVoiceMemberSettings {
  const settings = value && typeof value === "object" ? value as Partial<AiVoiceMemberSettings> : {};
  const input = settings.input ?? EMPTY_AI_VOICE_MEMBER_SETTINGS.input;
  const speech = settings.speech ?? EMPTY_AI_VOICE_MEMBER_SETTINGS.speech;
  const count = (number: unknown, fallback: number) => typeof number === "number" && Number.isFinite(number) && number >= 0 ? number : fallback;
  return {
    input: {
      enabled: input.enabled === true,
      pointsPerMinute: count(input.pointsPerMinute, 0),
      maxSeconds: Math.min(count(input.maxSeconds, 60) || 60, AI_VOICE_LIMITS.maxAudioMs / 1000),
      maxBytes: Math.min(count(input.maxBytes, AI_VOICE_LIMITS.maxAudioBytes) || AI_VOICE_LIMITS.maxAudioBytes, AI_VOICE_LIMITS.maxAudioBytes),
    },
    speech: {
      engine: speech.engine === "external" ? "external" : "browser",
      pointsPer1kChars: count(speech.pointsPer1kChars, 0),
      maxCharacters: Math.min(count(speech.maxCharacters, AI_VOICE_LIMITS.maxSpeechCharacters) || AI_VOICE_LIMITS.maxSpeechCharacters, AI_VOICE_LIMITS.maxSpeechCharacters),
    },
  };
}

export function voiceSettingsSnapshot(accountId: string | undefined): AiVoiceMemberSettings {
  return entry && accountId && entry.accountId === accountId ? entry.settings : EMPTY_AI_VOICE_MEMBER_SETTINGS;
}

export function subscribeVoiceSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function invalidateVoiceSettings(): void {
  if (entry) entry.loadedAt = 0;
}

/** Loads the member view once a minute. An older server without the voice
 * routes (or no network) yields "no microphone, local read-aloud". */
export function ensureVoiceSettings(api: VoiceApi, accountId: string, maxAgeMs = 60_000): Promise<AiVoiceMemberSettings> {
  if (entry?.accountId !== accountId) entry = { accountId, settings: EMPTY_AI_VOICE_MEMBER_SETTINGS, loadedAt: 0, failed: false, pending: null };
  const current = entry;
  if (current.pending) return current.pending;
  const age = Date.now() - current.loadedAt;
  if (current.loadedAt && age < (current.failed ? RETRY_AFTER_FAILURE_MS : maxAgeMs)) return Promise.resolve(current.settings);
  current.pending = api<{ settings: unknown }>("/api/ai/voice", { headers: { "X-Tongpin-Account": accountId } })
    .then(result => ({ settings: normalizeSettings(result.settings), failed: false }))
    .catch(() => ({ settings: EMPTY_AI_VOICE_MEMBER_SETTINGS, failed: true }))
    .then(({ settings, failed }) => {
      current.pending = null;
      if (entry === current) {
        current.settings = settings; current.loadedAt = Date.now(); current.failed = failed;
        for (const listener of listeners) listener();
      }
      return settings;
    });
  return current.pending;
}

// ---------------------------------------------------------------- requests
export async function transcribeRecording(api: VoiceApi, accountId: string, recording: { blob: Blob; durationMs: number; fileName: string }): Promise<AiTranscriptionResponse> {
  const form = new FormData();
  form.append("requestId", newVoiceRequestId());
  form.append("durationMs", String(Math.max(1, Math.min(AI_VOICE_LIMITS.maxAudioMs, Math.round(recording.durationMs)))));
  // Mandarin hint for either transcription engine (Whisper also defaults to it).
  form.append("language", "zh");
  form.append("audio", recording.blob, recording.fileName);
  // Serialize once: the multipart boundary must be in the header the API helper sends.
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type") ?? "";
  const body = await encoded.blob();
  return api<AiTranscriptionResponse>(AI_VOICE_TRANSCRIPTION_PATH, {
    method: "POST", body, headers: { "Content-Type": contentType, "X-Tongpin-Account": accountId },
  }, 120_000);
}

/** One synthesized chunk as a playable Blob (bounded, cancellable). */
export async function synthesizeSpeech(api: VoiceApi, accountId: string, text: string, signal?: AbortSignal): Promise<Blob> {
  const response = await api<Response>(AI_VOICE_SPEECH_PATH, {
    method: "POST", body: JSON.stringify({ requestId: newVoiceRequestId(), text }), headers: { "X-Tongpin-Account": accountId }, signal,
  }, 90_000, "stream");
  const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!type.startsWith("audio/") || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiRequestError(502, "AI_VOICE_SPEECH_INVALID", "朗读服务没有返回音频");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException("朗读已停止", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > AI_VOICE_LIMITS.maxSpeechResponseBytes) { cancel(); throw new ApiRequestError(413, "AI_VOICE_SPEECH_TOO_LARGE", "朗读音频超出大小上限"); }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return new Blob(chunks, { type });
}

export function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError");
}

/** Server messages are already sanitized Chinese; transport failures get ours. */
export function voiceErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "NETWORK_UNAVAILABLE") return "连接不上服务器，请检查网络后重试。";
    if (error.status === 404) return "服务器暂不支持语音功能，请联系管理员更新同频服务。";
    if (error.status === 401) return "登录已失效，请重新登录。";
    return error.message || fallback;
  }
  return fallback;
}
