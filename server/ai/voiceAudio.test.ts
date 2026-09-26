import { describe, expect, it } from "vitest";
import { AI_VOICE_LIMITS, voiceSpeechPoints, voiceTranscriptionPoints } from "../../shared/aiVoice";
import { AiError } from "./security";
import {
  audioDurationMs, declaredAudioContainer, encodeMultipartForm, parseTranscriptionUpload,
  sniffAudioContainer, validatedLanguageCode, webmDurationMs,
} from "./voiceAudio";
import {
  bytesFromBase64, chromeLikeWebm, FFMPEG_LIVE_WEBM_1200MS, FFMPEG_M4A_AAC_1200MS, FFMPEG_OGG_OPUS_1200MS, MP3_BYTES, pcmWav,
} from "../testSupport/voiceFixtures";

async function upload(parts: Array<[string, string | Blob, string?]>, headers: Record<string, string> = {}): Promise<Request> {
  const form = new FormData();
  for (const [name, value, filename] of parts) {
    if (typeof value === "string") form.append(name, value);
    else form.append(name, value, filename);
  }
  const encoded = new Response(form);
  const contentType = encoded.headers.get("content-type")!;
  return new Request("https://tongpin.test/api/ai/audio/transcriptions", {
    method: "POST", body: await encoded.arrayBuffer(), headers: { "content-type": contentType, ...headers },
  });
}

