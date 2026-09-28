/**
 * Contract between the desktop OpenSquilla router (Electron worker), the
 * renderer and the AI service. The desktop client runs OpenSquilla's V4.2
 * Phase 3 router locally and attaches only this bounded decision to a
 * quick- or standard-tier chat request; the server re-validates it, maps it
 * to the behaviour the administrator chose for that tier and clamps it to
 * what the tier allows.
 */

export const OPENSQUILLA_ROUTER_VERSION = "v4.2-phase3" as const;
export const OPENSQUILLA_ROUTER_LABEL = "OpenSquilla v4.2";
export const OPENSQUILLA_TIERS = ["c0", "c1", "c2", "c3"] as const;
export type AiOpenSquillaTier = typeof OPENSQUILLA_TIERS[number];
/** OpenSquilla's own tier names (router_tiers.py / WebUI zh-Hans). */
export const OPENSQUILLA_TIER_LABELS: Record<AiOpenSquillaTier, string> = {
  c0: "C0 快速/简单",
  c1: "C1 均衡",
  c2: "C2 强推理",
  c3: "C3 最高质量",
};
export const OPENSQUILLA_ROUTE_CLASSES = ["R0", "R1", "R2", "R3"] as const;
export const OPENSQUILLA_THINKING_MODES = ["T0", "T1", "T2", "T3"] as const;
export const OPENSQUILLA_PROMPT_POLICIES = ["P0", "P1", "P2"] as const;
export const OPENSQUILLA_FLAGS = ["high_risk", "long_context", "debug", "repo_arch", "strict_format"] as const;
export const OPENSQUILLA_GATES = ["confidence_gate", "complaint_upgrade", "anti_downgrade"] as const;
export type AiOpenSquillaFlag = typeof OPENSQUILLA_FLAGS[number];
export type AiOpenSquillaGate = typeof OPENSQUILLA_GATES[number];

export interface AiOpenSquillaRouteDecision {
  router: "opensquilla";
  version: typeof OPENSQUILLA_ROUTER_VERSION;
  /** First 12 hex chars of the converted bundle manifest's sha256. */
  bundle: string;
  /** V4.2 post-processed route class before the gateway policy. */
  routeClass: typeof OPENSQUILLA_ROUTE_CLASSES[number];
  /** OpenSquilla's final tier after its gateway routing policy. */
  tier: AiOpenSquillaTier;
  /** Fused R0..R3 probabilities (rounded). */
  probabilities: [number, number, number, number];
  confidence: number;
  margin: number;
  difficulty: number;
  thinkingMode: typeof OPENSQUILLA_THINKING_MODES[number];
  promptPolicy: typeof OPENSQUILLA_PROMPT_POLICIES[number];
  flags: AiOpenSquillaFlag[];
  gates: AiOpenSquillaGate[];
  latencyMs: number;
}

/** Renderer → desktop router request, already bounded like OpenSquilla's runtime context. */
export interface AiOpenSquillaRouteInput {
  conversationId: string;
  message: string;
  historyUserTexts: string[];
  prevAssistantText: string | null;
  prevAssistantOutputTokens: number | null;
}

export const OPENSQUILLA_INPUT_LIMITS = Object.freeze({
  conversationId: 128,
  /** AI_CHAT_CONTEXT_LIMITS.requestMessageCharacters: the server rejects longer turns anyway. */
  messageCharacters: 24_000,
  historyTurns: 4,
  /** OpenSquilla runtime.py _ROUTER_HISTORY_USER_MAX_CHARS / _ROUTER_PREV_ASSISTANT_MAX_CHARS (code points). */
  contextCharacters: 8000,
  outputTokens: 10_000_000,
});

const KEYS = ["router", "version", "bundle", "routeClass", "tier", "probabilities", "confidence", "margin", "difficulty", "thinkingMode", "promptPolicy", "flags", "gates", "latencyMs"] as const;
const BUNDLE = /^[0-9a-f]{12}$/;

function unit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
function enumValue<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
function enumList<T extends string>(values: readonly T[], value: unknown): value is T[] {
  return Array.isArray(value) && value.length <= values.length && new Set(value).size === value.length && value.every(item => enumValue(values, item));
}

/**
 * Strict read of a client-supplied decision. Returns null for anything that
 * is not exactly this contract; the server then treats the turn as having no
 * OpenSquilla decision (built-in routing), never as a partially trusted one.
 */
export function parseOpenSquillaRouteDecision(value: unknown): AiOpenSquillaRouteDecision | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== KEYS.length || !KEYS.every(key => Object.hasOwn(source, key))) return null;
  if (source.router !== "opensquilla" || source.version !== OPENSQUILLA_ROUTER_VERSION) return null;
  if (typeof source.bundle !== "string" || !BUNDLE.test(source.bundle)) return null;
  if (!enumValue(OPENSQUILLA_ROUTE_CLASSES, source.routeClass) || !enumValue(OPENSQUILLA_TIERS, source.tier)) return null;
  const probabilities = source.probabilities;
  if (!Array.isArray(probabilities) || probabilities.length !== 4 || !probabilities.every(unit)) return null;
  const total = (probabilities as number[]).reduce((sum, item) => sum + item, 0);
  if (Math.abs(total - 1) > 0.01) return null;
  if (!unit(source.confidence) || !unit(source.margin)) return null;
  if (typeof source.difficulty !== "number" || !Number.isFinite(source.difficulty) || source.difficulty < 0 || source.difficulty > 3) return null;
  if (!enumValue(OPENSQUILLA_THINKING_MODES, source.thinkingMode) || !enumValue(OPENSQUILLA_PROMPT_POLICIES, source.promptPolicy)) return null;
  if (!enumList(OPENSQUILLA_FLAGS, source.flags) || !enumList(OPENSQUILLA_GATES, source.gates)) return null;
  if (!Number.isSafeInteger(source.latencyMs) || Number(source.latencyMs) < 0 || Number(source.latencyMs) > 600_000) return null;
  // The confidence is the fused probability of the reported route class.
  const routeIndex = OPENSQUILLA_ROUTE_CLASSES.indexOf(source.routeClass);
  if (Math.abs((probabilities as number[])[routeIndex] - source.confidence) > 1e-3) return null;
  return {
    router: "opensquilla",
    version: OPENSQUILLA_ROUTER_VERSION,
    bundle: source.bundle,
    routeClass: source.routeClass,
    tier: source.tier,
    probabilities: [...probabilities] as [number, number, number, number],
    confidence: source.confidence,
    margin: source.margin,
    difficulty: source.difficulty,
    thinkingMode: source.thinkingMode,
    promptPolicy: source.promptPolicy,
    flags: [...source.flags],
    gates: [...source.gates],
    latencyMs: Number(source.latencyMs),
  };
}

