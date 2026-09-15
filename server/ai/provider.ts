import type { AiChatRequest, AiProviderDiagnostic, AiSource, AiUsage } from "../../shared/ai";
import type { StoredProvider } from "./storage";
import { AiError } from "./security";
import { chatInstructions, chatMessages, safeSource } from "./capabilities";
import type { AiPersonaProfile } from "../../shared/aiPersona";
import { createSearchStreamGuard } from "./searchStreamGuard";
import { AI_WORKSPACE_LIMITS } from "../../shared/aiWorkspace";

export interface AiTransportInit {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  maxResponseBytes?: number;
}
export type AiTransport = (url: string, init: AiTransportInit) => Promise<Response>;
export const AI_TIMEOUT_MS = 120_000;
export async function readBoundedText(response: Response, maxBytes = 2_000_000, inspect?: (chunk: string, final: boolean) => void): Promise<string> {
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
      const chunk = decoder.decode(value, { stream: true });
      text += chunk;
      inspect?.(chunk, false);
    }
    const final = decoder.decode();
    inspect?.(final, true);
    return text + final;
  } catch (error) {
    // Cancel the body immediately when a budget/parser guard fails; do not keep draining paid work.
    try { await reader.cancel(); } catch { /* Keep the original bounded diagnostic. */ }
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
export async function readProviderResponse(response: Response, options: { maxSearchCalls?: number } = {}): Promise<unknown> {
  const guard = options.maxSearchCalls === undefined ? undefined : createSearchStreamGuard(options.maxSearchCalls);
  const text = await readBoundedText(response, 2_000_000, guard?.feed);
  if (!response.headers.get("content-type")?.includes("text/event-stream") && !text.trimStart().startsWith("event:") && !text.trimStart().startsWith("data:")) {
    try { const value = JSON.parse(text) as unknown; guard?.inspectResponse(value); return value; }
    catch (error) { if (error instanceof AiError) throw error; throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回格式不正确，请检查接口协议和模型名称"); }
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
  // Also reconcile events arriving after the terminal envelope before accepting its usage.
  guard?.inspectResponse(completed);
  return completed;
}
/** Only explicit pre-generation HTTP refusals release a reservation. A timeout/conflict may follow paid work. */
export function isProviderRejection(status: number): boolean {
  return (status >= 300 && status < 400) || [400, 401, 403, 404, 405, 406, 410, 411, 413, 414, 415, 422, 429].includes(status);
}
// Provider error fields can echo credentials or prompts. Even syntactically safe arbitrary strings are not safe to expose.
const SAFE_ERROR_CODES = new Set(["invalid_api_key", "invalid_request_error", "invalid_value", "invalid_parameter", "unsupported_parameter", "unknown_parameter", "model_not_found", "model_not_supported", "permission_denied", "insufficient_quota", "rate_limit_exceeded", "content_policy_violation", "moderation_blocked", "server_error", "internal_error", "service_unavailable", "upstream_error", "timeout", "request_timeout", "no_available_compatible_accounts"]);
const SAFE_ERROR_PARAMS = new Set(["model", "size", "quality", "n", "prompt", "stream", "response_format", "output_format", "background", "moderation", "partial_images", "max_output_tokens", "max_completion_tokens", "reasoning_effort", "reasoning.effort", "tools", "tool_choice", "max_tool_calls", "include", "store", "search_context_size"]);
function safeErrorParam(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (SAFE_ERROR_PARAMS.has(value)) return value;
  if (/^tools\[\]\.(?:type|search_context_size|external_web_access)$/.test(value)) return value;
  // Some compatible gateways identify a rejected nested parameter instead of the top-level field.
  // Emit only fixed field names; arbitrary indices/paths can contain prompt or credential material.
  if (/^tools(?:\[\d{1,3}\]|\.\d{1,3})\.(?:type|search_context_size|external_web_access)$/.test(value)) return `tools[].${value.slice(value.lastIndexOf(".") + 1)}`;
  return undefined;
}
type ProviderErrorMetadata = Pick<AiProviderDiagnostic, "code" | "param" | "responseKind" | "gatewaySignal" | "cfRay">;
function safeCfRay(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/.test(value) ? value : undefined;
}
export function providerHttpError(status: number, operation: AiProviderDiagnostic["operation"] = "chat", metadata: ProviderErrorMetadata = {}): AiError {
  const code = metadata.code && SAFE_ERROR_CODES.has(metadata.code) ? metadata.code : undefined;
  const gatewaySignal = metadata.gatewaySignal === "cloudflare_challenge" || metadata.gatewaySignal === "cloudflare_block_page" ? metadata.gatewaySignal : undefined;
  const responseKind = ["json", "html", "text", "empty", "unknown"].includes(metadata.responseKind ?? "") ? metadata.responseKind : undefined;
  const cfRay = safeCfRay(metadata.cfRay);
  // A 403 alone cannot establish that a key is invalid. A CDN Ray ID alone cannot establish a WAF block either.
  const category: AiProviderDiagnostic["category"] = (status === 401 || status === 403) && gatewaySignal ? "gateway_block"
    : status === 401 || status === 403 && code === "invalid_api_key" ? "authentication"
    : status === 403 && ["permission_denied", "model_not_found", "model_not_supported"].includes(code ?? "") ? "permission"
    : status === 403 ? "access_denied"
    : status === 429 ? "rate_limit" : status >= 300 && status < 400 ? "redirect" : status === 408 || status === 504 ? "timeout" : status === 409 ? "conflict" : status >= 500 ? "upstream_unavailable" : [400, 404, 405, 406, 413, 415, 422].includes(status) ? "invalid_request" : "rejected";
  const param = safeErrorParam(metadata.param);
  const diagnostic: AiProviderDiagnostic = { operation, httpStatus: status, category, billing: isProviderRejection(status) ? "rejected" : "unknown",
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    ...(responseKind ? { responseKind } : {}),
    ...(gatewaySignal ? { gatewaySignal } : {}),
    ...(cfRay ? { cfRay } : {}),
  };
  const prefix = operation === "image" ? "图片服务" : operation === "video" ? "视频服务" : "AI 服务";
  const http = `（HTTP ${status}）`;
  const failure = (code: string, message: string) => new AiError(502, code, message, false, undefined, diagnostic);
  if (category === "authentication") return failure("AI_PROVIDER_AUTH", `${prefix}身份验证失败${http}，请管理员检查对应 API 密钥是否有效`);
  if (category === "gateway_block") return failure("AI_PROVIDER_GATEWAY_BLOCK", `${prefix}请求被服务商安全网关拦截${http}，请管理员联系服务商核查拦截记录；这不等于密钥失效`);
  if (category === "permission") return failure("AI_PROVIDER_PERMISSION", `${prefix}明确拒绝当前模型权限${http}，请管理员检查该密钥的模型与分组权限`);
  if (category === "access_denied") return failure("AI_PROVIDER_ACCESS_DENIED", `${prefix}拒绝访问${http}，${code === "content_policy_violation" || code === "moderation_blocked" ? "内容未通过服务商审核" : "尚不能确定是密钥、模型权限还是安全策略限制，请管理员核对本次失败记录"}`);
  if (category === "rate_limit") return failure("AI_PROVIDER_LIMIT", `${prefix}余额不足或请求过于频繁${http}，请管理员检查服务商账号`);
  if (category === "redirect") return failure("AI_PROVIDER_REDIRECT", `API 地址发生重定向${http}，已为保护密钥停止连接，请填写最终 API 地址`);
  if (category === "timeout" || category === "conflict" || category === "upstream_unavailable" || diagnostic.billing === "unknown") {
    if (operation === "models") return failure("AI_PROVIDER_UNAVAILABLE", `读取模型列表时服务异常${http}，请稍后重新测试连接；本次测试未发起生成`);
    if (diagnostic.code === "no_available_compatible_accounts") return failure("AI_PROVIDER_UNAVAILABLE", `${prefix}暂无可用兼容通道${http}，需要服务商恢复对应模型通道；结果与用量待核对，请勿直接重复生成`);
    return failure("AI_PROVIDER_UNAVAILABLE", `${prefix}${category === "timeout" ? "处理超时" : category === "conflict" ? "报告请求冲突" : "暂时故障"}${http}，结果与用量待核对；请管理员先核对服务商记录，不要直接重复生成`);
  }
  const hint = diagnostic.code === "content_policy_violation" || diagnostic.code === "moderation_blocked" ? "内容未通过服务商审核" : diagnostic.code === "model_not_found" || diagnostic.code === "model_not_supported" ? "模型不存在或当前分组不支持" : diagnostic.param ? `参数 ${diagnostic.param} 不被当前接口接受` : "请管理员检查对应 API 地址、接口参数、模型名称及密钥分组";
  return failure("AI_PROVIDER_REJECTED", `${prefix}拒绝请求${http}，${hint}`);
}
/** Read a small error envelope, but retain only fixed allowlisted metadata. Never log/return arbitrary upstream text. */
export async function readProviderHttpError(response: Response, operation: AiProviderDiagnostic["operation"]): Promise<AiError> {
  const cfRay = safeCfRay(response.headers.get("cf-ray"));
  const metadata: ProviderErrorMetadata = {
    responseKind: "unknown",
    ...(cfRay ? { cfRay } : {}),
    ...(response.headers.get("cf-mitigated") === "challenge" ? { gatewaySignal: "cloudflare_challenge" } : {}),
  };
  try {
    const text = response.body ? await readBoundedText(response, 16 * 1024) : "";
    const html = /^\s*(?:<!doctype\s+html\b|<html\b)/i.test(text);
    metadata.responseKind = !text.trim() ? "empty" : html ? "html" : "text";
    // Recognize a known HTML block template only with Cloudflare header evidence.
    // The document itself is never retained, logged or sent to the client.
    if (html && (cfRay || response.headers.get("server")?.toLowerCase() === "cloudflare")
      && /Sorry, you have been blocked/i.test(text) && /(?:cf-error-details|Cloudflare Ray ID)/i.test(text)
      && !metadata.gatewaySignal) metadata.gatewaySignal = "cloudflare_block_page";
    const root = object(JSON.parse(text));
    metadata.responseKind = "json";
    const error = object(root.error);
    // OpenAI-compatible errors sometimes put invalid_request_error in type while code is null.
    const code = [error.code, error.type].find(value => typeof value === "string" && SAFE_ERROR_CODES.has(value));
    if (typeof code === "string") metadata.code = code;
    metadata.param = safeErrorParam(error.param);
    // Observed Codex-compatible gateway refusal: no code/param, only this exact message.
    // An anchored, known-field match is diagnostic evidence, never permission to echo arbitrary text.
    const unsupported = typeof error.message === "string" ? /^Unsupported parameter: ([a-z_]+)$/.exec(error.message) : null;
    if (unsupported && SAFE_ERROR_PARAMS.has(unsupported[1]) && !metadata.param) {
      metadata.code = typeof code === "string" ? code : "unsupported_parameter";
      metadata.param = unsupported[1];
    }
    if (error.message === "No available compatible accounts") metadata.code = "no_available_compatible_accounts";
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
  if (content.length > AI_WORKSPACE_LIMITS.messageCharacters) throw new AiError(502, "AI_RESPONSE_TOO_LONG", "AI 回复超出可保存长度，未将截断内容作为完整回复；用量待管理员核对，请勿直接重复发送");
  if (content.includes("\u0000")) throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 回复包含无法保存的字符，用量待管理员核对；请勿直接重复发送");
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
    ...(request.webSearch ? { tools: [{ type: "web_search", search_context_size: "low" }], ...(provider.webSearchProtocol === "compatible" ? {} : { max_tool_calls: 1 }), tool_choice: request.webSearchMode === "auto" ? "auto" : "required", include: ["web_search_call.action.sources"] } : {}),
    ...(request.mode === "deep" && provider.reasoningEffort ? { reasoning: { effort: provider.reasoningEffort } } : {}),
  };
  const isBaiChat = new URL(provider.baseUrl).hostname === "api.b.ai";
  return {
    model, messages: [{ role: "system", content: instructions }, ...messages.map((message, index) => images.length && index === messages.length - 1
      ? { role: message.role, content: [{ type: "text", text: message.content }, ...images.map(item => ({ type: "image_url", image_url: { url: item.dataUrl, detail: "low" } }))] }
      : message)], ...(isBaiChat ? { max_tokens: maxOutputTokens } : { max_completion_tokens: maxOutputTokens }), stream: false,
    ...(!isBaiChat && request.mode === "deep" && provider.reasoningEffort ? { reasoning_effort: provider.reasoningEffort } : {}),
  };
}
