import type { MicVAD } from "@ricky0123/vad-web";

/**
 * Speech detection for 语音通话: the Silero VAD model (MIT,
 * https://github.com/snakers4/silero-vad) run in the renderer by
 * @ricky0123/vad-web (ISC, https://github.com/ricky0123/vad) on ONNX Runtime
 * Web. It replaces the loudness threshold of Open WebUI's call mode, so room
 * noise alone does not open or keep a turn open. The model, the audio worklet
 * and the ONNX Runtime WebAssembly files are emitted next to the app under
 * `vad/` (see vite.config.ts). The library's speech thresholds are kept; the
 * end-of-turn silence is shorter than its 1.4 s default so replies start
 * sooner (a pause that turns out to be mid-thought is joined back by the call
 * controller), and a one-word answer such as “好” is not dropped as too short.
 */
const END_OF_TURN_SILENCE_MS = 900;
const MIN_UTTERANCE_MS = 250;
export const VAD_ASSET_DIRECTORY = "vad/";

export interface CallVadHandlers {
  onSpeechStart(): void;
  /** 16 kHz mono samples of one finished utterance. */
  onSpeechEnd(audio: Float32Array): void;
  onMisfire(): void;
  /** Input level of the latest 32 ms frame (RMS, 0–1) and its speech probability. */
  onLevel(level: number, speech: number): void;
}

export const CALL_AUDIO_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true };

function rms(frame: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index];
  return frame.length ? Math.sqrt(sum / frame.length) : 0;
}

/**
 * Creates a paused detector on `stream`. Pausing only disconnects the
 * microphone from the model (the stream stays open, so resuming is instant and
 * the system microphone indicator does not flicker between turns); the caller
 * stops the stream's tracks when the call ends.
 */
export async function createCallVad(stream: MediaStream, handlers: CallVadHandlers): Promise<MicVAD> {
  const { MicVAD } = await import("@ricky0123/vad-web");
  const base = new URL(VAD_ASSET_DIRECTORY, document.baseURI).href;
  return MicVAD.new({
    model: "v5",
    baseAssetPath: base,
    onnxWASMBasePath: base,
    startOnLoad: false,
    redemptionMs: END_OF_TURN_SILENCE_MS,
    minSpeechMs: MIN_UTTERANCE_MS,
    ortConfig: ort => {
      ort.env.logLevel = "error";
      // file:// pages are not cross-origin isolated: one thread, no proxy worker.
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
    },
    getStream: async () => stream,
    pauseStream: async () => undefined,
    resumeStream: async () => stream,
    onSpeechStart: () => handlers.onSpeechStart(),
    onSpeechEnd: audio => handlers.onSpeechEnd(audio),
    onVADMisfire: () => handlers.onMisfire(),
    onFrameProcessed: (probabilities, frame) => handlers.onLevel(rms(frame), probabilities.isSpeech),
  });
}

/** 16-bit PCM WAV of 16 kHz mono samples (the upload Whisper transcribes). */
export async function utteranceWav(audio: Float32Array): Promise<Blob> {
  const { utils } = await import("@ricky0123/vad-web");
  return new Blob([utils.encodeWAV(audio, 1, 16000, 1, 16)], { type: "audio/wav" });
}
