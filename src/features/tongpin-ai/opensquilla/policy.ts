// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import { computeFlags, ROUTE_CLASSES, ROUTE_INDEX, type ContextMetadata, type FlagRulesConfig, type PrevRouteDecision, type RouteClass, type RoutingFlags } from "./features";
import { codePoints, pyLen, pyLower, pyStrip } from "./pyText";

/*
 * Decision rules of OpenSquilla's V4.2 router, ported line by line:
 * `runtime_src/src/router/inference/postprocess.py` + `predictor.py`
 * (margin upgrade, aux downgrade, R1 rescue, under-routing safety, flag and
 * context overrides, sticky tier, thinking mode / prompt policy, trivial
 * acknowledgements) and the gateway's post-classifier policy in
 * `src/opensquilla/engine/routing/policy.py` (confidence gate, complaint
 * upgrade, KV-cache anti-downgrade, controller reconciliation). Thresholds
 * come from the bundled `router.runtime.yaml` and gateway defaults.
 */

export type TextTier = "c0" | "c1" | "c2" | "c3";
export type ThinkingMode = "T0" | "T1" | "T2" | "T3";
export type PromptPolicy = "P0" | "P1" | "P2";
export const TEXT_TIERS: readonly TextTier[] = ["c0", "c1", "c2", "c3"];
const ROUTE_TO_TIER: Record<RouteClass, TextTier> = { R0: "c0", R1: "c1", R2: "c2", R3: "c3" };
const TIER_TO_ROUTE: Record<TextTier, RouteClass> = { c0: "R0", c1: "R1", c2: "R2", c3: "R3" };

export interface RuntimeConfig {
  thresholds?: { margin_upgrade?: number; under_routing_safety?: number; kv_cache_aware?: boolean; r1_rescue?: { from_r0_max_gap?: number } };
  flag_rules?: FlagRulesConfig;
  thinking_mode_rules?: {
    T0?: { max_class?: string; min_margin?: number };
    T1?: { max_class?: string; min_margin?: number };
    T3?: { min_class?: string; flags?: string[] };
  };
  prompt_policies?: Record<string, { hint_zh?: string; hint_en?: string; conditions?: { max_difficulty?: number; min_margin?: number; no_flags?: string[]; any_flag?: string[] } }>;
  context_rules?: { deep_conversation_threshold?: number; heavy_context_tokens?: number; deep_conversation_min_class?: string };
  v4?: { aux_downgrade?: { enabled?: boolean; threshold?: number }; sticky_tier?: { enabled?: boolean; max_user_len?: number } };
}

export interface GatewayPolicyConfig {
  default_tier: TextTier;
  confidence_threshold: number;
  confidence_high_tier_margin: number;
  kv_cache_anti_downgrade_enabled: boolean;
  kv_cache_anti_downgrade_window_seconds: number;
  complaint_upgrade_enabled: boolean;
  complaint_upgrade_steps: number;
  complaint_upgrade_max_chars: number;
  complaint_terms: string[];
  routing_history_window_seconds: number;
  max_routing_history: number;
  router_history_user_max_turns: number;
  router_history_user_max_chars: number;
  router_prev_assistant_max_chars: number;
}

export interface AuxProbabilities { initial: number; maintain: number; upgrade: number; downgrade: number }

export interface PostprocessDecision {
  routeClass: RouteClass;
  margin: number;
  difficulty: number;
  flags: RoutingFlags;
  thinkingMode: ThinkingMode;
  promptPolicy: PromptPolicy;
  auxDowngradeApplied: boolean;
  stickyApplied: boolean;
}

function classIndex(value: string | undefined, fallback: number): number {
  return value !== undefined && Object.hasOwn(ROUTE_INDEX, value) ? ROUTE_INDEX[value as RouteClass] : fallback;
}

function marginUpgrade(route: RouteClass, margin: number, config: RuntimeConfig): RouteClass {
  const threshold = config.thresholds?.margin_upgrade ?? 0.15;
  const index = ROUTE_INDEX[route];
  return margin < threshold && index < ROUTE_CLASSES.length - 1 ? ROUTE_CLASSES[index + 1] : route;
}

