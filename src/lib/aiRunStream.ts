import type { AiChatRequest, AiChatResponse } from "../../shared/ai";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import { ApiRequestError } from "./api";

type StreamApi = <T>(path: string, init?: RequestInit, timeoutMs?: number, responseMode?: "stream") => Promise<T>;
type StreamOptions = { accountId: string; signal: AbortSignal; onEvent?: (event: AiRunEvent) => void };

const STREAM_BYTES_LIMIT = 4 * 1024 * 1024;
const REPLAY_WINDOW_MS = 8_000;
const REPLAY_ATTEMPTS = 8;

class UnsafeEvent extends Error {}
class SequenceGap extends Error {}

const interrupted = (message = "回复连接已断开，正在查询原请求") =>
  new ApiRequestError(0, "AI_STREAM_INTERRUPTED", message);

/** A replay query only reads the accepted request's journal. It never submits
 * the prompt again, so a dropped subscriber cannot create a second charge. */
export async function readAiChatStream(api: StreamApi, request: AiChatRequest, options: StreamOptions): Promise<AiChatResponse> {
  let lastSeq = 0;
  let runId: string | undefined;
  let result: AiChatResponse | undefined;
  const accountHeaders = { "X-Tongpin-Account": options.accountId };
  const checkAbort = () => { if (options.signal.aborted) throw interrupted(); };

  const accept = (raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new UnsafeEvent("回复事件格式无效");
    const event = raw as AiRunEvent;
    if (event.requestId !== request.requestId || typeof event.runId !== "string" || !event.runId ||
        event.stepId !== request.requestId ||
        !Number.isSafeInteger(event.seq) || event.seq < 0 ||
        (runId !== undefined && event.runId !== runId)) throw new UnsafeEvent("回复事件标识不正确");
    if (event.type === "answer_delta" || event.type === "public_summary_delta") {
      if (typeof event.data?.delta !== "string") throw new UnsafeEvent("回复增量格式无效");
    } else if (event.type === "run_finished") {
      if (!event.data?.response || event.data.response.requestId !== request.requestId ||
          typeof event.data.response.content !== "string") throw new UnsafeEvent("回复结果标识不正确");
    } else if (event.type === "run_failed") {
      if (typeof event.data?.error?.code !== "string" || typeof event.data.error.message !== "string")
        throw new UnsafeEvent("回复失败事件格式无效");
      // An explicit terminal failure must not be mistaken for a dropped socket.
      throw new ApiRequestError(502, event.data.error.code, event.data.error.message);
    } else if (event.type !== "run_started" || typeof event.data?.startedAt !== "number") {
      throw new UnsafeEvent("回复事件类型无效");
    }
    if (event.seq <= lastSeq) {
      // A completed request can be reopened with an unjournaled seq=0 finish.
      if (event.seq !== 0 || event.type !== "run_finished" || runId !== undefined) return;
    } else if (event.seq !== lastSeq + 1) {
      throw new SequenceGap("回复事件缺失");
    }
    checkAbort();
    runId ??= event.runId;
    if (event.seq > lastSeq) lastSeq = event.seq;
    if (event.type === "run_finished") result = event.data.response;
    options.onEvent?.(event);
  };

  const pause = (delayMs: number) => new Promise<void>((resolve, reject) => {
    if (options.signal.aborted) { reject(interrupted()); return; }
    const onAbort = () => { clearTimeout(timer); reject(interrupted()); };
    const timer = setTimeout(() => { options.signal.removeEventListener("abort", onAbort); resolve(); }, delayMs);
    options.signal.addEventListener("abort", onAbort, { once: true });
  });

  const replay = async (): Promise<AiChatResponse> => {
    const deadline = Date.now() + REPLAY_WINDOW_MS;
    for (let attempt = 0; attempt < REPLAY_ATTEMPTS && Date.now() < deadline; attempt++) {
      checkAbort();
      let payload: { events: unknown[] } | undefined;
      try {
        payload = await api<{ events: unknown[] }>(
          `/api/ai/requests/${encodeURIComponent(request.requestId)}/events?after=${lastSeq}`,
          { headers: accountHeaders, signal: options.signal },
          Math.min(3_000, deadline - Date.now()),
        );
      } catch (error) {
        checkAbort();
        if (error instanceof ApiRequestError && (error.status === 401 || error.status === 403)) throw error;
        // A transient unavailable/404 journal may appear before the accepted
        // POST is recorded. The caller's result query handles a longer wait.
        if (!(error instanceof ApiRequestError && (error.status === 0 || error.status === 404 || error.status >= 500)) &&
            !(error instanceof TypeError)) throw error;
      }
      if (payload) {
        if (!Array.isArray(payload.events) || payload.events.length > 512) throw new UnsafeEvent("回复事件列表无效");
        for (const event of payload.events) accept(event);
        if (result) return result;
        // The server pages at 512 events. Drain the next page immediately.
        if (payload.events.length === 512) continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await pause(Math.min(remaining, 150 * 2 ** Math.min(attempt, 4)));
    }
    throw interrupted();
  };
  const recoverFromJournal = async (): Promise<AiChatResponse> => {
    try { return await replay(); }
    catch (error) {
      if (error instanceof UnsafeEvent || error instanceof SequenceGap)
        throw new ApiRequestError(502, "AI_STREAM_INTERRUPTED", error.message);
      throw error;
    }
  };

  let response: Response;
  try {
    checkAbort();
    response = await api<Response>("/api/ai/chat/stream", {
      method: "POST", body: JSON.stringify(request), headers: accountHeaders, signal: options.signal,
    }, 130_000, "stream");
  } catch (error) {
    checkAbort();
    if (error instanceof ApiRequestError && error.status === 0 || error instanceof TypeError) return recoverFromJournal();
    throw error;
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) return recoverFromJournal();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  const timer = setTimeout(cancel, 130_000);
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!result) {
      checkAbort();
      let next: ReadableStreamReadResult<Uint8Array>;
      try { next = await reader.read(); }
      catch { break; }
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > STREAM_BYTES_LIMIT) throw new UnsafeEvent("回复数据超出传输上限");
      buffer += decoder.decode(next.value, { stream: true });
      let split: RegExpExecArray | null;
      while ((split = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, split.index);
        buffer = buffer.slice(split.index + split[0].length);
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        let event: unknown;
        try { event = JSON.parse(data); } catch { throw new UnsafeEvent("回复事件格式无效"); }
        if (event && typeof event === "object" && (event as { type?: string }).type === "request_error") {
          const failure = (event as { data?: { error?: { code?: string; message?: string } } }).data?.error;
          throw new ApiRequestError(502, failure?.code ?? "AI_STREAM_INTERRUPTED", failure?.message ?? "回复请求失败");
        }
        accept(event);
        if (result) break;
      }
    }
  } catch (error) {
    checkAbort();
    if (error instanceof SequenceGap) { /* Replay the missing journal entry. */ }
    else if (error instanceof UnsafeEvent) throw new ApiRequestError(502, "AI_STREAM_INTERRUPTED", error.message);
    else throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", cancel);
    try { await reader.cancel(); } catch { /* Network already closed. */ }
    reader.releaseLock();
  }
  checkAbort();
  if (result) return result;
  // EOF, a transport timeout, a partial frame, or a sequence gap resume from
  // the highest contiguous event. No additional POST occurs.
  return recoverFromJournal();
}
