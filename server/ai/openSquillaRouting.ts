import { AI_BUSINESS_TIER_LABELS, AI_BUSINESS_TIERS, type AiChatRequest, type AiHarnessConfig, type AiMode, type AiProviderConfig } from "../../shared/ai";
import { BAI_QUICK_MODELS, isTongpinQuickAgent } from "../../shared/aiAuto";
import {
  DEFAULT_OPENSQUILLA_ROUTING, OPENSQUILLA_ACTIONS, OPENSQUILLA_ROUTER_LABEL, OPENSQUILLA_TIER_LABELS, OPENSQUILLA_TIERS,
  parseOpenSquillaRouteDecision,
  type AiOpenSquillaAction, type AiOpenSquillaPlan, type AiOpenSquillaRoutingSettings, type AiOpenSquillaTier,
} from "../../shared/aiOpenSquilla";
import type { ResolvedHarnessRoute } from "./harness";
import { AiError } from "./security";
import type { AiStore } from "./storage";
import { tenantStorageKey } from "./tenant";

/*
 * Maps a desktop OpenSquilla decision onto Tongpin's quick tier. The client
 * only proposes; everything here is recomputed from server-side settings and
 * the resolved quick route, so a modified client can at most choose among
 * behaviours the administrator already allowed for the quick tier.
 */

const SETTINGS_ID = "opensquilla-routing";

// router.runtime.yaml prompt_policies.P0 (OpenSquilla v4.2), localized as
// controller.select_localized_prompt_hint does.
const P0_HINT_ZH = "直接作答，缩短思考长度，避免无关展开。";
const P0_HINT_EN = "Answer directly, keep thinking short, avoid irrelevant expansion.";
// controller._THINKING_MODE_LEVEL
const THINKING_LEVEL = { T0: undefined, T1: "low", T2: "medium", T3: "high" } as const;
const EFFORT_LABEL = { low: "低", medium: "中", high: "高" } as const;
// OpenSquilla tier semantics → the Tongpin tier worth suggesting first.
const SUGGEST_TARGET: Record<AiOpenSquillaTier, "standard" | "deep" | null> = { c0: null, c1: null, c2: "standard", c3: "deep" };
// router.runtime.yaml tier_registry: S = fast flash model, M = general default,
// L/XL = reasoning tiers. Applied to the legacy B.AI quick Agent pool.
const QUICK_MODEL_ORDER: Record<AiOpenSquillaTier, readonly string[]> = {
  c0: ["qwen3.8-flash", "hy3", "mimo-v2.5"],
  c1: ["hy3", "qwen3.8-flash", "mimo-v2.5"],
  c2: ["mimo-v2.5", "qwen3.8-flash", "hy3"],
  c3: ["mimo-v2.5", "qwen3.8-flash", "hy3"],
};

function settingsKey(store: AiStore): string { return tenantStorageKey(store.tenantId, SETTINGS_ID); }

