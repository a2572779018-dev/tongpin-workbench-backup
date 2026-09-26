// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import { codePoints, pyCount, pyLen, pyLower, pyRegex, pySplit, pyStrip, pyTail } from "./pyText";

/*
 * TypeScript port of the OpenSquilla V4.2 Phase 3 router's hand-written
 * feature channels (Apache-2.0, TokenRhythm/opensquilla @ d27ba0e):
 * `runtime_src/src/router/features.py` (hand-crafted, context, history),
 * `flags.py`, `trajectory.py` and `v4_features.py` (assistant, continuation,
 * reasoning, history-text helpers). Keyword lists and regular expressions are
 * copied verbatim; values follow NumPy float32 storage exactly.
 */

export type RouteClass = "R0" | "R1" | "R2" | "R3";
export const ROUTE_CLASSES: readonly RouteClass[] = ["R0", "R1", "R2", "R3"];
export const ROUTE_INDEX: Record<RouteClass, number> = { R0: 0, R1: 1, R2: 2, R3: 3 };

// ---------------------------------------------------------------------------
// Channel 1: hand-crafted features (features.py)
// ---------------------------------------------------------------------------

const CODE_BLOCK_RE = pyRegex("```[\\s\\S]*?```", { global: true });
const JSON_RE = pyRegex("\\{[\\s\\S]*?[\\\"'][\\w]+[\\\"']\\s*:");
const YAML_RE = pyRegex("^[\\w_]+:\\s+\\S", { multiline: true });
const CSV_RE = pyRegex("^[^,\\n]+,[^,\\n]+,[^,\\n]+", { multiline: true });
const TABLE_RE = pyRegex("\\|.*\\|.*\\|");
const FILE_PATH_SOURCE = "(?:^|[\\s\\\"'`(])([a-zA-Z_][\\w.-]*/[\\w./-]+\\.[\\w]+)";
const FILE_PATH_RE = pyRegex(FILE_PATH_SOURCE, { multiline: true, global: true });
const URL_RE = pyRegex("https?://\\S+");
const LOG_SOURCE = "(\\d{4}[-/]\\d{2}[-/]\\d{2}[\\sT]\\d{2}:\\d{2}.*\\n){3,}|(^\\[?(INFO|WARN|ERROR|DEBUG)\\]?\\s.*\\n){3,}";
const LOG_RE = pyRegex(LOG_SOURCE, { multiline: true, global: true });
const SHELL_RE = pyRegex("^\\$\\s+\\w|^>\\s+\\w|```(?:bash|sh|shell)", { multiline: true });
const TRACEBACK_RE = pyRegex("Traceback \\(most recent|stderr:|\\.py\\\", line \\d+");
const BULLET_RE = pyRegex("^[\\s]*[-*]\\s", { multiline: true, global: true });
const NUMBERED_RE = pyRegex("^[\\s]*\\d+[.)]\\s", { multiline: true, global: true });
const QUOTED_RE = pyRegex("[\\\"'`](.*?)[\\\"'`]", { global: true });

const DEBUG_KW = ["error", "bug", "exception", "traceback", "failed", "root cause", "报错", "根因", "修复", "stack trace", "debug"];
const RESEARCH_KW = ["调研", "research", "对比", "compare", "survey", "分析报告", "competitive analysis", "综述"];
const ARCH_KW = ["architecture", "架构", "重构", "refactor", "monorepo", "codebase", "module", "dependency"];
const COMPARE_KW = ["对比", "compare", "audit", "审计", "review", "评估"];
const PLANNING_KW = ["plan", "规划", "roadmap", "设计方案", "workflow", "pipeline", "步骤", "step by step"];
const STRICT_FMT_KW = ["JSON", "YAML", "CSV", "schema", "只返回", "不要解释", "按格式", "only return", "no explanation"];
const HIGH_RISK_KW = ["deploy", "rollback", "migration", "delete", "overwrite", "production", "生产", "部署", "删除", "客户", "法务", "财务"];
const PRODUCTION_KW = ["production", "生产", "prod", "线上", "正式环境"];
const CUSTOMER_KW = ["customer", "客户", "用户邮件", "client"];
const DELETE_KW = ["delete", "remove", "drop", "truncate", "删除", "清空", "覆盖", "overwrite"];
const FORMAL_KW = ["formal", "正式", "official", "公文", "合同", "法律"];
const CONSTRAINT_KW = ["必须", "不能", "不要", "只能", "must", "shall", "required", "forbidden", "不允许", "至少", "最多"];
const TEACHING_KW = ["how does", "explain", "what is", "why does", "how to", "教我", "解释", "为什么", "怎么", "是什么", "how can", "tell me about", "walk me through", "介绍", "说明"];
const IMPLEMENT_KW = ["implement", "write function", "write a", "create a", "写个", "实现", "用法", "帮我写", "生成代码", "add a", "build a", "make a", "写一个", "编写"];

