import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AI_VOICE_LIMITS, EMPTY_AI_VOICE_MEMBER_SETTINGS } from "../../../../shared/aiVoice";
import { ApiRequestError } from "../../../lib/api";
import { ChatMessageRow } from "../ChatMessageRow";
import { aiUsageDescription } from "../usageFormatting";
import { ReadAloudButton } from "./ReadAloudButton";
import { VoiceInputControl } from "./VoiceInputControl";
import {
  ensureVoiceSettings, invalidateVoiceSettings, newVoiceRequestId, synthesizeSpeech, transcribeRecording, voiceErrorMessage,
  voiceSettingsSnapshot, type VoiceApi,
} from "./voiceApi";

const MEMBER = { input: { enabled: true, pointsPerMinute: 60, maxSeconds: 60, maxBytes: AI_VOICE_LIMITS.maxAudioBytes }, speech: { engine: "external", pointsPer1kChars: 20, maxCharacters: 1000 } };

describe("voice API client", () => {
  it("uploads a recording as multipart with the account binding and a fresh request id", async () => {
    const api = vi.fn(async (_path: string, _init?: RequestInit) => ({ requestId: "x", text: "你好" })) as unknown as VoiceApi & ReturnType<typeof vi.fn>;
    const audio = new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], { type: "audio/webm;codecs=opus" });
    await transcribeRecording(api, "member-1", { blob: audio, durationMs: 61_234.6, fileName: "voice.webm" });
    const [path, init, timeout] = api.mock.calls[0];
    expect(path).toBe("/api/ai/audio/transcriptions");
    expect(timeout).toBe(120_000);
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Tongpin-Account"]).toBe("member-1");
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data; boundary=/);
    const form = await new Request("https://test.local", { method: "POST", headers: { "content-type": headers["Content-Type"] }, body: init.body as Blob }).formData();
    expect(form.get("requestId")).toMatch(/^voice-[0-9a-f-]{36}$/);
    expect(form.get("durationMs")).toBe("60000");
    // Mandarin hint for the server's transcription engine.
    expect(form.get("language")).toBe("zh");
    const file = form.get("audio") as File;
    expect([file.name, file.type, file.size]).toEqual(["voice.webm", "audio/webm;codecs=opus", 7]);
    expect(newVoiceRequestId()).not.toBe(newVoiceRequestId());
  });

  it("caches the member view, and treats an older server as voice input off", async () => {
    const api = vi.fn(async () => ({ settings: MEMBER })) as unknown as VoiceApi & ReturnType<typeof vi.fn>;
    expect(await ensureVoiceSettings(api, "member-cache")).toMatchObject({ input: { enabled: true }, speech: { engine: "external" } });
    await ensureVoiceSettings(api, "member-cache");
    expect(api).toHaveBeenCalledTimes(1);
    expect(voiceSettingsSnapshot("member-cache").input.pointsPerMinute).toBe(60);
    expect(voiceSettingsSnapshot("someone-else")).toBe(EMPTY_AI_VOICE_MEMBER_SETTINGS);
    invalidateVoiceSettings();
    await ensureVoiceSettings(api, "member-cache");
    expect(api).toHaveBeenCalledTimes(2);
    const old = vi.fn(async () => { throw new ApiRequestError(404, "NOT_FOUND", "请求的接口不存在"); }) as unknown as VoiceApi;
    expect(await ensureVoiceSettings(old, "member-old-server")).toEqual(EMPTY_AI_VOICE_MEMBER_SETTINGS);
    const hostile = vi.fn(async () => ({ settings: { input: { enabled: "yes", maxSeconds: 999, maxBytes: -1 }, speech: { engine: "cloud" } } })) as unknown as VoiceApi;
    expect(await ensureVoiceSettings(hostile, "member-hostile")).toEqual({
      input: { enabled: false, pointsPerMinute: 0, maxSeconds: 60, maxBytes: AI_VOICE_LIMITS.maxAudioBytes },
      speech: { engine: "browser", pointsPer1kChars: 0, maxCharacters: AI_VOICE_LIMITS.maxSpeechCharacters },
    });
  });

  it("returns synthesized audio and refuses a non-audio answer", async () => {
    const audio = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);
    const api = vi.fn(async () => new Response(audio, { headers: { "content-type": "audio/mpeg" } })) as unknown as VoiceApi & ReturnType<typeof vi.fn>;
    const blob = await synthesizeSpeech(api, "member-1", "你好");
    expect(blob.type).toBe("audio/mpeg");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(audio);
    const [, init, , mode] = api.mock.calls[0];
    expect(mode).toBe("stream");
    expect(JSON.parse(init.body as string)).toMatchObject({ text: "你好", requestId: expect.stringMatching(/^voice-/) });
    const html = vi.fn(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as unknown as VoiceApi;
    await expect(synthesizeSpeech(html, "member-1", "你好")).rejects.toMatchObject({ code: "AI_VOICE_SPEECH_INVALID" });
  });

  it("explains transport failures in Chinese and passes server messages through", () => {
    expect(voiceErrorMessage(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "x"), "兜底")).toBe("连接不上服务器，请检查网络后重试。");
    expect(voiceErrorMessage(new ApiRequestError(404, "NOT_FOUND", "x"), "兜底")).toContain("暂不支持语音");
    expect(voiceErrorMessage(new ApiRequestError(402, "AI_QUOTA_INSUFFICIENT", "同频点不足以完成这段语音转写"), "兜底")).toBe("同频点不足以完成这段语音转写");
    expect(voiceErrorMessage(new Error("raw"), "兜底")).toBe("兜底");
  });
});

describe("voice usage records", () => {
  it("describes transcription and read-aloud charges instead of token counts", () => {
    const base = { inputTokens: 0, outputTokens: 0, totalTokens: 3, convertedTokens: 3, estimated: false };
    expect(aiUsageDescription({ ...base, billingKind: "speech_to_text_conversion" })).toBe("语音转文字折算 3 同频点");
    expect(aiUsageDescription({ ...base, billingKind: "text_to_speech_conversion", estimated: true })).toBe("朗读折算 3 同频点 · 待核对");
  });
});

describe("voice controls in static rendering", () => {
  it("renders nothing without a signed-in session or a browser", () => {
    expect(renderToStaticMarkup(createElement(VoiceInputControl, { onTranscript: () => undefined }))).toBe("");
    expect(renderToStaticMarkup(createElement(ReadAloudButton, { messageId: "m1", content: "你好" }))).toBe("");
    const row = renderToStaticMarkup(createElement(ChatMessageRow, {
      message: { id: "m1", role: "assistant", content: "已完成。", time: "12:00", status: "ready" }, assistantName: "同频 AI",
      copied: false, retryable: false, retryDisabled: false, onCopy: () => undefined, onOpenArtifact: () => undefined, onRetry: () => undefined,
    }));
    expect(row).toContain('aria-label="复制回复"');
    expect(row).not.toContain("朗读");
  });
});
