import type { AiChatRequest, AiProviderConfig } from "../../shared/ai";
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
 */
export function needsOnlineEvidence(text: string): boolean {
  return /(?:最新|现在|当前|今天|昨天|刚刚|近期|本周|本月|实时|新闻|热搜|行情|股价|汇率|价格|天气|赛程|比分|日程|政策|法规|版本|更新|发布|是否还|上网查|联网|搜索|查找|查询|查一下|核实一下|latest|today|current|recent|breaking|news|weather|price|schedule|score|release|version|search\s+(?:for|the\s+web)|look\s+up)/iu.test(text);
}

/**
 * Bounded local agent dispatch inspired by OpenSquilla's local-router design.
 * This is intentionally not a second desktop/gateway runtime: it reuses
 * Tongpin's account, quota, approval and tool-result loop.
 */
export function routeChatProvider<T extends AiProviderConfig>(provider: T, request: AiChatRequest, verifiedModels: readonly string[] | null = null): T {
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
  const preferences: readonly BaiQuickModel[] = visual || longContext || structuredTask || researchTask
    ? ["qwen3.8-flash", "mimo-v2.5", "hy3"]
    : /代码|编程|脚本|调试|程序|数据|表格|\b(code|coding|debug|python|javascript|typescript|sql|csv)\b/i.test(text)
      ? ["mimo-v2.5", "qwen3.8-flash", "hy3"]
      : ["hy3", "qwen3.8-flash", "mimo-v2.5"];
  const model = chooseQuickModel(verifiedModels, preferences, Boolean(visual));
  return { ...provider, quickModel: model, protocol: "chat_completions" };
}