export const HANDCRAFTED_DIMS = 51;
export const CONTEXT_DIMS = 10;
export const HIST_DIMS = 16;

function findAll(re: RegExp, text: string): RegExpMatchArray[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)];
}

function keywordCount(lowered: string, keywords: readonly string[]): number {
  let count = 0;
  for (const keyword of keywords) if (lowered.includes(pyLower(keyword))) count += 1;
  return count;
}

function charTypeRatios(text: string): [number, number, number] {
  const cps = codePoints(text);
  if (!cps.length) return [0, 0, 0];
  let zh = 0, en = 0, code = 0;
  for (const cp of cps) {
    if (cp >= 0x4e00 && cp <= 0x9fff) zh += 1;
    if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) en += 1;
    if ("{}[]();=<>|&!@#$%^*~`\\".includes(String.fromCodePoint(cp))) code += 1;
  }
  return [zh / cps.length, en / cps.length, code / cps.length];
}

export function extractHandcrafted(text: string): Float32Array {
  const feats = new Float32Array(HANDCRAFTED_DIMS);
  const lowered = pyLower(text);
  const textLength = pyLen(text);
  feats[0] = textLength;
  const words = pySplit(text);
  feats[1] = words.length;
  feats[2] = text.split("\n").length;
  feats[3] = feats[0] / Math.max(feats[2], 1);

  const [zh, en, code] = charTypeRatios(text);
  feats[4] = zh;
  feats[5] = en;
  feats[6] = code;
  feats[7] = zh > 0.1 && en > 0.1 ? 1 : 0;

  const codeBlocks = findAll(CODE_BLOCK_RE, text).map(match => match[0]);
  feats[8] = codeBlocks.length ? 1 : 0;
  feats[9] = codeBlocks.length;
  feats[10] = codeBlocks.reduce((sum, block) => sum + pyLen(block), 0);
  feats[11] = JSON_RE.test(text) ? 1 : 0;
  feats[12] = YAML_RE.test(text) ? 1 : 0;
  feats[13] = CSV_RE.test(text) ? 1 : 0;
  feats[14] = TABLE_RE.test(text) ? 1 : 0;

  feats[15] = pyCount(text, "?") + pyCount(text, "？");
  feats[16] = pyCount(text, "!") + pyCount(text, "！");
  feats[17] = findAll(BULLET_RE, text).length;
  feats[18] = findAll(NUMBERED_RE, text).length;

  feats[22] = keywordCount(lowered, DEBUG_KW);
  feats[23] = keywordCount(lowered, RESEARCH_KW);
  feats[24] = keywordCount(lowered, ARCH_KW);
  feats[25] = keywordCount(lowered, COMPARE_KW);
  feats[26] = keywordCount(lowered, PLANNING_KW);
  feats[27] = keywordCount(lowered, STRICT_FMT_KW);
  feats[28] = keywordCount(lowered, HIGH_RISK_KW);
  feats[29] = keywordCount(lowered, PRODUCTION_KW);
  feats[30] = keywordCount(lowered, CUSTOMER_KW);
  feats[31] = keywordCount(lowered, DELETE_KW);
  feats[32] = keywordCount(lowered, FORMAL_KW);

  const fileRefs = findAll(FILE_PATH_RE, text).map(match => match[1]);
  feats[33] = fileRefs.length ? 1 : 0;
  feats[34] = URL_RE.test(text) ? 1 : 0;
  feats[35] = findAll(LOG_RE, text).length ? 1 : 0;
  feats[36] = SHELL_RE.test(text) ? 1 : 0;
  feats[37] = TRACEBACK_RE.test(text) ? 1 : 0;

  feats[38] = keywordCount(lowered, CONSTRAINT_KW);
  const quoted = findAll(QUOTED_RE, text).map(match => match[1]);
  feats[39] = quoted.reduce((sum, value) => sum + pyLen(value), 0) / Math.max(textLength, 1);
  const wordsLower = words.map(pyLower);
  feats[40] = new Set(wordsLower).size / Math.max(wordsLower.length, 1);

  feats[41] = keywordCount(lowered, TEACHING_KW);
  feats[42] = keywordCount(lowered, IMPLEMENT_KW);
  const files = new Set(fileRefs).size;
  feats[43] = files === 0 ? 1 : 0;
  feats[44] = files >= 1 && files <= 2 ? 1 : 0;
  feats[45] = files >= 3 ? 1 : 0;
  feats[46] = codeBlocks.length && feats[22] === 0 ? 1 : 0;
  feats[47] = textLength < 200 ? 1 : 0;
  feats[48] = textLength >= 200 && textLength <= 1000 ? 1 : 0;
  feats[49] = textLength > 1000 ? 1 : 0;
  // float32 accumulation, as NumPy does on the float32 array elements.
  let totalKeywords = Math.fround(feats[22] + feats[23]);
  for (const index of [24, 25, 26, 27, 28]) totalKeywords = Math.fround(totalKeywords + feats[index]);
  feats[50] = totalKeywords < 2 ? 1 : 0;
  return feats;
}

