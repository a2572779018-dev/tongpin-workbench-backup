import { AI_BUSINESS_TIER_LABELS, AI_BUSINESS_TIERS, type AiChatRequest, type AiHarnessConfig, type AiMode, type AiProviderConfig } from "../../shared/ai";
import { BAI_QUICK_MODELS, isTongpinQuickAgent } from "../../shared/aiAuto";
import {
  DEFAULT_OPENSQUILLA_ROUTING, isOpenSquillaBusinessTier, OPENSQUILLA_ACTIONS, OPENSQUILLA_ROUTER_LABEL, OPENSQUILLA_TIER_LABELS, OPENSQUILLA_TIERS,
  openSquillaTierRouting, parseOpenSquillaRouteDecision,
  type AiOpenSquillaAction, type AiOpenSquillaBusinessTier, type AiOpenSquillaPlan, type AiOpenSquillaRoutingSettings, type AiOpenSquillaTier, type AiOpenSquillaTierRouting,
} from "../../shared/aiOpenSquilla";
import type { ResolvedHarnessRoute } from "./harness";
import { AiError } from "./security";
import type { AiStore } from "./storage";
import { tenantStorageKey } from "./tenant";

/*
 * Maps a desktop OpenSquilla decision onto Tongpin's quick or standard tier.
 * The client only proposes; everything here is recomputed from server-side
 * settings and the resolved route, so a modified client can at most choose
 * among behaviours the administrator already allowed for that tier.
 */

const SETTINGS_ID = "opensquilla-routing";

// router.runtime.yaml prompt_policies.P0 (OpenSquilla v4.2), localized as
// controller.select_localized_prompt_hint does.
const P0_HINT_ZH = "直接作答，缩短思考长度，避免无关展开。";
const P0_HINT_EN = "Answer directly, keep thinking short, avoid irrelevant expansion.";
// controller._THINKING_MODE_LEVEL
const THINKING_LEVEL = { T0: undefined, T1: "low", T2: "medium", T3: "high" } as const;
const EFFORT_LABEL = { low: "低", medium: "中", high: "高" } as const;
// OpenSquilla tier semantics → the Tongpin tier worth suggesting first, per routed tier.
const SUGGEST_TARGET: Record<AiOpenSquillaBusinessTier, Record<AiOpenSquillaTier, "standard" | "deep" | "pro" | null>> = {
  quick: { c0: null, c1: null, c2: "standard", c3: "deep" },
  standard: { c0: null, c1: null, c2: "deep", c3: "pro" },
};
// router.runtime.yaml tier_registry: S = fast flash model, M = general default,
// L/XL = reasoning tiers. Applied to the legacy B.AI quick Agent pool.
const QUICK_MODEL_ORDER: Record<AiOpenSquillaTier, readonly string[]> = {
  c0: ["qwen3.8-flash", "hy3", "mimo-v2.5"],
  c1: ["hy3", "qwen3.8-flash", "mimo-v2.5"],
  c2: ["mimo-v2.5", "qwen3.8-flash", "hy3"],
  c3: ["mimo-v2.5", "qwen3.8-flash", "hy3"],
};

function settingsKey(store: AiStore): string { return tenantStorageKey(store.tenantId, SETTINGS_ID); }

const fail = (message: string): never => { throw new AiError(400, "AI_OPENSQUILLA_SETTINGS_INVALID", message); };
const TIER_LABEL: Record<AiOpenSquillaBusinessTier, string> = { quick: "快速档", standard: "标准档" };

function copyTierRouting(value: AiOpenSquillaTierRouting): AiOpenSquillaTierRouting {
  return { enabled: value.enabled, applyPromptPolicy: value.applyPromptPolicy, tiers: { ...value.tiers } };
}