function auxDowngrade(route: RouteClass, aux: AuxProbabilities | null, config: RuntimeConfig): [RouteClass, boolean] {
  const cfg = config.v4?.aux_downgrade ?? {};
  if (!cfg.enabled || !aux) return [route, false];
  const threshold = cfg.threshold ?? 0.55;
  const nonInitial = aux.maintain + aux.upgrade + aux.downgrade;
  const probability = nonInitial > 0 ? aux.downgrade / nonInitial : 0;
  if (probability < threshold || route === "R0") return [route, false];
  const downgraded = ROUTE_CLASSES[Math.max(0, ROUTE_INDEX[route] - 1)];
  return [downgraded, downgraded !== route];
}

function r1Rescue(route: RouteClass, probs: Float64Array, config: RuntimeConfig): RouteClass {
  const gap = config.thresholds?.r1_rescue?.from_r0_max_gap ?? 0.20;
  return route === "R0" && probs[0] - probs[1] < gap ? "R1" : route;
}

function underRoutingSafety(route: RouteClass, probs: Float64Array, config: RuntimeConfig): RouteClass {
  if (ROUTE_INDEX[route] >= ROUTE_INDEX.R2) return route;
  const threshold = config.thresholds?.under_routing_safety ?? 0.45;
  return probs[2] + probs[3] > threshold ? "R2" : route;
}

function flagOverrides(route: RouteClass, flags: RoutingFlags): RouteClass {
  let index = ROUTE_INDEX[route];
  if (flags.high_risk) index = Math.max(index, ROUTE_INDEX.R2);
  if (flags.debug && flags.long_context) index = Math.max(index, ROUTE_INDEX.R2);
  if (flags.repo_arch) index = Math.max(index, ROUTE_INDEX.R1);
  return ROUTE_CLASSES[index];
}

function contextRules(route: RouteClass, context: ContextMetadata | null, config: RuntimeConfig): RouteClass {
  if (!context) return route;
  const rules = config.context_rules ?? {};
  if (context.turn_index >= Math.trunc(rules.deep_conversation_threshold ?? 4)) {
    return ROUTE_CLASSES[Math.max(ROUTE_INDEX[route], classIndex(rules.deep_conversation_min_class ?? "R1", ROUTE_INDEX.R1))];
  }
  return route;
}

function stickyTier(route: RouteClass, message: string, history: readonly PrevRouteDecision[], config: RuntimeConfig): [RouteClass, boolean] {
  const cfg = config.v4?.sticky_tier ?? {};
  if (!cfg.enabled) return [route, false];
  if (cfg.max_user_len !== undefined && pyLen(message) > Math.trunc(cfg.max_user_len)) return [route, false];
  if (!history.length) return [route, false];
  const previous = history[history.length - 1].route_class;
  const sticky = classIndex(previous, -1) > ROUTE_INDEX[route] ? previous as RouteClass : route;
  return [sticky, sticky !== route];
}

function flagSet(flags: RoutingFlags, name: string): boolean {
  return Object.hasOwn(flags, name) && Boolean(flags[name as keyof RoutingFlags]);
}

export function deriveThinkingMode(route: RouteClass, margin: number, flags: RoutingFlags, config: RuntimeConfig): ThinkingMode {
  const rules = config.thinking_mode_rules ?? {};
  if (route === "R3") return "T3";
  const t3Flags = rules.T3?.flags ?? ["debug", "long_context", "high_risk"];
  if (ROUTE_INDEX[route] >= classIndex(rules.T3?.min_class ?? "R2", 2) && t3Flags.some(flag => flagSet(flags, flag))) return "T3";
  if (ROUTE_INDEX[route] <= classIndex(rules.T0?.max_class ?? "R0", 0) && margin >= (rules.T0?.min_margin ?? 0.5)) return "T0";
  if (ROUTE_INDEX[route] <= classIndex(rules.T1?.max_class ?? "R1", 1) && margin >= (rules.T1?.min_margin ?? 0.4)) return "T1";
  return "T2";
}

