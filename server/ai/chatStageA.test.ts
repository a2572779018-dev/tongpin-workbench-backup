import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest } from "../../shared/ai";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import { readAiChatStream } from "../../src/lib/aiRunStream";
import { createChatStreamResponse } from "./chatStream";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";

/**
 * P1 stage A acceptance: the minimal real loop
 * upstream delta -> service -> versioned event -> browser decoder -> assistant body.
 *
 * Everything runs the real AiService, the real SSE responder and the real browser
 * stream decoder. Only the provider transport is a local fixture, so there is no
 * paid call. Upstream output is pushed by hand, which makes "the body appeared
 * before the run finished" an observation instead of a replayed fixture.
 */

const provider = {
  name: "fixture",
  baseUrl: "https://api.example.com/v1",
  apiKey: "fixture-not-real",
  protocol: "chat_completions" as const,
  quickModel: "quick",
  deepModel: "deep",
  maxOutputTokens: 1024,
  reasoningEffort: "",
  enabled: true,
};

const USAGE = { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 };
const chatFrame = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`;
const STOP_FRAME = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
const USAGE_FRAME = `data: ${JSON.stringify({ choices: [], usage: USAGE })}\n\ndata: [DONE]\n\n`;

/** Re-slice an SSE body into fixed byte windows. A window of 1 byte is the worst
 * case for frame and multi-byte character splitting; the transport in the field
 * splits at arbitrary offsets, so every window size must decode identically. */
function reframe(response: Response, windowBytes: number): Response {
  const reader = response.body!.getReader();
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      for (let offset = 0; offset < value.byteLength; offset += windowBytes) {
        controller.enqueue(value.slice(offset, Math.min(offset + windowBytes, value.byteLength)));
      }
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

describe("P1 stage A: real answer delta reaches the browser incrementally", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-chat-stage-a-"));
    transport.mockReset();
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider(provider);
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  const request = (overrides: Partial<AiChatRequest> = {}): AiChatRequest => ({
    requestId: crypto.randomUUID(),
    conversationId: "conversation-a",
    mode: "quick",
    messages: [{ role: "user", content: "写一个完整方案" }],
    ...overrides,
  });

  /** An open provider stream we push into by hand. */
  function openProvider() {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { push = controller; } });
    transport.mockResolvedValueOnce(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    return {
      send: (text: string) => push.enqueue(new TextEncoder().encode(text)),
      finish: () => { push.enqueue(new TextEncoder().encode(STOP_FRAME + USAGE_FRAME)); push.close(); },
    };
  }

  /** The real client talks to the real responder for the run, and to the real
   * request journal for recovery, exactly like the desktop page does. */
  const apiFor = (target: AiChatRequest, windowBytes: number | null) =>
    async <T,>(requestPath: string): Promise<T> => {
      if (requestPath === "/api/ai/chat/stream") {
        const response = createChatStreamResponse(runtime.service, "member", target);
        return (windowBytes === null ? response : reframe(response, windowBytes)) as T;
      }
      const after = Number(new URLSearchParams(requestPath.split("?")[1] ?? "").get("after") ?? 0);
      return { events: runtime.service.getRunEvents("member", target.requestId, after) } as T;
    };

  const subscriber = (target: AiChatRequest, windowBytes: number | null, events: AiRunEvent[]) =>
    readAiChatStream(apiFor(target, windowBytes), target as never,
      { accountId: "member", signal: new AbortController().signal, onEvent: value => events.push(value) });

  const answerOf = (events: AiRunEvent[]) =>
    events.flatMap(value => value.type === "answer_delta" ? [value.data.delta] : []).join("");
  const summaryOf = (events: AiRunEvent[]) =>
    events.flatMap(value => value.type === "public_summary_delta" ? [value.data.delta] : []).join("");
  const ledger = (requestId: string) => runtime.store.usage("member").filter(entry => entry.requestId === requestId);

  it.each([1, 3, 7])("delivers the body before the run finishes, with CJK/emoji/newlines framed in %i-byte chunks", async windowBytes => {
    const upstream = "第一段正文。\n\n带 emoji 🚀 和第二段";
    const stream = openProvider();
    const target = request();
    const events: AiRunEvent[] = [];
    const client = subscriber(target, windowBytes, events);

    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    stream.send(chatFrame("第一段正文。\n\n"));
    await vi.waitFor(() => expect(events.some(value => value.type === "answer_delta")).toBe(true));
    // The first body text is on screen while the provider stream is still open.
    expect(events.some(value => value.type === "run_finished")).toBe(false);
    expect(upstream.startsWith(answerOf(events))).toBe(true);

    stream.send(chatFrame("带 emoji 🚀 和第二段"));
    stream.finish();
    const result = await client;

    expect(result.content).toBe(upstream);
    expect(result.richContent).toMatchObject({ version: 1 });
    expect(events.at(-1)).toMatchObject({ type: "run_finished" });
    expect(events.map(value => value.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.every(value => value.schemaVersion === 1 && value.eventId === `${target.requestId}:${value.seq}`)).toBe(true);
    // Deltas coalesce under rapid output but nothing is dropped or reordered.
    expect(upstream.startsWith(answerOf(events)) || answerOf(events) === upstream).toBe(true);
    expect(runtime.service.getRunEvents("member", target.requestId).map(value => value.seq))
      .toEqual(events.map(value => value.seq));
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ledger(target.requestId)).toHaveLength(1);
    expect(runtime.store.quota("member").usedTokens).toBe(50);
  });

  it("keeps the received body when the provider disconnects, and settles exactly once", async () => {
    let push!: ReadableStreamDefaultController<Uint8Array>;
    transport.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { push = controller; } }), {
      headers: { "content-type": "text/event-stream" },
    }));
    const target = request();
    const events: AiRunEvent[] = [];
    const client = subscriber(target, null, events);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    push.enqueue(new TextEncoder().encode(chatFrame("已经到达的正文")));
    await vi.waitFor(() => expect(events.some(value => value.type === "answer_delta")).toBe(true));
    push.error(new Error("socket dropped"));

    const result = await client;
    expect(result.content).toBe("已经到达的正文");
    expect(result.completion).toMatchObject({ state: "partial" });
    expect(answerOf(events)).toBe("已经到达的正文");
    expect(events.at(-1)).toMatchObject({ type: "run_finished", data: { response: { content: "已经到达的正文" } } });
    // A disconnect is neither a second generation nor a second charge.
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ledger(target.requestId)).toHaveLength(1);
    expect(runtime.store.quota("member").usedTokens).toBe(ledger(target.requestId)[0].totalTokens);
    expect(runtime.service.getRequestResult("member", target.requestId).result?.content).toBe("已经到达的正文");
  });

  it("treats EOF without a terminal event as failure while preserving the deltas already shown", async () => {
    vi.useFakeTimers();
    try {
      const target = request();
      const events: AiRunEvent[] = [];
      const base = { requestId: target.requestId, runId: "run-a", stepId: target.requestId };
      const started: AiRunEvent = { ...base, seq: 1, timestamp: 1, type: "run_started", data: { startedAt: 1 } };
      const delta: AiRunEvent = { ...base, seq: 2, timestamp: 2, type: "answer_delta", data: { delta: "半句话" } };
      const paths: string[] = [];
      const api = async <T,>(requestPath: string): Promise<T> => {
        paths.push(requestPath);
        if (requestPath === "/api/ai/chat/stream") {
          const encoded = new TextEncoder().encode([started, delta].map(value => `data: ${JSON.stringify(value)}\n\n`).join(""));
          return new Response(new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(encoded); controller.close(); },
          }), { headers: { "content-type": "text/event-stream" } }) as T;
        }
        // The journal never reaches a terminal event, so the run is not a success.
        return { events: [] } as T;
      };
      const pending = readAiChatStream(api, target, { accountId: "member", signal: new AbortController().signal, onEvent: value => events.push(value) });
      const assertion = expect(pending).rejects.toMatchObject({ code: "AI_STREAM_INTERRUPTED" });
      await vi.advanceTimersByTimeAsync(9_000);
      await assertion;
      // The page keeps this on screen even though the run did not succeed.
      expect(answerOf(events)).toBe("半句话");
      expect(events.some(value => value.type === "run_finished")).toBe(false);
      expect(paths[0]).toBe("/api/ai/chat/stream");
      expect(paths.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resumes a running reply from a second subscriber without re-sending the prompt or charging twice", async () => {
    const stream = openProvider();
    const target = request();
    const accepted: Promise<void>[] = [];
    const first = createChatStreamResponse(runtime.service, "member", target, task => accepted.push(task));
    const reader = first.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("run_started");
    // Leaving the page cancels only the subscriber; the accepted run continues.
    await reader.cancel();
    expect(accepted).toHaveLength(1);

    stream.send(chatFrame("第一段"));
    await vi.waitFor(() => expect(runtime.service.getRunEvents("member", target.requestId).some(value => value.type === "answer_delta")).toBe(true));
    stream.send(chatFrame("第二段"));
    stream.finish();
    await Promise.all(accepted);

    // The second subscriber re-opens the same request and answers from the journal.
    const events: AiRunEvent[] = [];
    const resumed = await subscriber(target, null, events);
    expect(resumed.content).toBe("第一段第二段");
    expect(resumed.requestId).toBe(target.requestId);
    expect(events.at(-1)).toMatchObject({ type: "run_finished" });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(ledger(target.requestId)).toHaveLength(1);
    expect(runtime.store.quota("member").usedTokens).toBe(50);

    const journal = runtime.service.getRunEvents("member", target.requestId);
    expect(journal.map(value => value.type)).toEqual(["run_started", "answer_delta", "answer_delta", "usage_updated", "run_finished"]);
    expect(journal.at(-1)).toMatchObject({ data: { response: { content: "第一段第二段" } } });
  });

  it("keeps two concurrent conversations isolated and bills each run once", async () => {
    const first = openProvider();
    const second = openProvider();
    const requestA = request({ conversationId: "conversation-a" });
    const requestB = request({ conversationId: "conversation-b" });
    const seenA: AiRunEvent[] = [], seenB: AiRunEvent[] = [];
    const clientA = subscriber(requestA, 5, seenA);
    // Bind the first queued fixture response to A before B can reach transport.
    // Both streams remain open and overlap below; provider arrival order is not
    // itself a production guarantee (async preparation can finish B first).
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const clientB = subscriber(requestB, 5, seenB);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));

    first.send(chatFrame("A 的第一段"));
    second.send(chatFrame("B 的第一段"));
    await vi.waitFor(() => expect(seenA.some(value => value.type === "answer_delta") && seenB.some(value => value.type === "answer_delta")).toBe(true));
    first.send(chatFrame("A 的第二段"));
    second.send(chatFrame("B 的第二段"));
    first.finish();
    second.finish();

    const [resultA, resultB] = await Promise.all([clientA, clientB]);
    expect(resultA.content).toBe("A 的第一段A 的第二段");
    expect(resultB.content).toBe("B 的第一段B 的第二段");
    // Background output for A never leaks into B's event stream or its body.
    expect(seenA.every(value => value.requestId === requestA.requestId)).toBe(true);
    expect(seenB.every(value => value.requestId === requestB.requestId)).toBe(true);
    expect(answerOf(seenA)).not.toContain("B 的");
    expect(answerOf(seenB)).not.toContain("A 的");
    expect(transport).toHaveBeenCalledTimes(2);
    expect(ledger(requestA.requestId)).toHaveLength(1);
    expect(ledger(requestB.requestId)).toHaveLength(1);
    expect(runtime.store.quota("member").usedTokens).toBe(100);
  });

  it("never turns private reasoning into visible body text", async () => {
    const stream = openProvider();
    const target = request();
    const events: AiRunEvent[] = [];
    const client = subscriber(target, 1, events);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    // Split the private markup across provider chunks; it is framed in 1-byte
    // chunks again on the way out and must still never become prose.
    for (const piece of ["<thi", "nk>私有思维链", "</thi", "nk><analysis_summary>公开依据</analysis_summary>可见正文"]) stream.send(chatFrame(piece));
    stream.finish();

    const result = await client;
    expect(answerOf(events)).toBe("可见正文");
    expect(result.content).toBe("可见正文");
    expect(result.analysisSummary).toBe("公开依据");
    // A model-authored public summary is a separate, declared channel.
    expect(summaryOf(events)).toBe("公开依据");
    expect(JSON.stringify(events)).not.toContain("私有思维链");
  });

  it("does not present a tool request that follows prose as the assistant's answer", async () => {
    const stream = openProvider();
    const target = request();
    const events: AiRunEvent[] = [];
    const client = subscriber(target, 1, events);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));

    const plan = '{"kind":"image","prompt":"未授权"}';
    stream.send(chatFrame("先说明一下。"));
    stream.send(chatFrame(`<tool_request>${plan}</tool_request>`));
    stream.finish();

    const result = await client;
    // A tool event may never be shown as body text, and its payload must not
    // leak into any incremental delta either.
    expect(answerOf(events)).toBe("先说明一下。");
    expect(result.content).toBe("先说明一下。");
    expect(JSON.stringify(result)).not.toContain("未授权");
  });
});
