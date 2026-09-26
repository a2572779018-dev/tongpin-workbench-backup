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
  it("accepts the server's request-id conversation fallback for an older request without conversationId", async () => {
    const olderRequest: AiChatRequest = { ...request, conversationId: undefined };
    const finished: AiChatResponse = { ...response, richContent: { version: 1, blocks: [{ id: "markdown:0", kind: "markdown", start: 0, end: response.content.length }] } };
    const versioned = (seq: number, type: AiRunEvent["type"], data: AiRunEvent["data"]) => ({
      ...event(seq, type, data), schemaVersion: 1 as const, eventId: `${request.requestId}:${seq}`,
      attemptId: request.requestId, conversationId: request.requestId,
    }) as AiRunEvent;
    const api = async <T,>() => eventResponse([
      versioned(1, "run_started", { startedAt: 1 }),
      versioned(2, "run_finished", { response: finished }),
    ]) as T;
    await expect(readAiChatStream(api, olderRequest, { accountId: "member", signal: new AbortController().signal })).resolves.toEqual(finished);
  });

  it("accepts old events but rejects an invalid versioned rich-content span before displaying it", async () => {
    const badResponse: AiChatResponse = { ...response, richContent: { version: 1, blocks: [{ id: "markdown:0", kind: "markdown", start: 0, end: 999 }] } };
    const api = async <T,>() => eventResponse([
      event(1, "run_started", { startedAt: 1 }),
      { ...event(2, "run_finished", { response: badResponse }), schemaVersion: 1, eventId: `${request.requestId}:2`, attemptId: request.requestId, conversationId: request.conversationId },
    ] as AiRunEvent[]) as T;
    const seen = vi.fn();
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: seen }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched versioned event identity without triggering another POST", async () => {
    let calls = 0;
    const api = async <T,>(): Promise<T> => { calls++; return eventResponse([
      { ...event(1, "answer_delta", { delta: "private" }), schemaVersion: 1, eventId: "another:1", attemptId: request.requestId, conversationId: request.conversationId },
    ] as AiRunEvent[]) as T; };
    const seen = vi.fn();
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: seen }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });

  it("decodes fragmented ordered events, ignores exact sequence replay, and never posts twice", async () => {
    const events = [
      event(1, "run_started", { startedAt: 1 }),
      event(1, "run_started", { startedAt: 1 }),
      event(2, "answer_delta", { delta: "complete" }),
      event(3, "usage_updated", { status: "completed", providerReported: true, usage: response.usage }),
      event(3, "usage_updated", { status: "completed", providerReported: true, usage: response.usage }),
      event(4, "run_finished", { response }),
    ];
    const call = vi.fn();
    const api = async <T,>(): Promise<T> => { call(); return eventResponse(events, 3) as T; };
    const seen: number[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value.seq) })).resolves.toEqual(response);
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("fills a sequence gap from the original request's journal before displaying later events", async () => {
    const calls: Array<{ path: string; init: RequestInit | undefined }> = [];
    const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      if (path === "/api/ai/chat/stream") return eventResponse([
        event(1, "run_started", { startedAt: 1 }), event(3, "run_finished", { response }),
      ]) as T;
      return { events: [event(2, "answer_delta", { delta: "complete" }), event(3, "run_finished", { response })] } as T;
    };
    const seen: number[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value.seq) }))
      .resolves.toEqual(response);
    expect(seen).toEqual([1, 2, 3]);
    expect(calls.map(call => call.path)).toEqual([
      "/api/ai/chat/stream", `/api/ai/requests/${request.requestId}/events?after=1`,
    ]);
    expect(calls[1].init).toMatchObject({ headers: { "X-Tongpin-Account": "member" } });
    expect(calls[1].init?.signal).toBe(calls[0].init?.signal);
  });

  it("replays missing answer and summary deltas after a transport drop without another POST", async () => {
    let reads = 0;
    const dropped = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event(1, "run_started", { startedAt: 1 }))}\n\n`));
        else controller.error(new Error("socket dropped"));
      },
    }), { headers: { "content-type": "text/event-stream" } });
    const paths: string[] = [];
    const api = async <T,>(path: string): Promise<T> => {
      paths.push(path);
      if (path === "/api/ai/chat/stream") return dropped as T;
      return { events: [
        event(1, "run_started", { startedAt: 1 }),
        event(2, "public_summary_delta", { delta: "依据" }),
        event(3, "answer_delta", { delta: "complete" }),
        event(4, "usage_updated", { status: "completed", providerReported: true, usage: response.usage }),
        event(4, "usage_updated", { status: "completed", providerReported: true, usage: response.usage }),
        event(5, "run_finished", { response }),
      ] } as T;
    };
    const seen: AiRunEvent[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value) }))
      .resolves.toEqual(response);
    expect(seen.map(value => value.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(seen.filter(value => value.type === "usage_updated")).toMatchObject([{ data: { usage: { totalTokens: 2 }, providerReported: true } }]);
    expect(seen.flatMap(value => value.type === "public_summary_delta" ? [value.data.delta] : [])).toEqual(["依据"]);
    expect(seen.flatMap(value => value.type === "answer_delta" ? [value.data.delta] : [])).toEqual(["complete"]);
    expect(paths).toEqual(["/api/ai/chat/stream", `/api/ai/requests/${request.requestId}/events?after=1`]);
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

  it("rejects malformed or untrusted usage instead of rendering it", async () => {
    const api = async <T,>() => eventResponse([
      event(1, "run_started", { startedAt: 1 }),
      event(2, "usage_updated", { status: "completed", providerReported: true, usage: { ...response.usage, totalTokens: -1 } }),
    ]) as T;
    const seen: AiRunEvent[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value) }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen.map(value => value.type)).toEqual(["run_started"]);
  });

  it("rejects a changed run identity before any replay query", async () => {
    const paths: string[] = [];
    const api = async <T,>(path: string): Promise<T> => {
      paths.push(path);
      return eventResponse([
        event(1, "run_started", { startedAt: 1 }),
        { ...event(2, "answer_delta", { delta: "untrusted" }), runId: "run-other" },
      ]) as T;
    };
    const seen: number[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value.seq) }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen).toEqual([1]);
    expect(paths).toEqual(["/api/ai/chat/stream"]);
  });

  it("stops replay on a foreign journal event or an explicit run failure", async () => {
    const foreign = { ...event(2, "answer_delta", { delta: "foreign" }), requestId: "request-foreign" };
    const paths: string[] = [];
    const api = async <T,>(path: string): Promise<T> => {
      paths.push(path);
      return (path === "/api/ai/chat/stream"
        ? eventResponse([event(1, "run_started", { startedAt: 1 })])
        : { events: [foreign] }) as T;
    };
    const seen: AiRunEvent[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value) }))
      .rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen.map(value => value.seq)).toEqual([1]);
    expect(paths).toHaveLength(2);

    const failedPaths: string[] = [];
    const failedApi = async <T,>(path: string): Promise<T> => {
      failedPaths.push(path);
      return eventResponse([event(1, "run_failed", { error: { code: "MODEL_REFUSED", message: "failed" } })]) as T;
    };
    await expect(readAiChatStream(failedApi, request, { accountId: "member", signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: "MODEL_REFUSED" });
    expect(failedPaths).toEqual(["/api/ai/chat/stream"]);
  });

  it("does not submit or replay an already aborted request", async () => {
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
    expect(cancelled).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it("propagates abort to the journal query and never starts another replay", async () => {
    const controller = new AbortController();
    let replayStarted!: () => void;
    const started = new Promise<void>(resolve => { replayStarted = resolve; });
    const paths: string[] = [];
    const api = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      paths.push(path);
      if (path === "/api/ai/chat/stream") return eventResponse([event(1, "run_started", { startedAt: 1 })]) as T;
      return new Promise<T>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new ApiRequestError(0, "NETWORK_UNAVAILABLE", "aborted")), { once: true });
        replayStarted();
      });
    };
    const pending = readAiChatStream(api, request, { accountId: "member", signal: controller.signal });
    await started;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 0, code: "AI_STREAM_INTERRUPTED" });
    expect(paths).toEqual(["/api/ai/chat/stream", `/api/ai/requests/${request.requestId}/events?after=1`]);
  });

  it("stops bounded polling without a terminal event and lets the caller query the result", async () => {
    vi.useFakeTimers();
    try {
      let queries = 0;
      const api = async <T,>(path: string): Promise<T> => {
        if (path === "/api/ai/chat/stream") return eventResponse([event(1, "run_started", { startedAt: 1 })]) as T;
        queries++;
        return { events: [] } as T;
      };
      const pending = readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal });
      const assertion = expect(pending).rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
      await vi.advanceTimersByTimeAsync(9_000);
      await assertion;
      expect(queries).toBeGreaterThan(0);
      expect(queries).toBeLessThanOrEqual(8);
    } finally {
      vi.useRealTimers();
    }
  });
  it("opts in to live progress and accepts reasoning_delta and tool_progress events", async () => {
    let body = "";
    const api = async <T,>(_path: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return eventResponse([
        event(1, "run_started", { startedAt: 1 }),
        event(2, "tool_progress", { tool: "web_search", callId: "search-1", status: "completed", query: "上海天气", sourceCount: 2 }),
        event(3, "reasoning_delta", { delta: "先确认城市", source: "provider_reasoning_content" }),
        event(4, "run_finished", { response }),
      ]) as T;
    };
    const seen: AiRunEvent[] = [];
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: value => seen.push(value) })).resolves.toEqual(response);
    expect(JSON.parse(body)).toMatchObject({ requestId: request.requestId, liveProgress: true });
    expect(seen.map(value => value.type)).toEqual(["run_started", "tool_progress", "reasoning_delta", "run_finished"]);
  });

  it.each([
    ["tool_progress", { tool: "shell", callId: "search-1", status: "completed" }],
    ["tool_progress", { tool: "web_search", callId: "ws_provider", status: "completed" }],
    ["tool_progress", { tool: "web_search", callId: "search-1", status: "thinking" }],
    ["reasoning_delta", { delta: "x", source: "hidden" }],
  ] as const)("rejects a malformed %s event", async (type, data) => {
    const api = async <T,>() => eventResponse([event(1, "run_started", { startedAt: 1 }), event(2, type, data as AiRunEvent["data"])]) as T;
    const seen = vi.fn();
    await expect(readAiChatStream(api, request, { accountId: "member", signal: new AbortController().signal, onEvent: seen })).rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