// ---------------------------------------------------------------------------
// Rule-based routing flags (flags.py), driven by router.runtime.yaml.
// ---------------------------------------------------------------------------

export interface FlagRulesConfig {
  high_risk?: { keywords_zh?: string[]; keywords_en?: string[] };
  debug?: { keywords?: string[]; patterns?: string[] };
  repo_arch?: { keywords?: string[] };
  strict_format?: { keywords?: string[] };
  long_context?: { char_threshold?: number; code_block_threshold?: number; log_block_threshold?: number; file_ref_threshold?: number };
}

export interface RoutingFlags {
  high_risk: boolean;
  long_context: boolean;
  debug: boolean;
  repo_arch: boolean;
  strict_format: boolean;
}

export interface ContextMetadata {
  turn_index: number;
  context_tokens_est: number;
  n_tools: number;
  tool_result_length: number;
  has_code_block: boolean;
  has_file_reference: boolean;
  has_url: boolean;
  has_tool_results: boolean;
}

const patternCache = new Map<string, RegExp>();
function compiled(pattern: string): RegExp {
  let re = patternCache.get(pattern);
  if (!re) { re = pyRegex(pattern); patternCache.set(pattern, re); }
  return re;
}

function hasKeyword(lowered: string, keywords: readonly string[] | undefined): boolean {
  return (keywords ?? []).some(keyword => lowered.includes(pyLower(keyword)));
}

export function computeFlags(text: string, rules: FlagRulesConfig, heavyContextTokens: number, context: ContextMetadata | null): RoutingFlags {
  const lowered = pyLower(text);
  const highRisk = hasKeyword(lowered, rules.high_risk?.keywords_zh) || hasKeyword(lowered, rules.high_risk?.keywords_en);
  const debug = hasKeyword(lowered, rules.debug?.keywords) || (rules.debug?.patterns ?? []).some(pattern => compiled(pattern).test(text));
  const repoArch = hasKeyword(lowered, rules.repo_arch?.keywords);
  const strictFormat = hasKeyword(lowered, rules.strict_format?.keywords);
  const lc = rules.long_context ?? {};
  const codeBlockLength = findAll(CODE_BLOCK_RE, text).reduce((sum, match) => sum + pyLen(match[0]), 0);
  const logBlockLength = findAll(LOG_RE, text).reduce((sum, match) => sum + pyLen(match[0]), 0);
  let longContext = pyLen(text) >= (lc.char_threshold ?? 6000)
    || codeBlockLength >= (lc.code_block_threshold ?? 1500)
    || logBlockLength >= (lc.log_block_threshold ?? 1500)
    || findAll(FILE_PATH_RE, text).length >= (lc.file_ref_threshold ?? 2);
  if (context && context.context_tokens_est > heavyContextTokens) longContext = true;
  return { high_risk: highRisk, long_context: longContext, debug, repo_arch: repoArch, strict_format: strictFormat };
}

// ---------------------------------------------------------------------------
// Context (features.py extract_context_features) and history channels.
// ---------------------------------------------------------------------------

