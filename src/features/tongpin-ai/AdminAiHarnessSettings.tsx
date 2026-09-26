import { Activity, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  AI_BUSINESS_TIERS, AI_BUSINESS_TIER_LABELS,
  type AiHarnessCapability, type AiHarnessConfig, type AiHarnessInput, type AiHarnessProviderConfig,
  type AiHarnessProviderInput, type AiHarnessTierRoute, type AiMode,
} from "../../../shared/ai";
import { AI_IMAGE_GENERATION_PROFILE_SPECS, type AiImageGenerationProfile } from "../../../shared/aiImageCapabilities";
import { useAuth } from "../../auth/AuthContext";
import { adminAiErrorMessage, normalizeAiBaseUrl } from "./adminAiForms";
import { planModelDiscovery } from "./adminAiModels";
import { AdminAiModelSelect } from "./AdminAiModelSelect";
import { AdminAiMultiAgentSettings, multiAgentSettingsError } from "./AdminAiMultiAgentSettings";
import { ModelDiscoveryRevision } from "./modelDiscoveryRevision";

const CAPABILITIES: Array<[AiHarnessCapability, string]> = [
  ["vision", "图片理解"], ["web_search", "自动联网"], ["code_interpreter", "代码执行"], ["image", "生成图片"], ["video", "生成视频"],
  ["presentation", "生成 PPT"], ["computer", "控制电脑"],
];
const emptyRoute = (): AiHarnessTierRoute => ({ providerId: "primary", modelId: "", protocol: "chat_completions", maxOutputTokens: 2048, reasoningEffort: "", capabilities: ["chat"], enabled: true });
const emptyInput = (): AiHarnessInput => ({
  providers: [{ id: "primary", name: "主要 AI 服务", baseUrl: "", protocol: "chat_completions", enabled: true }],
  tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, emptyRoute()])) as Record<AiMode, AiHarnessTierRoute>,
  policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
});
function editable(config: AiHarnessConfig | null): AiHarnessInput {
  if (!config) return emptyInput();
  return {
    providers: config.providers.map(({ apiKeyConfigured: _key, modelsVerified: _verified, availableModels: _models, modelsVerifiedAt: _at, ...provider }) => provider),
    tiers: structuredClone(config.tiers), policy: { ...config.policy, requireApproval: true },
  };
}

