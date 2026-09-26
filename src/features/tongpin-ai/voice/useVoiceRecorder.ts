import { useCallback, useEffect, useReducer, useRef } from "react";
import type { MicrophoneBridge } from "../../../../shared/aiVoice";
import { classifyMicrophoneError, ensureMicrophoneAccess, microphoneIssue } from "./micPermission";
import {
  audioLevel, INITIAL_RECORDER_STATE, pickRecorderMimeType, recorderReducer, recordingStopReason, trackSilence,
  type SilenceTracker, type VoiceIssue,
} from "./recorderState";

export interface VoiceRecording {
  blob: Blob;
  durationMs: number;
  mimeType: string;
  stopReason: "manual" | "limit" | "silence";
}

interface ActiveRecording {
  stream: MediaStream;
  recorder: MediaRecorder;
  context: AudioContext | null;
  analyser: AnalyserNode | null;
  chunks: Blob[];
  startedAt: number;
  startedAtClock: number;
  timer: number;
  silence: SilenceTracker;
  discard: boolean;
  reason: VoiceRecording["stopReason"];
}

/** True while any composer holds the microphone, so read-aloud never plays into it. */
let captures = 0;
export function isVoiceCaptureActive(): boolean { return captures > 0; }

const TICK_MS = 100;
const SILENCE_STOP_MS = 1800;
const NO_SPEECH_MS = 8000;

/**
 * MediaRecorder lifecycle for one composer. Microphone tracks and the audio
 * context are released as soon as a recording stops, is cancelled, fails or
 * the composer unmounts; nothing is recorded before the member presses the
 * microphone button.
 */
export function useVoiceRecorder({ maxMs, stopOnSilence, onRecorded }: {
  maxMs: number;
  stopOnSilence: boolean;
  onRecorded: (recording: VoiceRecording) => void;
}) {
  const [state, dispatch] = useReducer(recorderReducer, INITIAL_RECORDER_STATE);
  const active = useRef<ActiveRecording | null>(null);
  const starting = useRef(false);
  const mounted = useRef(true);
  const options = useRef({ maxMs, stopOnSilence, onRecorded });
  options.current = { maxMs, stopOnSilence, onRecorded };

  const release = useCallback((recording: ActiveRecording) => {
    if (active.current === recording) captures = Math.max(0, captures - 1);
    window.clearInterval(recording.timer);
    for (const track of recording.stream.getTracks()) track.stop();
    void recording.context?.close().catch(() => undefined);
    if (active.current === recording) active.current = null;
  }, []);

  const halt = useCallback((recording: ActiveRecording, discard: boolean) => {
    if (discard) recording.discard = true;
    if (recording.recorder.state === "inactive") { release(recording); return; }
    try { recording.recorder.stop(); } catch { release(recording); }
  }, [release]);

  const stop = useCallback((reason: VoiceRecording["stopReason"] = "manual") => {
    const recording = active.current;
    if (!recording || recording.recorder.state === "inactive") return;
    recording.reason = reason;
    dispatch({ type: "stop", notice: reason === "limit" ? "已到单次录音上限，已自动停止" : "" });
    halt(recording, false);
  }, [halt]);

  const cancel = useCallback((notice?: string) => {
    const recording = active.current;
    if (recording) halt(recording, true);
    dispatch({ type: "cancel", ...(notice ? { notice } : {}) });
  }, [halt]);

  const start = useCallback(async (bridge: MicrophoneBridge | undefined, platform: string) => {
    if (starting.current || active.current) return;
    starting.current = true;
    dispatch({ type: "start" });
    const fail = (issue: VoiceIssue) => { if (mounted.current) dispatch({ type: "fail", issue }); };
    const desktop = Boolean(bridge);
    try {
      const access = await ensureMicrophoneAccess(bridge);
      if (!access.ok) { fail(microphoneIssue(access.reason, platform, desktop)); return; }
      if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        fail(microphoneIssue("unsupported", platform, desktop)); return;
      }
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }, video: false });
      } catch (error) {
        fail(microphoneIssue(classifyMicrophoneError(error), platform, desktop)); return;
      }
      if (!mounted.current) { for (const track of stream.getTracks()) track.stop(); return; }
      const mimeType = pickRecorderMimeType(type => MediaRecorder.isTypeSupported(type));
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
      } catch {
        for (const track of stream.getTracks()) track.stop();
        fail(microphoneIssue("unsupported", platform, desktop)); return;
      }
      let context: AudioContext | null = null, analyser: AnalyserNode | null = null;
      try {
        context = new AudioContext();
        analyser = context.createAnalyser();
        analyser.fftSize = 512;
        context.createMediaStreamSource(stream).connect(analyser);
        void context.resume().catch(() => undefined);
      } catch { context = null; analyser = null; }
      const recording: ActiveRecording = {
        stream, recorder, context, analyser, chunks: [], startedAt: performance.now(), startedAtClock: Date.now(), timer: 0,
        silence: { speechAt: null, lastLoudAt: null }, discard: false, reason: "manual",
      };
      recorder.ondataavailable = event => { if (event.data.size > 0) recording.chunks.push(event.data); };
      recorder.onstop = () => {
        const durationMs = performance.now() - recording.startedAt;
        release(recording);
        if (recording.discard || !mounted.current) return;
        const type = recorder.mimeType || mimeType || "audio/webm";
        options.current.onRecorded({ blob: new Blob(recording.chunks, { type }), durationMs, mimeType: type, stopReason: recording.reason });
      };
      recorder.onerror = () => { recording.discard = true; release(recording); fail(microphoneIssue("busy", platform, desktop)); };
      active.current = recording;
      captures += 1;
      recorder.start(250);
      dispatch({ type: "started", at: recording.startedAtClock });
      const samples = new Uint8Array(analyser?.fftSize ?? 0);
      recording.timer = window.setInterval(() => {
        if (active.current !== recording || recording.recorder.state !== "recording") return;
        let level = 0;
        if (analyser) { analyser.getByteTimeDomainData(samples); level = audioLevel(samples); }
        const now = Date.now();
        recording.silence = trackSilence(recording.silence, now, level);
        dispatch({ type: "tick", now, level });
        // Silence rules need a live level meter; without one only the time cap applies.
        const metered = Boolean(analyser && context?.state === "running");
        const reason = recordingStopReason(recording.startedAtClock, recording.silence, now, {
          maxMs: options.current.maxMs,
          ...(options.current.stopOnSilence && metered ? { silenceStopMs: SILENCE_STOP_MS, noSpeechMs: NO_SPEECH_MS } : {}),
        });
        if (reason === "no-speech") cancel("没有听到说话声，已结束录音");
        else if (reason) stop(reason);
      }, TICK_MS);
    } finally {
      starting.current = false;
    }
  }, [cancel, release, stop]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const recording = active.current;
      if (recording) halt(recording, true);
    };
  }, [halt]);

  const finish = useCallback((notice?: string) => dispatch({ type: "transcribed", ...(notice ? { notice } : {}) }), []);
  const fail = useCallback((issue: VoiceIssue) => dispatch({ type: "fail", issue }), []);
  const dismiss = useCallback(() => dispatch({ type: "dismiss" }), []);
  return { state, start, stop, cancel, finish, fail, dismiss };
}
