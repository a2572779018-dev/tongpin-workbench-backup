import type { AiChatRequest, AiSource, AiUsage } from "../../shared/ai";
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
async function readBoundedText(response: Response, maxBytes = 2_000_000): Promise<string> {
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
export function providerHttpError(status: number): AiError {
  if (status === 401 || status === 403) return new AiError(502, "AI_PROVIDER_AUTH", "API 密钥无效或无权使用该模型，请管理员检查配置");
  if (status === 429) return new AiError(502, "AI_PROVIDER_LIMIT", "AI 服务余额不足或请求过于频繁，请管理员检查服务商账号");
  if (status >= 300 && status < 400) return new AiError(502, "AI_PROVIDER_REDIRECT", "API 地址发生重定向，已为保护密钥停止连接，请填写最终 API 地址");
  return new AiError(502, "AI_PROVIDER_REJECTED", "AI 服务拒绝请求，请管理员检查 API 地址、接口协议及模型名称");
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
