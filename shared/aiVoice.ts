import type { AiQuota, AiUsage } from "./ai";

/**
 * Browser-safe voice contract shared by the recorder, both server runtimes and
 * the Worker entry body limit. Provider credentials, provider base URLs and
 * audio bytes never appear in these types.
 */
export const AI_VOICE_LIMITS = Object.freeze({
  /** Longest single recording accepted for transcription. */
  maxAudioMs: 60_000,
  /** MediaRecorder timer jitter tolerated on top of maxAudioMs. */
  audioToleranceMs: 1_000,
  /** Recordings shorter than this are not uploaded (nothing useful to transcribe). */
  minAudioMs: 500,
  maxAudioBytes: 10 * 1024 * 1024,
  /** Whole multipart request: the audio part plus a few short text fields. */
  uploadBytes: 10 * 1024 * 1024 + 64 * 1024,
  /** Unicode code points synthesized by one external speech request. */
  maxSpeechCharacters: 1_000,
  /** Upper bound of one synthesized audio response. */
  maxSpeechResponseBytes: 6_000_000,
  maxTranscriptCharacters: 20_000,
});

export const AI_VOICE_TRANSCRIPTION_PATH = "/api/ai/audio/transcriptions";
export const AI_VOICE_SPEECH_PATH = "/api/ai/audio/speech";

/** "browser" = window.speechSynthesis with the system's voices (free);
 * "external" = an administrator-selected OpenAI-compatible /audio/speech model. */
export type AiVoiceTtsEngine = "browser" | "external";

/** "whisper" = OpenAI's open-source Whisper model run by Cloudflare Workers AI
 * through the Worker's AI binding (no provider key; only the cloud Worker has
 * it); "provider" = an administrator-selected OpenAI-compatible
 * /audio/transcriptions model. Stored settings without the field mean "whisper". */
export type AiVoiceSttEngine = "whisper" | "provider";

/** Workers AI model id of the Whisper engine (recorded on each request). */
export const AI_VOICE_WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** The open-source CosyVoice2 speech model as SiliconFlow names it. */
export const COSYVOICE2_MODEL = "FunAudioLLM/CosyVoice2-0.5B";
/** SiliconFlow's OpenAI-compatible API (the host allowed by the Worker). */
export const SILICONFLOW_BASE_URL = "https://api.siliconflow.cn/v1";
/** SiliconFlow's preset CosyVoice2 voices and how SiliconFlow describes them (women first). */
export const COSYVOICE2_VOICE_NAMES: ReadonlyArray<readonly [name: string, description: string]> = [
  ["anna", "沉稳女声"], ["bella", "激情女声"], ["claire", "温柔女声"], ["diana", "欢快女声"],
  ["alex", "沉稳男声"], ["benjamin", "低沉男声"], ["charles", "磁性男声"], ["david", "欢快男声"],
];
export const OPENAI_TTS_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] as const;
/** Most voices a member can choose from. */
export const AI_VOICE_MAX_MEMBER_VOICES = 16;
/** A provider voice id: letters, digits and _ . : / - (e.g. "FunAudioLLM/CosyVoice2-0.5B:anna"). */
export const AI_VOICE_ID_PATTERN = /^[A-Za-z0-9_.:/-]{1,128}$/;

/** The preset voice ids of a speech model: CosyVoice2 voices are "<model>:<name>". */
export function knownSpeechVoices(model: string): string[] {
  const trimmed = model.trim();
  if (/cosyvoice2/i.test(trimmed)) return COSYVOICE2_VOICE_NAMES.map(([name]) => `${trimmed}:${name}`);
  if (/tts|speech/i.test(trimmed)) return [...OPENAI_TTS_VOICES];
  return [];
}

/** A short member-facing name for a voice id ("Anna · 沉稳女声", "Alloy"). */
export function speechVoiceLabel(voice: string): string {
  const name = voice.includes(":") ? voice.slice(voice.lastIndexOf(":") + 1) : voice.slice(voice.lastIndexOf("/") + 1);
  const title = name ? name.charAt(0).toUpperCase() + name.slice(1) : voice;
  const description = /cosyvoice2/i.test(voice) ? COSYVOICE2_VOICE_NAMES.find(([preset]) => preset === name.toLowerCase())?.[1] : undefined;
  return description ? `${title} · ${description}` : title;
}

export interface AiVoiceOption { id: string; label: string }

