import { markdownToSpeechText, pickSpeechVoice, speechLanguage, splitSpeechChunks, type SpeechVoiceLike } from "./speechText";

/**
 * One read-aloud at a time for the whole AI workspace. Adapted from LibreChat
 * v0.8.7 `client/src/hooks/Input/useTextToSpeechBrowser.ts` (speechSynthesis
 * utterances, cancel on "interrupted"/"canceled") and
 * `client/src/hooks/Input/useTextToSpeechExternal.ts` (audio Blob played with
 * the member's playback rate, object URL revoked when done), with Tongpin's
 * sentence chunking, a Chinese voice preference and a single global stop.
 */
export type SpeechStatus = "idle" | "loading" | "speaking";
export type SpeechEngine = "browser" | "external";
export interface SpeechPlaybackState { key: string | null; status: SpeechStatus; error: string }
export interface SpeechPlayOptions {
  engine: SpeechEngine;
  rate: number;
  synthesize?: (text: string, signal: AbortSignal) => Promise<Blob>;
}
export type SpeechPlayResult = { outcome: "completed" | "stopped" } | { outcome: "failed"; error: unknown };

export interface UtteranceLike {
  text: string; lang: string; rate: number; voice: unknown;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}
export interface SynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): SpeechVoiceLike[];
  addEventListener?(type: "voiceschanged", listener: () => void): void;
  removeEventListener?(type: "voiceschanged", listener: () => void): void;
}
export interface AudioLike {
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}
export interface SpeechEnvironment {
  synthesis: SynthesisLike | null;
  createUtterance(text: string): UtteranceLike;
  createAudio(url: string): AudioLike;
  createObjectUrl(blob: Blob): string;
  revokeObjectUrl(url: string): void;
}

export function browserSpeechEnvironment(): SpeechEnvironment | null {
  if (typeof window === "undefined") return null;
  let synthesis: SynthesisLike | null = null;
  try { synthesis = "speechSynthesis" in window ? window.speechSynthesis as unknown as SynthesisLike : null; } catch { synthesis = null; }
  return {
    synthesis,
    createUtterance: text => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    createAudio: url => new Audio(url) as unknown as AudioLike,
    createObjectUrl: blob => URL.createObjectURL(blob),
    revokeObjectUrl: url => URL.revokeObjectURL(url),
  };
}

const BROWSER_CHUNK = 160;
const EXTERNAL_CHUNK = 600;

function failureMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string" && (error as { message: string }).message) {
    return (error as { message: string }).message;
  }
  return "朗读失败，请稍后重试";
}

function isAbort(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "name" in error && (error as { name: unknown }).name === "AbortError");
}