/** One tier's mapping; `fallback` fills what a lenient read finds missing. */
function normalizeTierRouting(value: unknown, strict: boolean, fallback: AiOpenSquillaTierRouting, label: string, extraKeys: readonly string[] = []): AiOpenSquillaTierRouting {
  if (!value || typeof value !== "object" || Array.isArray(value)) return strict ? fail(`${label}的 OpenSquilla 路由设置格式不正确`) : copyTierRouting(fallback);
  const source = value as Record<string, unknown>;
  if (strict && Object.keys(source).some(key => !["enabled", "applyPromptPolicy", "tiers", ...extraKeys].includes(key))) fail("OpenSquilla 路由设置包含不支持的字段");
  const tiersSource = source.tiers && typeof source.tiers === "object" && !Array.isArray(source.tiers) ? source.tiers as Record<string, unknown> : {};
  if (strict && Object.keys(tiersSource).some(key => !(OPENSQUILLA_TIERS as readonly string[]).includes(key))) fail("OpenSquilla 档位不正确");
  const tiers = {} as Record<AiOpenSquillaTier, AiOpenSquillaAction>;
  for (const tier of OPENSQUILLA_TIERS) {
    const action = tiersSource[tier];
    if ((OPENSQUILLA_ACTIONS as readonly unknown[]).includes(action)) tiers[tier] = action as AiOpenSquillaAction;
    else if (strict) fail(`请为${label}的 ${OPENSQUILLA_TIER_LABELS[tier]} 选择处理方式`);
    else tiers[tier] = fallback.tiers[tier];
  }
  const flag = (key: "enabled" | "applyPromptPolicy") => {
    if (typeof source[key] === "boolean") return source[key] as boolean;
    return strict ? fail("OpenSquilla 开关格式不正确") : fallback[key];
  };
  return { enabled: flag("enabled"), applyPromptPolicy: flag("applyPromptPolicy"), tiers };
}

/** The top level is the quick mapping (its pre-0.1.50 shape). A save that
 * omits `standard` (an older admin client) keeps the stored standard mapping. */
function normalizeSettings(value: unknown, strict: boolean, previous?: AiOpenSquillaRoutingSettings): AiOpenSquillaRoutingSettings {
  const quick = normalizeTierRouting(value, strict, DEFAULT_OPENSQUILLA_ROUTING, TIER_LABEL.quick, ["standard", "updatedAt"]);
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const standard = source.standard === undefined
    ? copyTierRouting(previous?.standard ?? DEFAULT_OPENSQUILLA_ROUTING.standard)
    : normalizeTierRouting(source.standard, strict, DEFAULT_OPENSQUILLA_ROUTING.standard, TIER_LABEL.standard);
  return { ...quick, standard, updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null };
}

export function readOpenSquillaRouting(store: AiStore): AiOpenSquillaRoutingSettings {
  const row = store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=? AND tenant_id=?", settingsKey(store), store.tenantId)[0];
  if (!row) return normalizeSettings(undefined, false);
  try { return normalizeSettings(JSON.parse(row.data), false); } catch { return normalizeSettings(undefined, false); }
}

export function saveOpenSquillaRouting(store: AiStore, value: unknown): AiOpenSquillaRoutingSettings {
  const settings = { ...normalizeSettings(value, true, readOpenSquillaRouting(store)), updatedAt: new Date().toISOString() };
  store.sql.exec("INSERT INTO ai_settings(id,tenant_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET tenant_id=excluded.tenant_id,data=excluded.data", settingsKey(store), store.tenantId, JSON.stringify(settings));
  return settings;
}

/** controller.prompt_hint_locale: Chinese when the text has two or more CJK characters. */
export function openSquillaHintLocale(text: string): "zh" | "en" {
  let cjk = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0xf900 && cp <= 0xfaff)) cjk += 1;
    if (cjk >= 2) return "zh";
  }
  return "en";
}

export interface OpenSquillaPlanContext {
  route: Pick<ResolvedHarnessRoute, "capabilities" | "protocol" | "legacy">;
  provider: Pick<AiProviderConfig, "protocol" | "quickModel" | "webSearchEnabled" | "webSearchQuotaTokens">;
  harness: AiHarnessConfig | null;
  settings: AiOpenSquillaRoutingSettings;
  /** Legacy B.AI quick Agent only: Astra is verified, so a search turn can escalate. */
  quickAgentSearch?: boolean;
}

/** The first enabled tier above `current`, starting at OpenSquilla's target and
 * then trying the other higher tiers (further up first, then back down). */
