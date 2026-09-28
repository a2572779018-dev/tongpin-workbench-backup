import type { VoiceIssue } from "../recorderState";
import { newSpeechParts, NO_SPEECH_PROGRESS, type SpeechProgress } from "./callSentences";

/**
 * The 语音通话 state machine, ported from Open WebUI v0.6.5 (BSD-3-Clause,
 * Copyright (c) 2023-2025 Timothy Jaeryang Baek)
 * `src/lib/components/chat/MessageInput/CallOverlay.svelte`:
 *
 * - listen → the member stops talking → transcribe (`transcribeHandler`) →
 *   send the text as a normal chat turn (`submitPrompt`);
 * - from the moment a turn is sent until its reply has been spoken, the
 *   microphone is muted (`assistantSpeaking`; Open WebUI's default without
 *   `voiceInterruption`), so the AI never answers its own voice;
 * - the reply is followed while it streams (Chat.svelte's `chat:start` /
 *   `chat` / `chat:finish` events) and its sentences are queued for speech;
 * - when the queue drains, listening starts again; "打断" (Open WebUI's "Tap
 *   to interrupt") silences the reply, stops it if it is still streaming and
 *   listens again; "挂断" ends the call.
 *
 * Changes for Tongpin: speech detection is Silero VAD (see sileroVad.ts) and
 * a pause inside one thought does not split it: text heard while the member
 * is talking again is carried into the next utterance instead of being sent.
 */

export type CallPhase = "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "failed";
export type VoiceCallTurnResult = { ok: true } | { ok: false; reason: string };

export interface CallViewState {
  phase: CallPhase;
  /** What the member said last (as transcribed). */
  heard: string;
  /** The sentence the AI is speaking now. */
  saying: string;
  /** A short, recoverable notice ("没听清…"). */
  notice: string;
  /** Why the call cannot run (microphone, speech detection). */
  fatal: VoiceIssue | null;
}

export interface CallReplyLike {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: "thinking" | "typing" | "ready" | "error" | "stopped";
  /** A task card (image, video, PPT…) that the reply handed over to. */
  artifactId?: string;
}

export interface CallMicrophone {
  resume(): Promise<void> | void;
  pause(): Promise<void> | void;
  destroy(): Promise<void> | void;
}

export interface CallSpeakerLike {
  start(id: string): void;
  push(id: string, content: string): void;
  finish(id: string): void;
  stopAll(): void;
}

export interface CallHost {
  transcribe(audio: Float32Array): Promise<string>;
  /** Sends one spoken turn; `reason: "busy"` means the previous reply has not released the conversation yet. */
  submitTurn(text: string): VoiceCallTurnResult;
  /** Stops the reply that is still being generated (the composer's stop). */
  stopReply(): void;
  errorMessage(error: unknown): string;
}

const BUSY_RETRY_MS = 300;
const BUSY_WAIT_MS = 5000;
/** A sent turn whose reply never appears (the composer refused it) gives the microphone back. */
const NO_REPLY_MS = 8000;
const APOLOGY = "抱歉，这次没有回答成功，请再说一遍。";
/** Said when a spoken request became a task card that waits for the member's click. */
const TASK_CARD = "好的，任务已经放到对话里了，需要确认的话请在屏幕上点一下。";

function join(first: string, second: string): string {
  if (!first) return second.trim();
  if (!second) return first.trim();
  const glue = /[\p{Script=Han}，。！？、；：]$/u.test(first) || /^[\p{Script=Han}，。！？、；：]/u.test(second) ? "" : " ";
  return `${first.trim()}${glue}${second.trim()}`;
}

function lastAssistantId(messages: readonly CallReplyLike[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) if (messages[index].role === "assistant") return messages[index].id;
  return null;
}

interface Follow { baseline: string | null; id: string | null; progress: SpeechProgress; spoken: boolean; finished: boolean }

export class VoiceCallController {
  private state: CallViewState = { phase: "starting", heard: "", saying: "", notice: "", fatal: null };
  private readonly listeners = new Set<() => void>();
  private microphone: CallMicrophone | null = null;
  private messages: readonly CallReplyLike[] = [];
  private follow: Follow | null = null;
  private carry = "";
  private transcriptions: Promise<void> = Promise.resolve();
  private pendingTranscriptions = 0;
  private closed = false;
  /** Assistant messages already present or already spoken; anything newer is announced. */
  private readonly seen = new Set<string>();
  private primed = false;

