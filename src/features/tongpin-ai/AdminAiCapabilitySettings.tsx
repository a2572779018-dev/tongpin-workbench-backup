import { Globe, Image, RefreshCw, Save, Terminal } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { AI_MAX_SEARCH_CALLS, type AiHarnessConfig, type AiProviderConfig } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { adminAiErrorMessage, parseAdminPoints } from "./adminAiForms";
import { tiersManageRouting, tiersWithCapability } from "./adminAiLayout";

/**
 * AI 管理 → 图片与视频 / 联网与代码: the prices and switches four-tier routing
 * reads besides the tiers themselves (per-image price, image streaming, image
 * input reserve, hosted search and code execution). Saved on their own through
 * PUT /api/admin/ai/capabilities: no connection, key or model field is sent.
 */

type CapabilityPatch = Partial<Pick<AiProviderConfig,
  "imageQuotaTokens" | "imageStream" | "visionInputReserveTokens" | "webSearchEnabled" | "webSearchQuotaTokens" | "webSearchProtocol" | "codeInterpreterEnabled" | "codeInterpreterQuotaTokens">>;

function useCapabilitySettings() {
  const { api } = useAuth();
  const [saved, setSaved] = useState<AiProviderConfig | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const [loadError, setLoadError] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState("loading"); setLoadError("");
    api<{ provider: AiProviderConfig | null }>("/api/admin/ai/provider", { signal: controller.signal })
      .then(({ provider }) => { if (!controller.signal.aborted) { setSaved(provider); setState("ready"); } })
      .catch(caught => { if (!controller.signal.aborted) { setState("failed"); setLoadError(adminAiErrorMessage(caught, "读取设置失败，请重试。")); } });
    return () => controller.abort();
  }, [api, version]);
  const save = async (patch: CapabilityPatch) => {
    const { provider } = await api<{ provider: AiProviderConfig }>("/api/admin/ai/capabilities", { method: "PUT", body: JSON.stringify(patch) });
    setSaved(provider);
    return provider;
  };
  return { saved, state, loadError, reload: () => setVersion(value => value + 1), save };
}

function useSaveState() {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const run = async (action: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try { setNotice(await action()); }
    catch (caught) { setError(adminAiErrorMessage(caught, "保存失败，请稍后重试。")); }
    finally { busyRef.current = false; setBusy(false); }
  };
  return { busy, error, notice, setError, clear: () => { setError(""); setNotice(""); }, run };
}

function NeedsTiers() {
  return <p className="tp-ai-admin-hint" role="note">请先在「服务与模型」接入服务并保存四个档位，这里的设置才会生效。</p>;
}

function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div className="tp-ai-admin-actions"><p className="tp-ai-admin-error" role="alert">{message}</p>
    <button className="tp-ai-admin-button" type="button" onClick={onRetry}><RefreshCw size={16} aria-hidden="true" />重新加载</button></div>;
}

const tierList = (labels: string[]) => labels.length ? labels.join("、") : "暂无";

