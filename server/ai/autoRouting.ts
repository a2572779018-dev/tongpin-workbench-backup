import type { AiChatRequest, AiProviderConfig } from "../../shared/ai";
import { BAI_QUICK_AUTO } from "../../shared/aiAuto";
import { AiError } from "./security";

/** Local deterministic selection: no classifier charge and no paid fallback. */
export function routeChatProvider<T extends AiProviderConfig>(provider: T, request: AiChatRequest): T {
  if (provider.quickModel !== BAI_QUICK_AUTO) return provider;
  if (new URL(provider.baseUrl).hostname !== "api.b.ai") throw new AiError(400, "AI_AUTO_PROVIDER_INVALID", "当前自动模式仅支持 B.AI");
  if (request.mode === "deep") return { ...provider, protocol: "responses", deepModel: "gpt-6-astra" };
  if (request.webSearch) throw new AiError(400, "AI_AUTO_SEARCH_UNSUPPORTED", "快速 Auto 暂不支持联网搜索，请关闭联网搜索，或切换深度思考", true);
  const text = request.messages.filter(message => message.role === "user").at(-1)?.content ?? "";
  const visual = request.attachments?.some(item => item.dataUrl);
  const longContext = request.messages.reduce((size, message) => size + message.content.length, 0) + (request.attachments ?? []).reduce((size, item) => size + (item.text?.length ?? 0), 0) > 16000;
  const model = visual || longContext ? "qwen3.8-flash" : /代码|编程|脚本|调试|程序|\b(code|coding|debug|python|javascript|typescript|sql)\b/i.test(text) ? "mimo-v2.5" : "hy3";
  return { ...provider, quickModel: model, protocol: "chat_completions" };
}