  constructor(private readonly host: CallHost, private readonly speaker: CallSpeakerLike, private readonly wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  readonly getState = (): CallViewState => this.state;

  private set(patch: Partial<CallViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  get phase(): CallPhase { return this.state.phase; }

  /** (Re)opens the call before the microphone is requested (React may mount twice). */
  open(): void {
    this.closed = false;
    this.follow = null;
    this.carry = "";
    this.seen.clear();
    this.primed = false;
    this.set({ phase: "starting", heard: "", saying: "", notice: "", fatal: null });
  }

  /** The microphone and speech detection are ready. */
  attach(microphone: CallMicrophone): void {
    if (this.closed) { void microphone.destroy(); return; }
    this.microphone = microphone;
    this.listen();
  }

  fail(issue: VoiceIssue): void {
    if (this.closed) return;
    this.set({ phase: "failed", fatal: issue });
  }

  private listen(): void {
    if (this.closed || !this.microphone) return;
    this.set({ phase: this.pendingTranscriptions ? "transcribing" : "listening", saying: "" });
    void this.microphone.resume();
  }

  // ------------------------------------------------------------ microphone events
  speechStarted(): void {
    if (this.closed || this.follow) return;
    this.set({ phase: "hearing", notice: "" });
  }

  misfire(): void {
    if (this.closed || this.follow || this.state.phase !== "hearing") return;
    if (this.pendingTranscriptions) { this.set({ phase: "transcribing" }); return; }
    if (this.carry) { const text = this.carry; this.carry = ""; void this.submit(text); return; }
    this.set({ phase: "listening" });
  }

  speechEnded(audio: Float32Array): void {
    if (this.closed || this.follow) return;
    this.pendingTranscriptions += 1;
    this.set({ phase: "transcribing" });
    // One utterance at a time, in order (Open WebUI transcribes each recording before the next).
    this.transcriptions = this.transcriptions.then(async () => {
      let text = "";
      try { text = await this.host.transcribe(audio); }
      catch (error) { if (!this.closed) this.set({ notice: this.host.errorMessage(error) }); }
      this.pendingTranscriptions -= 1;
      if (this.closed || this.follow) return;
      // The member is talking again (or another utterance waits): keep this part of the thought.
      if (this.state.phase === "hearing" || this.pendingTranscriptions > 0) { this.carry = join(this.carry, text); return; }
      const full = join(this.carry, text);
      this.carry = "";
      if (!full) { this.set({ phase: "listening", notice: this.state.notice || "没听清，请再说一遍。" }); return; }
      await this.submit(full);
    });
  }

  // ------------------------------------------------------------ turns
  private async submit(text: string): Promise<void> {
    this.set({ heard: text, notice: "" });
    const baseline = lastAssistantId(this.messages);
    const deadline = Date.now() + BUSY_WAIT_MS;
    for (;;) {
      if (this.closed) return;
      const result = this.host.submitTurn(text);
      if (result.ok) break;
      if (result.reason !== "busy" || Date.now() >= deadline) {
        this.set({ phase: "listening", notice: result.reason === "busy" ? "上一条回复还没结束，请稍后再说。" : result.reason });
        return;
      }
      await this.wait(BUSY_RETRY_MS);
    }
    // Open WebUI mutes detection from `chat:start` until the reply has been spoken.
    const follow: Follow = { baseline, id: null, progress: NO_SPEECH_PROGRESS, spoken: false, finished: false };
    this.follow = follow;
    this.set({ phase: "thinking" });
    void this.microphone?.pause();
    this.track();
    void this.wait(NO_REPLY_MS).then(() => { if (this.follow === follow && !follow.id) this.notSent("这句话没有发出去，请再说一遍。"); });
  }

  /** The turn was not sent after all (the composer showed why): listen again. */
  notSent(reason: string): void {
    if (this.closed || !this.follow || this.follow.id) return;
    this.follow = null;
    this.set({ notice: reason });
    this.listen();
  }

  /** The conversation's messages as rendered (streamed text included). */
  updateMessages(messages: readonly CallReplyLike[]): void {
    this.messages = messages;
    if (!this.primed) {
      this.primed = true;
      for (const message of messages) if (message.role === "assistant") this.seen.add(message.id);
    }
    this.track();
    this.announce();
  }

  /** A reply that arrives on its own while the call listens (an operation's
   * result, a finished task) is read out too. */
  private announce(): void {
    if (this.closed || this.follow || !this.microphone || this.state.phase !== "listening") return;
    const reply = this.messages.find(message => message.role === "assistant" && !this.seen.has(message.id) && message.status !== "thinking" && message.content.trim());
    if (!reply) return;
    this.follow = { baseline: null, id: reply.id, progress: NO_SPEECH_PROGRESS, spoken: false, finished: false };
    this.seen.add(reply.id);
    this.speaker.start(reply.id);
    void this.microphone.pause();
    this.track();
  }

  private track(): void {
    const follow = this.follow;
    if (!follow || this.closed) return;
    let reply: CallReplyLike | undefined;
    if (follow.id) reply = this.messages.find(message => message.id === follow.id);
    else {
      const id = lastAssistantId(this.messages);
      if (!id || id === follow.baseline) return;
      follow.id = id;
      this.seen.add(id);
      this.speaker.start(id);
      reply = this.messages.find(message => message.id === id);
    }
    if (!reply || follow.finished) return;
    const done = reply.status !== "thinking";
    // A failed reply's text is an error notice for the screen, not an answer to read out.
    if (reply.status !== "error") {
      const next = newSpeechParts(reply.content, follow.progress, done);
      for (const part of next.parts) this.speaker.push(reply.id, part);
      follow.progress = next.progress;
      if (next.parts.length) follow.spoken = true;
    }
    if (!done) return;
    follow.finished = true;
    if (!follow.spoken) {
      if (reply.status === "error" || reply.status === "stopped") this.speaker.push(reply.id, APOLOGY);
      else if (reply.artifactId) this.speaker.push(reply.id, TASK_CARD);
      if (reply.status === "error" && reply.content.trim()) this.set({ notice: reply.content.trim().slice(0, 120) });
    }
    this.speaker.finish(reply.id);
  }

  // ------------------------------------------------------------ speaker events
  speaking(sentence: string): void {
    if (this.closed || !this.follow) return;
    this.set({ phase: "speaking", saying: sentence });
  }

  drained(): void {
    if (this.closed) return;
    this.follow = null;
    this.listen();
    this.announce();
  }

  // ------------------------------------------------------------ member actions
  /** "打断": silence the reply, stop it if it is still running, listen again. */
  interrupt(): void {
    if (this.closed || !this.follow) return;
    const follow = this.follow;
    this.follow = null;
    this.speaker.stopAll();
    if (!follow.finished) this.host.stopReply();
    this.listen();
  }

  /** "挂断". The reply keeps its text in the conversation; only the voice stops. */
  hangUp(): void {
    if (this.closed) return;
    this.closed = true;
    this.follow = null;
    this.speaker.stopAll();
    const microphone = this.microphone;
    this.microphone = null;
    void microphone?.destroy();
  }
}
