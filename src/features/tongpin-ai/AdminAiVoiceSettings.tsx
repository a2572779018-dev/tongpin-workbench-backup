import { Mic, Save } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AiHarnessConfig } from "../../../shared/ai";
import { AI_VOICE_LIMITS, type AiVoiceSettings } from "../../../shared/aiVoice";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import { AdminAiModelSelect } from "./AdminAiModelSelect";
import { adminAiErrorMessage } from "./adminAiForms";
import { OPENAI_TTS_VOICES, voiceDraftFromSettings, voiceInputFromDraft, voiceModelWarning, type AiVoiceSettingsDraft } from "./adminAiVoiceForm";

interface Readiness { ready: boolean; message: string }
interface VoiceAdminView { settings: AiVoiceSettings; readiness: { input: Readiness; speech: Readiness } }

const STT_MODEL = /whisper|transcri|stt|asr|sensevoice|paraformer|speech|audio/i;
const TTS_MODEL = /tts|speech|voice|audio|cosyvoice/i;

function preferredModels(models: readonly string[], pattern: RegExp): string[] {
  const matching = models.filter(model => pattern.test(model));
  return matching.length ? [...matching, ...models.filter(model => !pattern.test(model))] : [...models];
}

function voiceErrorMessage(error: unknown, fallback: string): string {
  // Our own voice validation messages are safe to show; provider text never reaches here.
  if (error instanceof ApiRequestError && error.code.startsWith("AI_VOICE_")) return error.message;
  return adminAiErrorMessage(error, fallback);
}

/** AI 管理 → 生成与搜索 → 语音: microphone transcription and read-aloud, and
 * what each costs in 同频点. Service connections come from 「服务与模型」. */