function normalizeSettings(value: unknown, strict: boolean): AiOpenSquillaRoutingSettings {
  const fail = (message: string): never => { throw new AiError(400, "AI_OPENSQUILLA_SETTINGS_INVALID", message); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return strict ? fail("OpenSquilla 路由设置格式不正确") : { ...DEFAULT_OPENSQUILLA_ROUTING, tiers: { ...DEFAULT_OPENSQUILLA_ROUTING.tiers } };
  const source = value as Record<string, unknown>;
  if (strict && Object.keys(source).some(key => !["enabled", "applyPromptPolicy", "tiers", "updatedAt"].includes(key))) fail("OpenSquilla 路由设置包含不支持的字段");
  const tiersSource = source.tiers && typeof source.tiers === "object" && !Array.isArray(source.tiers) ? source.tiers as Record<string, unknown> : {};
  if (strict && Object.keys(tiersSource).some(key => !(OPENSQUILLA_TIERS as readonly string[]).includes(key))) fail("OpenSquilla 档位不正确");
  const tiers = {} as Record<AiOpenSquillaTier, AiOpenSquillaAction>;
  for (const tier of OPENSQUILLA_TIERS) {
    const action = tiersSource[tier];
    if ((OPENSQUILLA_ACTIONS as readonly unknown[]).includes(action)) tiers[tier] = action as AiOpenSquillaAction;
    else if (strict) fail(`请为 ${OPENSQUILLA_TIER_LABELS[tier]} 选择处理方式`);
    else tiers[tier] = DEFAULT_OPENSQUILLA_ROUTING.tiers[tier];
  }
  const flag = (key: "enabled" | "applyPromptPolicy") => {
    if (typeof source[key] === "boolean") return source[key] as boolean;
    return strict ? fail("OpenSquilla 开关格式不正确") : DEFAULT_OPENSQUILLA_ROUTING[key];
  };
  return { enabled: flag("enabled"), applyPromptPolicy: flag("applyPromptPolicy"), tiers, updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null };
}

export function readOpenSquillaRouting(store: AiStore): AiOpenSquillaRoutingSettings {
  const row = store.sql.all<{ data: string }>("SELECT data FROM ai_settings WHERE id=? AND tenant_id=?", settingsKey(store), store.tenantId)[0];
  if (!row) return normalizeSettings(undefined, false);
  try { return normalizeSettings(JSON.parse(row.data), false); } catch { return normalizeSettings(undefined, false); }
}

export function saveOpenSquillaRouting(store: AiStore, value: unknown): AiOpenSquillaRoutingSettings {
  const settings = { ...normalizeSettings(value, true), updatedAt: new Date().toISOString() };
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

function suggestionFor(tier: AiOpenSquillaTier, harness: AiHarnessConfig | null): "standard" | "deep" | "pro" | undefined {
  const target = SUGGEST_TARGET[tier];
  if (!target) return undefined;
  const enabled = (mode: AiMode) => harness ? Boolean(harness.tiers[mode]?.enabled) : mode === "deep";
  const higher = AI_BUSINESS_TIERS.slice(AI_BUSINESS_TIERS.indexOf(target)).concat(AI_BUSINESS_TIERS.slice(1, AI_BUSINESS_TIERS.indexOf(target)).reverse());
  return higher.find(mode => mode !== "quick" && enabled(mode)) as "standard" | "deep" | "pro" | undefined;
}

/**
 * Plans one quick-tier turn. Returns undefined for every other tier. The
 * returned plan is also stored on the request (`openSquillaPlan`) for the
 * harness route step, the instructions and the provider body.
 */
export function planOpenSquillaRoute(request: AiChatRequest, context: OpenSquillaPlanContext): AiOpenSquillaPlan | undefined {
  if (request.mode !== "quick") return undefined;
  const ordinary = !request.outputFormat || request.outputFormat === "text" || request.outputFormat === "dispatch";
  if (!ordinary) return undefined;
  // Re-validated here too: direct callers may bypass the HTTP request parser.
  const decision = request.openSquillaRoute ? parseOpenSquillaRouteDecision(request.openSquillaRoute) : null;
  let plan: AiOpenSquillaPlan;
  if (!context.settings.enabled) plan = { source: "builtin", fallback: "disabled" };
  else if (request.openSquillaRoute === undefined) plan = { source: "builtin", fallback: "missing" };
  else if (!decision) plan = { source: "builtin", fallback: "invalid" };
  else {
    const action = context.settings.tiers[decision.tier];
    const quickAgent = context.route.legacy && isTongpinQuickAgent(context.provider.quickModel);
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
      else if (!memberSearch && !searchable) { applied = "direct"; clampNote = "快速档未开放联网核实，已直接回答"; }
    } else if (action === "reasoning") {
      reasoningEffort = THINKING_LEVEL[decision.thinkingMode];
      if (!reasoningEffort || quickAgent || context.provider.protocol !== "responses") {
        applied = "direct"; reasoningEffort = undefined;
        clampNote = THINKING_LEVEL[decision.thinkingMode] ? "当前快速模型不支持调节推理强度，已直接回答" : "本轮无需加深推理，已直接回答";
      }
    } else if (action === "suggest_upgrade") {
      if (decision.gates.includes("anti_downgrade")) { applied = "direct"; clampNote = "沿用上一轮档位"; }
      else {
        suggestTier = suggestionFor(decision.tier, context.harness);
        if (!suggestTier) { applied = "direct"; clampNote = "暂无更高的可用档位，已直接回答"; }
      }
    }
    const promptHint = context.settings.applyPromptPolicy && decision.promptPolicy === "P0"
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

/** Responses `reasoning.effort` for a quick turn the plan escalated. */
export function openSquillaReasoningEffort(request: AiChatRequest): "low" | "medium" | "high" | undefined {
  return request.mode === "quick" && request.openSquillaPlan?.applied === "reasoning" ? request.openSquillaPlan.reasoningEffort : undefined;
}

const FALLBACK_TEXT = {
  missing: "未收到本机 OpenSquilla 路由结果（网页端、旧版客户端或本机路由未就绪），已按内置规则处理。",
  invalid: "本机 OpenSquilla 路由结果未通过服务端校验，已按内置规则处理。",
  disabled: "管理员已关闭 OpenSquilla 快速档路由，已按内置规则处理。",
} as const;

/**
 * Route step for a quick-tier turn. An OpenSquilla decision becomes the
 * member-visible "路由：OpenSquilla v4.2 → …" line of the reply process. A
 * built-in fallback keeps the usual (hidden) tier step and only records why,
 * so web answers do not gain process chrome.
 */
export function openSquillaRouteStep(request: AiChatRequest): { title: string; summary: string } | undefined {
  const plan = request.openSquillaPlan;
  if (!plan) return undefined;
  if (plan.source === "builtin" || !plan.decision) return { title: `${AI_BUSINESS_TIER_LABELS.quick}档位`, summary: FALLBACK_TEXT[plan.fallback ?? "missing"] };
  const decision = plan.decision;
  const parts: string[] = [];
  switch (plan.applied) {
    // The budget check may still drop an automatic search when search quota is short.
    case "search": parts.push(request.webSearch ? "快速档按需联网核实" : "联网额度不足，已直接回答"); break;
    case "reasoning": parts.push(`快速模型加深推理（${EFFORT_LABEL[plan.reasoningEffort ?? "medium"]}）`); break;
    case "suggest_upgrade": parts.push(`快速模型先回答，建议切换到${AI_BUSINESS_TIER_LABELS[plan.suggestTier ?? "standard"]}档`); break;
    default: parts.push(plan.promptHint ? "快速模型直接简答" : "快速模型直接回答");
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
