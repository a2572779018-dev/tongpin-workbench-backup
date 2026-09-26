import type { AiAttachment, AiChatRequest, AiProviderConfig } from "../../shared/ai";
import { BAI_ASTRA_MODEL, BAI_QUICK_MODELS, filterBaiAgentModels, isTongpinQuickAgent, type BaiQuickModel } from "../../shared/aiAuto";
import { AiError } from "./security";

const VISUAL_MODELS = new Set<BaiQuickModel>(["qwen3.8-flash", "mimo-v2.5"]);

function chooseQuickModel(verifiedModels: readonly string[], preferences: readonly BaiQuickModel[], visual: boolean): BaiQuickModel {
  const verified = new Set(filterBaiAgentModels(verifiedModels));
  const available = BAI_QUICK_MODELS.filter(model => verified.has(model));
  if (!available.length) throw new AiError(503, "AI_AGENT_QUICK_MODELS_UNAVAILABLE", "当前密钥没有已验证的快速 Agent 模型，请管理员重新检查模型列表", true);
  const compatible = visual ? available.filter(model => VISUAL_MODELS.has(model)) : available;
  if (!compatible.length) throw new AiError(503, "AI_AGENT_VISION_MODEL_UNAVAILABLE", "当前已验证的快速模型不支持图片理解，请管理员检查模型权限", true);
  return preferences.find(model => compatible.includes(model)) ?? compatible[0];
}

function requireAstra(verifiedModels: readonly string[]): void {
  if (!filterBaiAgentModels(verifiedModels).includes(BAI_ASTRA_MODEL)) {
    throw new AiError(503, "AI_AGENT_ASTRA_UNAVAILABLE", "当前密钥没有已验证的 Astra 模型，暂时不能使用深度思考或 Agent 联网搜索", true);
  }
}

/**
 * A deliberately narrow freshness detector. False negatives stay on the cheap
 * local route; false positives would spend administrator-owned search quota, so
 * generic words such as "介绍" or "分析" are intentionally absent.
 *
 * Standalone freshness signals. Generic words that are common in ordinary
 * chats ("当前"/"现在"/"版本"/"更新"/"发布"/"查询"/"查找"/"价格"/"current",
 * "version", "release"...) used to match alone, which silently turned plain
 * quick-tier turns into a search turn (and, for the B.AI quick agent, an Astra
 * escalation), adding a full search/tool round trip before the first token.
 */
const FRESHNESS_SIGNAL = /(?:最新|今天|今日|昨天|刚刚|近期|最近几天|本周|本月|实时|新闻|热搜|行情|股价|汇率|天气|赛程|比分|是否还|还在营业|上网查|联网|网上搜|搜一下|搜索一下|查一下|核实一下|latest|today|breaking|news|weather|stock\s+price|exchange\s+rate|search\s+(?:for|the\s+web)|look\s+up)/iu;
// A generic "current/now" word only counts when it qualifies a time-sensitive
// fact that cannot be answered from the conversation itself.
const QUALIFIED_FRESHNESS = /(?:现在|当前|目前|\bcurrent(?:ly)?\b|\bnow\b)[^。！？.!?\n]{0,12}?(?:价格|售价|报价|多少钱|政策|法规|排名|比分|股价|汇率|price|ranking|policy|score)/iu;

// A lookup verb counts when the member asks for external sources, not for
// e.g. "写一个 SQL 查询" or "搜索算法".
const SOURCE_LOOKUP = /(?:查找|查询|搜索|检索)[^。！？.!?\n]{0,8}?(?:官方|官网|资料|来源|出处|文献|报道)/u;

// Asking what something costs right now ("黄金价格多少", "iPhone 多少钱") is a
// live fact even without a time word.
const PRICE_QUESTION = /(?:价格|售价|报价|金价|油价|房价)[^。！？.!?\n]{0,6}?(?:多少|几|怎么样|如何)|多少钱/u;

export function needsOnlineEvidence(text: string): boolean {
  return FRESHNESS_SIGNAL.test(text) || QUALIFIED_FRESHNESS.test(text) || SOURCE_LOOKUP.test(text) || PRICE_QUESTION.test(text);
}

/**
 * A deliberately narrow "needs real computation" detector, mirroring
 * needsOnlineEvidence's asymmetry: a false negative just skips the hosted
 * code_interpreter tool (the model still answers in plain text), while a
 * false positive spends an administrator-owned code-exec session on an
 * ordinary chat message. A data file attachment is evidence on its own.
 */
