import { useEffect, useRef, useState, type FormEvent } from "react";
import { COMPUTER_AGENT_LIMITS, type AiComputerSettings } from "../../../shared/computerAgent";
import { useAuth } from "../../auth/AuthContext";
import { ApiRequestError } from "../../lib/api";
import { adminAiErrorMessage } from "./adminAiForms";

/** Jev/computer errors carry specific, secret-free Chinese messages from the server. */
function jevErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiRequestError && /^AI_(?:COMPUTER|JEV)_/.test(error.code) && error.message) return error.message;
  return adminAiErrorMessage(error, fallback);
}

type Draft = { enabled: boolean; model: string; inputPointsPer1k: string; outputPointsPer1k: string; maxSteps: string; maxMinutes: string; minConfidence: string };

function draftFrom(settings: AiComputerSettings): Draft {
  return {
    enabled: settings.enabled, model: settings.model,
    inputPointsPer1k: String(settings.inputPointsPer1k), outputPointsPer1k: String(settings.outputPointsPer1k),
    maxSteps: String(settings.maxSteps), maxMinutes: String(settings.maxMinutes), minConfidence: String(settings.minConfidence),
  };
}

/**
 * "Jev 决策服务": the TypeSafe System One key used by the unified computer
 * executor. The key is write-only here (sealed server-side like provider keys,
 * never returned or logged); prices convert Jev's reported input/output tokens
 * into 同频点 through the normal quota ledger.
 */
export function AdminAiJevSettings() {
  const { api, session } = useAuth();
  const account = session?.user.id;
  const headers = { "X-Tongpin-Account": account ?? "" };
  const [settings, setSettings] = useState<AiComputerSettings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [key, setKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api<{ settings: AiComputerSettings }>("/api/admin/ai/computer", { headers: { "X-Tongpin-Account": account ?? "" }, signal: controller.signal })
      .then(response => { if (!controller.signal.aborted) { setSettings(response.settings); setDraft(draftFrom(response.settings)); } })
      .catch(error => { if (!controller.signal.aborted) setNotice(jevErrorMessage(error, "Jev 决策服务配置读取失败，请重试。")); });
    return () => controller.abort();
  }, [api, account]);

  async function action(run: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setNotice("");
    try { await run(); } catch (error) { setNotice(jevErrorMessage(error, "操作失败，请重试。")); }
    finally { busyRef.current = false; setBusy(false); }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    void action(async () => {
      const response = await api<{ settings: AiComputerSettings }>("/api/admin/ai/computer", {
        method: "PUT", headers,
        body: JSON.stringify({
          enabled: draft.enabled, model: draft.model.trim() || "jev-latest",
          inputPointsPer1k: Number(draft.inputPointsPer1k), outputPointsPer1k: Number(draft.outputPointsPer1k),
          maxSteps: Number(draft.maxSteps), maxMinutes: Number(draft.maxMinutes), minConfidence: Number(draft.minConfidence),
          ...(key.trim() ? { apiKey: key.trim() } : {}),
        }),
      });
      setSettings(response.settings); setDraft(draftFrom(response.settings)); setKey("");
      setNotice(response.settings.enabled ? "Jev 决策服务已保存并启用。建议点“检查连接”确认密钥可用。" : "Jev 决策服务配置已保存（未启用）。");
    });
  }

  function test() {
    void action(async () => {
      const response = await api<AiComputerSettings & { message: string }>("/api/admin/ai/computer/test", { method: "POST", headers }, 30_000);
      const { message, ...next } = response;
      setSettings(next); setNotice(message);
    });
  }

  const set = (field: keyof Draft) => (value: string | boolean) => setDraft(current => current ? { ...current, [field]: value } : current);
  return <section className="tp-ai-admin-card" aria-label="Jev 决策服务">
    <header className="tp-ai-admin-heading"><div>
      <h2>Jev 决策服务（电脑操作）</h2>
      <p>同频的电脑操作执行器每一步都由 TypeSafe 的 Jev 模型在代码列出的候选动作中选择下一步。档位是否开放“电脑操作”在「服务与模型」中勾选。</p>
    </div></header>
    {!settings || !draft ? <p role="status">{notice || "读取配置中…"}</p> : <form onSubmit={save}>
      <fieldset className="tp-ai-admin-fields" disabled={busy}>
        <label className="tp-ai-admin-toggle"><input type="checkbox" checked={draft.enabled} onChange={event => set("enabled")(event.target.checked)} />启用 Jev 决策（电脑操作）</label>
        <label className="tp-ai-admin-field">TypeSafe API 密钥<input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)}
          placeholder={settings.apiKeyConfigured ? "已在服务端安全保存，留空保留" : "粘贴 TypeSafe（Jev）API 密钥"} /></label>
        <label className="tp-ai-admin-field">决策模型<input value={draft.model} list="tp-ai-jev-models" onChange={event => set("model")(event.target.value)} placeholder="jev-latest" />
          <datalist id="tp-ai-jev-models">{["jev-latest", ...settings.availableModels.filter(model => model !== "jev-latest")].map(model => <option key={model} value={model} />)}</datalist></label>
        <label className="tp-ai-admin-field">每千输入 Token · 同频点<input type="number" min="0" max="10000000" step="1" value={draft.inputPointsPer1k} onChange={event => set("inputPointsPer1k")(event.target.value)} /></label>
        <label className="tp-ai-admin-field">每千输出 Token · 同频点<input type="number" min="0" max="10000000" step="1" value={draft.outputPointsPer1k} onChange={event => set("outputPointsPer1k")(event.target.value)} /></label>
        <label className="tp-ai-admin-field">单次任务步数上限<input type="number" min="1" max={COMPUTER_AGENT_LIMITS.maxStepsCeiling} step="1" value={draft.maxSteps} onChange={event => set("maxSteps")(event.target.value)} /></label>
        <label className="tp-ai-admin-field">单次任务时长上限（分钟）<input type="number" min="1" max={COMPUTER_AGENT_LIMITS.maxMinutesCeiling} step="1" value={draft.maxMinutes} onChange={event => set("maxMinutes")(event.target.value)} /></label>
        <label className="tp-ai-admin-field">最低置信度（低于它先重读界面、再询问成员）<input type="number" min="0.3" max="0.95" step="0.05" value={draft.minConfidence} onChange={event => set("minConfidence")(event.target.value)} /></label>
      </fieldset>
      <p className="tp-ai-admin-hint">密钥只保存在服务端并加密，不会下发到客户端或写入日志。每步决策先按上限预留同频点，完成后按 Jev 报告的输入/输出 Token 和上面的折算价格结算；任务整理那一次调用按当前档位模型正常计费。</p>
      <p className="tp-ai-admin-hint">{settings.verifiedAt ? `连接已验证（${new Date(settings.verifiedAt).toLocaleString("zh-CN")}），可用模型 ${settings.availableModels.length} 个。` : settings.apiKeyConfigured ? "密钥已保存，尚未验证连接。" : "尚未配置密钥。"}</p>
      <div className="tp-ai-admin-actions">
        <button type="submit" className="tp-ai-admin-button is-primary" disabled={busy}>保存 Jev 配置</button>
        <button type="button" className="tp-ai-admin-button" disabled={busy || !settings.apiKeyConfigured || Boolean(key)} onClick={test}>检查连接</button>
      </div>
    </form>}
    {settings && notice ? <p role="status">{notice}</p> : null}
  </section>;
}
