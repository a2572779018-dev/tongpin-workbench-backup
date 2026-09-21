import { Activity, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import { useEffect, useId, useState, type FormEvent } from "react";
import {
  AI_BUSINESS_TIERS,
  AI_BUSINESS_TIER_LABELS,
  type AiHarnessCapability,
  type AiHarnessConfig,
  type AiHarnessInput,
  type AiHarnessProviderInput,
  type AiHarnessTierRoute,
  type AiMode,
  type AiProviderTestResult,
} from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { adminAiErrorMessage, normalizeAiBaseUrl } from "./adminAiForms";

const CAPABILITIES: Array<[AiHarnessCapability, string]> = [
  ["vision", "图片理解"], ["web_search", "自动联网"], ["image", "生成图片"], ["video", "生成视频"],
  ["presentation", "生成 PPT"], ["computer", "控制电脑"],
];

const emptyRoute = (providerId = "primary"): AiHarnessTierRoute => ({
  providerId, modelId: "", protocol: "chat_completions", maxOutputTokens: 2048,
  reasoningEffort: "", capabilities: ["chat"], enabled: true,
});

const emptyInput = (): AiHarnessInput => ({
  providers: [{ id: "primary", name: "主要 AI 服务", baseUrl: "", protocol: "chat_completions", enabled: true }],
  tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, emptyRoute()])) as Record<AiMode, AiHarnessTierRoute>,
  policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
});

function editable(config: AiHarnessConfig | null): AiHarnessInput {
  if (!config) return emptyInput();
  return {
    providers: config.providers.map(({ apiKeyConfigured: _key, modelsVerified: _verified, availableModels: _models, modelsVerifiedAt: _at, ...provider }) => provider),
    tiers: structuredClone(config.tiers),
    policy: { ...config.policy, requireApproval: true },
  };
}