/** 图片生成 price and streaming, and the input reserve for images a member sends. */
export function AdminAiImageSettings({ harnessConfig }: { harnessConfig: AiHarnessConfig | null }) {
  const id = useId();
  const settings = useCapabilitySettings();
  const status = useSaveState();
  const [price, setPrice] = useState(""), [stream, setStream] = useState(false), [reserve, setReserve] = useState("");
  const [dirty, setDirty] = useState(false);
  const { saved } = settings;
  useEffect(() => {
    if (dirty) return;
    setPrice(saved?.imageQuotaTokens ? String(saved.imageQuotaTokens) : saved ? "0" : "");
    setStream(saved?.imageStream ?? false);
    setReserve(String(saved?.visionInputReserveTokens ?? 4096));
  }, [saved, dirty]);
  const generating = tiersWithCapability(harnessConfig, "image");
  const understanding = tiersWithCapability(harnessConfig, "vision");
  const ready = tiersManageRouting(harnessConfig);
  const touch = () => { setDirty(true); status.clear(); };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const points = parseAdminPoints(price, "每张图片折算的同频点");
    if (points.error) { status.setError(points.error); return; }
    if (generating.length && points.value < 1) { status.setError(`${generating.join("、")}档开放了生成图片，每张图片折算的同频点需大于 0（0 表示关闭图片生成）。`); return; }
    const inputReserve = parseAdminPoints(reserve, "每张图片的输入预留", { min: 256, max: 131_072 });
    if (inputReserve.error) { status.setError(inputReserve.error); return; }
    await status.run(async () => {
      await settings.save({ imageQuotaTokens: points.value, imageStream: stream, visionInputReserveTokens: inputReserve.value });
      setDirty(false);
      return "图片设置已保存。";
    });
  }

  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={settings.state === "loading" || status.busy}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Image size={20} aria-hidden="true" />图片</h2>
      <p>开放生成图片的档位：{tierList(generating)}；开放图片理解（看懂成员发来的图片、视频画面）的档位：{tierList(understanding)}。</p>
    </div></header>
    {settings.state === "failed" ? <LoadFailed message={settings.loadError} onRetry={settings.reload} /> : <form onSubmit={submit} noValidate>
      {!ready ? <NeedsTiers /> : null}
      <fieldset className="tp-ai-admin-fields" disabled={!ready || settings.state === "loading" || status.busy}>
        <label className="tp-ai-admin-field" htmlFor={`${id}-price`}>每张图片折算 · 同频点
          <input id={`${id}-price`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 2000" value={price} onChange={event => { setPrice(event.target.value); touch(); }} />
        </label>
        <label className="tp-ai-admin-field" htmlFor={`${id}-reserve`}>每张图片的输入预留 · 同频点
          <input id={`${id}-reserve`} type="text" inputMode="numeric" maxLength={6} value={reserve} onChange={event => { setReserve(event.target.value); touch(); }} />
        </label>
        <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={stream} onChange={event => { setStream(event.target.checked); touch(); }} />图片流式响应（服务商要求流式生图时才开）</label>
        <p className="tp-ai-admin-hint is-wide">生成一张图片扣你设置的同频点，0 表示关闭图片生成。成员发图片或视频让 AI 看时，每张图片（视频按抽取的画面，每帧算一张）先按输入预留估算，完成后按服务商实际用量结算；视频不包含声音。</p>
      </fieldset>
      {status.error ? <p className="tp-ai-admin-error" role="alert">{status.error}</p> : null}
      {status.notice ? <p className="tp-ai-admin-success" role="status">{status.notice}</p> : null}
      <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button is-primary" type="submit" disabled={!ready || !dirty || status.busy}>
        <Save size={17} aria-hidden="true" />{status.busy ? "保存中…" : "保存图片设置"}</button>
        {dirty ? <span className="tp-ai-admin-hint">有未保存的修改</span> : null}</div>
    </form>}
  </section>;
}