const COMPUTATION_SIGNAL = /(?:计算|算一下|算出来?|求解|求导|积分|解方程|统计(?:一下|分析)|回归分析|标准差|方差|平均值|中位数|画(?:一?个|张)(?:折线图|柱状图|饼图|环形图|散点图)|生成(?:一?个|张)(?:图表|走势图)|数据分析|分析(?:一下)?(?:这个|这份)?数据|(?:运行|执行)(?:一下)?代码|写(?:一?段|一?个)(?:python|代码|脚本)(?:来|帮我|计算|处理|分析)|用代码(?:计算|处理|分析|画)|模拟一下|蒙特卡洛|这道数学题|这道题怎么算|\b(?:calculate|computes?|regression|std\s*dev|standard\s+deviation|monte\s+carlo|plot\s+(?:a|the)\s*(?:chart|graph)|run\s+(?:the\s+)?code|write\s+(?:a\s+)?(?:python|script)\s+to)\b)/iu;
const COMPUTATION_ATTACHMENT = /\.(?:csv|xlsx?|tsv|parquet|json)$/i;

export function needsComputation(text: string, attachments?: readonly Pick<AiAttachment, "name">[]): boolean {
  if (attachments?.some(item => COMPUTATION_ATTACHMENT.test(item.name))) return true;
  return COMPUTATION_SIGNAL.test(text);
}

/**
 * Built-in quick-Agent dispatch (keyword rules), used when no desktop
 * OpenSquilla decision is available. With a decision, `openSquillaModels`
 * (planned in openSquillaRouting.ts from OpenSquilla's tier) replaces the
 * keyword preference; visual and search constraints still apply.
 */
export function routeChatProvider<T extends AiProviderConfig>(provider: T, request: AiChatRequest, verifiedModels: readonly string[] | null = null, openSquillaModels?: readonly string[]): T {
  if (!isTongpinQuickAgent(provider.quickModel)) return provider;
  if (new URL(provider.baseUrl).hostname !== "api.b.ai") throw new AiError(400, "AI_AGENT_PROVIDER_INVALID", "快速 Agent 当前仅支持 B.AI");
  if (verifiedModels === null) throw new AiError(503, "AI_AGENT_MODELS_UNVERIFIED", "快速 Agent 尚未完成当前密钥的模型检查，请管理员保存配置后重新检查模型列表", true);
  if (request.mode === "deep" || request.mode === "pro") {
    requireAstra(verifiedModels);
    return { ...provider, protocol: "responses", deepModel: BAI_ASTRA_MODEL };
  }
  const text = request.messages.filter(message => message.role === "user").at(-1)?.content ?? "";
  const searchTurn = request.webSearch === true || (request.webSearchMode === "auto" && needsOnlineEvidence(text));
  if (searchTurn && provider.webSearchEnabled && provider.webSearchQuotaTokens) {
    // Search is a one-turn escalation inside the same agent loop. The member
    // does not toggle a skill and the saved quick-agent setting is untouched.
    requireAstra(verifiedModels);
    return { ...provider, protocol: "responses", quickModel: BAI_ASTRA_MODEL };
  }
  const visual = request.attachments?.some(item => item.dataUrl);
  const longContext = request.messages.reduce((size, message) => size + message.content.length, 0) + (request.attachments ?? []).reduce((size, item) => size + (item.text?.length ?? 0), 0) > 16000;
  const structuredTask = request.outputFormat && request.outputFormat !== "text";
  const researchTask = request.skillIds?.some(id => id === "deep-research" || id === "data-reader");
  const planned = openSquillaModels?.filter((model): model is BaiQuickModel => (BAI_QUICK_MODELS as readonly string[]).includes(model));
  const preferences: readonly BaiQuickModel[] = planned?.length ? planned : visual || longContext || structuredTask || researchTask
    ? ["qwen3.8-flash", "mimo-v2.5", "hy3"]
    : /代码|编程|脚本|调试|程序|数据|表格|\b(code|coding|debug|python|javascript|typescript|sql|csv)\b/i.test(text)
      ? ["mimo-v2.5", "qwen3.8-flash", "hy3"]
      : ["hy3", "qwen3.8-flash", "mimo-v2.5"];
  const model = chooseQuickModel(verifiedModels, preferences, Boolean(visual));
  return { ...provider, quickModel: model, protocol: "chat_completions" };
}
