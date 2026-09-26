import { AI_MAX_SEARCH_CALLS } from "../../shared/ai";
import { AiError } from "./security";

function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Detect over-budget tool invocations while bytes arrive. Cancellation cannot guarantee upstream billing stopped. */
export function createSearchStreamGuard(maxCalls: number) {
  if (!Number.isInteger(maxCalls) || maxCalls < 0 || maxCalls > AI_MAX_SEARCH_CALLS) throw new Error("Invalid local search budget");
  let pending = "";
  const seen = new Set<string>();
  const limit = (count: number) => {
    if (count > maxCalls) throw new AiError(502, "AI_SEARCH_LIMIT_EXCEEDED", "搜索调用超过本次预留预算，已停止接收；服务商可能仍在处理，请管理员核对用量，不要直接重复发送");
  };
  const inspectResponse = (value: unknown) => {
    const output = record(value).output;
    const count = Array.isArray(output) ? output.filter(item => record(item).type === "web_search_call").length : 0;
    limit(count);
    // A terminal envelope may omit start/done events, but it cannot erase calls already observed.
    // Do not accept its lower count as actual billing or synthesize a successful tool result.
    if (seen.size > count) throw new AiError(502, "AI_SEARCH_USAGE_MISMATCH", "搜索数据流与最终调用记录不一致，用量待管理员核对；请勿直接重复发送");
  };
  const inspectEvent = (value: unknown) => {
    const event = record(value);
    if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
      const item = record(event.item);
      if (item.type === "web_search_call") {
        // output_index is stable across added/done events, unlike different event/request IDs.
        const key = Number.isSafeInteger(event.output_index) && Number(event.output_index) >= 0
          ? `index:${event.output_index}` : typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 ? `id:${item.id}` : null;
        if (!key) throw new AiError(502, "AI_PROVIDER_RESPONSE", "搜索数据流缺少调用标识，用量待管理员核对");
        seen.add(key); limit(seen.size);
      }
    }
    if (event.type === "response.completed" || event.type === "response.incomplete") inspectResponse(event.response);
  };
  const inspectBlock = (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let value: unknown;
    try { value = JSON.parse(data); } catch { throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回了损坏的数据流"); }
    inspectEvent(value);
  };
  return {
    feed(chunk: string, final: boolean) {
      pending += chunk;
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        inspectBlock(pending.slice(0, separator.index));
        pending = pending.slice(separator.index + separator[0].length);
      }
      if (final && pending.trim()) { inspectBlock(pending); pending = ""; }
    },
    inspectResponse,
  };
}