export function extractContext(context: ContextMetadata | null): Float32Array {
  const feats = new Float32Array(CONTEXT_DIMS);
  if (!context) return feats;
  feats[0] = Math.min(Math.max(context.turn_index, 0), 20) / 20.0;
  feats[1] = Math.min(Math.max(context.context_tokens_est, 0), 20000) / 20000.0;
  feats[2] = Math.min(Math.max(context.n_tools, 0), 5) / 5.0;
  feats[3] = Math.min(Math.max(context.tool_result_length, 0), 5000) / 5000.0;
  feats[4] = context.has_code_block ? 1 : 0;
  feats[5] = context.has_file_reference ? 1 : 0;
  feats[6] = context.has_url ? 1 : 0;
  feats[7] = context.has_tool_results ? 1 : 0;
  feats[8] = context.turn_index >= 4 ? 1 : 0;
  feats[9] = context.context_tokens_est > 2000 ? 1 : 0;
  return feats;
}

export interface PrevRouteDecision { route_class: string; difficulty: number; margin: number }

const TRAJECTORIES = ["COLD_START", "STABLE_LOW", "STABLE_HIGH", "ESCALATING", "DESCALATING", "OSCILLATING", "UNCLEAR", "MIXED"] as const;
export type Trajectory = typeof TRAJECTORIES[number];

/** trajectory.py `classify` with the default 0.3 delta threshold. */
export function classifyTrajectory(history: readonly PrevRouteDecision[], deltaThreshold = 0.3): Trajectory {
  if (!history.length) return "COLD_START";
  if (history.length < 2) return "UNCLEAR";
  const tiers = history.map(item => item.route_class);
  if (tiers.every(tier => tier === "R0" || tier === "R1")) return "STABLE_LOW";
  if (tiers.every(tier => tier === "R2" || tier === "R3")) return "STABLE_HIGH";
  const diffs = history.map(item => item.difficulty);
  const signs = diffs.slice(1).map((value, index) => {
    const delta = value - diffs[index];
    return delta > deltaThreshold ? 1 : delta < -deltaThreshold ? -1 : 0;
  });
  const nonzero = signs.filter(sign => sign !== 0);
  if (nonzero.length >= 2 && nonzero.every(sign => sign === 1)) return "ESCALATING";
  if (nonzero.length >= 2 && nonzero.every(sign => sign === -1)) return "DESCALATING";
  const changes = nonzero.slice(1).filter((sign, index) => sign !== nonzero[index]).length;
  if (changes >= 2) return "OSCILLATING";
  return "MIXED";
}

function routeIndex(routeClass: string, fallback: number): number {
  return Object.hasOwn(ROUTE_INDEX, routeClass) ? ROUTE_INDEX[routeClass as RouteClass] : fallback;
}

export function extractHist(history: readonly PrevRouteDecision[]): Float32Array {
  const vec = new Float32Array(HIST_DIMS);
  if (history.length) {
    const last = history[history.length - 1];
    vec[0] = routeIndex(last.route_class, -1);
    vec[1] = last.difficulty;
    vec[2] = last.margin;
    vec[3] = Math.max(...history.map(item => routeIndex(item.route_class, -1)));
    vec[4] = history.length + 1;
    vec[5] = history.length;
    const indexes = history.map(item => routeIndex(item.route_class, 0));
    const counts = new Map<number, number>();
    for (const index of indexes) counts.set(index, (counts.get(index) ?? 0) + 1);
    const maxCount = Math.max(...counts.values());
    vec[6] = Math.max(...[...counts].filter(([, count]) => count === maxCount).map(([index]) => index));
    vec[7] = indexes.slice(1).filter((value, index) => value !== indexes[index]).length;
  } else {
    vec[0] = -1;
    vec[3] = -1;
    vec[4] = 1;
    vec[6] = -1;
    vec[7] = 0;
  }
  vec[8 + TRAJECTORIES.indexOf(classifyTrajectory(history))] = 1;
  return vec;
}

// ---------------------------------------------------------------------------
// v4_features.py: assistant, continuation and reasoning channels.
// ---------------------------------------------------------------------------