export function derivePromptPolicy(difficulty: number, margin: number, flags: RoutingFlags, config: RuntimeConfig): PromptPolicy {
  const policies = config.prompt_policies ?? {};
  const p2 = policies.P2?.conditions ?? {};
  if ((p2.any_flag ?? ["high_risk", "long_context", "debug", "strict_format"]).some(flag => flagSet(flags, flag))) return "P2";
  const p0 = policies.P0?.conditions ?? {};
  const blocked = (p0.no_flags ?? ["high_risk", "strict_format", "debug"]).some(flag => flagSet(flags, flag));
  if (difficulty <= (p0.max_difficulty ?? 0.8) && margin >= (p0.min_margin ?? 0.4) && !blocked) return "P0";
  return "P1";
}

const TRIVIAL_ACK_TEXTS = new Set(["thanks", "thank you", "ok", "okay", "yes", "no", "收到", "好的", "谢谢", "是的", "不用了"]);
const ACK_STRIP = new Set(codePoints(" \t\r\n.!?。！？,，;；:："));

function stripChars(text: string, chars: ReadonlySet<number>): string {
  const cps = codePoints(text);
  let start = 0, end = cps.length;
  while (start < end && chars.has(cps[start])) start += 1;
  while (end > start && chars.has(cps[end - 1])) end -= 1;
  return String.fromCodePoint(...cps.slice(start, end));
}

export function isTrivialAck(text: string): boolean {
  return TRIVIAL_ACK_TEXTS.has(stripChars(pyLower(pyStrip(text)), ACK_STRIP));
}

/** inference/postprocess.py `apply_postprocess`. */
export function applyPostprocess(input: {
  fused: Float64Array;
  aux: AuxProbabilities | null;
  message: string;
  context: ContextMetadata | null;
  history: readonly PrevRouteDecision[];
  config: RuntimeConfig;
}): PostprocessDecision {
  const { fused, config } = input;
  let top = 0;
  for (let index = 1; index < 4; index += 1) if (fused[index] > fused[top]) top = index;
  let route = ROUTE_CLASSES[top];
  const sorted = Array.from(fused).sort((a, b) => b - a);
  const margin = sorted[0] - sorted[1];
  const difficulty = fused[0] * 0 + fused[1] * 1 + fused[2] * 2 + fused[3] * 3;

  const preUpgrade = route;
  route = marginUpgrade(route, margin, config);
  let auxApplied = false;
  if (route === preUpgrade) [route, auxApplied] = auxDowngrade(route, input.aux, config);
  route = r1Rescue(route, fused, config);
  route = underRoutingSafety(route, fused, config);
  const flags = computeFlags(input.message, config.flag_rules ?? {}, config.context_rules?.heavy_context_tokens ?? 2000, input.context);
  route = flagOverrides(route, flags);
  route = contextRules(route, input.context, config);
  let stickyApplied = false;
  [route, stickyApplied] = stickyTier(route, input.message, input.history, config);

  let thinkingMode = deriveThinkingMode(route, margin, flags, config);
  let promptPolicy = derivePromptPolicy(difficulty, margin, flags, config);
  if (route === "R0" && isTrivialAck(input.message)) { thinkingMode = "T0"; promptPolicy = "P0"; }
  return { routeClass: route, margin, difficulty, flags, thinkingMode, promptPolicy, auxDowngradeApplied: auxApplied, stickyApplied };
}

// ---------------------------------------------------------------------------
// Gateway post-classifier policy (engine/routing/policy.py), history strategy.
// ---------------------------------------------------------------------------

export interface RoutingHistoryEntry {
  routeClass: RouteClass;
  finalRouteClass: RouteClass;
  finalTier: TextTier;
  difficulty: number;
  margin: number;
  /** Seconds between this entry and the current turn. */
  ageSeconds: number;
}

export interface GatewayDecision {
  tier: TextTier;
  thinkingMode: ThinkingMode;
  promptPolicy: PromptPolicy;
  confidenceGateApplied: boolean;
  complaintTerms: string[];
  complaintUpgradeApplied: boolean;
  antiDowngradeApplied: boolean;
  previousTier: TextTier | null;
}

