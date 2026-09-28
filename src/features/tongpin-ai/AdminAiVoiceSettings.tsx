import { KeyRound, Mic, Save, Volume2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AiHarnessConfig, AiHarnessInput, AiHarnessProviderConfig } from "../../../shared/ai";
import { AI_VOICE_LIMITS, SILICONFLOW_BASE_URL, knownSpeechVoices, speechVoiceLabel, type AiVoiceSettings } from "../../../shared/aiVoice";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import { AdminAiModelSelect } from "./AdminAiModelSelect";
import { editableHarness } from "./AdminAiHarnessSettings";
import { adminAiErrorMessage, normalizeAiBaseUrl } from "./adminAiForms";
import { tiersManageRouting } from "./adminAiLayout";
import { hasSpeechConnection, ttsVoiceSuggestions, voiceDraftFromSettings, voiceInputFromDraft, voiceModelWarning, type AiVoiceSettingsDraft } from "./adminAiVoiceForm";

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

const sameUrl = (left: string, right: string) => { try { return normalizeAiBaseUrl(left) === normalizeAiBaseUrl(right); } catch { return false; } };

/** AI 管理 → 语音: microphone transcription, read-aloud (and 语音通话), which
 * voices members may pick, and what each costs in 同频点. Service connections
 * come from 「服务与模型」; SiliconFlow CosyVoice2 can be connected right here. */
