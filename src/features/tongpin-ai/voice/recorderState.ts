/**
 * Pure state for the composer's voice recorder, adapted from LibreChat v0.8.7
 * `client/src/hooks/Input/useSpeechToTextExternal.ts` (MediaRecorder chunks,
 * best supported MIME type, silence monitoring that stops the recording) and
 * `client/src/components/Chat/Input/AudioRecorder.tsx` (append the
 * transcription to text already in the composer). Timers, the level meter and
 * the 60-second cap are Tongpin's.
 */

export type RecorderPhase = "idle" | "starting" | "recording" | "transcribing" | "error";

export interface VoiceIssue {
  message: string;
  /** The desktop app can open the operating system's microphone privacy pane. */
  canOpenSettings: boolean;
}

export interface RecorderState {
  phase: RecorderPhase;
  startedAt: number | null;
  elapsedMs: number;
  /** Most recent input levels, 0..1, oldest first. */
  levels: number[];
  issue: VoiceIssue | null;
  notice: string;
}

export type RecorderEvent =
  | { type: "start" }
  | { type: "started"; at: number }
  | { type: "tick"; now: number; level: number }
  | { type: "stop"; notice?: string }
  | { type: "cancel"; notice?: string }
  | { type: "transcribed"; notice?: string }
  | { type: "fail"; issue: VoiceIssue }
  | { type: "dismiss" };

export const LEVEL_HISTORY = 5;

export const INITIAL_RECORDER_STATE: RecorderState = Object.freeze({
  phase: "idle", startedAt: null, elapsedMs: 0, levels: [], issue: null, notice: "",
}) as RecorderState;

export function recorderReducer(state: RecorderState, event: RecorderEvent): RecorderState {
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "error" ? { ...INITIAL_RECORDER_STATE, phase: "starting" } : state;
    case "started":
      return state.phase === "starting" ? { ...state, phase: "recording", startedAt: event.at, elapsedMs: 0, levels: [] } : state;
    case "tick": {
      if (state.phase !== "recording" || state.startedAt === null) return state;
      const level = Number.isFinite(event.level) ? Math.min(1, Math.max(0, event.level)) : 0;
      return { ...state, elapsedMs: Math.max(0, event.now - state.startedAt), levels: [...state.levels, level].slice(-LEVEL_HISTORY) };
    }
    case "stop":
      return state.phase === "recording" ? { ...state, phase: "transcribing", levels: [], notice: event.notice ?? "" } : state;
    case "cancel":
      return state.phase === "starting" || state.phase === "recording" ? { ...INITIAL_RECORDER_STATE, notice: event.notice ?? "" } : state;
    case "transcribed":
      return state.phase === "transcribing" ? { ...INITIAL_RECORDER_STATE, notice: event.notice ?? "" } : state;
    case "fail":
      return { ...INITIAL_RECORDER_STATE, phase: "error", issue: event.issue };
    case "dismiss":
      return state.phase === "error" || state.phase === "idle" ? { ...INITIAL_RECORDER_STATE } : { ...state, notice: "" };
    default:
      return state;
  }
}

/** A recording is in progress from the permission check until the transcript is back. */
export function recorderBusy(state: RecorderState): boolean {
  return state.phase === "starting" || state.phase === "recording" || state.phase === "transcribing";
}

/** Silence tracking for voice conversation mode: stop after speech, then quiet. */
export interface SilenceTracker { speechAt: number | null; lastLoudAt: number | null }
export const SPEECH_LEVEL = 0.08;

export function trackSilence(tracker: SilenceTracker, now: number, level: number): SilenceTracker {
  if (level < SPEECH_LEVEL) return tracker;
  return { speechAt: tracker.speechAt ?? now, lastLoudAt: now };
}

export function recordingStopReason(
  startedAt: number,
  tracker: SilenceTracker,
  now: number,
  options: { maxMs: number; silenceStopMs?: number; noSpeechMs?: number },
): "limit" | "silence" | "no-speech" | null {
  if (now - startedAt >= options.maxMs) return "limit";
  if (!options.silenceStopMs) return null;
  if (tracker.lastLoudAt !== null && now - tracker.lastLoudAt >= options.silenceStopMs) return "silence";
  if (tracker.speechAt === null && options.noSpeechMs && now - startedAt >= options.noSpeechMs) return "no-speech";
  return null;
}

/** RMS level (0..1) of 8-bit time-domain samples centred on 128, scaled for display. */
export function audioLevel(samples: ArrayLike<number>): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = (samples[index] - 128) / 128;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}

/** Heights (0.18..1) for the level bars; quiet input still shows a baseline. */
export function levelBars(levels: readonly number[], count = LEVEL_HISTORY): number[] {
  const recent = levels.slice(-count);
  const padded = [...Array.from({ length: Math.max(0, count - recent.length) }, () => 0), ...recent];
  return padded.map(level => Number((0.18 + 0.82 * Math.min(1, Math.max(0, level))).toFixed(3)));
}

const RECORDER_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

/** First MIME type the MediaRecorder supports; "" lets the browser choose. */
export function pickRecorderMimeType(isTypeSupported: (type: string) => boolean): string {
  for (const type of RECORDER_TYPES) {
    try { if (isTypeSupported(type)) return type; } catch { /* Keep looking. */ }
  }
  return "";
}

export function recordingFileName(mimeType: string): string {
  const essence = mimeType.split(";")[0].trim().toLowerCase();
  return essence === "audio/ogg" ? "voice.ogg" : essence === "audio/mp4" ? "voice.m4a" : essence === "audio/wav" ? "voice.wav" : "voice.webm";
}

export function formatRecordingTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const CJK = /[\p{Script=Han}　-〿＀-￯]/u;

/** Appends a transcript to the draft: no space between Chinese text, one
 * space between Latin words, nothing when the draft already ends in space. */
export function joinTranscript(existing: string, addition: string): string {
  const text = addition.trim();
  if (!text) return existing;
  if (!existing.trim()) return text;
  if (/\s$/.test(existing)) return existing + text;
  const last = Array.from(existing).at(-1) ?? "";
  const first = Array.from(text)[0] ?? "";
  return CJK.test(last) || CJK.test(first) ? existing + text : `${existing} ${text}`;
}
