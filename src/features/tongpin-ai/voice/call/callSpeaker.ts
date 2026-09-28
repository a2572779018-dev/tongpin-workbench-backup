import { pickSpeechVoice, speechLanguage, type SpeechVoiceLike } from "../speechText";

/**
 * The spoken side of a 语音通话, ported from Open WebUI v0.6.5 (BSD-3-Clause,
 * Copyright (c) 2023-2025 Timothy Jaeryang Baek)
 * `src/lib/components/chat/MessageInput/CallOverlay.svelte`:
 * `chatStartHandler` / `chatEventHandler` / `chatFinishHandler` (a queue of
 * sentences per reply), `fetchAudio` (external audio fetched as soon as a
 * sentence is queued, kept in a cache), `monitorAndPlayAudio` (play the queue
 * in order until the reply is finished and the queue is empty),
 * `speakSpeechSynthesisHandler`, `playAudio` and `stopAllAudio`.
 *
 * Changes for Tongpin: sentences come from `callSentences.ts`; system voices
 * prefer an installed Chinese voice (a Premium/Enhanced one when present);
 * the member's read-aloud rate is used; a sentence whose end event never
 * arrives, or whose external audio fails, cannot leave the call stuck in
 * "speaking" (it times out, or falls back to the system voice).
 */

export interface CallSpeakerOptions {
  /** "external" fetches each sentence from the administrator's speech model. */
  engine: "browser" | "external";
  rate: number;
  synthesize?: (text: string, signal: AbortSignal) => Promise<Blob>;
  /** A sentence of the reply starts playing. */
  onSpeaking(sentence: string): void;
  /** The reply is finished and every queued sentence was spoken (or skipped). */
  onDrained(): void;
}

const PAUSE_AFTER_SENTENCE_MS = 120;
const POLL_MS = 60;

const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, ms);
  function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

/** A zh-CN voice, preferring the higher-quality downloads macOS offers. */
export function pickCallVoice<T extends SpeechVoiceLike>(voices: readonly T[], text: string): T | null {
  const language = speechLanguage(text);
  const chinese = language === "zh-CN" ? voices.filter(voice => /^(zh[-_]cn|zh[-_]hans|cmn)/i.test(voice.lang)) : [];
  const better = chinese.find(voice => /premium|enhanced|高品质|优化/i.test(voice.name));
  return better ?? pickSpeechVoice(voices, language);
}

function loadVoices(signal: AbortSignal): Promise<SpeechSynthesisVoice[]> {
  const synthesis = window.speechSynthesis;
  const voices = synthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); synthesis.removeEventListener("voiceschanged", done); resolve(synthesis.getVoices()); };
    const timer = setTimeout(done, 1500);
    synthesis.addEventListener("voiceschanged", done);
    signal.addEventListener("abort", done, { once: true });
  });
}

export class CallSpeaker {
  private readonly messages = new Map<string, string[]>();
  private readonly finished = new Set<string>();
  private readonly audioCache = new Map<string, Promise<Blob | null>>();
  private currentMessageId: string | null = null;
  private loop: AbortController | null = null;
  private utterance: SpeechSynthesisUtterance | null = null;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private externalFailed = false;

  constructor(private readonly options: CallSpeakerOptions) {}

  /** Open WebUI `chatStartHandler`: a new reply replaces whatever was playing. */
  start(id: string): void {
    if (this.currentMessageId === id) return;
    this.stopAll();
    this.currentMessageId = id;
    const loop = new AbortController();
    this.loop = loop;
    void this.monitorAndPlayAudio(id, loop.signal);
  }

  /** Open WebUI `chatEventHandler`: one more finished sentence of the reply. */
  push(id: string, content: string): void {
    if (this.currentMessageId !== id || !content.trim()) return;
    const queue = this.messages.get(id);
    if (queue) queue.push(content); else this.messages.set(id, [content]);
    this.fetchAudio(content);
  }

  /** Open WebUI `chatFinishHandler`. */
  finish(id: string): void {
    if (this.currentMessageId === id) this.finished.add(id);
  }

  get active(): boolean { return this.loop !== null; }

  /** Open WebUI `stopAllAudio`: silence now and forget the current reply. */
  stopAll(): void {
    this.loop?.abort();
    this.loop = null;
    if (this.currentMessageId) { this.messages.delete(this.currentMessageId); this.finished.delete(this.currentMessageId); }
    this.currentMessageId = null;
    try { if (this.utterance || window.speechSynthesis?.speaking) window.speechSynthesis.cancel(); } catch { /* Nothing is speaking. */ }
    this.utterance = null;
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio.pause(); this.audio = null; }
    if (this.audioUrl) { URL.revokeObjectURL(this.audioUrl); this.audioUrl = null; }
    this.audioCache.clear();
  }

  private fetchAudio(content: string): void {
    if (this.options.engine !== "external" || this.externalFailed || !this.options.synthesize || this.audioCache.has(content)) return;
    const signal = this.loop?.signal;
    if (!signal) return;
    const pending = this.options.synthesize(content, signal).catch(() => null);
    this.audioCache.set(content, pending);
  }

  private async monitorAndPlayAudio(id: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const queue = this.messages.get(id);
      if (queue?.length) {
        const content = queue.shift()!;
        this.options.onSpeaking(content);
        const cached = this.audioCache.get(content);
        const blob = cached ? await cached : null;
        this.audioCache.delete(content);
        if (signal.aborted) break;
        if (blob) await this.playAudio(blob, signal);
        else {
          // Open WebUI left the call "speaking" when external speech failed; fall back instead.
          if (cached) this.externalFailed = true;
          await this.speakSpeechSynthesis(content, signal);
        }
        await wait(PAUSE_AFTER_SENTENCE_MS, signal);
      } else if (this.finished.has(id)) {
        break;
      } else {
        await wait(POLL_MS, signal);
      }
    }
    if (!signal.aborted && this.loop?.signal === signal) {
      this.loop = null;
      this.messages.delete(id); this.finished.delete(id);
      this.currentMessageId = null;
      this.options.onDrained();
    }
  }

  private async speakSpeechSynthesis(content: string, signal: AbortSignal): Promise<void> {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const voices = await loadVoices(signal);
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const utterance = new SpeechSynthesisUtterance(content);
      const voice = pickCallVoice(voices, content);
      utterance.lang = voice?.lang ?? speechLanguage(content);
      if (voice) utterance.voice = voice;
      utterance.rate = this.options.rate;
      // Chromium may never fire "end" for a dropped utterance: a generous upper bound.
      const limit = setTimeout(done, 4000 + Array.from(content).length * 450 / this.options.rate);
      function done() { clearTimeout(limit); signal.removeEventListener("abort", done); resolve(); }
      utterance.onend = done;
      utterance.onerror = done;
      signal.addEventListener("abort", done, { once: true });
      this.utterance = utterance;
      window.speechSynthesis.speak(utterance);
    });
    this.utterance = null;
  }

  private async playAudio(blob: Blob, signal: AbortSignal): Promise<void> {
    const url = URL.createObjectURL(blob);
    this.audioUrl = url;
    await new Promise<void>(resolve => {
      const audio = new Audio(url);
      audio.playbackRate = this.options.rate;
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      audio.onended = done;
      audio.onerror = done;
      signal.addEventListener("abort", done, { once: true });
      this.audio = audio;
      audio.play().catch(done);
    });
    if (this.audio) { this.audio.onended = null; this.audio.onerror = null; this.audio = null; }
    URL.revokeObjectURL(url);
    if (this.audioUrl === url) this.audioUrl = null;
  }
}