export function AdminAiHarnessSettings() {
  const { api } = useAuth();
  const id = useId();
  const [saved, setSaved] = useState<AiHarnessConfig | null>(null);
  const [draft, setDraft] = useState<AiHarnessInput>(emptyInput);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [discovered, setDiscovered] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api<{ harness: AiHarnessConfig | null }>("/api/admin/ai/harness", { signal: controller.signal })
      .then(({ harness }) => {
        if (controller.signal.aborted) return;
        setSaved(harness); setDraft(editable(harness)); setKeys({});
        setDiscovered(Object.fromEntries((harness?.providers ?? []).map(provider => [provider.id, provider.availableModels])));
      })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(adminAiErrorMessage(caught, "业务档位读取失败，请重试。")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, version]);

  function updateProvider(index: number, patch: Partial<AiHarnessProviderInput>) {
    setDraft(current => {
      const previous = current.providers[index];
      const nextId = patch.id ?? previous.id;
      return {
        ...current,
        providers: current.providers.map((provider, item) => item === index ? { ...provider, ...patch } : provider),
        tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, {
          ...current.tiers[tier],
          ...(patch.id !== undefined && current.tiers[tier].providerId === previous.id ? { providerId: nextId } : {}),
          ...(patch.id !== undefined && current.tiers[tier].imageProviderId === previous.id ? { imageProviderId: nextId } : {}),
          ...(patch.id !== undefined && current.tiers[tier].videoProviderId === previous.id ? { videoProviderId: nextId } : {}),
          ...(patch.protocol !== undefined && current.tiers[tier].providerId === previous.id ? { protocol: patch.protocol } : {}),
        }])) as Record<AiMode, AiHarnessTierRoute>,
      };
    });
    setNotice(""); setError("");
  }

  function updateTier(tier: AiMode, patch: Partial<AiHarnessTierRoute>) {
    setDraft(current => ({ ...current, tiers: { ...current.tiers, [tier]: { ...current.tiers[tier], ...patch } } }));
    setNotice(""); setError("");
  }

  async function discover(provider: AiHarnessProviderInput) {
    if (busy || loading) return;
    setBusy(`discover:${provider.id}`); setError(""); setNotice("");
    try {
      let models: string[];
      const savedProvider = saved?.providers.find(item => item.id === provider.id);
      if (!keys[provider.id]?.trim() && savedProvider?.apiKeyConfigured && saved?.migratedFromLegacy === false) {
        const result = await api<{ models: string[] }>(`/api/admin/ai/harness/providers/${encodeURIComponent(provider.id)}/discover`, { method: "POST" }, 30_000);
        models = result.models;
      } else {
        if (!keys[provider.id]?.trim()) throw new Error("首次读取模型时请填写 API Key。");
        const result = await api<AiProviderTestResult>("/api/admin/ai/provider/test", {
          method: "POST",
          body: JSON.stringify({ target: "chat", baseUrl: normalizeAiBaseUrl(provider.baseUrl), apiKey: keys[provider.id].trim() }),
        }, 30_000);
        models = result.models;
      }
      setDiscovered(current => ({ ...current, [provider.id]: models }));
      setNotice(`已读取 ${models.length} 个模型，仅查询列表，未生成内容。`);
    } catch (caught) { setError(adminAiErrorMessage(caught, "模型列表读取失败，请核对 API 地址和密钥。")); }
    finally { setBusy(null); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || loading) return;
    setBusy("save"); setError(""); setNotice("");
    try {
      const payload: AiHarnessInput = {
        ...draft,
        providers: draft.providers.map(provider => ({ ...provider, baseUrl: normalizeAiBaseUrl(provider.baseUrl), ...(keys[provider.id]?.trim() ? { apiKey: keys[provider.id].trim() } : {}) })),
        policy: { ...draft.policy, requireApproval: true },
      };
      const result = await api<{ harness: AiHarnessConfig }>("/api/admin/ai/harness", { method: "PUT", body: JSON.stringify(payload) });
      const verified: Record<string, string[]> = {};
      for (const provider of result.harness.providers.filter(item => item.enabled)) {
        const list = await api<{ models: string[] }>(`/api/admin/ai/harness/providers/${encodeURIComponent(provider.id)}/discover`, { method: "POST" }, 30_000);
        verified[provider.id] = list.models;
      }
      const missing = AI_BUSINESS_TIERS.filter(tier => {
        const route = draft.tiers[tier];
        return !verified[route.providerId]?.includes(route.modelId)
          || (route.capabilities.includes("image") && (!route.imageProviderId || !route.imageModelId || !verified[route.imageProviderId]?.includes(route.imageModelId)))
          || (route.capabilities.includes("video") && (!route.videoProviderId || !route.videoModelId || !verified[route.videoProviderId]?.includes(route.videoModelId)));
      });
      setSaved(result.harness); setKeys({}); setDiscovered(verified);
      if (missing.length) setError(`配置已保存，但${missing.map(tier => AI_BUSINESS_TIER_LABELS[tier]).join("、")}所选模型不在当前密钥返回列表中；该档位会保持不可用。`);
      else setNotice("四个业务档位已保存，并与当前密钥返回的模型列表完成绑定。");
    } catch (caught) { setError(adminAiErrorMessage(caught, "业务档位保存或模型校验失败，请检查配置。")); }
    finally { setBusy(null); }
  }

  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={loading || Boolean(busy)}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Activity size={21} aria-hidden="true" />业务档位与 Harness</h2>
      <p>成员只看到快速、标准、深度和 Pro；服务商、模型 ID 与专属参数仅管理员可见。</p>
    </div><button className="tp-ai-admin-button" type="button" disabled={loading || Boolean(busy)} onClick={() => setVersion(value => value + 1)}><RefreshCw size={16} />刷新</button></header>
    {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
    {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
    <form onSubmit={submit} autoComplete="off">
      <fieldset className="tp-ai-admin-fields" disabled={loading || Boolean(busy)}>
        {draft.providers.map((provider, index) => <div className="tp-ai-provider-capabilities is-wide" key={provider.id || index}>
          <strong>服务连接 {index + 1}</strong>
          <div className="tp-ai-admin-fields" style={{ marginTop: 12 }}>
            <label className="tp-ai-admin-field">服务标识<input value={provider.id} maxLength={48} required onChange={event => updateProvider(index, { id: event.target.value.toLowerCase() })} /></label>
            <label className="tp-ai-admin-field">服务名称<input value={provider.name} maxLength={80} required onChange={event => updateProvider(index, { name: event.target.value })} /></label>
            <label className="tp-ai-admin-field is-wide">API Base URL<input type="url" value={provider.baseUrl} required placeholder="https://api.example.com/v1" onChange={event => updateProvider(index, { baseUrl: event.target.value })} /></label>
            <label className="tp-ai-admin-field">协议<select value={provider.protocol} onChange={event => updateProvider(index, { protocol: event.target.value as AiHarnessProviderInput["protocol"] })}><option value="chat_completions">Chat Completions</option><option value="responses">Responses</option></select></label>
            <label className="tp-ai-admin-field">API Key<input type="password" value={keys[provider.id] ?? ""} placeholder={saved?.providers.some(item => item.id === provider.id && item.apiKeyConfigured) ? "留空保持已保存密钥" : "首次配置必须填写"} onChange={event => setKeys(current => ({ ...current, [provider.id]: event.target.value }))} /></label>
          </div>
          <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button" type="button" onClick={() => void discover(provider)}><RefreshCw size={16} />读取模型</button>
            {draft.providers.length > 1 ? <button className="tp-ai-admin-button" type="button" onClick={() => setDraft(current => ({ ...current, providers: current.providers.filter((_, item) => item !== index) }))}><Trash2 size={16} />移除</button> : null}
            <small className="tp-ai-admin-hint">{discovered[provider.id]?.length ?? 0} 个可选模型</small></div>
        </div>)}
        <div className="is-wide"><button className="tp-ai-admin-button" type="button" disabled={draft.providers.length >= 8} onClick={() => {
          const providerId = `provider-${draft.providers.length + 1}`;
          setDraft(current => ({ ...current, providers: [...current.providers, { id: providerId, name: `AI 服务 ${current.providers.length + 1}`, baseUrl: "", protocol: "chat_completions", enabled: true }] }));
        }}><Plus size={16} />添加服务连接</button></div>
        {AI_BUSINESS_TIERS.map(tier => {
          const route = draft.tiers[tier];
          const options = discovered[route.providerId] ?? saved?.providers.find(provider => provider.id === route.providerId)?.availableModels ?? [];
          const imageOptions = discovered[route.imageProviderId ?? ""] ?? saved?.providers.find(provider => provider.id === route.imageProviderId)?.availableModels ?? [];
          const videoOptions = discovered[route.videoProviderId ?? ""] ?? saved?.providers.find(provider => provider.id === route.videoProviderId)?.availableModels ?? [];
          return <div className="tp-ai-provider-capabilities" key={tier}>
            <strong>{AI_BUSINESS_TIER_LABELS[tier]}</strong>
            <div className="tp-ai-admin-fields" style={{ marginTop: 12 }}>
              <label className="tp-ai-admin-field">文字服务<select value={route.providerId} onChange={event => updateTier(tier, { providerId: event.target.value, modelId: "" })}>{draft.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></label>
              <label className="tp-ai-admin-field">文字模型 ID<input list={`${id}-${tier}-models`} value={route.modelId} required placeholder="输入关键字搜索" onChange={event => updateTier(tier, { modelId: event.target.value })} /><datalist id={`${id}-${tier}-models`}>{options.map(model => <option value={model} key={model} />)}</datalist></label>
              <label className="tp-ai-admin-field">图片服务<select value={route.imageProviderId ?? ""} onChange={event => updateTier(tier, { imageProviderId: event.target.value || undefined, imageModelId: "" })}><option value="">未配置</option>{draft.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></label>
              <label className="tp-ai-admin-field">图片模型 ID<input list={`${id}-${tier}-image-models`} value={route.imageModelId ?? ""} placeholder="输入关键字搜索" onChange={event => updateTier(tier, { imageModelId: event.target.value || undefined })} /><datalist id={`${id}-${tier}-image-models`}>{imageOptions.map(model => <option value={model} key={model} />)}</datalist></label>
              <label className="tp-ai-admin-field">视频服务<select value={route.videoProviderId ?? ""} onChange={event => updateTier(tier, { videoProviderId: event.target.value || undefined, videoModelId: "" })}><option value="">未配置</option>{draft.providers.map(provider => <option value={provider.id} key={provider.id}>{provider.name || provider.id}</option>)}</select></label>
              <label className="tp-ai-admin-field">视频模型 ID<input list={`${id}-${tier}-video-models`} value={route.videoModelId ?? ""} placeholder="输入关键字搜索" onChange={event => updateTier(tier, { videoModelId: event.target.value || undefined })} /><datalist id={`${id}-${tier}-video-models`}>{videoOptions.map(model => <option value={model} key={model} />)}</datalist><small className="tp-ai-admin-hint">付费视频当前只执行 https://www.75api.com/v1 的已验证模型。</small></label>
              <label className="tp-ai-admin-field">单次输出上限<input type="number" min={16} max={32768} value={route.maxOutputTokens} onChange={event => updateTier(tier, { maxOutputTokens: Number(event.target.value) })} /></label>
              <label className="tp-ai-admin-field">思考强度<select value={route.reasoningEffort} onChange={event => updateTier(tier, { reasoningEffort: event.target.value as AiHarnessTierRoute["reasoningEffort"] })}><option value="">默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label>
              <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={route.enabled} onChange={event => updateTier(tier, { enabled: event.target.checked })} />启用此档位</label>
              <div className="is-wide tp-ai-admin-actions" style={{ marginTop: 0 }}><span className="tp-ai-admin-hint">开放能力：</span>{CAPABILITIES.map(([capability, label]) => <label className="tp-ai-admin-toggle" key={capability}><input type="checkbox" checked={route.capabilities.includes(capability)} onChange={event => updateTier(tier, { capabilities: event.target.checked ? [...route.capabilities, capability] : route.capabilities.filter(item => item !== capability) })} />{label}</label>)}</div>
            </div>
          </div>;
        })}
        <label className="tp-ai-admin-field">代理策略<select value={draft.policy.strategy} onChange={event => setDraft(current => ({ ...current, policy: { ...current.policy, strategy: event.target.value as AiHarnessInput["policy"]["strategy"] } }))}><option value="direct">直接回答</option><option value="react">观察后调用安全工具</option><option value="plan_execute">先规划、确认后执行</option></select></label>
        <label className="tp-ai-admin-field">单轮工具步骤上限<input type="number" min={1} max={8} value={draft.policy.maxToolSteps} onChange={event => setDraft(current => ({ ...current, policy: { ...current.policy, maxToolSteps: Number(event.target.value) } }))} /></label>
        <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.policy.autoWebSearch} onChange={event => setDraft(current => ({ ...current, policy: { ...current.policy, autoWebSearch: event.target.checked } }))} />需要时自动联网（成员端不显示开关）</label>
      </fieldset>
      <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button is-primary" type="submit" disabled={loading || Boolean(busy)}><Save size={16} />{busy === "save" ? "保存并校验中…" : "保存并校验四档配置"}</button><span className="tp-ai-admin-hint">付费生成与本机操作始终需要成员确认。</span></div>
    </form>
  </section>;
}
