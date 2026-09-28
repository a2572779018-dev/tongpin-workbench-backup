import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiHarnessConfig } from "../../../shared/ai";
import type { AiVoiceSettings } from "../../../shared/aiVoice";
import { ttsVoiceSuggestions, voiceDraftFromSettings, voiceInputFromDraft, voiceModelWarning } from "./adminAiVoiceForm";

const providers = new Set(["primary"]);
const enabledDraft = () => ({
  ...voiceDraftFromSettings(null), inputEnabled: true, sttEngine: "provider" as const, sttProviderId: "primary", sttModelId: " whisper-1 ", sttPointsPerMinute: "60",
});

describe("admin voice form", () => {
  it("starts from safe defaults and round-trips saved settings", () => {
    expect(voiceDraftFromSettings(null)).toMatchObject({ inputEnabled: false, sttEngine: "whisper", ttsEngine: "browser", sttPointsPerMinute: "", ttsPointsPer1kChars: "" });
    const saved = { inputEnabled: true, sttEngine: "provider" as const, sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60, ttsEngine: "external" as const, ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsMemberVoices: ["alloy", "nova"], ttsPointsPer1kChars: 20, updatedAt: null };
    expect(voiceDraftFromSettings(saved)).toMatchObject({ sttEngine: "provider", sttPointsPerMinute: "60", ttsPointsPer1kChars: "20", ttsVoice: "alloy", ttsMemberVoices: ["alloy", "nova"] });
    // A server that predates member voices has no list: members hear the default voice.
    const { ttsMemberVoices: _none, ...beforeVoices } = saved;
    expect(voiceDraftFromSettings(beforeVoices as unknown as AiVoiceSettings).ttsMemberVoices).toEqual([]);
    expect(voiceDraftFromSettings({ ...saved, sttEngine: "whisper" })).toMatchObject({ sttEngine: "whisper", sttProviderId: "primary", sttModelId: "whisper-1" });
    // A server that predates the engine field can only use a provider connection.
    const { sttEngine: _missing, ...olderServer } = saved;
    expect(voiceDraftFromSettings(olderServer as unknown as AiVoiceSettings).sttEngine).toBe("provider");
  });

  it("needs only a price for Whisper and sends a saved connection back unchanged", () => {
    const whisper = { ...voiceDraftFromSettings(null), inputEnabled: true, sttPointsPerMinute: "60" };
    expect(voiceInputFromDraft(whisper, new Set())).toEqual({ error: "", input: expect.objectContaining({ inputEnabled: true, sttEngine: "whisper", sttProviderId: "", sttModelId: "", sttPointsPerMinute: 60 }) });
    expect(voiceInputFromDraft({ ...whisper, sttPointsPerMinute: "" }, new Set()).error).toContain("每分钟");
    expect(voiceInputFromDraft({ ...whisper, sttPointsPerMinute: "abc" }, new Set()).error).toContain("整数");
    // Kept for switching back to 接口转写, even if the connection is gone meanwhile.
    expect(voiceInputFromDraft({ ...enabledDraft(), sttEngine: "whisper", sttProviderId: "gone" }, providers).input)
      .toMatchObject({ sttEngine: "whisper", sttProviderId: "gone", sttModelId: "whisper-1" });
    expect(voiceInputFromDraft({ ...enabledDraft(), sttProviderId: "gone" }, providers).error).toContain("服务连接");
  });

  it("requires a connection, model and price for each enabled engine", () => {
    expect(voiceInputFromDraft(voiceDraftFromSettings(null), providers)).toMatchObject({ error: "", input: { inputEnabled: false, sttEngine: "whisper", ttsEngine: "browser", sttPointsPerMinute: 0 } });
    expect(voiceInputFromDraft(enabledDraft(), providers).input).toMatchObject({ sttEngine: "provider", sttModelId: "whisper-1", sttPointsPerMinute: 60 });
    expect(voiceInputFromDraft({ ...enabledDraft(), sttProviderId: "gone" }, providers).error).toContain("服务连接");
    expect(voiceInputFromDraft({ ...enabledDraft(), sttModelId: " " }, providers).error).toContain("模型");
    expect(voiceInputFromDraft({ ...enabledDraft(), sttPointsPerMinute: "0" }, providers).error).toContain("每分钟");
    expect(voiceInputFromDraft({ ...enabledDraft(), sttPointsPerMinute: "1.5" }, providers).error).toContain("整数");
    expect(voiceInputFromDraft({ ...enabledDraft(), sttPointsPerMinute: "10000001" }, providers).error).toContain("整数");
    const external = { ...enabledDraft(), ttsEngine: "external" as const, ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: "20" };
    expect(voiceInputFromDraft(external, providers).input).toMatchObject({ ttsEngine: "external", ttsVoice: "alloy", ttsPointsPer1kChars: 20 });
    expect(voiceInputFromDraft({ ...external, ttsVoice: "al loy" }, providers).error).toContain("音色");
    expect(voiceInputFromDraft({ ...external, ttsPointsPer1kChars: "" }, providers).error).toContain("每千字");
  });

  it("always offers the default voice to members and sends no list when members cannot choose", () => {
    const cosy = "FunAudioLLM/CosyVoice2-0.5B";
    const external = { ...voiceDraftFromSettings(null), ttsEngine: "external" as const, ttsProviderId: "primary", ttsModelId: cosy, ttsVoice: `${cosy}:anna`, ttsPointsPer1kChars: "20" };
    expect(voiceInputFromDraft({ ...external, ttsMemberVoices: [`${cosy}:claire`, `${cosy}:claire`] }, providers).input?.ttsMemberVoices).toEqual([`${cosy}:anna`, `${cosy}:claire`]);
    expect(voiceInputFromDraft({ ...external, ttsMemberVoices: [] }, providers).input?.ttsMemberVoices).toEqual([]);
    expect(voiceInputFromDraft({ ...external, ttsMemberVoices: ["bad voice"] }, providers).error).toContain("成员可选音色");
    expect(voiceInputFromDraft({ ...external, ttsVoice: "" }, providers).error).toContain("默认音色");
    // The system voice needs no list at all.
    expect(voiceInputFromDraft({ ...external, ttsEngine: "browser", ttsMemberVoices: [`${cosy}:claire`] }, providers).input?.ttsMemberVoices).toEqual([]);
    expect(ttsVoiceSuggestions(cosy)).toHaveLength(8);
    expect(ttsVoiceSuggestions(cosy)[0]).toBe(`${cosy}:anna`);
  });

  it("warns when a chosen model is not usable with the connection's verified list", () => {
    const config = { providers: [
      { id: "primary", name: "Primary", enabled: true, modelsVerified: true, availableModels: ["whisper-1"] },
      { id: "fresh", name: "Fresh", enabled: true, modelsVerified: false, availableModels: [] },
      { id: "off", name: "Off", enabled: false, modelsVerified: true, availableModels: ["tts-1"] },
    ] } as unknown as AiHarnessConfig;
    expect(voiceModelWarning(config, "primary", "whisper-1")).toBe("");
    expect(voiceModelWarning(config, "primary", "gpt-4o-transcribe")).toContain("不在此连接");
    expect(voiceModelWarning(config, "fresh", "whisper-1")).toContain("尚未读取模型列表");
    expect(voiceModelWarning(config, "off", "tts-1")).toContain("已停用");
    expect(voiceModelWarning(config, "missing", "x")).toContain("不存在");
    expect(voiceModelWarning(config, "", "")).toBe("");
  });

  it("has its own 语音 section, where a SiliconFlow key can be pasted once", () => {
    const panel = readFileSync(new URL("./AdminAiQuotaPanel.tsx", import.meta.url), "utf8");
    expect(panel).toContain('{mounted("voice") ? <div className="tp-ai-admin-section-stack" hidden={section !== "voice"}>');
    const card = readFileSync(new URL("./AdminAiVoiceSettings.tsx", import.meta.url), "utf8");
    expect(card).toContain("接入硅基流动 CosyVoice2");
    expect(card).toContain('type="password" autoComplete="new-password"');
    // The key goes through the normal connection save (encrypted on the server) and is cleared at once.
    expect(card).toContain('"/api/admin/ai/harness", { method: "PUT"');
    expect(card).toContain('setSiliconFlowKey("")');
    expect(card).not.toMatch(/localStorage|sessionStorage|console\./);
  });

  it("offers the transcription engine choice, with provider fields only for 接口转写", () => {
    const card = readFileSync(new URL("./AdminAiVoiceSettings.tsx", import.meta.url), "utf8");
    expect(card).toContain("语音转写引擎");
    expect(card).toContain('<option value="whisper">Whisper（开源模型，Cloudflare 运行，无需密钥）</option>');
    expect(card).toContain('<option value="provider">接口转写（OpenAI 兼容接口）</option>');
    const providerFields = card.slice(card.indexOf("{providerStt ? <>"), card.indexOf("</> : null}", card.indexOf("{providerStt ? <>")));
    expect(providerFields).toContain("语音转文字服务");
    expect(providerFields).toContain('label="语音转文字模型"');
    expect(card).toContain('const providerStt = draft.inputEnabled && draft.sttEngine === "provider";');
  });
});
