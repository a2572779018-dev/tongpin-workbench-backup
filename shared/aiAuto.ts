/** Tongpin's local agent-router identifier; never send it to the provider. */
export const TONGPIN_QUICK_AGENT = "tongpin-agent";
/** Read-only migration support for installations configured before v0.1.47. */
export const LEGACY_BAI_QUICK_AUTO = "tongpin-auto";
/** @deprecated Use TONGPIN_QUICK_AGENT. Kept so older imports do not become a provider model ID. */
export const BAI_QUICK_AUTO = TONGPIN_QUICK_AGENT;
export const BAI_QUICK_MODELS = ["qwen3.8-flash", "hy3", "mimo-v2.5"] as const;
export const BAI_ASTRA_MODEL = "gpt-6-astra" as const;
/** Deployment-owned allowlist. Provider discovery can only remove entries from it. */
export const BAI_AGENT_MODELS = [...BAI_QUICK_MODELS, BAI_ASTRA_MODEL] as const;
export type BaiQuickModel = typeof BAI_QUICK_MODELS[number];
export type BaiAgentModel = typeof BAI_AGENT_MODELS[number];
export function isTongpinQuickAgent(value: unknown): value is typeof TONGPIN_QUICK_AGENT | typeof LEGACY_BAI_QUICK_AUTO {
  return value === TONGPIN_QUICK_AGENT || value === LEGACY_BAI_QUICK_AUTO;
}

export function filterBaiAgentModels(values: Iterable<string>): BaiAgentModel[] {
  const listed = new Set(values);
  return BAI_AGENT_MODELS.filter(model => listed.has(model));
}
