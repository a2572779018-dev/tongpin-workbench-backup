import { AiError } from "./security";
import { createSearchStreamGuard } from "./searchStreamGuard";
import { createStreamedAnnotations } from "./citations";
import type { AiToolProgress } from "../../shared/aiRunEvents";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export interface ProviderReadOptions {
  maxSearchCalls?: number;
  onTextDelta?: (delta: string) => void;
  /** Only provider-designated public summaries (`response.reasoning_summary_text.*`).
   * Raw `response.reasoning_text.*` is private reasoning and is never passed here. */
  onPublicSummaryDelta?: (delta: string) => void;
  /** Reserved; raw `reasoning_content` is private and is not forwarded. */
  onProviderReasoningDelta?: (delta: string) => void;
  /** Real Responses `web_search_call` lifecycle, deduplicated per status. */
  onToolProgress?: (progress: AiToolProgress) => void;
}

const QUERY_LIMIT = 200;
function publicQuery(action: Record<string, unknown>): string | undefined {
  const raw = typeof action.query === "string" ? action.query
    : Array.isArray(action.queries) ? action.queries.filter((item): item is string => typeof item === "string").join(" · ") : undefined;
  if (!raw) return undefined;
  const clean = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? [...clean].slice(0, QUERY_LIMIT).join("") : undefined;
}

/** Tracks public reasoning-summary parts so multi-part summaries stay readable,
 * and a `.done` event only fills in a part whose deltas never arrived. */
function createSummaryTracker(emit: (delta: string) => void) {
  const streamed = new Set<string>();
  let lastKey: string | undefined;
  const key = (value: Record<string, unknown>) => `${typeof value.item_id === "string" ? value.item_id : Number.isSafeInteger(value.output_index) ? value.output_index : ""}:${Number.isSafeInteger(value.summary_index) ? value.summary_index : 0}`;
  const send = (partKey: string, text: string) => {
    if (!text) return;
    if (lastKey !== undefined && lastKey !== partKey) emit("\n\n");
    lastKey = partKey; streamed.add(partKey); emit(text);
  };
  return {
    delta(value: Record<string, unknown>) { if (typeof value.delta === "string") send(key(value), value.delta); },
    done(value: Record<string, unknown>) {
      const partKey = key(value);
      if (!streamed.has(partKey) && typeof value.text === "string") send(partKey, value.text);
    },
  };
}

/** Maps Responses `web_search_call` events to deduplicated public progress.
 * Only status, the provider-reported query and a source count leave here. */
function createSearchProgress(emit: (progress: AiToolProgress) => void) {
  const calls = new Map<string, { callId: string; status: AiToolProgress["status"]; query?: string; sourceCount?: number; emitted: boolean }>();
  const byItem = new Map<string, string>();
  const resolve = (value: Record<string, unknown>, item: Record<string, unknown>) => {
    const itemId = typeof item.id === "string" ? item.id : typeof value.item_id === "string" ? value.item_id : undefined;
    const key = Number.isSafeInteger(value.output_index) ? `index:${value.output_index}` : itemId ? byItem.get(itemId) ?? `id:${itemId}` : undefined;
    if (!key) return undefined;
    if (itemId) byItem.set(itemId, key);
    let call = calls.get(key);
    if (!call) { call = { callId: `search-${calls.size + 1}`, status: "in_progress", emitted: false }; calls.set(key, call); }
    return call;
  };
  const update = (call: NonNullable<ReturnType<typeof resolve>>, status: AiToolProgress["status"], item: Record<string, unknown>) => {
    const action = record(item.action);
    const query = publicQuery(action) ?? call.query;
    const sourceCount = Array.isArray(action.sources) ? action.sources.length : call.sourceCount;
    // A terminal state is final; late in_progress/searching events never regress it.
    if ((call.status === "completed" || call.status === "failed") && status !== call.status) return;
    const changed = !call.emitted || status !== call.status || query !== call.query || sourceCount !== call.sourceCount;
    call.status = status; call.query = query; call.sourceCount = sourceCount;
    if (!changed) return;
    call.emitted = true;
    emit({ tool: "web_search", callId: call.callId, status, ...(query ? { query } : {}), ...(sourceCount !== undefined ? { sourceCount } : {}) });
  };
  return (value: Record<string, unknown>) => {
    const type = value.type;
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = record(value.item);
      if (item.type !== "web_search_call") return;
      const call = resolve(value, item);
      if (!call) return;
      const status = type === "response.output_item.added" ? (call.status === "searching" ? "searching" : "in_progress")
        : item.status === "failed" || item.status === "incomplete" ? "failed" : "completed";
      update(call, status, item);
      return;
    }
    const match = typeof type === "string" ? /^response\.web_search_call\.(in_progress|searching|completed)$/.exec(type) : null;
    if (!match) return;
    const call = resolve(value, {});
    if (call) update(call, match[1] as AiToolProgress["status"], {});
  };
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
  const summary = options.onPublicSummaryDelta ? createSummaryTracker(options.onPublicSummaryDelta) : undefined;
  const searchProgress = options.onToolProgress ? createSearchProgress(options.onToolProgress) : undefined;
  // Citation positions a gateway only streams; merged into the terminal envelope below.
  const annotations = createStreamedAnnotations();
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
    // Only the provider-designated public summary channel is displayed.
    // `response.reasoning_text.*` carries raw reasoning content (a
    // `content_index` part, not a `summary_index` part) and is always dropped.
    if (value.type === "response.reasoning_summary_text.delta") summary?.delta(value);
    if (value.type === "response.reasoning_summary_text.done") summary?.done(value);
    searchProgress?.(value);
    annotations.observe(value);
    if (value.type === "response.completed" || value.type === "response.incomplete") terminal = { ...record(value.response), status: value.type === "response.incomplete" ? "incomplete" : "completed" };
    if (Array.isArray(value.choices)) {
      chat = true;
      const choice = record(value.choices[0]);
      const delta = record(choice.delta);
      // `reasoning_content` (e.g. Qwen) is the model's raw thinking, not an
      // official public summary: never displayed or stored.
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
  if (terminal) { guard?.inspectResponse(terminal); return annotations.attach(terminal); }
  if (chat && chatFinish) return { choices: [{ message: { content: text }, finish_reason: chatFinish }], usage: chatUsage };
  if (text) return chat
    ? { choices: [{ message: { content: text }, finish_reason: "length" }], incomplete_details: { reason: "stream_interrupted" } }
    : { output_text: text, status: "incomplete", incomplete_details: { reason: "stream_interrupted" } };
  throw new AiError(502, "AI_STREAM_INTERRUPTED", "AI 数据流中断，用量暂按预留上限记录，请管理员核对");
}