export interface AiVoiceSettingsInput {
  /** Speech-to-text (microphone) for members. */
  inputEnabled: boolean;
  sttEngine: AiVoiceSttEngine;
  /** Harness provider connection id reused for /audio/transcriptions (provider
   * engine only; kept while Whisper is selected so switching back is one step). */
  sttProviderId: string;
  sttModelId: string;
  /** 同频点 per minute of audio, billed per started second. */
  sttPointsPerMinute: number;
  ttsEngine: AiVoiceTtsEngine;
  ttsProviderId: string;
  ttsModelId: string;
  /** The default voice: used for members who have not chosen one. */
  ttsVoice: string;
  /** Voices members may choose from (the default voice is always one of them).
   * Empty means members hear the default voice only. Optional for older
   * administrator clients, which keep the saved list. */
  ttsMemberVoices?: string[];
  /** 同频点 per 1,000 characters sent to the external speech model. */
  ttsPointsPer1kChars: number;
}

export interface AiVoiceSettings extends AiVoiceSettingsInput {
  ttsMemberVoices: string[];
  updatedAt: string | null;
}

/** Member view: no provider or model identity. */
export interface AiVoiceMemberSettings {
  input: { enabled: boolean; pointsPerMinute: number; maxSeconds: number; maxBytes: number };
  speech: {
    engine: AiVoiceTtsEngine; pointsPer1kChars: number; maxCharacters: number;
    /** External engine only: the voices a member may choose, default first. */
    voices?: AiVoiceOption[];
    defaultVoice?: string;
  };
}

export interface AiTranscriptionResponse {
  requestId: string;
  text: string;
  /** Billed duration (server-verified where the container allows it). */
  durationMs: number;
  usage: AiUsage;
  quota: AiQuota;
}

export interface AiSpeechRequest {
  requestId: string;
  text: string;
  /** The member's chosen voice (an opaque key from the member settings); one the administrator no longer offers falls back to the default. */
  voice?: string;
}

export type MicrophoneAccessStatus = "granted" | "denied" | "restricted" | "not-determined" | "unknown";

/** Desktop preload bridge (window.tongpin.microphone). Absent in a plain browser. */
export interface MicrophoneBridge {
  status(): Promise<MicrophoneAccessStatus>;
  /** Shows the operating system prompt when the decision is still open (macOS). */
  request(): Promise<MicrophoneAccessStatus>;
  /** Opens the fixed system privacy pane for the microphone. */
  openSettings(): Promise<boolean>;
}

export const EMPTY_AI_VOICE_MEMBER_SETTINGS: AiVoiceMemberSettings = Object.freeze({
  input: Object.freeze({ enabled: false, pointsPerMinute: 0, maxSeconds: AI_VOICE_LIMITS.maxAudioMs / 1000, maxBytes: AI_VOICE_LIMITS.maxAudioBytes }),
  speech: Object.freeze({ engine: "browser" as const, pointsPer1kChars: 0, maxCharacters: AI_VOICE_LIMITS.maxSpeechCharacters }),
}) as AiVoiceMemberSettings;

/** Code points, so an emoji or a rare CJK character counts once. */
export function countSpeechCharacters(text: string): number {
  let count = 0;
  for (const _character of text) count += 1;
  return count;
}

/** Billed seconds: every started second, at least one, at most the recording cap. */
export function voiceBilledSeconds(durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return 1;
  return Math.min(AI_VOICE_LIMITS.maxAudioMs / 1000, Math.max(1, Math.ceil(durationMs / 1000)));
}

/** 同频点 for one transcription, rounded up; 0 only when the price is 0. */
export function voiceTranscriptionPoints(durationMs: number, pointsPerMinute: number): number {
  if (!Number.isSafeInteger(pointsPerMinute) || pointsPerMinute <= 0) return 0;
  const product = pointsPerMinute * voiceBilledSeconds(durationMs);
  return Math.floor((product + 59) / 60);
}

/** 同频点 for one synthesized chunk, rounded up per request. */
export function voiceSpeechPoints(characters: number, pointsPer1kChars: number): number {
  if (!Number.isSafeInteger(pointsPer1kChars) || pointsPer1kChars <= 0 || !Number.isSafeInteger(characters) || characters <= 0) return 0;
  return Math.floor((pointsPer1kChars * characters + 999) / 1000);
}