describe("voice audio containers", () => {
  it("recognizes the accepted containers by their bytes and refuses MP3", () => {
    expect(sniffAudioContainer(bytesFromBase64(FFMPEG_LIVE_WEBM_1200MS))).toBe("webm");
    expect(sniffAudioContainer(bytesFromBase64(FFMPEG_OGG_OPUS_1200MS))).toBe("ogg");
    expect(sniffAudioContainer(bytesFromBase64(FFMPEG_M4A_AAC_1200MS))).toBe("mp4");
    expect(sniffAudioContainer(pcmWav({ durationMs: 100 }))).toBe("wav");
    expect(sniffAudioContainer(MP3_BYTES)).toBeNull();
    expect(sniffAudioContainer(new Uint8Array())).toBeNull();
  });

  it("maps declared recorder MIME types and never lets a declared type change the container", () => {
    expect(declaredAudioContainer("audio/webm;codecs=opus")).toBe("webm");
    expect(declaredAudioContainer("AUDIO/OGG; codecs=opus")).toBe("ogg");
    expect(declaredAudioContainer("audio/mp4")).toBe("mp4");
    expect(declaredAudioContainer("")).toBe("generic");
    expect(declaredAudioContainer("application/octet-stream")).toBe("generic");
    expect(declaredAudioContainer("audio/mpeg")).toBeNull();
    expect(declaredAudioContainer("text/html")).toBeNull();
  });

  it("reads real encoder output durations (live WebM without Duration, Ogg Opus, M4A)", () => {
    const webm = audioDurationMs(bytesFromBase64(FFMPEG_LIVE_WEBM_1200MS), "webm")!;
    expect(webm).toBeGreaterThanOrEqual(1180);
    expect(webm).toBeLessThanOrEqual(1260);
    expect(audioDurationMs(bytesFromBase64(FFMPEG_OGG_OPUS_1200MS), "ogg")).toBeCloseTo(1200, -1);
    expect(audioDurationMs(bytesFromBase64(FFMPEG_M4A_AAC_1200MS), "mp4")).toBe(1200);
    expect(audioDurationMs(pcmWav({ durationMs: 2500 }), "wav")).toBe(2500);
  });

  it("measures Chromium-style unknown-size clusters, including a truncated final block", () => {
    expect(webmDurationMs(chromeLikeWebm({ durationMs: 2400 }))).toBe(2400);
    expect(webmDurationMs(chromeLikeWebm({ durationMs: 45_000, clusterMs: 5000 }))).toBe(45_000);
    // The recorder may stop mid-block: the complete blocks still count.
    expect(webmDurationMs(chromeLikeWebm({ durationMs: 3000, truncateLastBlock: true }))).toBe(2980);
    const tooLong = webmDurationMs(chromeLikeWebm({ durationMs: 75_000, clusterMs: 30_000 }))!;
    expect(tooLong).toBeGreaterThan(AI_VOICE_LIMITS.maxAudioMs + AI_VOICE_LIMITS.audioToleranceMs);
  });

  it("returns null instead of guessing for malformed data", () => {
    const garbage = new Uint8Array(64).fill(7);
    garbage.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    expect(audioDurationMs(garbage, "webm")).toBeNull();
    expect(audioDurationMs(new Uint8Array([0x4f, 0x67, 0x67, 0x53]), "ogg")).toBeNull();
    expect(audioDurationMs(new Uint8Array([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), "mp4")).toBeNull();
  });
});

describe("voice billing units", () => {
  it("bills transcription per started second, capped at the recording limit", () => {
    expect(voiceTranscriptionPoints(2_400, 60)).toBe(3);
    expect(voiceTranscriptionPoints(500, 60)).toBe(1);
    expect(voiceTranscriptionPoints(59_001, 60)).toBe(60);
    expect(voiceTranscriptionPoints(600_000, 60)).toBe(60);
    expect(voiceTranscriptionPoints(10_000, 1)).toBe(1);
    expect(voiceTranscriptionPoints(10_000, 0)).toBe(0);
  });
  it("bills speech per 1,000 characters, rounded up per request", () => {
    expect(voiceSpeechPoints(1, 20)).toBe(1);
    expect(voiceSpeechPoints(500, 20)).toBe(10);
    expect(voiceSpeechPoints(1000, 20)).toBe(20);
    expect(voiceSpeechPoints(1001, 20)).toBe(21);
    expect(voiceSpeechPoints(0, 20)).toBe(0);
  });
});

describe("voice multipart", () => {
  it("encodes a provider form that a standard multipart parser reads back", async () => {
    const audio = chromeLikeWebm({ durationMs: 1000 });
    const encoded = encodeMultipartForm([["model", "whisper-1"], ["response_format", "json"]], { name: "file", filename: "audio.webm", contentType: "audio/webm", bytes: audio });
    expect(encoded.contentType).toMatch(/^multipart\/form-data; boundary=tongpin-voice-/);
    const form = await new Request("https://provider.test", { method: "POST", headers: { "content-type": encoded.contentType }, body: encoded.body }).formData();
    expect(form.get("model")).toBe("whisper-1");
    expect(form.get("response_format")).toBe("json");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.webm");
    expect(file.type).toBe("audio/webm");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
    expect(() => encodeMultipartForm([["model", "a\r\nb"]], { name: "file", filename: "a.webm", contentType: "audio/webm", bytes: audio })).toThrow(AiError);
  });

  it("parses the member upload after a bounded read", async () => {
    const audio = chromeLikeWebm({ durationMs: 1500 });
    const parsed = await parseTranscriptionUpload(await upload([
      ["requestId", "voice-request-0000000001"], ["durationMs", "1500"], ["language", "zh-CN"],
      ["audio", new Blob([audio], { type: "audio/webm;codecs=opus" }), "voice.webm"],
    ]));
    expect(parsed).toMatchObject({ requestId: "voice-request-0000000001", durationMs: "1500", language: "zh-CN", declaredType: "audio/webm;codecs=opus" });
    expect(parsed.audio).toEqual(audio);
  });

  it("rejects non-multipart bodies, missing audio and oversized uploads", async () => {
    const reject = async (pending: Request | Promise<Request>) => { const request = await pending; try { await parseTranscriptionUpload(request); } catch (error) { return error as AiError; } throw new Error("accepted"); };
    expect((await reject(new Request("https://tongpin.test", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).status).toBe(415);
    expect((await reject(upload([["requestId", "voice-request-0000000002"]]))).code).toBe("AI_VOICE_UPLOAD_INVALID");
    expect((await reject(upload([["audio", new Blob([]), "empty.webm"]]))).code).toBe("AI_VOICE_AUDIO_EMPTY");
    const declaredTooLarge = await reject(upload([["audio", new Blob([new Uint8Array(8)]), "a.webm"]], { "content-length": String(AI_VOICE_LIMITS.uploadBytes + 1) }));
    expect([declaredTooLarge.status, declaredTooLarge.code]).toEqual([413, "AI_VOICE_AUDIO_TOO_LARGE"]);
    const streamedTooLarge = await reject(upload([["audio", new Blob([new Uint8Array(AI_VOICE_LIMITS.uploadBytes + 10)]), "a.webm"]]));
    expect(streamedTooLarge.status).toBe(413);
  });

  it("accepts only ISO-639-1 language hints", () => {
    expect(validatedLanguageCode("zh-CN")).toBe("zh");
    expect(validatedLanguageCode("EN")).toBe("en");
    expect(validatedLanguageCode("zh_Hans")).toBeUndefined();
    expect(validatedLanguageCode("../../x")).toBeUndefined();
    expect(validatedLanguageCode(undefined)).toBeUndefined();
  });
});