export function AdminAiHarnessSettings({ onConfigured }: { onConfigured?: (config: AiHarnessConfig | null) => void }) {
  const { api } = useAuth(); const id = useId();
  const [saved, setSaved] = useState<AiHarnessConfig | null>(null);
  const [draft, setDraft] = useState<AiHarnessInput>(emptyInput);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({});
  const [providerErrors, setProviderErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true), [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null), busyRef = useRef(false);
  const connectionRevisions = useRef(new ModelDiscoveryRevision());
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0), [activeTier, setActiveTier] = useState<AiMode>("quick");

  useEffect(() => {
    connectionRevisions.current.invalidateAll();
    const controller = new AbortController(); setLoading(true); setLoadFailed(false); setError("");
    api<{ harness: AiHarnessConfig | null }>("/api/admin/ai/harness", { signal: controller.signal }).then(({ harness }) => {
      if (controller.signal.aborted) return;
      setSaved(harness); setDraft(editable(harness)); setKeys({}); setProviderErrors({});
      onConfigured?.(harness);
      setDiscovered(Object.fromEntries((harness?.providers ?? []).map(provider => [provider.id, provider.availableModels])));
    }).catch((caught: unknown) => {
      if (!controller.signal.aborted) { setLoadFailed(true); setError(adminAiErrorMessage(caught, "服务与模型读取失败，请重试。")); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, version, onConfigured]);

  function updateProvider(providerId: string, patch: Partial<AiHarnessProviderInput>) {
    setDraft(current => ({ ...current,
      providers: current.providers.map(provider => provider.id === providerId ? { ...provider, ...patch } : provider),
      tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, { ...current.tiers[tier],
        ...(patch.protocol !== undefined && current.tiers[tier].providerId === providerId ? { protocol: patch.protocol } : {}),
        ...(patch.baseUrl !== undefined && current.tiers[tier].imageProviderId === providerId ? { imageEditCapability: undefined, imageGenerationCapability: undefined } : {}),
      }])) as Record<AiMode, AiHarnessTierRoute>,
    }));
    if (patch.baseUrl !== undefined) {
      connectionRevisions.current.invalidate(providerId);
      setDiscovered(current => ({ ...current, [providerId]: [] }));
    }
    setProviderErrors(current => ({ ...current, [providerId]: "" })); setNotice(""); setError("");
  }
  function updateTier(tier: AiMode, patch: Partial<AiHarnessTierRoute>) {
    setDraft(current => ({ ...current, tiers: { ...current.tiers, [tier]: { ...current.tiers[tier], ...patch,
      ...(Object.hasOwn(patch, "imageProviderId") || Object.hasOwn(patch, "imageModelId") ? { imageEditCapability: undefined, imageGenerationCapability: undefined } : {}),
    } } }));
    setNotice(""); setError("");
  }
  async function discover(provider: AiHarnessProviderInput) {
    if (busyRef.current || loading) return;
    const plan = planModelDiscovery(provider, keys[provider.id] ?? "", saved);
    if (plan.error) { setProviderErrors(current => ({ ...current, [provider.id]: plan.error })); return; }
    busyRef.current = true; setBusy(`discover:${provider.id}`); setError(""); setNotice("");
    const revision = connectionRevisions.current.begin(provider.id);
    setProviderErrors(current => ({ ...current, [provider.id]: "" }));
    try {
      const result = await api<{ models: string[] }>(plan.path!, { method: "POST", ...(plan.body ? { body: JSON.stringify(plan.body) } : {}) }, 30_000);
      if (!connectionRevisions.current.isCurrent(provider.id, revision)) return;
      setDiscovered(current => ({ ...current, [provider.id]: result.models }));
      setNotice(`${provider.name}：已读取 ${result.models.length} 个模型。`);
      if (!result.models.length) setProviderErrors(current => ({ ...current, [provider.id]: "此密钥没有返回可选模型，请核对服务商模型权限。" }));
    } catch (caught) { if (connectionRevisions.current.isCurrent(provider.id, revision)) setProviderErrors(current => ({ ...current, [provider.id]: adminAiErrorMessage(caught, "模型列表读取失败，请核对这个服务的地址和密钥。") })); }
    finally { busyRef.current = false; setBusy(null); }
  }
  function discoverIfNeeded(providerId: string) {
    const provider = draft.providers.find(item => item.id === providerId);
    if (provider && !discovered[providerId]?.length && !providerErrors[providerId]) void discover(provider);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busyRef.current || loading || loadFailed) return;
    for (const provider of draft.providers) {
      const plan = planModelDiscovery(provider, keys[provider.id] ?? "", saved);
      if (plan.error) { setError(`${provider.name}：${plan.error}`); return; }
    }
    for (const tier of AI_BUSINESS_TIERS) {
      const route = draft.tiers[tier];
      if (!route.modelId) { setActiveTier(tier); setError(`请为${AI_BUSINESS_TIER_LABELS[tier]}选择文字模型。`); return; }
      for (const capability of ["image", "video"] as const) {
        if ((route.capabilities.includes(capability) || route[`${capability}ProviderId`] || route[`${capability}ModelId`]) && (!route[`${capability}ProviderId`] || !route[`${capability}ModelId`])) {
          setActiveTier(tier); setError(`请为${AI_BUSINESS_TIER_LABELS[tier]}选择${capability === "image" ? "图片" : "视频"}服务和模型。`); return;
        }
      }
      const multiAgentError = multiAgentSettingsError(route);
      if (multiAgentError) { setActiveTier(tier); setError(`${AI_BUSINESS_TIER_LABELS[tier]}档：${multiAgentError}`); return; }
    }
    busyRef.current = true; setBusy("save"); setError(""); setNotice("");
    try {
      const payload: AiHarnessInput = { ...draft,
        providers: draft.providers.map(provider => ({ ...provider, baseUrl: normalizeAiBaseUrl(provider.baseUrl), ...(keys[provider.id]?.trim() ? { apiKey: keys[provider.id].trim() } : {}) })),
        policy: { ...draft.policy, requireApproval: true },
      };
      const { harness } = await api<{ harness: AiHarnessConfig }>("/api/admin/ai/harness", { method: "PUT", body: JSON.stringify(payload) });
      // Persisted credentials stay cleared even when a subsequent provider check fails.
      setSaved(harness); setDraft(editable(harness)); setKeys({});
      onConfigured?.(harness);
      const results = await Promise.all(harness.providers.filter(provider => provider.enabled).map(async provider => {
        try {
          const result = await api<{ provider: AiHarnessProviderConfig; models: string[] }>(`/api/admin/ai/harness/providers/${encodeURIComponent(provider.id)}/discover`, { method: "POST" }, 30_000);
          return { id: provider.id, ...result, error: "" };
        } catch (caught) { return { id: provider.id, models: [] as string[], provider, error: adminAiErrorMessage(caught, "无法读取当前密钥的模型列表。") }; }
      }));
      const verified = Object.fromEntries(results.map(result => [result.id, result.models]));
      setDiscovered(verified); setProviderErrors(Object.fromEntries(results.map(result => [result.id, result.error])));
      setSaved({ ...harness, providers: harness.providers.map(provider => results.find(result => result.id === provider.id)?.provider ?? provider) });
      const missing = AI_BUSINESS_TIERS.filter(tier => {
        const route = harness.tiers[tier]; if (!route.enabled) return false;
        return !verified[route.providerId]?.includes(route.modelId)
          || (route.capabilities.includes("image") && !verified[route.imageProviderId ?? ""]?.includes(route.imageModelId ?? ""))
          || (route.capabilities.includes("video") && !verified[route.videoProviderId ?? ""]?.includes(route.videoModelId ?? ""))
          || Boolean(route.multiAgent?.subAgentModelId && !verified[route.providerId]?.includes(route.multiAgent.subAgentModelId));
      });
      if (missing.length) setError(`配置已保存，${missing.map(tier => AI_BUSINESS_TIER_LABELS[tier]).join("、")}的模型尚未全部验证，请检查服务连接和模型权限。`);
      else setNotice("服务连接和四个档位已保存，模型列表校验通过。");
    } catch (caught) { setError(adminAiErrorMessage(caught, "配置保存失败，请检查服务连接和档位设置。")); }
    finally { busyRef.current = false; setBusy(null); }
  }
  const route = draft.tiers[activeTier];
  const modelField = (capability: "text" | "image" | "video") => {
    const providerId = capability === "text" ? route.providerId : route[`${capability}ProviderId`] ?? "";
    const value = capability === "text" ? route.modelId : route[`${capability}ModelId`] ?? "";
    return <AdminAiModelSelect key={`${activeTier}-${capability}-${providerId}`} label={`${capability === "text" ? "文字" : capability === "image" ? "图片" : "视频"}模型`}
      value={value} models={discovered[providerId] ?? []} disabled={!providerId || loading || busy === "save"}
      loading={busy === `discover:${providerId}`} emptyMessage={providerErrors[providerId] || "点击上方服务的「读取模型」重试"}
      onOpen={() => discoverIfNeeded(providerId)} onChange={modelId => updateTier(activeTier, capability === "text" ? { modelId } : { [`${capability}ModelId`]: modelId })} />;
  };
  const providerOptions = draft.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}{provider.enabled ? "" : "（停用）"}</option>);
  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={loading || Boolean(busy)}>
    <header className="tp-ai-admin-heading"><div><h2 id={`${id}-title`}><Activity size={21} aria-hidden="true" />服务与模型</h2>
      <p>先接入 API 服务，再为快速、标准、深度、Pro 分配模型。</p></div>
      <button className="tp-ai-admin-button" type="button" disabled={loading || Boolean(busy)} onClick={() => setVersion(value => value + 1)}><RefreshCw size={16} />刷新</button></header>
    {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
    {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
    {loadFailed ? null : <form onSubmit={submit} autoComplete="off">
      <fieldset className="tp-ai-admin-fields" disabled={loading || busy === "save"}>
        <div className="is-wide tp-ai-admin-section-heading"><h3>1. 服务连接</h3></div>
        {draft.providers.map(provider => <div className="tp-ai-provider-capabilities is-wide" key={provider.id}>
          <div className="tp-ai-admin-fields">
            <label className="tp-ai-admin-field">服务名称<input value={provider.name} maxLength={80} required onChange={event => updateProvider(provider.id, { name: event.target.value })} /></label>
            <label className="tp-ai-admin-field">API Base URL<input type="url" value={provider.baseUrl} required placeholder="https://api.example.com/v1" onChange={event => updateProvider(provider.id, { baseUrl: event.target.value })} /></label>
            <label className="tp-ai-admin-field">API Key<input type="password" autoComplete="new-password" value={keys[provider.id] ?? ""} placeholder={saved?.providers.some(item => item.id === provider.id && item.apiKeyConfigured) ? "已保存；留空保留" : "粘贴 API Key"} onChange={event => {
              connectionRevisions.current.invalidate(provider.id);
              setKeys(current => ({ ...current, [provider.id]: event.target.value })); setDiscovered(current => ({ ...current, [provider.id]: [] }));
              setProviderErrors(current => ({ ...current, [provider.id]: "" })); setNotice("");
            }} /></label>
            <label className="tp-ai-admin-field">文字接口协议<select value={provider.protocol} onChange={event => updateProvider(provider.id, { protocol: event.target.value as AiHarnessProviderInput["protocol"] })}><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></label>
          </div>
          <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button" type="button" disabled={Boolean(busy)} onClick={() => void discover(provider)}><RefreshCw size={16} />{busy === `discover:${provider.id}` ? "读取中…" : "读取模型"}</button>
            <small className="tp-ai-admin-hint">{discovered[provider.id]?.length ?? 0} 个可选模型</small>
            <label className="tp-ai-admin-toggle"><input type="checkbox" checked={provider.enabled} onChange={event => updateProvider(provider.id, { enabled: event.target.checked })} />启用</label>
            {draft.providers.length > 1 ? <button className="tp-ai-admin-button" type="button" disabled={AI_BUSINESS_TIERS.some(tier => [draft.tiers[tier].providerId, draft.tiers[tier].imageProviderId, draft.tiers[tier].videoProviderId].includes(provider.id))}
              title="使用中的服务请先在下方档位中更换" onClick={() => setDraft(current => ({ ...current, providers: current.providers.filter(item => item.id !== provider.id) }))}><Trash2 size={16} />移除</button> : null}
          </div>{providerErrors[provider.id] ? <p className="tp-ai-admin-error" role="alert">{providerErrors[provider.id]}</p> : null}
        </div>)}
        <div className="is-wide"><button className="tp-ai-admin-button" type="button" disabled={draft.providers.length >= 8} onClick={() => {
          const providerId = `provider-${crypto.randomUUID().slice(0, 8)}`;
          setDraft(current => ({ ...current, providers: [...current.providers, { id: providerId, name: `AI 服务 ${current.providers.length + 1}`, baseUrl: "", protocol: "chat_completions", enabled: true }] }));
        }}><Plus size={16} />添加服务连接</button></div>
        <div className="is-wide tp-ai-admin-section-heading"><h3>2. 四个档位</h3></div>
        <div className="tp-ai-admin-tier-tabs is-wide" role="tablist" aria-label="配置业务档位">{AI_BUSINESS_TIERS.map(tier => <button key={tier} type="button" role="tab" aria-selected={activeTier === tier} aria-controls={`${id}-tier-panel`} onClick={() => setActiveTier(tier)}>{AI_BUSINESS_TIER_LABELS[tier]}{draft.tiers[tier].enabled ? "" : " · 停用"}</button>)}</div>
        <div className="tp-ai-provider-capabilities is-wide" id={`${id}-tier-panel`} role="tabpanel" aria-label={`${AI_BUSINESS_TIER_LABELS[activeTier]}配置`}>
          <div className="tp-ai-admin-fields">
            <label className="tp-ai-admin-field">文字服务<select value={route.providerId} onChange={event => updateTier(activeTier, { providerId: event.target.value, protocol: draft.providers.find(provider => provider.id === event.target.value)?.protocol ?? "chat_completions", modelId: "" })}>{providerOptions}</select></label>
            {modelField("text")}
            <label className="tp-ai-admin-field">图片服务<select value={route.imageProviderId ?? ""} onChange={event => updateTier(activeTier, { imageProviderId: event.target.value || undefined, imageModelId: undefined })}><option value="">未配置</option>{providerOptions}</select></label>
            {modelField("image")}
            <label className="tp-ai-admin-field">视频服务<select value={route.videoProviderId ?? ""} onChange={event => updateTier(activeTier, { videoProviderId: event.target.value || undefined, videoModelId: undefined })}><option value="">未配置</option>{providerOptions}</select></label>
            {modelField("video")}
            <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={route.enabled} onChange={event => updateTier(activeTier, { enabled: event.target.checked })} />启用{AI_BUSINESS_TIER_LABELS[activeTier]}档</label>
            <div className="is-wide tp-ai-admin-actions"><span className="tp-ai-admin-hint">开放能力</span>{CAPABILITIES.map(([capability, label]) => <label className="tp-ai-admin-toggle" key={capability}><input type="checkbox" checked={route.capabilities.includes(capability)} onChange={event => updateTier(activeTier, { capabilities: event.target.checked ? [...route.capabilities, capability] : route.capabilities.filter(item => item !== capability) })} />{label}</label>)}</div>
            <details className="is-wide tp-ai-provider-capabilities"><summary>高级参数</summary><div className="tp-ai-admin-fields">
              <label className="tp-ai-admin-field">图片生成协议<select disabled={!route.imageModelId || !route.imageProviderId} value={route.imageGenerationCapability?.profile ?? ""} onChange={event => {
                const provider = draft.providers.find(item => item.id === route.imageProviderId);
                const profile = event.target.value as AiImageGenerationProfile | "";
                if (!profile) { updateTier(activeTier, { imageGenerationCapability: undefined }); return; }
                if (!provider || !route.imageModelId || !Object.hasOwn(AI_IMAGE_GENERATION_PROFILE_SPECS, profile)) return;
                try {
                  updateTier(activeTier, { imageGenerationCapability: { baseUrl: normalizeAiBaseUrl(provider.baseUrl), modelId: route.imageModelId, profile, size: "1024x1024" } });
                } catch { setError("请先填写有效的图片服务 HTTPS 地址，再选择生成协议。"); }
              }}><option value="">旧版兼容 · 参数能力未验证</option>{Object.entries(AI_IMAGE_GENERATION_PROFILE_SPECS).map(([profile, spec]) => <option value={profile} key={profile}>{spec.label}</option>)}</select></label>
              {route.imageGenerationCapability ? <label className="tp-ai-admin-field">生成图片尺寸<select value={route.imageGenerationCapability.size} onChange={event => updateTier(activeTier, { imageGenerationCapability: { ...route.imageGenerationCapability!, size: event.target.value } })}>
                {AI_IMAGE_GENERATION_PROFILE_SPECS[route.imageGenerationCapability.profile].sizes.map(size => <option value={size} key={size}>{size}</option>)}
              </select></label> : null}
              <small className="tp-ai-admin-hint is-wide">模型列表只验证当前密钥能看到模型，不验证图片参数。请按服务商实际协议选择；更换地址或模型后需重新确认。旧配置可继续按原参数运行。</small>
              <label className="tp-ai-admin-field">参考图编辑协议<select disabled={!route.imageModelId || !route.imageProviderId} value={route.imageEditCapability?.profile ?? ""} onChange={event => {
                const provider = draft.providers.find(item => item.id === route.imageProviderId);
                const profile = event.target.value;
                if (!profile) { updateTier(activeTier, { imageEditCapability: undefined }); return; }
                if (!provider || !route.imageModelId || profile !== "openai-gpt-image-edits-v1" && profile !== "openai-dall-e-2-edits-v1") return;
                try {
                  updateTier(activeTier, { imageEditCapability: { baseUrl: normalizeAiBaseUrl(provider.baseUrl), modelId: route.imageModelId, profile } });
                } catch { setError("请先填写有效的图片服务 HTTPS 地址，再选择参考图编辑协议。"); }
              }}><option value="">未配置 · 仅文字生图</option><option value="openai-gpt-image-edits-v1">GPT Image 兼容编辑</option><option value="openai-dall-e-2-edits-v1">DALL·E 2 兼容编辑</option></select></label>
              <small className="tp-ai-admin-hint">按服务商文档选择；模型列表不代表支持参考图。更换地址或模型后需重新确认。</small>
              <label className="tp-ai-admin-field">单次输出上限 · Token<input type="number" min={16} max={32768} required value={route.maxOutputTokens} onChange={event => updateTier(activeTier, { maxOutputTokens: Number(event.target.value) })} /></label>
              <label className="tp-ai-admin-field">思考强度<select value={route.reasoningEffort} onChange={event => updateTier(activeTier, { reasoningEffort: event.target.value as AiHarnessTierRoute["reasoningEffort"] })}><option value="">服务商默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
            </div></details>
          </div>
        </div>
        <details className="is-wide tp-ai-provider-capabilities"><summary>自动调用规则</summary><div className="tp-ai-admin-fields">
          <label className="tp-ai-admin-field">任务处理方式<select value={draft.policy.strategy} onChange={event => setDraft(current => ({ ...current, policy: { ...current.policy, strategy: event.target.value as AiHarnessInput["policy"]["strategy"] } }))}><option value="direct">直接回答</option><option value="react">按需要调用工具</option><option value="plan_execute">先规划再执行</option></select></label>
          <AdminAiMultiAgentSettings tier={activeTier} route={route} models={discovered[route.providerId] ?? []} loading={busy === `discover:${route.providerId}`}
            emptyMessage={providerErrors[route.providerId] || "点击上方服务的「读取模型」重试"} onOpenModels={() => discoverIfNeeded(route.providerId)} onChange={multiAgent => updateTier(activeTier, { multiAgent })} />
          <label className="tp-ai-admin-field">单轮工具步骤上限<input type="number" min={1} max={8} required value={draft.policy.maxToolSteps} onChange={event => setDraft(current => ({ ...current, policy: { ...current.policy, maxToolSteps: Number(event.target.value) } }))} /></label>
          <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.policy.autoWebSearch} onChange={event => setDraft(current => ({ ...current, policy: { ...current.policy, autoWebSearch: event.target.checked } }))} />需要时自动联网</label>
        </div></details>
      </fieldset>
      <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button is-primary" type="submit" disabled={loading || Boolean(busy)}><Save size={16} />{busy === "save" ? "保存并校验中…" : "保存服务与档位"}</button></div>
    </form>}
  </section>;
}