function suggestionFor(current: AiOpenSquillaBusinessTier, tier: AiOpenSquillaTier, harness: AiHarnessConfig | null): "standard" | "deep" | "pro" | undefined {
  const target = SUGGEST_TARGET[current][tier];
  if (!target) return undefined;
  const enabled = (mode: AiMode) => harness ? Boolean(harness.tiers[mode]?.enabled) : mode === "deep";
  const above = AI_BUSINESS_TIERS.slice(AI_BUSINESS_TIERS.indexOf(current) + 1);
  const from = Math.max(0, above.indexOf(target));
  const ordered = [...above.slice(from), ...above.slice(0, from).reverse()];
  return ordered.find(mode => enabled(mode)) as "standard" | "deep" | "pro" | undefined;
}

/**
 * Plans one quick- or standard-tier turn with that tier's mapping. Returns
 * undefined for every other tier. The returned plan is also stored on the
 * request (`openSquillaPlan`) for the harness route step, the instructions
 * and the provider body.
 */
export function planOpenSquillaRoute(request: AiChatRequest, context: OpenSquillaPlanContext): AiOpenSquillaPlan | undefined {
  const mode = request.mode;
  if (!isOpenSquillaBusinessTier(mode)) return undefined;
  const ordinary = !request.outputFormat || request.outputFormat === "text" || request.outputFormat === "dispatch";
  if (!ordinary) return undefined;
  const routing = openSquillaTierRouting(context.settings, mode);
  const tierLabel = TIER_LABEL[mode];
  // Re-validated here too: direct callers may bypass the HTTP request parser.
  const decision = request.openSquillaRoute ? parseOpenSquillaRouteDecision(request.openSquillaRoute) : null;
  let plan: AiOpenSquillaPlan;
  if (!routing.enabled) plan = { source: "builtin", fallback: "disabled" };
  else if (request.openSquillaRoute === undefined) plan = { source: "builtin", fallback: "missing" };
  else if (!decision) plan = { source: "builtin", fallback: "invalid" };
  else {
    const action = routing.tiers[decision.tier];
    // The legacy B.AI quick Agent pool exists only on the quick tier.
    const quickAgent = mode === "quick" && context.route.legacy && isTongpinQuickAgent(context.provider.quickModel);
    let applied: AiOpenSquillaAction = action;
    let clampNote: string | undefined;
    let reasoningEffort: AiOpenSquillaPlan["reasoningEffort"];
    let suggestTier: AiOpenSquillaPlan["suggestTier"];
    if (action === "search") {
      const searchable = context.provider.webSearchEnabled && Boolean(context.provider.webSearchQuotaTokens)
        && (quickAgent ? context.quickAgentSearch === true : context.provider.protocol === "responses" && (context.route.legacy || context.route.capabilities.includes("web_search")));
      const memberSearch = request.webSearch === true && request.webSearchMode !== "auto";
      // Search the member explicitly asked for is checked by the service as before.
      if (!memberSearch && request.webSearchMode !== "auto") { applied = "direct"; clampNote = "本轮未开启自动联网，已直接回答"; }
      else if (!memberSearch && !searchable) { applied = "direct"; clampNote = `${tierLabel}未开放联网核实，已直接回答`; }
    } else if (action === "reasoning") {
      reasoningEffort = THINKING_LEVEL[decision.thinkingMode];
      if (!reasoningEffort || quickAgent || context.provider.protocol !== "responses") {
        applied = "direct"; reasoningEffort = undefined;
        clampNote = THINKING_LEVEL[decision.thinkingMode] ? `当前${AI_BUSINESS_TIER_LABELS[mode]}模型不支持调节推理强度，已直接回答` : "本轮无需加深推理，已直接回答";
      }
    } else if (action === "suggest_upgrade") {
      if (decision.gates.includes("anti_downgrade")) { applied = "direct"; clampNote = "沿用上一轮档位"; }
      else {
        suggestTier = suggestionFor(mode, decision.tier, context.harness);
        if (!suggestTier) { applied = "direct"; clampNote = "暂无更高的可用档位，已直接回答"; }
      }
    }
    const promptHint = routing.applyPromptPolicy && decision.promptPolicy === "P0"
      ? (openSquillaHintLocale(request.messages.at(-1)?.content ?? "") === "zh" ? P0_HINT_ZH : P0_HINT_EN)
      : undefined;
    plan = {
      source: "opensquilla", decision, action, applied,
      ...(clampNote ? { clampNote } : {}),
      ...(promptHint ? { promptHint } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(suggestTier ? { suggestTier } : {}),
      ...(quickAgent ? { quickModels: QUICK_MODEL_ORDER[decision.tier].filter(model => (BAI_QUICK_MODELS as readonly string[]).includes(model)) } : {}),
    };
    if (applied === "search") request.webSearch = true;
  }
  request.openSquillaPlan = plan;
  return plan;
}

/** Instruction line for OpenSquilla's P0 response policy. */
export function openSquillaInstruction(request: AiChatRequest): string {
  const hint = request.openSquillaPlan?.promptHint;
  return hint ? `本轮回答策略（OpenSquilla 路由）：${hint}` : "";
}

/** Responses `reasoning.effort` for a quick or standard turn the plan escalated. */
export function openSquillaReasoningEffort(request: AiChatRequest): "low" | "medium" | "high" | undefined {
  return isOpenSquillaBusinessTier(request.mode) && request.openSquillaPlan?.applied === "reasoning" ? request.openSquillaPlan.reasoningEffort : undefined;
}

const FALLBACK_TEXT = (tierLabel: string) => ({
  missing: "未收到本机 OpenSquilla 路由结果（网页端、旧版客户端或本机路由未就绪），已按内置规则处理。",
  invalid: "本机 OpenSquilla 路由结果未通过服务端校验，已按内置规则处理。",
  disabled: `管理员已关闭 OpenSquilla ${tierLabel}路由，已按内置规则处理。`,
}) as const;

/**
 * Route step for a quick- or standard-tier turn. An OpenSquilla decision
 * becomes the member-visible "路由：OpenSquilla v4.2 → …" line of the reply
 * process. A built-in fallback keeps the usual (hidden) tier step and only
 * records why, so web answers do not gain process chrome.
 */
export function openSquillaRouteStep(request: AiChatRequest): { title: string; summary: string } | undefined {
  const plan = request.openSquillaPlan;
  if (!plan || !isOpenSquillaBusinessTier(request.mode)) return undefined;
  const tier = AI_BUSINESS_TIER_LABELS[request.mode];
  if (plan.source === "builtin" || !plan.decision) return { title: `${tier}档位`, summary: FALLBACK_TEXT(TIER_LABEL[request.mode])[plan.fallback ?? "missing"] };
  const decision = plan.decision;
  const parts: string[] = [];
  switch (plan.applied) {
    // The budget check may still drop an automatic search when search quota is short.
    case "search": parts.push(request.webSearch ? `${tier}档按需联网核实` : "联网额度不足，已直接回答"); break;
    case "reasoning": parts.push(`${tier}模型加深推理（${EFFORT_LABEL[plan.reasoningEffort ?? "medium"]}）`); break;
    case "suggest_upgrade": parts.push(`${tier}模型先回答，建议切换到${AI_BUSINESS_TIER_LABELS[plan.suggestTier ?? "standard"]}档`); break;
    default: parts.push(plan.promptHint ? `${tier}模型直接简答` : `${tier}模型直接回答`);
  }
  if (plan.clampNote && plan.clampNote !== "沿用上一轮档位") parts.push(plan.clampNote);
  if (decision.gates.includes("anti_downgrade")) parts.push("沿用上一轮档位");
  // OpenSquilla matches complaint and redo words as substrings of short messages
  // (policy.py detect_complaint), so the note states the match, not a verdict.
  if (decision.gates.includes("complaint_upgrade")) parts.push("命中不满或重做用语，提升一档");
  if (decision.gates.includes("confidence_gate")) parts.push("模型把握不足，按默认档位处理");
  parts.push(`${decision.routeClass} · 置信 ${Math.round(decision.confidence * 100)}%`);
  return { title: `路由：${OPENSQUILLA_ROUTER_LABEL} → ${OPENSQUILLA_TIER_LABELS[decision.tier]}`, summary: parts.join(" · ") };
}