export function AdminAiVoiceSettings({ harnessConfig = null, onHarnessChanged, onOpenModels }: {
  harnessConfig?: AiHarnessConfig | null;
  /** A connection added here; the parent refreshes 「服务与模型」 with it. */
  onHarnessChanged?: (config: AiHarnessConfig) => void;
  onOpenModels?: () => void;
}) {
  const { api, session } = useAuth();
  const account = session?.user.id ?? "";
  const id = useId();
  const [view, setView] = useState<VoiceAdminView | null>(null);
  const [draft, setDraft] = useState<AiVoiceSettingsDraft>(() => voiceDraftFromSettings(null));
  const [loadError, setLoadError] = useState(""), [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<"save" | "connect" | null>(null);
  const busyRef = useRef(false);
  const [siliconFlowKey, setSiliconFlowKey] = useState("");
  const providers = harnessConfig?.providers ?? [];
  const providerIds = new Set(providers.map(provider => provider.id));

  useEffect(() => {
    const controller = new AbortController();
    setLoadError("");
    api<VoiceAdminView>("/api/admin/ai/voice", { headers: { "X-Tongpin-Account": account }, signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) { setView(result); setDraft(voiceDraftFromSettings(result.settings)); } })
      .catch(caught => { if (!controller.signal.aborted) setLoadError(voiceErrorMessage(caught, "语音设置读取失败，请确认服务器已更新后重试。")); });
    return () => controller.abort();
  }, [api, account, loadVersion]);

  const change = (patch: Partial<AiVoiceSettingsDraft>) => { setDraft(current => ({ ...current, ...patch })); setError(""); setNotice(""); };
  const run = async (kind: "save" | "connect", action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(kind); setError(""); setNotice("");
    try { await action(); } finally { busyRef.current = false; setBusy(null); }
  };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { input, error: invalid } = voiceInputFromDraft(draft, providerIds);
    if (!input) { setError(invalid); return; }
    await run("save", async () => {
      try {
        const result = await api<VoiceAdminView>("/api/admin/ai/voice", { method: "PUT", headers: { "X-Tongpin-Account": account }, body: JSON.stringify(input) });
        setView(result); setDraft(voiceDraftFromSettings(result.settings));
        setNotice("语音设置已保存。");
      } catch (caught) { setError(voiceErrorMessage(caught, "语音设置保存失败，请稍后重试。")); }
    });
  }

  /** Adds (or re-keys) the SiliconFlow connection, reads its models and fills in CosyVoice2. */
  async function connectSiliconFlow() {
    const key = siliconFlowKey.trim();
    if (!key) { setError("请先粘贴硅基流动的 API 密钥。"); return; }
    if (!tiersManageRouting(harnessConfig)) { setError("请先在「服务与模型」保存四个档位，再接入朗读服务。"); return; }
    await run("connect", async () => {
      try {
        const input: AiHarnessInput = editableHarness(harnessConfig);
        const existing = input.providers.find(provider => sameUrl(provider.baseUrl, SILICONFLOW_BASE_URL));
        const providerId = existing?.id ?? (input.providers.some(provider => provider.id === "siliconflow") ? `siliconflow-${crypto.randomUUID().slice(0, 6)}` : "siliconflow");
        if (!existing && input.providers.length >= 8) { setError("服务连接已达 8 个上限，请先在「服务与模型」移除一个不用的连接。"); return; }
        input.providers = existing
          ? input.providers.map(provider => provider.id === existing.id ? { ...provider, enabled: true, apiKey: key } : provider)
          : [...input.providers, { id: providerId, name: "硅基流动", baseUrl: SILICONFLOW_BASE_URL, protocol: "chat_completions", enabled: true, apiKey: key }];
        const { harness } = await api<{ harness: AiHarnessConfig }>("/api/admin/ai/harness", { method: "PUT", body: JSON.stringify(input) });
        setSiliconFlowKey("");
        const discovered = await api<{ provider: AiHarnessProviderConfig; models: string[] }>(`/api/admin/ai/harness/providers/${encodeURIComponent(providerId)}/discover`, { method: "POST" }, 30_000);
        onHarnessChanged?.({ ...harness, providers: harness.providers.map(provider => provider.id === discovered.provider.id ? discovered.provider : provider) });
        const model = discovered.models.find(item => /cosyvoice2/i.test(item));
        if (!model) { setError("已保存硅基流动连接，但这个密钥的模型列表里没有 CosyVoice2，请到硅基流动确认账号可以使用语音模型。"); return; }
        const voices = knownSpeechVoices(model);
        change({ ttsEngine: "external", ttsProviderId: providerId, ttsModelId: model, ttsVoice: draft.ttsModelId === model && draft.ttsVoice ? draft.ttsVoice : voices[0], ttsMemberVoices: voices });
        setNotice(`已接入硅基流动（读取到 ${discovered.models.length} 个模型）。已选好 CosyVoice2 和 ${voices.length} 个音色，请填写每千字折算的同频点，再点「保存语音设置」。`);
      } catch (caught) { setError(voiceErrorMessage(caught, "接入硅基流动失败，请核对密钥后重试。")); }
    });
  }

  const providerOptions = <>
    <option value="">选择服务连接</option>
    {providers.map(provider => <option key={provider.id} value={provider.id} disabled={!provider.enabled}>{provider.name}{provider.enabled ? "" : "（已停用）"}</option>)}
  </>;
  const modelsFor = (providerId: string) => providers.find(provider => provider.id === providerId)?.availableModels ?? [];
  const providerStt = draft.inputEnabled && draft.sttEngine === "provider";
  const sttWarning = providerStt ? voiceModelWarning(harnessConfig, draft.sttProviderId, draft.sttModelId) : "";
  const ttsWarning = draft.ttsEngine === "external" ? voiceModelWarning(harnessConfig, draft.ttsProviderId, draft.ttsModelId) : "";
  const presetVoices = ttsVoiceSuggestions(draft.ttsModelId);
  const offersQuickSetup = draft.ttsEngine === "external" && !hasSpeechConnection(harnessConfig);
  const memberVoiceSet = new Set(draft.ttsMemberVoices);
  const toggleMemberVoice = (voice: string, on: boolean) => change({ ttsMemberVoices: on ? [...draft.ttsMemberVoices, voice] : draft.ttsMemberVoices.filter(item => item !== voice) });

  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={Boolean(busy) || (!view && !loadError)}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Mic size={20} aria-hidden="true" />语音</h2>
      <p>成员可在输入框旁用麦克风说话（转写成文字）、朗读 AI 回复，也可以和 AI 语音通话；通话用这里的声音。</p>
    </div></header>
    {!view ? <div className="tp-ai-admin-actions"><p role={loadError ? "alert" : "status"} className={loadError ? "tp-ai-admin-error" : undefined}>{loadError || "读取语音设置中…"}</p>
      {loadError ? <button className="tp-ai-admin-button" type="button" onClick={() => setLoadVersion(value => value + 1)}>重新加载</button> : null}</div> : <form onSubmit={save} noValidate>
      <fieldset className="tp-ai-admin-fields" disabled={Boolean(busy)}>
        <div className="is-wide tp-ai-admin-section-heading"><h3><Mic size={16} aria-hidden="true" /> 语音输入（说话转文字）</h3></div>
        <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.inputEnabled} onChange={event => change({ inputEnabled: event.target.checked })} />开启语音输入</label>
        {draft.inputEnabled ? <>
          <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-stt-engine`}>语音转写引擎
            <select id={`${id}-stt-engine`} value={draft.sttEngine} onChange={event => change({ sttEngine: event.target.value === "provider" ? "provider" : "whisper" })}>
              <option value="whisper">Whisper（开源模型，Cloudflare 运行，无需密钥）</option>
              <option value="provider">接口转写（OpenAI 兼容接口）</option>
            </select>
          </label>
          {providerStt ? <>
            <label className="tp-ai-admin-field" htmlFor={`${id}-stt-provider`}>语音转文字服务
              <select id={`${id}-stt-provider`} value={draft.sttProviderId} onChange={event => change({ sttProviderId: event.target.value, sttModelId: "" })}>{providerOptions}</select>
            </label>
            <AdminAiModelSelect label="语音转文字模型" value={draft.sttModelId} models={preferredModels(modelsFor(draft.sttProviderId), STT_MODEL)} allowCustom
              emptyMessage="先选择服务连接，并在「服务与模型」读取模型列表" onChange={model => change({ sttModelId: model })} />
          </> : null}
          <label className="tp-ai-admin-field" htmlFor={`${id}-stt-points`}>每分钟录音折算 · 同频点
            <input id={`${id}-stt-points`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 60" value={draft.sttPointsPerMinute} onChange={event => change({ sttPointsPerMinute: event.target.value })} />
          </label>
          {sttWarning ? <p className="tp-ai-admin-hint is-wide" role="note">{sttWarning}</p> : null}
          <p className="tp-ai-admin-hint is-wide">按秒计费、向上取整；单次最长 {AI_VOICE_LIMITS.maxAudioMs / 1000} 秒、{AI_VOICE_LIMITS.maxAudioBytes / 1024 / 1024} MB。{providerStt
            ? "调用服务商的 /audio/transcriptions 接口（如 whisper-1、硅基流动的 FunAudioLLM/SenseVoiceSmall）。"
            : "使用 OpenAI 开源的 Whisper 模型（whisper-large-v3-turbo），由同频的 Cloudflare 云端服务运行，不需要服务商 API 密钥；默认按普通话识别并输出简体中文，没有清晰说话时不生成文字。"}</p>
        </> : null}

        <div className="is-wide tp-ai-admin-section-heading"><h3><Volume2 size={16} aria-hidden="true" /> 朗读与通话的声音</h3></div>
        <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-tts-engine`}>朗读方式
          <select id={`${id}-tts-engine`} value={draft.ttsEngine} onChange={event => change({ ttsEngine: event.target.value === "external" ? "external" : "browser" })}>
            <option value="browser">成员电脑的系统语音（免费，不消耗同频点）</option>
            <option value="external">外部语音服务（声音更自然，按每千字计费）</option>
          </select>
        </label>
        {draft.ttsEngine === "external" ? <>
          {offersQuickSetup ? <div className="tp-ai-admin-quick-connect is-wide">
            <h4><KeyRound size={16} aria-hidden="true" />接入硅基流动 CosyVoice2（推荐：开源模型，中文自然）</h4>
            <p className="tp-ai-admin-hint">在 cloud.siliconflow.cn 注册并充值，到「API 密钥」页面新建一个密钥，粘贴到下面。密钥只保存在同频服务器上并加密，不会再显示。</p>
            <div className="tp-ai-admin-quick-connect__row">
              <label className="tp-ai-admin-field" htmlFor={`${id}-sf-key`}>硅基流动 API 密钥
                <input id={`${id}-sf-key`} type="password" autoComplete="new-password" maxLength={4096} placeholder="粘贴 sk- 开头的密钥" value={siliconFlowKey}
                  onChange={event => { setSiliconFlowKey(event.target.value); setError(""); setNotice(""); }} />
              </label>
              <button className="tp-ai-admin-button is-primary" type="button" disabled={Boolean(busy) || !siliconFlowKey.trim()} onClick={() => void connectSiliconFlow()}>
                {busy === "connect" ? "接入中…" : "接入并读取模型"}</button>
            </div>
            <p className="tp-ai-admin-hint">也可以在「服务与模型」里手动添加任何 OpenAI 兼容的语音服务。{onOpenModels ? <> <button className="tp-ai-admin-link" type="button" onClick={onOpenModels}>去服务与模型</button></> : null}</p>
          </div> : null}
          <label className="tp-ai-admin-field" htmlFor={`${id}-tts-provider`}>朗读服务
            <select id={`${id}-tts-provider`} value={draft.ttsProviderId} onChange={event => change({ ttsProviderId: event.target.value, ttsModelId: "" })}>{providerOptions}</select>
          </label>
          <AdminAiModelSelect label="朗读模型" value={draft.ttsModelId} models={preferredModels(modelsFor(draft.ttsProviderId), TTS_MODEL)} allowCustom
            emptyMessage="先选择服务连接，并在「服务与模型」读取模型列表" onChange={model => change({ ttsModelId: model, ttsVoice: "", ttsMemberVoices: [] })} />
          {presetVoices.length ? <label className="tp-ai-admin-field" htmlFor={`${id}-tts-voice`}>默认音色（成员没选时用）
            <select id={`${id}-tts-voice`} value={draft.ttsVoice} onChange={event => change({ ttsVoice: event.target.value })}>
              <option value="">选择音色</option>
              {presetVoices.map(voice => <option key={voice} value={voice}>{speechVoiceLabel(voice)}</option>)}
              {draft.ttsVoice && !presetVoices.includes(draft.ttsVoice) ? <option value={draft.ttsVoice}>{draft.ttsVoice}</option> : null}
            </select>
          </label> : <label className="tp-ai-admin-field" htmlFor={`${id}-tts-voice`}>默认音色
            <input id={`${id}-tts-voice`} maxLength={128} placeholder="例如 alloy" value={draft.ttsVoice} onChange={event => change({ ttsVoice: event.target.value })} />
          </label>}
          <label className="tp-ai-admin-field" htmlFor={`${id}-tts-points`}>每千字朗读折算 · 同频点
            <input id={`${id}-tts-points`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 20" value={draft.ttsPointsPer1kChars} onChange={event => change({ ttsPointsPer1kChars: event.target.value })} />
          </label>
          {presetVoices.length ? <fieldset className="tp-ai-admin-voice-choices is-wide">
            <legend>成员可以自己选的音色</legend>
            <div>{presetVoices.map(voice => {
              const isDefault = voice === draft.ttsVoice;
              return <label key={voice} className="tp-ai-admin-toggle">
                <input type="checkbox" checked={isDefault || memberVoiceSet.has(voice)} disabled={isDefault} onChange={event => toggleMemberVoice(voice, event.target.checked)} />
                {speechVoiceLabel(voice)}{isDefault ? "（默认）" : ""}
              </label>;
            })}</div>
            <p className="tp-ai-admin-hint">成员在输入框旁的「语音设置」里选择（也可以选免费的系统声音）；只勾默认音色表示成员不能换音色。</p>
          </fieldset> : null}
          {ttsWarning ? <p className="tp-ai-admin-hint is-wide" role="note">{ttsWarning}</p> : null}
          <p className="tp-ai-admin-hint is-wide">朗读前会去掉代码、公式、链接和引用角标；长回复按句分段请求，每段单独计费（向上取整）。调用服务商的 /audio/speech 接口。</p>
        </> : null}
      </fieldset>
      {!providers.length && (providerStt || draft.ttsEngine === "external") && !offersQuickSetup ? <p className="tp-ai-admin-hint">还没有服务连接：请先在「服务与模型」接入服务并读取模型列表。</p> : null}
      <p className="tp-ai-admin-hint">折算值是成员额度，不是人民币或服务商账单；转写或朗读前先预留，完成后结算，结果不明时按预留保守计入。</p>
      <p className="tp-ai-admin-hint" role="status">当前状态 · 语音输入：{view.readiness.input.message}；朗读：{view.readiness.speech.message}</p>
      {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
      {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
      <div className="tp-ai-admin-actions"><button type="submit" className="tp-ai-admin-button is-primary" disabled={Boolean(busy)}><Save size={17} aria-hidden="true" />{busy === "save" ? "保存中…" : "保存语音设置"}</button></div>
    </form>}
  </section>;
}