const RE_CLAR = pyRegex("(?:能否|请\\s*提供|需要(?:更多|具体).{0,8}信息|could you (?:clarify|provide)|please (?:specify|provide)|clarify which)", { ignoreCase: true });
const RE_REFUSAL = pyRegex("(?:I cannot|I can't help|对不起.{0,5}无法|抱歉.{0,5}不能|作为(?:AI|大语言模型))", { ignoreCase: true });
const RE_SELF_DOUBT = pyRegex("(?:我不(?:确定|清楚)|可能(?:不太|不一定)|not sure|might not be|I'm not entirely)", { ignoreCase: true });
const RE_CODE_INLINE = pyRegex("`[^`]{4,}`");
const RE_NUMBERED_LIST = pyRegex("^\\s*\\d+[\\.、]\\s", { multiline: true });
const RE_CONTINUATION = pyRegex("(?:请继续|继续|接着|续写|展开一下|再说|more|continue|go on|carry on|next)", { ignoreCase: true });
const RE_REASONING = pyRegex("(?:why|compare|trade[ -]?off|analy[sz]e|architecture|reasoning|design|解释|原因|对比|分析|架构|设计|权衡)", { ignoreCase: true });

/** OpenSquilla's usage dict keys; values are non-negative integers. */
export interface AssistantUsage {
  output_tokens?: number;
  reasoning_tokens?: number;
  duration_ms?: number;
  cached_tokens?: number;
  input_tokens?: number;
}

function usageValue(usage: AssistantUsage | null | undefined, key: keyof AssistantUsage, fallback = 0): number {
  const value = usage?.[key];
  return typeof value === "number" && value ? value : fallback;
}

function zhCharRatio(text: string): number {
  const cps = codePoints(text);
  if (!cps.length) return 0;
  return cps.filter(cp => cp >= 0x4e00 && cp <= 0x9fff).length / Math.max(cps.length, 1);
}

export function extractAssistantHandcrafted(prevAssistant: string | null, usage: AssistantUsage | null, currentUser: string): Float32Array {
  if (prevAssistant === null) return new Float32Array(12);
  const t = prevAssistant;
  return Float32Array.from([
    1.0,
    RE_CLAR.test(t) ? 1 : 0,
    RE_REFUSAL.test(t) ? 1 : 0,
    RE_SELF_DOUBT.test(t) ? 1 : 0,
    t.includes("```") || RE_CODE_INLINE.test(t) ? 1 : 0,
    RE_NUMBERED_LIST.test(t) ? 1 : 0,
    Math.log1p(usageValue(usage, "output_tokens")) / 10.0,
    Math.log1p(usageValue(usage, "reasoning_tokens")) / 10.0,
    Math.log1p(usageValue(usage, "duration_ms")) / 10.0,
    Math.min(pyLen(t) / Math.max(pyLen(currentUser), 1), 5.0) / 5.0,
    zhCharRatio(t),
    usageValue(usage, "cached_tokens") / Math.max(usageValue(usage, "input_tokens", 1), 1),
  ]);
}

function normalizedLogUsage(usage: AssistantUsage | null, key: keyof AssistantUsage): number {
  return Math.log1p(Math.max(usageValue(usage, key), 0)) / 10.0;
}

export function extractContinuation(usage: AssistantUsage | null, currentUser: string): Float32Array {
  const text = pyStrip(currentUser || "");
  const hasCue = Boolean(text) && pyLen(text) <= 24 && RE_CONTINUATION.test(text);
  return Float32Array.from([hasCue ? 1 : 0, normalizedLogUsage(usage, "output_tokens")]);
}

export function extractReasoning(usage: AssistantUsage | null, currentUser: string): Float32Array {
  const text = pyStrip(currentUser || "");
  const length = pyLen(text);
  const questionMarks = pyCount(text, "?") + pyCount(text, "？");
  return Float32Array.from([
    RE_REASONING.test(text) ? 1 : 0,
    Math.min(questionMarks / Math.max(length, 1) * 20.0, 1.0),
    Math.log1p(length) / 10.0,
    normalizedLogUsage(usage, "reasoning_tokens"),
    normalizedLogUsage(usage, "duration_ms"),
  ]);
}

const HISTORY_SEPARATOR = "\n[SEP]\n";

/** v4_features.make_history_user_text (oldest → newest, bounded). */
export function makeHistoryUserText(priorUserTurns: readonly string[], maxTurns = 4, maxChars = 1500): string {
  if (!priorUserTurns.length) return "";
  let selected = priorUserTurns.slice(-maxTurns);
  let text = selected.join(HISTORY_SEPARATOR);
  while (pyLen(text) > maxChars && selected.length > 1) {
    selected = selected.slice(1);
    text = selected.join(HISTORY_SEPARATOR);
  }
  if (pyLen(text) > maxChars) text = pyTail(text, maxChars);
  return text;
}
