import { describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiChatResponse } from "../../shared/ai";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import { ApiRequestError } from "./api";
import { readAiChatStream } from "./aiRunStream";

const request: AiChatRequest = {
  requestId: "request-123456789",
  conversationId: "conversation-a",
  mode: "quick",
  messages: [{ role: "user", content: "hello" }],
};

const response: AiChatResponse = {
  requestId: request.requestId,
  content: "complete",
  model: "快速",
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false },
  quota: { limitTokens: 100, usedTokens: 2, reservedTokens: 0, remainingTokens: 98, inputTokens: 1, outputTokens: 1 },
};

const event = (seq: number, type: AiRunEvent["type"], data: AiRunEvent["data"]): AiRunEvent => ({
  requestId: request.requestId,
  runId: "run-a",
  stepId: request.requestId,
  seq,
  timestamp: 1_000 + seq,
  type,
  data,
} as AiRunEvent);

function eventResponse(events: AiRunEvent[], fragmentSize = 9): Response {
  const encoded = new TextEncoder().encode(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < encoded.length; offset += fragmentSize) controller.enqueue(encoded.slice(offset, offset + fragmentSize));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

describe("AI run stream decoder", () => {
  it("decodes fragmented ordered events, ignores exact sequence replay, and never posts twice", async () => {
    const events = [
      event(1, "run_started", { startedAt: 1 }),
      event(1, "run_started", { startedAt: 1 }),
      event(2, "answer_delta", { delta: "complete" }),
      event(3, "run_finished", { response }),
    ];
    const call = vi.fn();
    const api = async <T,>(): Promise<T> => { call(); return eventResponse(events, 3) as T; };
    const seen: number[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value.seq) })).resolves.toEqual(response);
    expect(seen).toEqual([1, 2, 3]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a sequence gap without issuing a recovery POST", async () => {
    const call = vi.fn();
    const api = async <T,>(): Promise<T> => {
      call();
      return eventResponse([event(1, "run_started", { startedAt: 1 }), event(3, "run_finished", { response })]) as T;
    };
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("rejects an event for another request and does not surface its content", async () => {
    const injected = { ...event(1, "answer_delta", { delta: "other tenant content" }), requestId: "request-other-tenant" };
    const call = vi.fn();
    const api = async <T,>(): Promise<T> => { call(); return eventResponse([injected]) as T; };
    const seen = vi.fn();
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: seen }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("turns a caller abort into a recoverable interruption and cancels the reader", async () => {
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel: cancelled });
    const call = vi.fn();
    const api = async <T,>(): Promise<T> => { call(); return new Response(stream, { headers: { "content-type": "text/event-stream" } }) as T; };
    const controller = new AbortController();
    controller.abort();
    let failure: unknown;
    try { await readAiChatStream(api, request, { accountId: "member", signal: controller.signal }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ status: 0, code: "AI_STREAM_INTERRUPTED" });
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });
});