/** Hosted web search and code execution: on/off and the price of each call. */
export function AdminAiToolSettings({ harnessConfig }: { harnessConfig: AiHarnessConfig | null }) {
  const id = useId();
  const settings = useCapabilitySettings();
  const status = useSaveState();
  const [search, setSearch] = useState(false), [searchPrice, setSearchPrice] = useState(""), [searchMode, setSearchMode] = useState<"standard" | "compatible">("standard");
  const [code, setCode] = useState(false), [codePrice, setCodePrice] = useState("");
  const [dirty, setDirty] = useState(false);
  const { saved } = settings;
  useEffect(() => {
    if (dirty) return;
    setSearch(saved?.webSearchEnabled ?? false); setSearchPrice(saved?.webSearchQuotaTokens ? String(saved.webSearchQuotaTokens) : "");
    setSearchMode(saved?.webSearchProtocol === "compatible" ? "compatible" : "standard");
    setCode(saved?.codeInterpreterEnabled ?? false); setCodePrice(saved?.codeInterpreterQuotaTokens ? String(saved.codeInterpreterQuotaTokens) : "");
  }, [saved, dirty]);
  const searchTiers = tiersWithCapability(harnessConfig, "web_search", "responses");
  const codeTiers = tiersWithCapability(harnessConfig, "code_interpreter", "responses");
  const ready = tiersManageRouting(harnessConfig);
  const touch = () => { setDirty(true); status.clear(); };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch: Parameters<typeof settings.save>[0] = { webSearchEnabled: search, webSearchProtocol: searchMode, codeInterpreterEnabled: code };
    if (search || searchPrice.trim()) {
      const points = parseAdminPoints(searchPrice, "每次联网搜索折算的同频点", { min: search ? 1 : 0 });
      if (points.error) { status.setError(points.error); return; }
      patch.webSearchQuotaTokens = points.value;
    }
    if (code || codePrice.trim()) {
      const points = parseAdminPoints(codePrice, "每次代码执行折算的同频点", { min: code ? 1 : 0 });
      if (points.error) { status.setError(points.error); return; }
      patch.codeInterpreterQuotaTokens = points.value;
    }
    await status.run(async () => {
      await settings.save(patch);
      setDirty(false);
      return "联网搜索与代码执行设置已保存。";
    });
  }

  const unused = (on: boolean, tiers: string[], capability: string) => on && ready && !tiers.length
    ? <p className="tp-ai-admin-hint is-wide" role="note">目前没有使用 Responses 协议的档位勾选「{capability}」，成员暂时用不到；在「服务与模型」的档位里勾选后生效。</p> : null;

  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={settings.state === "loading" || status.busy}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Globe size={20} aria-hidden="true" />联网搜索与代码执行</h2>
      <p>会用到联网搜索的档位：{tierList(searchTiers)}；会用到代码执行的档位：{tierList(codeTiers)}。文字每 1 Token 计 1 同频点，这两项每次另外按下面的设置折算。</p>
    </div></header>
    {settings.state === "failed" ? <LoadFailed message={settings.loadError} onRetry={settings.reload} /> : <form onSubmit={submit} noValidate>
      {!ready ? <NeedsTiers /> : null}
      <fieldset className="tp-ai-admin-fields" disabled={!ready || settings.state === "loading" || status.busy}>
        <div className="is-wide tp-ai-admin-section-heading"><h3><Globe size={16} aria-hidden="true" /> 联网搜索</h3></div>
        <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={search} onChange={event => { setSearch(event.target.checked); touch(); }} />开启服务商联网搜索</label>
        <label className="tp-ai-admin-field" htmlFor={`${id}-search-price`}>每次联网搜索折算 · 同频点
          <input id={`${id}-search-price`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 10000" value={searchPrice} onChange={event => { setSearchPrice(event.target.value); touch(); }} />
        </label>
        <label className="tp-ai-admin-field" htmlFor={`${id}-search-mode`}>搜索接口兼容方式
          <select id={`${id}-search-mode`} value={searchMode} onChange={event => { setSearchMode(event.target.value === "compatible" ? "compatible" : "standard"); touch(); }}>
            <option value="standard">标准 Responses（最多搜 1 次）</option><option value="compatible">兼容接口（不支持 max_tool_calls）</option>
          </select>
        </label>
        <p className="tp-ai-admin-hint is-wide">{searchMode === "compatible" ? `兼容方式先预留最多 ${AI_MAX_SEARCH_CALLS} 次搜索的折算额度，按实际次数结算；超过预算会停止接收并记录待核对，不能保证服务商同时停止计费。` : "只有服务商明确不支持 max_tool_calls 时才选兼容方式。"}</p>
        {unused(search, searchTiers, "自动联网")}
        <div className="is-wide tp-ai-admin-section-heading"><h3><Terminal size={16} aria-hidden="true" /> 代码执行</h3></div>
        <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={code} onChange={event => { setCode(event.target.checked); touch(); }} />开启服务商代码执行（计算、统计、图表时才会用）</label>
        <label className="tp-ai-admin-field" htmlFor={`${id}-code-price`}>每次代码执行折算 · 同频点
          <input id={`${id}-code-price`} type="text" inputMode="numeric" maxLength={8} placeholder="例如 30000" value={codePrice} onChange={event => { setCodePrice(event.target.value); touch(); }} />
        </label>
        <p className="tp-ai-admin-hint is-wide">服务商拒绝代码执行工具时会自动重试一次并跳过代码执行，不会重复扣费。</p>
        {unused(code, codeTiers, "代码执行")}
      </fieldset>
      {status.error ? <p className="tp-ai-admin-error" role="alert">{status.error}</p> : null}
      {status.notice ? <p className="tp-ai-admin-success" role="status">{status.notice}</p> : null}
      <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button is-primary" type="submit" disabled={!ready || !dirty || status.busy}>
        <Save size={17} aria-hidden="true" />{status.busy ? "保存中…" : "保存联网与代码设置"}</button>
        {dirty ? <span className="tp-ai-admin-hint">有未保存的修改</span> : null}</div>
    </form>}
  </section>;
}
