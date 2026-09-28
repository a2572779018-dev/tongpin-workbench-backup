import type { AiHarnessConfig } from "../../../shared/ai";
import {
  AI_VOICE_ID_PATTERN, AI_VOICE_MAX_MEMBER_VOICES, knownSpeechVoices,
  type AiVoiceSettings, type AiVoiceSettingsInput, type AiVoiceSttEngine, type AiVoiceTtsEngine,
} from "../../../shared/aiVoice";

/** Administrator form for AI 管理 → 语音. Prices are edited as text. */
export interface AiVoiceSettingsDraft {
  inputEnabled: boolean;
  sttEngine: AiVoiceSttEngine;
  sttProviderId: string;
  sttModelId: string;
  sttPointsPerMinute: string;
  ttsEngine: AiVoiceTtsEngine;
  ttsProviderId: string;
  ttsModelId: string;
  /** The default voice. */
  ttsVoice: string;
  /** Voices members may choose; the default voice is always included when saved. */
  ttsMemberVoices: string[];
  ttsPointsPer1kChars: string;
}

/** Preset voice suggestions for the chosen speech model (CosyVoice2 voices are "<model>:<name>"). */
export function ttsVoiceSuggestions(model: string): string[] {
  return knownSpeechVoices(model);
}

export function voiceDraftFromSettings(settings: AiVoiceSettings | null): AiVoiceSettingsDraft {
  return {
    inputEnabled: settings?.inputEnabled ?? false,
    // Whisper is the default; a server whose settings lack the field predates
    // it and can only transcribe through a provider connection.
    sttEngine: settings && settings.sttEngine !== "whisper" ? "provider" : "whisper",
    sttProviderId: settings?.sttProviderId ?? "",
    sttModelId: settings?.sttModelId ?? "",
    sttPointsPerMinute: settings?.sttPointsPerMinute ? String(settings.sttPointsPerMinute) : "",
    ttsEngine: settings?.ttsEngine ?? "browser",
    ttsProviderId: settings?.ttsProviderId ?? "",
    ttsModelId: settings?.ttsModelId ?? "",
    ttsVoice: settings?.ttsVoice ?? "",
    ttsMemberVoices: Array.isArray(settings?.ttsMemberVoices) ? [...settings.ttsMemberVoices] : [],
    ttsPointsPer1kChars: settings?.ttsPointsPer1kChars ? String(settings.ttsPointsPer1kChars) : "",
  };
}

function points(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return 0;
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed <= 10_000_000 ? parsed : null;
}

/** Same rules as the server; the server still validates everything again. */
export function voiceInputFromDraft(draft: AiVoiceSettingsDraft, providerIds: ReadonlySet<string>): { input: AiVoiceSettingsInput | null; error: string } {
  const sttPointsPerMinute = points(draft.sttPointsPerMinute);
  const ttsPointsPer1kChars = points(draft.ttsPointsPer1kChars);
  if (sttPointsPerMinute === null || ttsPointsPer1kChars === null) return { input: null, error: "同频点折算需填写 0 到 10,000,000 之间的整数。" };
  if (draft.inputEnabled) {
    // Whisper needs no service connection; the saved one is sent back unchanged for switching back.
    if (draft.sttEngine === "provider") {
      if (!draft.sttProviderId || !providerIds.has(draft.sttProviderId)) return { input: null, error: "请选择用于语音转文字的服务连接。" };
      if (!draft.sttModelId.trim()) return { input: null, error: "请选择语音转文字模型。" };
    }
    if (sttPointsPerMinute < 1) return { input: null, error: "开启语音输入前，请设置每分钟折算的同频点。" };
  }
  const ttsVoice = draft.ttsVoice.trim();
  const memberVoices = [...new Set(draft.ttsMemberVoices.map(voice => voice.trim()).filter(Boolean))];
  if (draft.ttsEngine === "external") {
    if (!draft.ttsProviderId || !providerIds.has(draft.ttsProviderId)) return { input: null, error: "请选择用于朗读的服务连接。" };
    if (!draft.ttsModelId.trim()) return { input: null, error: "请选择朗读模型。" };
    if (!AI_VOICE_ID_PATTERN.test(ttsVoice)) return { input: null, error: "请选择或填写默认音色（字母、数字和 _ . : / -），例如 alloy。" };
    if (memberVoices.some(voice => !AI_VOICE_ID_PATTERN.test(voice))) return { input: null, error: "成员可选音色只能包含字母、数字和 _ . : / -。" };
    if (new Set([ttsVoice, ...memberVoices]).size > AI_VOICE_MAX_MEMBER_VOICES) return { input: null, error: `成员可选音色最多 ${AI_VOICE_MAX_MEMBER_VOICES} 个。` };
    if (ttsPointsPer1kChars < 1) return { input: null, error: "使用外部朗读前，请设置每千字折算的同频点。" };
  }
  return {
    input: {
      inputEnabled: draft.inputEnabled, sttEngine: draft.sttEngine, sttProviderId: draft.sttProviderId, sttModelId: draft.sttModelId.trim(), sttPointsPerMinute,
      ttsEngine: draft.ttsEngine, ttsProviderId: draft.ttsProviderId, ttsModelId: draft.ttsModelId.trim(), ttsVoice,
      // The default voice is always one of the member's choices.
      ttsMemberVoices: draft.ttsEngine === "external" && memberVoices.length ? [...new Set([ttsVoice, ...memberVoices])] : [],
      ttsPointsPer1kChars,
    },
    error: "",
  };
}

/** Plain-language warning when the chosen model is not in the connection's verified list. */
export function voiceModelWarning(config: AiHarnessConfig | null | undefined, providerId: string, modelId: string): string {
  if (!providerId || !modelId.trim()) return "";
  const provider = config?.providers.find(item => item.id === providerId);
  if (!provider) return "所选服务连接不存在，请重新选择。";
  if (!provider.enabled) return "该服务连接已停用，成员暂时无法使用。";
  if (!provider.modelsVerified) return "该服务连接尚未读取模型列表：请先在「服务与模型」读取，成员才能使用。";
  if (!provider.availableModels.includes(modelId.trim())) return "该模型不在此连接已读取的模型列表中，成员暂时无法使用；请确认模型名称或重新读取模型列表。";
  return "";
}

/** A connection that already offers a speech model (so the quick setup is not needed). */
export function hasSpeechConnection(config: AiHarnessConfig | null | undefined): boolean {
  return Boolean(config?.providers.some(provider => provider.enabled && provider.modelsVerified
    && provider.availableModels.some(model => /cosyvoice|tts|speech/i.test(model))));
}
