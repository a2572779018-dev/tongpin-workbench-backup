import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiHarnessConfig } from "../../../shared/ai";
import { voiceDraftFromSettings, voiceInputFromDraft, voiceModelWarning } from "./adminAiVoiceForm";

const providers = new Set(["primary"]);
const enabledDraft = () => ({
  ...voiceDraftFromSettings(null), inputEnabled: true, sttProviderId: "primary", sttModelId: " whisper-1 ", sttPointsPerMinute: "60",
});

describe("admin voice form", () => {
  it("starts from safe defaults and round-trips saved settings", () => {
    expect(voiceDraftFromSettings(null)).toMatchObject({ inputEnabled: false, ttsEngine: "browser", sttPointsPerMinute: "", ttsPointsPer1kChars: "" });
    expect(voiceDraftFromSettings({ inputEnabled: true, sttProviderId: "primary", sttModelId: "whisper-1", sttPointsPerMinute: 60, ttsEngine: "external", ttsProviderId: "primary", ttsModelId: "tts-1", ttsVoice: "alloy", ttsPointsPer1kChars: 20, updatedAt: null }))
      .toMatchObject({ sttPointsPerMinute: "60", ttsPointsPer1kChars: "20", ttsVoice: "alloy" });
  });

  it("requires a connection, model and price for each enabled engine", () => {
    expect(voiceInputFromDraft(voiceDraftFromSettings(null), providers)).toMatchObject({ error: "", input: { inputEnabled: false, ttsEngine: "browser", sttPointsPerMinute: 0 } });
    expect(voiceInputFromDraft(enabledDraft(), providers).input).toMatchObject({ sttModelId: "whisper-1", sttPointsPerMinute: 60 });
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

  it("is placed in the 生成与搜索 section after video", () => {
    const panel = readFileSync(new URL("./AdminAiQuotaPanel.tsx", import.meta.url), "utf8");
    expect(panel).toMatch(/<AdminAiVideoSettings[^\n]*\/>\n\s*<AdminAiVoiceSettings key=\{`voice-\$\{session\?\.user\.id\}`\} harnessConfig=\{harnessConfig\} \/>/);
  });
});
