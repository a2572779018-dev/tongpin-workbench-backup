import type { AiRunEvent } from "../../shared/aiRunEvents";
import { AiError } from "./security";
import type { AiService } from "./service";

/** Streaming is an additional protocol. Legacy /chat JSON remains available.
 * A disconnected subscriber never triggers an automatic provider resubmit. */
export function createChatStreamResponse(service: AiService, userId: string, body: unknown, keepAlive?: (task: Promise<void>) => void): Response {
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let terminal = false;
      const send = (value: AiRunEvent | { type: "request_error"; data: { error: { code: string; message: string } } }) => {
        terminal ||= value.type === "run_finished" || value.type === "run_failed";
        if (!closed) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { closed = true; } }
      };
      const task = service.chat(userId, body, { stream: true, onEvent: send }).then(response => {
        // Reopening a completed request is a ledger read, not a generation.
        if (!terminal) {
          const events = service.getRunEvents(userId, response.requestId);
          const final = [...events].reverse().find(event => event.type === "run_finished");
          if (final) send(final);
          else send({ requestId: response.requestId, runId: response.attempt?.runId ?? response.requestId, stepId: response.requestId, seq: 0, timestamp: Date.now(), type: "run_finished", data: { response } });
        }
      }).catch(error => {
        if (!terminal) send({ type: "request_error", data: { error: error instanceof AiError ? { code: error.code, message: error.message } : { code: "AI_SERVER_ERROR", message: "AI 服务处理失败，请查询原请求结果" } } });
      }).finally(() => { if (!closed) { closed = true; controller.close(); } });
      // A client may leave the page after submission. In a Durable Object the
      // host must keep this accepted request alive independently of the SSE
      // subscriber; cancellation of the stream only stops delivery, not work.
      keepAlive?.(task);
    },
    cancel() { closed = true; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
