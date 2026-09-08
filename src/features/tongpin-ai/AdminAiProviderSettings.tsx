import { Globe, Image, KeyRound, RefreshCw, Save } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { AiProviderConfig, AiProviderInput, AiProviderTestResult } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { adminAiErrorMessage, normalizeAiBaseUrl, validateAiProviderConnection, validateAiProviderInput } from "./adminAiForms";

const EMPTY_PROVIDER: AiProviderInput = {
  name: "AI 服务",
  baseUrl: "",
  protocol: "responses",
  quickModel: "",
  deepModel: "",
  maxOutputTokens: 2_048,
  reasoningEffort: "",
  enabled: true,
  imageModel: "",
  imageBaseUrl: "",
  imageQuotaTokens: 0,
  imageStream: false,
  visionEnabled: false,
  visionInputReserveTokens: 4096,
  webSearchEnabled: false,
  webSearchQuotaTokens: 0,
  webSearchProtocol: "standard",
};

export function AdminAiProviderSettings() {
  const { api } = useAuth();
  const id = useId();
  const [saved, setSaved] = useState<AiProviderConfig | null>(null);
  const [draft, setDraft] = useState<AiProviderInput>(EMPTY_PROVIDER);
  const [apiKey, setApiKey] = useState("");
  const [imageApiKey, setImageApiKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "test" | "image-test" | null>(null);
  const busyRef = useRef(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [imageModels, setImageModels] = useState<string[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setLoadFailed(false);
    api<{ provider: AiProviderConfig | null }>("/api/admin/ai/provider", { signal: controller.signal })
      .then(({ provider }) => {
        if (controller.signal.aborted) return;
        setSaved(provider);
        setDraft(provider ?? EMPTY_PROVIDER);
        setApiKey("");
        setImageApiKey("");
        setDirty(false);
      })
      .catch((caught: unknown) => {
        if (controller.signal.aborted) return;
        setLoadFailed(true);
        setError(adminAiErrorMessage(caught, "读取 AI 接入配置失败，请重试。"));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, loadVersion]);

  function update<K extends keyof AiProviderInput>(field: K, value: AiProviderInput[K]) {
    setDraft((current) => ({ ...current, [field]: value }));
    setDirty(true);
    setNotice("");
    setError("");
    if (field === "baseUrl") setModels([]);
    if (field === "imageBaseUrl") setImageModels([]);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || loading || loadFailed) return;
    const input: AiProviderInput = { ...draft, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(imageApiKey.trim() ? { imageApiKey: imageApiKey.trim() } : {}) };
    const validation = validateAiProviderInput(input, saved);
    if (validation) { setError(validation); return; }
    const payload: AiProviderInput = {
      name: input.name.trim(),
      baseUrl: normalizeAiBaseUrl(input.baseUrl),
      protocol: input.protocol,
      quickModel: input.quickModel.trim(),
      deepModel: input.deepModel.trim(),
      maxOutputTokens: input.maxOutputTokens,
      reasoningEffort: input.reasoningEffort,
      enabled: input.enabled,
      imageModel: input.imageModel?.trim() || "",
      imageBaseUrl: input.imageBaseUrl?.trim() ? normalizeAiBaseUrl(input.imageBaseUrl) : "",
      imageQuotaTokens: input.imageQuotaTokens ?? 0,
      imageStream: input.imageStream ?? false,
      visionEnabled: input.visionEnabled ?? false,
      visionInputReserveTokens: input.visionInputReserveTokens ?? 4096,
      webSearchEnabled: input.webSearchEnabled ?? false,
      webSearchQuotaTokens: input.webSearchQuotaTokens ?? 0,
      webSearchProtocol: input.webSearchProtocol ?? "standard",
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.imageApiKey ? { imageApiKey: input.imageApiKey } : {}),
    };
    busyRef.current = true;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      const { provider } = await api<{ provider: AiProviderConfig }>("/api/admin/ai/provider", {
        method: "PUT", body: JSON.stringify(payload),
      });
      setSaved(provider);
      setDraft(provider);
      setApiKey("");
      setImageApiKey("");
      setDirty(false);
      setModels([]);
      setImageModels([]);
      setNotice(provider.enabled ? "接入已保存并启用。" : "接入已保存，当前未启用。");
    } catch (caught) {
      setError(adminAiErrorMessage(caught, "保存失败，请检查地址、密钥和模型配置后重试。"));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  async function testImageConnection() {
    if (busyRef.current || loading || loadFailed) return;
    const separate = Boolean(draft.imageBaseUrl?.trim());
    const baseUrl = separate ? draft.imageBaseUrl! : draft.baseUrl;
    const key = separate ? imageApiKey : apiKey;
    const previous = separate && saved ? { ...saved, baseUrl: saved.imageBaseUrl || "", apiKeyConfigured: Boolean(saved.imageApiKeyConfigured && saved.imageBaseUrl) } : saved;
    const validation = validateAiProviderConnection(baseUrl, key, previous);
    if (validation) { setError(validation); return; }
    busyRef.current = true; setBusy("image-test"); setError(""); setNotice("");
    try {
      const result = await api<AiProviderTestResult>("/api/admin/ai/provider/test", {
        method: "POST", body: JSON.stringify({ target: separate ? "image" : "chat", baseUrl: normalizeAiBaseUrl(baseUrl), ...(key.trim() ? { apiKey: key.trim() } : {}) }),
      }, 30_000);
      setImageModels(result.models);
      setNotice(result.ok ? `已读取 ${result.models.length} 个模型。请确认所选图片模型支持图像生成，测试未生成图片。` : "图片接口测试未通过，请核对服务商信息。");
    } catch (caught) { setError(adminAiErrorMessage(caught, "图片接口连接失败，可核对文档后手动填写图片模型。")); }
    finally { busyRef.current = false; setBusy(null); }
  }

  async function testConnection() {
    if (busyRef.current || loading || loadFailed) return;
    const validation = validateAiProviderConnection(draft.baseUrl, apiKey, saved);
    if (validation) { setError(validation); return; }
    busyRef.current = true;
    setBusy("test");
    setError("");
    setNotice("");
    try {
      const result = await api<AiProviderTestResult>("/api/admin/ai/provider/test", {
        method: "POST",
        body: JSON.stringify({ baseUrl: normalizeAiBaseUrl(draft.baseUrl), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
      }, 30_000);
      setModels(result.models);
      if (result.ok) {
        setNotice(result.models.length
          ? `连接成功，获取到 ${result.models.length} 个模型。未生成内容。`
          : "连接已验证，模型列表不可用，可手动填写模型 ID。未生成内容。");
      } else {
        setError("未能读取模型列表，请核对接入信息；若服务不提供列表，可手动填写模型 ID。");
      }
    } catch (caught) {
      setError(adminAiErrorMessage(caught, "连接测试未通过，请核对 API 地址和密钥；模型 ID 也可以手动填写。"));
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  return (
    <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={loading}>
      <header className="tp-ai-admin-heading">
        <div><h2 id={`${id}-title`}><KeyRound size={21} aria-hidden="true" />AI 接入</h2>
          <p>密钥仅保存到服务器，不向成员公开。</p></div>
        <span className={`tp-ai-admin-status ${saved?.enabled ? "is-active" : ""}`}>
          {loading ? "加载中" : loadFailed ? "读取失败" : saved?.enabled ? "已启用" : saved ? "已停用" : "未配置"}
        </span>
      </header>
      {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
      {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
      {loadFailed ? <button className="tp-ai-admin-button" type="button" onClick={() => setLoadVersion((value) => value + 1)}>重新加载</button> : (
        <form onSubmit={save} autoComplete="off">
          <fieldset className="tp-ai-admin-fields" disabled={loading || busy !== null}>
            <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-name`}>服务名称
              <input id={`${id}-name`} value={draft.name} required maxLength={80} placeholder="例如：公司 AI"
                onChange={(event) => update("name", event.target.value)} />
            </label>
            <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-url`}>API Base URL
              <input id={`${id}-url`} type="url" value={draft.baseUrl} required maxLength={512}
                placeholder="https://yes.hubniconico.com/v1" spellCheck={false}
                onChange={(event) => update("baseUrl", event.target.value)} />
            </label>
            <label className="tp-ai-admin-field" htmlFor={`${id}-protocol`}>接口协议
              <select id={`${id}-protocol`} value={draft.protocol} onChange={(event) => update("protocol", event.target.value as AiProviderInput["protocol"])}>
                <option value="responses">OpenAI Responses</option>
                <option value="chat_completions">OpenAI Chat Completions</option>
              </select>
            </label>
            <label className="tp-ai-admin-field" htmlFor={`${id}-key`}>API 密钥
              <input id={`${id}-key`} type="password" value={apiKey} autoComplete="new-password" maxLength={4_096}
                placeholder={saved?.apiKeyConfigured ? "已保存密钥；留空保留，填写则替换" : "粘贴你的 API 密钥"}
                onChange={(event) => { setApiKey(event.target.value); setDirty(true); setModels([]); setError(""); setNotice(""); }} />
            </label>
            <div className="tp-ai-admin-inline-test is-wide">
              <button className="tp-ai-admin-button" type="button" onClick={() => void testConnection()} disabled={loading || busy !== null}>
                <RefreshCw size={17} aria-hidden="true" />{busy === "test" ? "测试中…" : "测试连接 / 获取模型"}
              </button>
              <span className="tp-ai-admin-hint">填写地址和密钥即可测试，不生成内容。</span>
            </div>
            <label className="tp-ai-admin-field" htmlFor={`${id}-quick`}>快速模式 · 模型 ID
              <input id={`${id}-quick`} value={draft.quickModel} required maxLength={160} list={`${id}-models`}
                placeholder="填写服务商提供的模型 ID" spellCheck={false} onChange={(event) => update("quickModel", event.target.value)} />
            </label>
            <label className="tp-ai-admin-field" htmlFor={`${id}-deep`}>深度思考 · 模型 ID
              <input id={`${id}-deep`} value={draft.deepModel} required maxLength={160} list={`${id}-models`}
                placeholder="可与快速模式使用相同模型" spellCheck={false} onChange={(event) => update("deepModel", event.target.value)} />
            </label>
            <datalist id={`${id}-models`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
            <label className="tp-ai-admin-field" htmlFor={`${id}-max`}>单次最大文本输出 · Token
              <input id={`${id}-max`} type="number" min="16" max="32768" step="1" required value={Number.isNaN(draft.maxOutputTokens) ? "" : draft.maxOutputTokens}
                onChange={(event) => update("maxOutputTokens", event.target.valueAsNumber)} />
            </label>
            <label className="tp-ai-admin-field" htmlFor={`${id}-reasoning`}>深度思考强度
              <select id={`${id}-reasoning`} value={draft.reasoningEffort} onChange={(event) => update("reasoningEffort", event.target.value as AiProviderInput["reasoningEffort"])}>
                <option value="">服务商默认</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option>
              </select>
            </label>
            <label className="tp-ai-admin-toggle is-wide">
              <input type="checkbox" checked={draft.enabled} onChange={(event) => update("enabled", event.target.checked)} />
              启用 AI 服务
            </label>
            <details className="tp-ai-provider-capabilities is-wide">
              <summary><Image size={17} />图片生成</summary>
              <div className="tp-ai-admin-fields">
                <label className="tp-ai-admin-field" htmlFor={`${id}-image-model`}>图片模型 ID
                  <input id={`${id}-image-model`} value={draft.imageModel ?? ""} maxLength={160} list={`${id}-image-models`} placeholder="留空关闭图片生成" spellCheck={false} onChange={event => update("imageModel", event.target.value)} />
                </label>
                <label className="tp-ai-admin-field" htmlFor={`${id}-image-quota`}>每张图片折算 · 同频点
                  <input id={`${id}-image-quota`} type="number" min={0} max={10_000_000} step={1} value={Number.isNaN(draft.imageQuotaTokens) ? "" : draft.imageQuotaTokens ?? 0} onChange={event => update("imageQuotaTokens", event.target.valueAsNumber)} />
                </label>
                <p className="tp-ai-admin-hint is-wide">图片按你设置的同频点扣减，属于折算值，不是服务商实际文本 Token。请先核对服务商图片价格和模型能力。</p>
                <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-image-url`}>独立图片 API 地址
                  <input id={`${id}-image-url`} type="url" value={draft.imageBaseUrl ?? ""} maxLength={512} placeholder="留空复用上面的 API 地址和密钥" spellCheck={false} onChange={event => update("imageBaseUrl", event.target.value)} />
                </label>
                <label className="tp-ai-admin-field is-wide" htmlFor={`${id}-image-key`}>独立图片 API 密钥
                  <input id={`${id}-image-key`} type="password" autoComplete="new-password" maxLength={4096} value={imageApiKey} placeholder={saved?.imageBaseUrl && saved.imageApiKeyConfigured ? "已保存；留空保留，填写则替换" : "使用独立图片地址时填写"} onChange={event => { setImageApiKey(event.target.value); setDirty(true); setImageModels([]); setError(""); setNotice(""); }} />
                </label>
                <datalist id={`${id}-image-models`}>{imageModels.map(model => <option key={model} value={model} />)}</datalist>
                <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.imageStream ?? false} onChange={event => update("imageStream", event.target.checked)} />图片流式响应（SSE）</label>
                <p className="tp-ai-admin-hint is-wide">服务商要求流式生图时开启。使用标准 Images 接口，仅接收最终图片；与文本的快速 / 深度思考无关。</p>
                <button className="tp-ai-admin-button" type="button" disabled={busy !== null} onClick={() => void testImageConnection()}><RefreshCw size={16} />{busy === "image-test" ? "测试中…" : "测试图片接口 / 获取模型"}</button>
              </div>
            </details>
            <details className="tp-ai-provider-capabilities is-wide">
              <summary><Image size={17} />图片与视频画面理解</summary>
              <div className="tp-ai-admin-fields">
                <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.visionEnabled ?? false} onChange={event => update("visionEnabled", event.target.checked)} />启用图片理解</label>
                <label className="tp-ai-admin-field" htmlFor={`${id}-vision-reserve`}>每张图片的输入预留 · 同频点
                  <input id={`${id}-vision-reserve`} type="number" min={256} max={131072} step={1} value={Number.isNaN(draft.visionInputReserveTokens) ? "" : draft.visionInputReserveTokens ?? 4096} onChange={event => update("visionInputReserveTokens", event.target.valueAsNumber)} />
                </label>
                <p className="tp-ai-admin-hint is-wide">请先确认文本模型支持图片输入。视频按抽取的画面理解，不包含音轨；每帧按一张图片预留。这里是发送前的预算估算，不是实际消费，完成后按服务商返回的 Token 结算。</p>
              </div>
            </details>
            <details className="tp-ai-provider-capabilities is-wide">
              <summary><Globe size={17} />联网搜索</summary>
              <div className="tp-ai-admin-fields">
                <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.webSearchEnabled ?? false} onChange={event => update("webSearchEnabled", event.target.checked)} />启用服务商联网搜索工具</label>
                <label className="tp-ai-admin-field" htmlFor={`${id}-search-quota`}>每次联网搜索折算 · 同频点
                  <input id={`${id}-search-quota`} type="number" min={0} max={10_000_000} step={1} value={Number.isNaN(draft.webSearchQuotaTokens) ? "" : draft.webSearchQuotaTokens ?? 0} onChange={event => update("webSearchQuotaTokens", event.target.valueAsNumber)} />
                </label>
                <label className="tp-ai-admin-field" htmlFor={`${id}-search-protocol`}>搜索接口兼容方式
                  <select id={`${id}-search-protocol`} value={draft.webSearchProtocol ?? "standard"} onChange={event => update("webSearchProtocol", event.target.value as AiProviderInput["webSearchProtocol"])}>
                    <option value="standard">标准 Responses</option><option value="compatible">兼容接口（不支持 max_tool_calls）</option>
                  </select>
                </label>
                <p className="tp-ai-admin-hint is-wide">仅支持 Responses 协议且模型必须支持搜索工具。文本每 1 Token 计 1 同频点，搜索另按本设置折算为同频点；实际 Token 和折算用量在明细中分开显示。</p>
                <p className="tp-ai-admin-hint is-wide">{draft.webSearchProtocol === "compatible" ? "兼容方式预留最多 3 次搜索的折算额度，按实际次数结算。超过预算会停止接收并记录待核对，不能保证服务商同时停止计费。" : "标准方式向服务商请求最多 1 次搜索。仅在服务商明确不支持 max_tool_calls 时选择兼容方式。"}</p>
              </div>
            </details>
          </fieldset>
          <footer className="tp-ai-admin-actions">
            <button className="tp-ai-admin-button is-primary" type="submit" disabled={loading || busy !== null || (!dirty && saved !== null)}>
              <Save size={17} aria-hidden="true" />{busy === "save" ? "保存中…" : "保存配置"}
            </button>
            <span className="tp-ai-admin-hint">{dirty ? "有未保存的修改" : "额度与模型配置保存后生效。"}</span>
          </footer>
        </form>
      )}
    </section>
  );
}