const THINKING_ORDER: Record<ThinkingMode, number> = { T0: 0, T1: 1, T2: 2, T3: 3 };

function tierIndex(tier: TextTier): number { return TEXT_TIERS.indexOf(tier); }

export function detectComplaint(message: string, config: GatewayPolicyConfig): string[] {
  const text = pyStrip(message);
  if (config.complaint_upgrade_max_chars > 0 && pyLen(text) > config.complaint_upgrade_max_chars) return [];
  const lowered = pyLower(text);
  return config.complaint_terms.filter(term => lowered.includes(term));
}

export function applyGatewayPolicy(input: {
  routeClass: RouteClass;
  confidence: number;
  thinkingMode: ThinkingMode;
  promptPolicy: PromptPolicy;
  message: string;
  history: readonly RoutingHistoryEntry[];
  config: GatewayPolicyConfig;
}): GatewayDecision {
  const config = input.config;
  const baseTier = ROUTE_TO_TIER[input.routeClass];
  let tier = baseTier;
  const preConfidenceTier = tier;

  // confidence_gate (no calibration state: identity threshold/bias).
  const defaultTier = config.default_tier;
  const cutoff = tierIndex(tier) > tierIndex(defaultTier)
    ? config.confidence_threshold - config.confidence_high_tier_margin
    : config.confidence_threshold;
  const confidenceGateApplied = input.confidence < cutoff && tier !== defaultTier;
  if (confidenceGateApplied) tier = defaultTier;

  // previous_final_entry: newest entry inside the KV-cache window.
  const window = config.kv_cache_anti_downgrade_window_seconds;
  let previousTier: TextTier | null = null;
  for (let index = input.history.length - 1; index >= 0; index -= 1) {
    const entry = input.history[index];
    if (entry.ageSeconds <= window) { previousTier = entry.finalTier; break; }
  }

  // complaint_upgrade.
  let complaintTerms: string[] = [];
  let complaintUpgradeApplied = false;
  if (config.complaint_upgrade_enabled) {
    complaintTerms = detectComplaint(input.message, config);
    if (complaintTerms.length) {
      let start = tier;
      if (tierIndex(preConfidenceTier) > tierIndex(start)) start = preConfidenceTier;
      if (previousTier && tierIndex(previousTier) > tierIndex(start)) start = previousTier;
      const upgraded = TEXT_TIERS[Math.min(tierIndex(start) + Math.max(config.complaint_upgrade_steps, 0), TEXT_TIERS.length - 1)];
      complaintUpgradeApplied = upgraded !== tier;
      tier = upgraded;
    }
  }

  // anti_downgrade.
  let antiDowngradeApplied = false;
  if (config.kv_cache_anti_downgrade_enabled && previousTier && tierIndex(previousTier) > tierIndex(tier)) {
    tier = previousTier;
    antiDowngradeApplied = true;
  }

  // reconcile_controller_with_final_tier.
  let thinkingMode = input.thinkingMode, promptPolicy = input.promptPolicy;
  if (tier !== baseTier) {
    const minimum: ThinkingMode | null = tier === "c3" ? "T3" : tier === "c2" ? "T2" : tier === "c1" ? "T1" : null;
    if (minimum && THINKING_ORDER[thinkingMode] < THINKING_ORDER[minimum]) thinkingMode = minimum;
    if (promptPolicy === "P0" && (tier === "c2" || tier === "c3" || complaintTerms.length > 0)) promptPolicy = "P1";
    if ((thinkingMode === "T2" || thinkingMode === "T3") && promptPolicy === "P0") promptPolicy = "P1";
  }
  return { tier, thinkingMode, promptPolicy, confidenceGateApplied, complaintTerms, complaintUpgradeApplied, antiDowngradeApplied, previousTier };
}

export function tierForRouteClass(route: RouteClass): TextTier { return ROUTE_TO_TIER[route]; }
export function routeClassForTier(tier: TextTier): RouteClass { return TIER_TO_ROUTE[tier]; }
