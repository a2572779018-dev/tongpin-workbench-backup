import { Route, Save } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import {
  DEFAULT_OPENSQUILLA_ROUTING, OPENSQUILLA_ACTION_LABELS, OPENSQUILLA_ACTIONS, OPENSQUILLA_ROUTER_LABEL, OPENSQUILLA_TIER_LABELS, OPENSQUILLA_TIERS,
  type AiOpenSquillaAction, type AiOpenSquillaRoutingSettings,
} from "../../../shared/aiOpenSquilla";
import { useAuth } from "../../auth/AuthContext";
import { adminAiErrorMessage } from "./adminAiForms";

/** What each OpenSquilla tier means (router.runtime.yaml tier_explanations). */
const TIER_HINTS = {
  c0: "寒暄、确认、简单改写和简短事实",
  c1: "日常问答、写作、编辑和有边界的编程",
  c2: "排错、多步骤实现计划和技术分析",
  c3: "架构设计、跨系统权衡、高风险生产决策",
} as const;

/** The settings form itself; the card below loads and saves it. */
export function AdminAiOpenSquillaForm({ draft, busy, onChange, onSubmit }: {
  draft: AiOpenSquillaRoutingSettings;
  busy: boolean;
  onChange: (patch: Partial<AiOpenSquillaRoutingSettings>) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return <form onSubmit={onSubmit}>
    <fieldset className="tp-ai-admin-fields" disabled={busy}>
      <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.enabled} onChange={event => onChange({ enabled: event.target.checked })} />快速档使用 OpenSquilla 路由结果</label>
      <label className="tp-ai-admin-toggle is-wide"><input type="checkbox" checked={draft.applyPromptPolicy} disabled={!draft.enabled} onChange={event => onChange({ applyPromptPolicy: event.target.checked })} />简单问题按 OpenSquilla 简答策略（直接作答、缩短思考）</label>
      {OPENSQUILLA_TIERS.map(tier => <label className="tp-ai-admin-field" key={tier}>
        {OPENSQUILLA_TIER_LABELS[tier]} · {TIER_HINTS[tier]}
        <select value={draft.tiers[tier]} disabled={!draft.enabled} onChange={event => onChange({ tiers: { ...draft.tiers, [tier]: event.target.value as AiOpenSquillaAction } })}>
          {OPENSQUILLA_ACTIONS.map(action => <option key={action} value={action}>{OPENSQUILLA_ACTION_LABELS[action]}{DEFAULT_OPENSQUILLA_ROUTING.tiers[tier] === action ? "（默认）" : ""}</option>)}
        </select>
      </label>)}
      <small className="tp-ai-admin-hint is-wide">联网核实需快速档开放「自动联网」且配置搜索额度；加深推理仅对使用 Responses 协议、支持推理强度的快速模型生效；建议切换只提示成员，不会自动改用更高档位或额外扣费。不满足条件时按“直接回答”处理，并在回复过程中注明。</small>
    </fieldset>
    <div className="tp-ai-admin-actions"><button className="tp-ai-admin-button is-primary" type="submit" disabled={busy}><Save size={16} />{busy ? "保存中…" : "保存快速档路由"}</button></div>
  </form>;
}

/**
 * AI 管理 → 服务与模型：桌面端本机运行的 OpenSquilla 快速档路由。
 * 只决定快速档内的处理方式；不会让成员越过快速档已开放的能力或额度。
 */
export function AdminAiOpenSquillaSettings() {
  const { api } = useAuth(); const id = useId();
  const [draft, setDraft] = useState<AiOpenSquillaRoutingSettings | null>(null);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), busyRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    api<{ settings: AiOpenSquillaRoutingSettings }>("/api/admin/ai/opensquilla", { signal: controller.signal })
      .then(({ settings }) => { if (!controller.signal.aborted) setDraft(settings); })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(adminAiErrorMessage(caught, "OpenSquilla 路由设置读取失败，请重试。")); });
    return () => controller.abort();
  }, [api]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const { settings } = await api<{ settings: AiOpenSquillaRoutingSettings }>("/api/admin/ai/opensquilla", {
        method: "PUT", body: JSON.stringify({ enabled: draft.enabled, applyPromptPolicy: draft.applyPromptPolicy, tiers: draft.tiers }),
      });
      setDraft(settings); setNotice("OpenSquilla 路由设置已保存，下一条快速档消息生效。");
    } catch (caught) {
      setError(adminAiErrorMessage(caught, "OpenSquilla 路由设置保存失败，请重试。"));
    } finally { busyRef.current = false; setBusy(false); }
  }

  const update = (patch: Partial<AiOpenSquillaRoutingSettings>) => { setDraft(current => current ? { ...current, ...patch } : current); setNotice(""); };
  return <section className="tp-ai-admin-card" aria-labelledby={`${id}-title`} aria-busy={!draft || busy}>
    <header className="tp-ai-admin-heading"><div>
      <h2 id={`${id}-title`}><Route size={21} aria-hidden="true" />快速档路由 · {OPENSQUILLA_ROUTER_LABEL}</h2>
      <p>同频桌面端在本机运行开源 OpenSquilla 路由模型，为每条快速档消息判断 C0–C3 难度档，这里决定各档在快速档内怎么处理。网页端或旧版客户端没有本机结果时，自动沿用内置快速路由。</p>
    </div></header>
    {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
    {notice ? <p className="tp-ai-admin-success" role="status">{notice}</p> : null}
    {!draft ? (error ? null : <p className="tp-ai-admin-empty" role="status">正在读取 OpenSquilla 路由设置…</p>)
      : <AdminAiOpenSquillaForm draft={draft} busy={busy} onChange={update} onSubmit={event => void save(event)} />}
  </section>;
}