/** Settles as soon as the member stops, even if the pending work ignores the signal. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new DOMException("朗读已停止", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("朗读已停止", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function loadVoices(synthesis: SynthesisLike, signal: AbortSignal): Promise<SpeechVoiceLike[]> {
  const available = synthesis.getVoices();
  if (available.length || !synthesis.addEventListener) return Promise.resolve(available);
  // Chromium fills the list asynchronously on first use.
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); synthesis.removeEventListener?.("voiceschanged", done); signal.removeEventListener("abort", done); resolve(synthesis.getVoices()); };
    const timer = setTimeout(done, 1500);
    synthesis.addEventListener!("voiceschanged", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class SpeechPlayer {
  private state: SpeechPlaybackState = { key: null, status: "idle", error: "" };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private controller: AbortController | null = null;
  private audio: AudioLike | null = null;
  /** Chromium may drop the end event of an utterance that was garbage-collected. */
  private utterance: UtteranceLike | null = null;
  private readonly urls = new Set<string>();

  constructor(private readonly environment: () => SpeechEnvironment | null) {}

  getState(): SpeechPlaybackState { return this.state; }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Primitive per-message snapshot, so only the affected row re-renders. */
  snapshot(key: string): string {
    return this.state.key === key ? `${this.state.status}\u0000${this.state.error}` : "idle\u0000";
  }

  private set(next: SpeechPlaybackState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private halt(): void {
    this.controller?.abort();
    this.controller = null;
    const environment = this.environment();
    try { environment?.synthesis?.cancel(); } catch { /* Nothing is speaking. */ }
    if (this.audio) {
      const audio = this.audio;
      this.audio = null;
      audio.onended = null; audio.onerror = null;
      try { audio.pause(); } catch { /* Already stopped. */ }
    }
    this.utterance = null;
    for (const url of this.urls) environment?.revokeObjectUrl(url);
    this.urls.clear();
  }

  stop(): void {
    this.generation += 1;
    this.halt();
    if (this.state.key !== null || this.state.status !== "idle" || this.state.error) this.set({ key: null, status: "idle", error: "" });
  }

  /** Marks `key` as loading at once (before settings or audio are fetched). */
  prepare(key: string): number {
    this.generation += 1;
    this.halt();
    this.controller = new AbortController();
    this.set({ key, status: "loading", error: "" });
    return this.generation;
  }

  async play(key: string, markdown: string, options: SpeechPlayOptions, ticket?: number): Promise<SpeechPlayResult> {
    if (ticket !== undefined && ticket !== this.generation) return { outcome: "stopped" };
    const token = ticket ?? this.prepare(key);
    const controller = this.controller ?? new AbortController();
    this.controller = controller;
    try {
      const text = markdownToSpeechText(markdown);
      if (!text) throw new Error("这条回复没有可朗读的文字");
      const environment = this.environment();
      if (!environment) throw new Error("当前环境不支持朗读");
      if (options.engine === "external" && options.synthesize) await this.playExternal(key, token, controller.signal, environment, text, options);
      else await this.playBrowser(key, token, controller.signal, environment, text, options.rate);
      if (token !== this.generation) return { outcome: "stopped" };
      this.halt();
      this.set({ key: null, status: "idle", error: "" });
      return { outcome: "completed" };
    } catch (error) {
      if (token !== this.generation || isAbort(error)) return { outcome: "stopped" };
      this.halt();
      this.set({ key, status: "idle", error: failureMessage(error) });
      return { outcome: "failed", error };
    }
  }

  private speaking(key: string, token: number): void {
    if (token === this.generation && this.state.status !== "speaking") this.set({ key, status: "speaking", error: "" });
  }

  private async playBrowser(key: string, token: number, signal: AbortSignal, environment: SpeechEnvironment, text: string, rate: number): Promise<void> {
    const synthesis = environment.synthesis;
    if (!synthesis) throw new Error("当前系统不支持朗读");
    const voices = await loadVoices(synthesis, signal);
    const language = speechLanguage(text);
    const voice = pickSpeechVoice(voices, language);
    for (const chunk of splitSpeechChunks(text, BROWSER_CHUNK)) {
      if (token !== this.generation || signal.aborted) return;
      await new Promise<void>((resolve, reject) => {
        const utterance = environment.createUtterance(chunk);
        utterance.lang = voice?.lang ?? language;
        if (voice) utterance.voice = voice;
        utterance.rate = rate;
        utterance.onend = () => resolve();
        utterance.onerror = event => event?.error === "interrupted" || event?.error === "canceled" ? resolve() : reject(new Error("系统朗读出错，请检查系统语音设置"));
        signal.addEventListener("abort", () => resolve(), { once: true });
        this.utterance = utterance;
        synthesis.speak(utterance);
        this.speaking(key, token);
      });
    }
  }

  private async playExternal(key: string, token: number, signal: AbortSignal, environment: SpeechEnvironment, text: string, options: SpeechPlayOptions): Promise<void> {
    const chunks = splitSpeechChunks(text, EXTERNAL_CHUNK);
    const fetchChunk = (index: number) => {
      const pending = options.synthesize!(chunks[index], signal);
      pending.catch(() => undefined);
      return pending;
    };
    // Fetch one chunk ahead so consecutive chunks play without a long gap.
    let next: Promise<Blob> | null = chunks.length ? fetchChunk(0) : null;
    for (let index = 0; index < chunks.length && next; index += 1) {
      const blob = await abortable(next, signal);
      if (token !== this.generation || signal.aborted) return;
      next = index + 1 < chunks.length ? fetchChunk(index + 1) : null;
      const url = environment.createObjectUrl(blob);
      this.urls.add(url);
      await new Promise<void>((resolve, reject) => {
        const audio = environment.createAudio(url);
        this.audio = audio;
        audio.playbackRate = options.rate;
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("朗读音频无法播放"));
        signal.addEventListener("abort", () => resolve(), { once: true });
        audio.play().then(() => this.speaking(key, token), reject);
      });
      environment.revokeObjectUrl(url);
      this.urls.delete(url);
    }
  }
}

export const speechPlayer = new SpeechPlayer(browserSpeechEnvironment);
