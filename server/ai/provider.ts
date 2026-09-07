import type { AiChatRequest, AiProviderDiagnostic, AiSource, AiUsage } from "../../shared/ai";
import type { StoredProvider } from "./storage";
import { AiError } from "./security";
import { chatInstructions, chatMessages, safeSource } from "./capabilities";
import type { AiPersonaProfile } from "../../shared/aiPersona";

export interface AiTransportInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  maxResponseBytes?: number;
}
export type AiTransport = (url: string, init: AiTransportInit) => Promise<Response>;
export const AI_TIMEOUT_MS = 120_000;
export async function readBoundedText(response: Response, maxBytes = 2_000_000): Promise<string> {
  if (!response.body) throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务没有返回有效内容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "", size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 返回内容过大"); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回格式不正确，请检查接口协议和模型名称");
  } finally { reader.releaseLock(); }
}
export async function readBoundedJson(response: Response, maxBytes = 2_000_000): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes);
  try { return JSON.parse(text) as unknown; }
  catch { throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回格式不正确，请检查接口协议和模型名称"); }
}
/** Codex-compatible relays may require Responses SSE. Aggregate only a terminal response, never invent a successful stream. */
export async function readProviderResponse(response: Response): Promise<unknown> {
  const text = await readBoundedText(response);
  if (!response.headers.get("content-type")?.includes("text/event-stream") && !text.trimStart().startsWith("event:") && !text.trimStart().startsWith("data:")) {
    try { return JSON.parse(text) as unknown; }
    catch { throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回格式不正确，请检查接口协议和模型名称"); }
  }
  let completed: unknown;
  for (const block of text.replace(/\r\n/g, "\n").split("\n\n")) {
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    let event: Record<string, unknown>;
    try { event = object(JSON.parse(data)); }
    catch { throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回了损坏的数据流"); }
    if (event.type === "error" || event.type === "response.failed") throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务未完成生成，请管理员检查模型和接口配置");
    if (event.type === "response.completed" || event.type === "response.incomplete") completed = { ...object(event.response), status: event.type === "response.incomplete" ? "incomplete" : "completed" };
  }
  if (!completed) throw new AiError(502, "AI_STREAM_INTERRUPTED", "AI 数据流中断，用量暂按预留上限记录，请管理员核对");
  return completed;
}
/** Only explicit pre-generation HTTP refusals release a reservation. A timeout/conflict may follow paid work. */
export function isProviderRejection(status: number): boolean {
  return (status >= 300 && status < 400) || [400, 401, 403, 404, 405, 406, 410, 411, 413, 414, 415, 422, 429].includes(status);
}
// Provider error fields can echo credentials or prompts. Even syntactically safe arbitrary strings are not safe to expose.
const SAFE_ERROR_CODES = new Set(["invalid_api_key", "invalid_request_error", "invalid_value", "invalid_parameter", "unsupported_parameter", "unknown_parameter", "model_not_found", "model_not_supported", "permission_denied", "insufficient_quota", "rate_limit_exceeded", "content_policy_violation", "moderation_blocked", "server_error", "internal_error", "service_unavailable", "upstream_error", "timeout", "request_timeout"]);
const SAFE_ERROR_PARAMS = new Set(["model", "size", "quality", "n", "prompt", "stream", "response_format", "output_format", "background", "moderation", "partial_images", "max_output_tokens", "max_completion_tokens", "reasoning_effort", "reasoning.effort", "tools"]);
export function providerHttpError(status: number, operation: AiProviderDiagnostic["operation"] = "chat", metadata: { code?: string; param?: string } = {}): AiError {
  const category: AiProviderDiagnostic["category"] = status === 401 || status === 403 ? "authentication" : status === 429 ? "rate_limit" : status >= 300 && status < 400 ? "redirect" : status === 408 || status === 504 ? "timeout" : status === 409 ? "conflict" : status >= 500 ? "upstream_unavailable" : [400, 404, 405, 406, 413, 415, 422].includes(status) ? "invalid_request" : "rejected";
  const diagnostic: AiProviderDiagnostic = { operation, httpStatus: status, category, billing: isProviderRejection(status) ? "rejected" : "unknown",
    ...(metadata.code && SAFE_ERROR_CODES.has(metadata.code) ? { code: metadata.code } : {}),
    ...(metadata.param && SAFE_ERROR_PARAMS.has(metadata.param) ? { param: metadata.param } : {}),
  };
  const prefix = operation === "image" ? "图片服务" : "AI 服务";
  const http = `（HTTP ${status}）`;
  const failure = (code: string, message: string) => new AiError(502, code, message, false, undefined, diagnostic);
  if (category === "authentication") return failure("AI_PROVIDER_AUTH", `${prefix}密钥无效或无权使用该模型${http}，请管理员检查对应密钥及分组权限`);
  if (category === "rate_limit") return failure("AI_PROVIDER_LIMIT", `${prefix}余额不足或请求过于频繁${http}，请管理员检查服务商账号`);
  if (category === "redirect") return failure("AI_PROVIDER_REDIRECT", `API 地址发生重定向${http}，已为保护密钥停止连接，请填写最终 API 地址`);
  if (category === "timeout" || category === "conflict" || category === "upstream_unavailable" || diagnostic.billing === "unknown") {
    if (operation === "models") return failure("AI_PROVIDER_UNAVAILABLE", `读取模型列表时服务异常${http}，请稍后重新测试连接；本次测试未发起生成`);
    return failure("AI_PROVIDER_UNAVAILABLE", `${prefix}${category === "timeout" ? "处理超时" : category === "conflict" ? "报告请求冲突" : "暂时故障"}${http}，结果与用量待核对；请管理员先核对服务商记录，不要直接重复生成`);
  }
  const hint = diagnostic.code === "content_policy_violation" || diagnostic.code === "moderation_blocked" ? "内容未通过服务商审核" : diagnostic.code === "model_not_found" || diagnostic.code === "model_not_supported" ? "模型不存在或当前分组不支持" : diagnostic.param ? `参数 ${diagnostic.param} 不被当前接口接受` : "请管理员检查对应 API 地址、接口参数、模型名称及密钥分组";
  return failure("AI_PROVIDER_REJECTED", `${prefix}拒绝请求${http}，${hint}`);
}
/** Read a small error envelope, but retain only fixed allowlisted metadata. Never log/return arbitrary upstream text. */
export async function readProviderHttpError(response: Response, operation: AiProviderDiagnostic["operation"]): Promise<AiError> {
  let metadata: { code?: string; param?: string } = {};
  try {
    const root = object(await readBoundedJson(response, 16 * 1024));
    const error = object(root.error);
    metadata = { ...(typeof error.code === "string" ? { code: error.code } : {}), ...(typeof error.param === "string" ? { param: error.param } : {}) };
  } catch { /* Oversized, non-JSON and interrupted error bodies do not erase the received HTTP status. */ }
  return providerHttpError(response.status, operation, metadata);
}
export function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function parseProviderResult(value: unknown, protocol: StoredProvider["protocol"]): { content: string; usage: AiUsage | null; status?: string; sources: AiSource[]; searchCalls: number; completedSearchCalls: number } {
  const root = object(value);
  const sources: AiSource[] = [];
  let searchCalls = 0;
  let completedSearchCalls = 0;
  const addSource = (value: unknown) => { const source = safeSource(value); if (source && sources.length < 30 && !sources.some(item => item.url === source.url)) sources.push(source); };
  if (protocol === "responses" && Array.isArray(root.output)) {
    for (const raw of root.output) {
      const output = object(raw);
      if (output.type === "web_search_call") {
        searchCalls++;
        // An attempted tool can still incur cost, but it is not proof of a completed search.
        if (output.status === "completed") completedSearchCalls++;
        const action = object(output.action);
        if (Array.isArray(action.sources)) action.sources.forEach(addSource);
      }
      if (Array.isArray(output.content)) for (const part of output.content) {
        const annotations = object(part).annotations;
        if (Array.isArray(annotations)) annotations.forEach(item => { const annotation = object(item); if (annotation.type === "url_citation") addSource(annotation); });
      }
    }
  }
  let content = "";
  if (protocol === "responses") {
    if (typeof root.output_text === "string") content = root.output_text;
    else if (Array.isArray(root.output)) content = root.output.flatMap(item => {
      const output = object(item);
      return Array.isArray(output.content) ? output.content.map(part => { const p = object(part); return p.type === "output_text" && typeof p.text === "string" ? p.text : ""; }) : [];
    }).join("");
  } else {
    const choice = Array.isArray(root.choices) ? object(root.choices[0]) : {};
    const message = object(choice.message);
    if (typeof message.content === "string") content = message.content;
  }
  const u = object(root.usage);
  const input = protocol === "responses" ? u.input_tokens : u.prompt_tokens;
  const output = protocol === "responses" ? u.output_tokens : u.completion_tokens;
  const total = u.total_tokens;
  const valid = [input, output, total].every(n => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 1_000_000_000);
  const usage = valid && total === (input as number) + (output as number) && (total as number) > 0
    ? { inputTokens: input as number, outputTokens: output as number, totalTokens: total as number, estimated: false } : null;
  const choice = Array.isArray(root.choices) ? object(root.choices[0]) : {};
  const status = root.error ? "failed" : protocol === "responses" ? typeof root.status === "string" ? root.status : undefined
    : choice.finish_reason === "length" ? "incomplete" : typeof choice.finish_reason === "string" && choice.finish_reason !== "stop" ? "failed" : undefined;
  return { content, usage, sources, searchCalls, completedSearchCalls, status };
}
export function providerBody(provider: StoredProvider, request: AiChatRequest, model: string, maxOutputTokens: number, persona?: AiPersonaProfile): Record<string, unknown> {
  const messages = chatMessages(request);
  const images = request.attachments?.filter(item => item.dataUrl) ?? [];
  const instructions = chatInstructions(request, persona, model);
  if (provider.protocol === "responses") return {
    model, instructions,
    input: messages.map((message, index) => images.length && index === messages.length - 1
      ? { role: message.role, content: [{ type: "input_text", text: message.content }, ...images.map(item => ({ type: "input_image", image_url: item.dataUrl, detail: "low" }))] }
      : message),
    max_output_tokens: maxOutputTokens, stream: true, store: false,
    ...(request.webSearch ? { tools: [{ type: "web_search", search_context_size: "low" }], max_tool_calls: 1, tool_choice: "required", include: ["web_search_call.action.sources"] } : {}),
    ...(request.mode === "deep" && provider.reasoningEffort ? { reasoning: { effort: provider.reasoningEffort } } : {}),
  };
  return {
    model, messages: [{ role: "system", content: instructions }, ...messages.map((message, index) => images.length && index === messages.length - 1
      ? { role: message.role, content: [{ type: "text", text: message.content }, ...images.map(item => ({ type: "image_url", image_url: { url: item.dataUrl, detail: "low" } }))] }
      : message)], max_completion_tokens: maxOutputTokens, stream: false,
    ...(request.mode === "deep" && provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
  };
}
