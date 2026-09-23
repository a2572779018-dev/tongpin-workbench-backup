import { AiError } from "./security";
import { createSearchStreamGuard } from "./searchStreamGuard";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface ProviderReadOptions {
  maxSearchCalls?: number;
  onTextDelta?: (delta: string) => void;
  /** Only provider-designated public summaries, never reasoning_content. */
  onPublicSummaryDelta?: (delta: string) => void;
}

/** Incremental SSE decoding. No terminal envelope is invented after a disconnect;
 * readable output is returned as incomplete and usage remains unknown. */
export async function consumeProviderResponse(response: Response, options: ProviderReadOptions = {}): Promise<unknown> {
  if (!response.body) throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务没有返回有效内容");
  const guard = options.maxSearchCalls === undefined ? undefined : createSearchStreamGuard(options.maxSearchCalls);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", bytes = 0, sse: boolean | undefined = response.headers.get("content-type")?.includes("text/event-stream") ? true : undefined;
  let text = "", terminal: Record<string, unknown> | undefined, chatFinish: string | undefined, chatUsage: unknown;
  let chat = false;
  const seen = new Set<number>();
  const event = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let value: Record<string, unknown>;
    try { value = record(JSON.parse(data)); }
    catch { throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回了损坏的数据流"); }
    if (Number.isSafeInteger(value.sequence_number)) {
      const seq = value.sequence_number as number;
      if (seen.has(seq)) return;
      seen.add(seq);
    }
    if (value.type === "error" || value.type === "response.failed") throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务未完成生成，请管理员检查模型和接口配置");
    if (value.type === "response.output_text.delta" && typeof value.delta === "string") {
      text += value.delta; options.onTextDelta?.(value.delta);
    }
    if (value.type === "response.reasoning_summary_text.delta" && typeof value.delta === "string") options.onPublicSummaryDelta?.(value.delta);
    if (value.type === "response.completed" || value.type === "response.incomplete") terminal = { ...record(value.response), status: value.type === "response.incomplete" ? "incomplete" : "completed" };
    if (Array.isArray(value.choices)) {
      chat = true;
      const choice = record(value.choices[0]);
      const delta = record(choice.delta);
      if (typeof delta.content === "string") { text += delta.content; options.onTextDelta?.(delta.content); }
      if (typeof choice.finish_reason === "string") chatFinish = choice.finish_reason;
      if (value.usage) chatUsage = value.usage;
    }
  };
  const feed = (chunk: string, final = false) => {
    guard?.feed(chunk, final);
    buffer += chunk;
    if (sse === undefined && buffer.trimStart()) sse = /^(?:data:|event:|:)/.test(buffer.trimStart()) ? true : buffer.trimStart().startsWith("{") ? false : undefined;
    if (sse) {
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        event(block);
      }
      if (final && buffer.trim()) { event(buffer); buffer = ""; }
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 2_000_000) throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 返回内容过大");
      feed(decoder.decode(value, { stream: true }));
    }
    feed(decoder.decode(), true);
  } catch (error) {
    try { await reader.cancel(); } catch { /* Preserve original diagnostic. */ }
    // Budget, malformed JSON, and explicit failures stay strict. A transport
    // disconnect can preserve only ordinary text, never a parsed tool action.
    if (error instanceof AiError || !text) throw error instanceof AiError ? error : new AiError(502, "AI_STREAM_INTERRUPTED", "AI 数据流中断，用量待核对");
    chatFinish = undefined; terminal = undefined;
  } finally { reader.releaseLock(); }
  if (!sse) {
    try { const value: unknown = JSON.parse(buffer); guard?.inspectResponse(value); return value; }
    catch (error) { if (error instanceof AiError) throw error; throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回格式不正确，请检查接口协议和模型名称"); }
  }
  if (terminal) { guard?.inspectResponse(terminal); return terminal; }
  if (chat && chatFinish) return { choices: [{ message: { content: text }, finish_reason: chatFinish }], usage: chatUsage };
  if (text) return chat
    ? { choices: [{ message: { content: text }, finish_reason: "length" }], incomplete_details: { reason: "stream_interrupted" } }
    : { output_text: text, status: "incomplete", incomplete_details: { reason: "stream_interrupted" } };
  throw new AiError(502, "AI_STREAM_INTERRUPTED", "AI 数据流中断，用量暂按预留上限记录，请管理员核对");
}
