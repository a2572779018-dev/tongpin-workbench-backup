import type { AiRequestResult, AiChatResponse, AiImageResponse } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";

export function shouldRecoverReply(error: unknown): boolean {
  return error instanceof ApiRequestError && ["AI_REQUEST_IN_PROGRESS", "NETWORK_UNAVAILABLE"].includes(error.code);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** Recovery only reads the original request. It must never submit another generation. */
export async function waitForReply(
  read: (signal: AbortSignal, timeoutMs: number) => Promise<AiRequestResult>,
  signal: AbortSignal,
  deadline = Date.now() + 180_000,
): Promise<AiChatResponse | AiImageResponse> {
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    let cached: AiRequestResult;
    try { cached = await read(signal, Math.min(10_000, deadline - Date.now())); }
    catch (error) {
      signal.throwIfAborted();
      if (!(error instanceof ApiRequestError) || error.code !== "NETWORK_UNAVAILABLE") throw error;
      await pause(Math.min(2_000, Math.max(0, deadline - Date.now())), signal);
      continue;
    }
    signal.throwIfAborted();
    if (cached.result || cached.imageResult) return (cached.result ?? cached.imageResult)!;
    if (cached.error) throw new ApiRequestError(cached.error.status, cached.error.code, cached.error.message);
    if (cached.status !== "pending") throw new ApiRequestError(502, "INVALID_RESPONSE", "生成记录未包含完整回复，请稍后重新获取。");
    await pause(Math.min(2_000, Math.max(0, deadline - Date.now())), signal);
  }
  throw new ApiRequestError(408, "AI_WAIT_TIMEOUT", "等待已超时，暂未取得最终结果。可重新获取同一请求，不会再次调用模型。");
}