// ---------------------------------------------------------------------------
// Admin mapping (AI 管理 → 服务与模型 → OpenSquilla 路由, 快速档与标准档)
// ---------------------------------------------------------------------------

/** Business tiers OpenSquilla routes; each has its own C0–C3 mapping. */
export const OPENSQUILLA_BUSINESS_TIERS = ["quick", "standard"] as const;
export type AiOpenSquillaBusinessTier = typeof OPENSQUILLA_BUSINESS_TIERS[number];
export function isOpenSquillaBusinessTier(mode: unknown): mode is AiOpenSquillaBusinessTier {
  return mode === "quick" || mode === "standard";
}

export const OPENSQUILLA_ACTIONS = ["direct", "search", "reasoning", "suggest_upgrade"] as const;
export type AiOpenSquillaAction = typeof OPENSQUILLA_ACTIONS[number];
/** Tier-neutral: the same action runs on the model of the tier being routed. */
export const OPENSQUILLA_ACTION_LABELS: Record<AiOpenSquillaAction, string> = {
  direct: "直接回答",
  search: "按需联网核实",
  reasoning: "加深推理",
  suggest_upgrade: "先回答，建议切换更高档位",
};

export interface AiOpenSquillaTierRouting {
  /** Use desktop OpenSquilla decisions for this tier's turns. */
  enabled: boolean;
  /** Apply OpenSquilla's P0 "answer directly" response policy. */
  applyPromptPolicy: boolean;
  tiers: Record<AiOpenSquillaTier, AiOpenSquillaAction>;
}

/** The top-level fields are the 快速档 mapping (as saved before 0.1.50);
 * `standard` is the 标准档 mapping. */
export interface AiOpenSquillaRoutingSettings extends AiOpenSquillaTierRouting {
  standard: AiOpenSquillaTierRouting;
  updatedAt: string | null;
}

/** Defaults follow OpenSquilla's tier semantics (router.runtime.yaml
 * tier_explanations): C0/C1 are direct-answer tiers; C2/C3 are reasoning /
 * highest-quality tiers. The quick model should not silently stand in for
 * them; the standard model reasons harder on C2 and suggests a higher tier on C3. */
export const DEFAULT_OPENSQUILLA_ROUTING: AiOpenSquillaRoutingSettings = Object.freeze({
  enabled: true,
  applyPromptPolicy: true,
  tiers: Object.freeze({ c0: "direct", c1: "direct", c2: "suggest_upgrade", c3: "suggest_upgrade" }) as Record<AiOpenSquillaTier, AiOpenSquillaAction>,
  standard: Object.freeze({
    enabled: true,
    applyPromptPolicy: true,
    tiers: Object.freeze({ c0: "direct", c1: "direct", c2: "reasoning", c3: "suggest_upgrade" }) as Record<AiOpenSquillaTier, AiOpenSquillaAction>,
  }) as AiOpenSquillaTierRouting,
  updatedAt: null,
}) as AiOpenSquillaRoutingSettings;

/** The mapping of one routed tier. */
export function openSquillaTierRouting(settings: AiOpenSquillaRoutingSettings, tier: AiOpenSquillaBusinessTier): AiOpenSquillaTierRouting {
  return tier === "quick" ? { enabled: settings.enabled, applyPromptPolicy: settings.applyPromptPolicy, tiers: settings.tiers } : settings.standard;
}

/** Server-owned result of mapping one decision; never read from a client body. */
export interface AiOpenSquillaPlan {
  source: "opensquilla" | "builtin";
  /** Why the built-in routing was used. */
  fallback?: "missing" | "invalid" | "disabled";
  decision?: AiOpenSquillaRouteDecision;
  /** Admin-mapped action for the decision's tier. */
  action?: AiOpenSquillaAction;
  /** What was actually applied after clamping to the routed tier's capabilities. */
  applied?: AiOpenSquillaAction;
  /** Why `applied` differs from `action`, in member-facing Chinese. */
  clampNote?: string;
  /** OpenSquilla P0 response policy text added to the instructions. */
  promptHint?: string;
  /** Reasoning effort for a `reasoning` turn on a Responses route. */
  reasoningEffort?: "low" | "medium" | "high";
  /** Business tier suggested to the member for this turn. */
  suggestTier?: "standard" | "deep" | "pro";
  /** Quick-model preference for the legacy B.AI quick Agent pool. */
  quickModels?: string[];
}