export function AdminAiVoiceSettings({ harnessConfig = null }: { harnessConfig?: AiHarnessConfig | null }) {
  const { api, session } = useAuth();
  const account = session?.user.id ?? "";
  const id = useId();
  const [view, setView] = useState<VoiceAdminView | null>(null);
  const [draft, setDraft] = useState<AiVoiceSettingsDraft>(() => voiceDraftFromSettings(null));
  const [loadError, setLoadError] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const providers = harnessConfig?.providers ?? [];
  const providerIds = new Set(providers.map(provider => provider.id));

  useEffect(() => {
    const controller = new AbortController();
    api<VoiceAdminView>("/api/admin/ai/voice", { headers: { "X-Tongpin-Account": account }, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setView(result); setDraft(voiceDraftFromSettings(result.settings)); } })
      .catch(caught => { if (!controller.signal.aborted) setLoadError(voiceErrorMessage(caught, "语音配置读取失败，请确认服务器已更新后刷新。")); });
    return () => controller.abort();
  }, [api, account]);

  const change = (patch: Partial<AiVoiceSettingsDraft>) => { setDraft(current => ({ ...current, ...patch })); setError(""); setNotice(""); };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    const { input, error: invalid } = voiceInputFromDraft(draft, providerIds);
    if (!input) { setError(invalid); return; }
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await api<VoiceAdminView>("/api/admin/ai/voice", { method: "PUT", headers: { "X-Tongpin-Account": account }, body: JSON.stringify(input) });
      setView(result); setDraft(voiceDraftFromSettings(result.settings));
      setNotice("语音配置已保存。");
    } catch (caught) {
      setError(voiceErrorMessage(caught, "语音配置保存失败，请稍后重试。"));
    } finally { busyRef.current = false; setBusy(false); }
  }

  const providerOptions = <>
    <option value="">选择服务连接</option>
    {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.enabled}>{provider.name}{provider.enabled ? "" : "（已停用）"}</option>)}
  </>;
  const modelsFor = (providerId: string) => providers.find(provider => provider.id === providerId)?.availableModels ?? [];
  const sttWarning = draft.inputEnabled ? voiceModelWarning(harnessConfig, draft.sttProviderId, draft.sttModelId) : "";
  const ttsWarning = draft.ttsEngine === "external" ? voiceModelWarning(harnessConfig, draft.ttsProviderId, draft.ttsModelId) : "";

  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Mic size={20} aria-hidden="true" />语音</h2>
      <p>成员可在输入框旁用麦克风说话（转写成文字），并朗读 AI 回复。服务连接和模型列表来自「服务与模型」。</p>
    </div></header>
    {!view ? <p role={loadError ? "alert" : "status"} className={loadError ? "tp-ai-admin-error" : undefined}>{loadError || "读取语音配置中…"}</p> : <form onSubmit={save}>
      <fieldset className="tp-ai-admin-fields" disabled={busy}>
        <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.inputEnabled} onChange={event => change({ inputEnabled: event.target.checked })} />开启语音输入（语音转文字）</label>
        {draft.inputEnabled ? <>
          <label className="tp-ai-admin-field" htmlFor={`${id}-stt-provider`}>语音转文字服务
            <select id={`${id}-stt-provider`} value={draft.sttProviderId} onChange={event => change({ sttProviderId: event.target.value, sttModelId: "" })}>{providerOptions}</select>
          </label>
          <AdminAiModelSelect label="语音转文字模型" value={draft.sttModelId} models={preferredModels(modelsFor(draft.sttProviderId), STT_MODEL)} allowCustom
            emptyMessage="先选择服务连接，并在「服务与模型」读取模型列表" onChange={model => change({ sttModelId: model })} />
          <label className="tp-ai-admin-field" htmlFor={`${id}-stt-points`}>每分钟录音折算 · 同频点
            <input id={`${id}-stt-points`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 60" value={draft.sttPointsPerMinute} onChange={event => change({ sttPointsPerMinute: event.target.value })} />
          </label>
          {sttWarning ? <p className="tp-ai-admin-hint is-wide" role="note">{sttWarning}</p> : null}
          <p className="tp-ai-admin-hint is-wide">按秒计费、向上取整；单次最长 {AI_VOICE_LIMITS.maxAudioMs / 1000} 秒、{AI_VOICE_LIMITS.maxAudioBytes / 1024 / 1024} MB。调用服务商的 /audio/transcriptions 接口（如 whisper-1、gpt-4o-transcribe）。</p>
        </> : null}
        <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-tts-engine`}>朗读方式
          <select id={`${id}-tts-engine`} value={draft.ttsEngine} onChange={event => change({ ttsEngine: event.target.value === "external" ? "external" : "browser" })}>
            <option value="browser">成员电脑的系统语音（免费，不消耗同频点）</option>
            <option value="external">外部语音服务（按每千字计费）</option>
          </select>
        </label>
        {draft.ttsEngine === "external" ? <>
          <label className="tp-ai-admin-field" htmlFor={`${id}-tts-provider`}>朗读服务
            <select id={`${id}-tts-provider`} value={draft.ttsProviderId} onChange={event => change({ ttsProviderId: event.target.value, ttsModelId: "" })}>{providerOptions}</select>
          </label>
          <AdminAiModelSelect label="朗读模型" value={draft.ttsModelId} models={preferredModels(modelsFor(draft.ttsProviderId), TTS_MODEL)} allowCustom
            emptyMessage="先选择服务连接，并在「服务与模型」读取模型列表" onChange={model => change({ ttsModelId: model })} />
          <label className="tp-ai-admin-field" htmlFor={`${id}-tts-voice`}>音色
            <input id={`${id}-tts-voice`} list={`${id}-tts-voices`} maxLength={128} placeholder="例如 alloy" value={draft.ttsVoice} onChange={event => change({ ttsVoice: event.target.value })} />
            <datalist id={`${id}-tts-voices`}>{OPENAI_TTS_VOICES.map(voice => <option key={voice} value={voice} />)}</datalist>
          </label>
          <label className="tp-ai-admin-field" htmlFor={`${id}-tts-points`}>每千字朗读折算 · 同频点
            <input id={`${id}-tts-points`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 20" value={draft.ttsPointsPer1kChars} onChange={event => change({ ttsPointsPer1kChars: event.target.value })} />
          </label>
          {ttsWarning ? <p className="tp-ai-admin-hint is-wide" role="note">{ttsWarning}</p> : null}
          <p className="tp-ai-admin-hint is-wide">朗读前会去掉代码、公式、链接和引用角标；长回复按句分段请求，每段单独计费（向上取整）。调用服务商的 /audio/speech 接口（如 tts-1、gpt-4o-mini-tts）。</p>
        </> : null}
      </fieldset>
      {!providers.length ? <p className="tp-ai-admin-hint">还没有服务连接：请先在「服务与模型」接入服务并读取模型列表。</p> : null}
      <p className="tp-ai-admin-hint">折算值是成员额度，不是人民币或服务商账单；转写或朗读前先预留，完成后结算，结果不明时按预留保守计入。</p>
      <p className="tp-ai-admin-hint" role="status">语音输入：{view.readiness.input.message}；朗读：{view.readiness.speech.message}</p>
      {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
      {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
      <div className="tp-ai-admin-actions"><button type="submit" className="tp-ai-admin-button is-primary" disabled={busy}><Save size={17} aria-hidden="true" />{busy ? "保存中…" : "保存语音配置"}</button></div>
    </form>}
  </section>;
}
