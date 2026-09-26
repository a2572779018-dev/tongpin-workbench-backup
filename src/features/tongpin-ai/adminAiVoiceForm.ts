import type { AiHarnessConfig } from "../../../shared/ai";
import type { AiVoiceSettings, AiVoiceSettingsInput, AiVoiceTtsEngine } from "../../../shared/aiVoice";

/** Administrator form for AI 管理 → 生成与搜索 → 语音. Prices are edited as text. */
export interface AiVoiceSettingsDraft {
  inputEnabled: boolean;
  sttProviderId: string;
  sttModelId: string;
  sttPointsPerMinute: string;
  ttsEngine: AiVoiceTtsEngine;
  ttsProviderId: string;
  ttsModelId: string;
  ttsVoice: string;
  ttsPointsPer1kChars: string;
}

export const OPENAI_TTS_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"] as const;

export function voiceDraftFromSettings(settings: AiVoiceSettings | null): AiVoiceSettingsDraft {
  return {
    inputEnabled: settings?.inputEnabled ?? false,
    sttProviderId: settings?.sttProviderId ?? "",
    sttModelId: settings?.sttModelId ?? "",
    sttPointsPerMinute: settings?.sttPointsPerMinute ? String(settings.sttPointsPerMinute) : "",
    ttsEngine: settings?.ttsEngine ?? "browser",
    ttsProviderId: settings?.ttsProviderId ?? "",
    ttsModelId: settings?.ttsModelId ?? "",
    ttsVoice: settings?.ttsVoice ?? "",
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
    if (!draft.sttProviderId || !providerIds.has(draft.sttProviderId)) return { input: null, error: "请选择用于语音转文字的服务连接。" };
    if (!draft.sttModelId.trim()) return { input: null, error: "请选择语音转文字模型。" };
    if (sttPointsPerMinute < 1) return { input: null, error: "开启语音输入前，请设置每分钟折算的同频点。" };
  }
  if (draft.ttsEngine === "external") {
    if (!draft.ttsProviderId || !providerIds.has(draft.ttsProviderId)) return { input: null, error: "请选择用于朗读的服务连接。" };
    if (!draft.ttsModelId.trim()) return { input: null, error: "请选择朗读模型。" };
    if (!/^[A-Za-z0-9_.:/-]{1,128}$/.test(draft.ttsVoice.trim())) return { input: null, error: "请填写朗读音色（字母、数字和 _ . : / -），例如 alloy。" };
    if (ttsPointsPer1kChars < 1) return { input: null, error: "使用外部朗读前，请设置每千字折算的同频点。" };
  }
  return {
    input: {
      inputEnabled: draft.inputEnabled, sttProviderId: draft.sttProviderId, sttModelId: draft.sttModelId.trim(), sttPointsPerMinute,
      ttsEngine: draft.ttsEngine, ttsProviderId: draft.ttsProviderId, ttsModelId: draft.ttsModelId.trim(), ttsVoice: draft.ttsVoice.trim(), ttsPointsPer1kChars,
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
