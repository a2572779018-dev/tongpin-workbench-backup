import { AI_BUSINESS_TIER_LABELS, type AiHarnessTierRoute, type AiMode } from "../../../shared/ai";
import { AI_MULTI_AGENT_DEFAULTS, AI_MULTI_AGENT_LABEL, AI_MULTI_AGENT_LIMITS, readAiMultiAgentSettings, type AiMultiAgentSettings } from "../../../shared/aiMultiAgent";
import { AdminAiModelSelect } from "./AdminAiModelSelect";

/** Early form-side feedback; the server applies the same check on save. */
export function multiAgentSettingsError(route: Pick<AiHarnessTierRoute, "multiAgent" | "maxOutputTokens">): string {
  return route.multiAgent ? readAiMultiAgentSettings(route.multiAgent, route.maxOutputTokens).error ?? "" : "";
}

/** Settings a tier starts with when an administrator switches it to 多 Agent 协作. */
export function defaultMultiAgentSettings(tierMaxOutputTokens: number): AiMultiAgentSettings {
  const { minSubAgentOutputTokens, maxSubAgentOutputTokens } = AI_MULTI_AGENT_LIMITS;
  const cap = Math.max(minSubAgentOutputTokens, Math.min(maxSubAgentOutputTokens, tierMaxOutputTokens));
  return { maxConcurrency: AI_MULTI_AGENT_DEFAULTS.maxConcurrency, subAgentMaxOutputTokens: Math.min(AI_MULTI_AGENT_DEFAULTS.subAgentMaxOutputTokens, cap) };
}

/**
 * Per-tier 任务处理方式 inside 自动调用规则: follow the global rule above, or
 * 多 Agent 协作 (a coordinator splits the request, 2–5 sub-agents work at the
 * same time, then the coordinator combines their results).
 */
export function AdminAiMultiAgentSettings({ tier, route, models, loading, emptyMessage, onOpenModels, onChange }: {
  tier: AiMode;
  route: AiHarnessTierRoute;
  /** Verified models on this tier's own text service. */
  models: readonly string[];
  loading: boolean;
  emptyMessage: string;
  onOpenModels: () => void;
  onChange: (multiAgent: AiMultiAgentSettings | undefined) => void;
}) {
  const settings = route.multiAgent;
  const label = AI_BUSINESS_TIER_LABELS[tier];
  const { minConcurrency, maxConcurrency, maxSubtasks, minSubAgentOutputTokens, maxSubAgentOutputTokens } = AI_MULTI_AGENT_LIMITS;
  const outputCap = Math.max(minSubAgentOutputTokens, Math.min(maxSubAgentOutputTokens, route.maxOutputTokens));
  const error = multiAgentSettingsError(route);
  const update = (patch: Partial<AiMultiAgentSettings>) => {
    if (!settings) return;
    const next: AiMultiAgentSettings = { ...settings, ...patch };
    if (!next.subAgentModelId) delete next.subAgentModelId;
    onChange(next);
  };
  return <>
    <label className="tp-ai-admin-field">{label} 档任务处理方式<select value={settings ? "multi_agent" : "policy"}
      onChange={event => onChange(event.target.value === "multi_agent" ? defaultMultiAgentSettings(route.maxOutputTokens) : undefined)}>
      <option value="policy">按上方规则</option><option value="multi_agent">{AI_MULTI_AGENT_LABEL}</option>
    </select></label>
    {settings ? <>
      <label className="tp-ai-admin-field">最多并行子 Agent<input type="number" min={minConcurrency} max={maxConcurrency} step={1} required value={settings.maxConcurrency}
        onChange={event => update({ maxConcurrency: Number(event.target.value) })} /></label>
      <AdminAiModelSelect key={`${tier}-subagent-${route.providerId}`} label="子 Agent 模型" value={settings.subAgentModelId ?? ""} placeholder="与本档位文字模型相同"
        models={models} loading={loading} emptyMessage={emptyMessage} onOpen={onOpenModels} onChange={subAgentModelId => update({ subAgentModelId })} />
      <label className="tp-ai-admin-field">每个子 Agent 输出上限 · Token<input type="number" min={minSubAgentOutputTokens} max={outputCap} step={1} required value={settings.subAgentMaxOutputTokens}
        onChange={event => update({ subAgentMaxOutputTokens: Number(event.target.value) })} /></label>
      <div className="is-wide tp-ai-admin-actions">
        <small className="tp-ai-admin-hint">协调 Agent 先判断是否需要拆分（简单问题直接回答），最多拆成 {maxSubtasks} 个子任务，按并行数同时处理后再综合成一条回答。发送前按「协调 + {maxSubtasks} 个子 Agent + 综合」的最坏情况预留额度，结束后按实际用量结算；余额不够时本次自动改为单个 Agent 回答。子 Agent 模型只使用本档位文字服务里已验证的模型。图片、视频、PPT、电脑操作等工具步骤仍按上方规则执行。</small>
        {settings.subAgentModelId ? <button className="tp-ai-admin-button" type="button" onClick={() => update({ subAgentModelId: undefined })}>改用本档位文字模型</button> : null}
      </div>
      {error ? <p className="tp-ai-admin-error is-wide" role="alert">{error}</p> : null}
    </> : null}
  </>;
}
