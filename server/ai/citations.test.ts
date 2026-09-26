import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiChatRequest, AiProviderInput, AiSource } from "../../shared/ai";
import type { AiRunEvent } from "../../shared/aiRunEvents";
import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { AI_CITATION_LIMITS } from "../../shared/aiCitations";
import { citationsForContent, providerCitationSpans, visibleTextOffset } from "./citations";
import { createNodeAi } from "./node";
import { parseProviderResult, type AiTransport } from "./provider";
import { consumeProviderResponse } from "./providerStream";
import { validateAiWorkspaceState } from "./workspace";

type Segment = string | { text: string; url: string; title?: string };
/** Builds provider text plus url_citation annotations whose indices cover each cited segment. */
function annotated(segments: Segment[]) {
  let text = "";
  const annotations: Array<Record<string, unknown>> = [];
  for (const segment of segments) {
    if (typeof segment === "string") { text += segment; continue; }
    const start = text.length;
    text += segment.text;
    annotations.push({ type: "url_citation", start_index: start, end_index: text.length, url: segment.url, title: segment.title ?? "" });
  }
  return { text, annotations };
}
const inline = (host: string, url: string) => ({ text: `([${host}](${url}))`, url });
const message = (...parts: Array<{ text: string; annotations: unknown[] }>) => ({ type: "message", role: "assistant", content: parts.map(part => ({ type: "output_text", ...part })) });
const search = (sources: AiSource[]) => ({ id: "ws_1", type: "web_search_call", status: "completed", action: { type: "search", query: "上海天气", sources } });
const usage = { input_tokens: 20, output_tokens: 10, total_tokens: 30 };

const WEATHER = "https://weather.example/shanghai";
const OTHER = "https://other.example/a";
const NEWS = "https://news.example/sh";
const actionSources = [{ title: "上海天气", url: WEATHER }, { title: "其他", url: OTHER }];
const answer = annotated(["上海今天晴，最高 27 度。", inline("weather.example", `${WEATHER}?utm_source=openai`), "\n\n明天转阴。", inline("news.example", NEWS)]);
const firstEnd = answer.annotations[0].end_index as number;
const secondEnd = answer.annotations[1].end_index as number;

describe("provider citation positions", () => {
  it("maps url_citation indices to deduplicated source numbers on the stored text", () => {
    const result = parseProviderResult({ status: "completed", output: [search(actionSources), message(answer)], usage }, "responses");
    expect(result.content).toBe(answer.text);
    expect(result.sources.map(source => source.url)).toEqual([`${WEATHER}`, `${OTHER}`, `${WEATHER}?utm_source=openai`, NEWS]);
    expect(result.citationSpans).toEqual([
      { start: answer.text.indexOf("([weather"), end: firstEnd, url: `${WEATHER}?utm_source=openai` },
      { start: answer.text.indexOf("([news"), end: secondEnd, url: NEWS },
    ]);
    // The tracking-parameter variant is the same page as search source 1; NEWS is the third distinct page.
    expect(citationsForContent(result.content, result.content, result.citationSpans, result.sources)).toEqual([
      { n: 1, sourceIndex: 0, end: firstEnd },
      { n: 3, sourceIndex: 3, end: secondEnd },
    ]);
  });

  it("adds part offsets across several parts and message items", () => {
    const one = annotated(["第一段。", inline("weather.example", WEATHER)]);
    const two = annotated(["第二段", { text: "有雨", url: NEWS }]);
    const three = annotated(["第三段。", inline("other.example", OTHER)]);
    const result = parseProviderResult({ output: [message(one, two), search([]), message(three)], usage }, "responses");
    expect(result.content).toBe(one.text + two.text + three.text);
    const ends = result.citationSpans!.map(span => span.end);
    expect(ends).toEqual([one.text.length, one.text.length + two.text.length, result.content.length]);
    expect(result.citationSpans!.map(span => result.content.slice(span.start, span.end))).toEqual([`([weather.example](${WEATHER}))`, "有雨", `([other.example](${OTHER}))`]);
  });

  it("aligns parts with a whitespace-joined convenience output_text but refuses any other difference", () => {
    const one = annotated(["甲。", inline("weather.example", WEATHER)]);
    const two = annotated(["乙。", inline("news.example", NEWS)]);
    const joined = parseProviderResult({ output_text: `${one.text}\n\n${two.text}`, output: [message(one), message(two)] }, "responses");
    expect(joined.citationSpans!.map(span => span.end)).toEqual([one.text.length, one.text.length + 2 + two.text.length]);
    const rewritten = parseProviderResult({ output_text: `${one.text}\n\n另外，${two.text}`, output: [message(one), message(two)] }, "responses");
    expect(rewritten.citationSpans).toBeUndefined();
    expect(rewritten.sources.map(source => source.url)).toEqual([WEATHER, NEWS]);
  });

  it.each([
    ["an index past the text", (a: Record<string, unknown>) => { a.end_index = 10_000; }],
    ["a reversed span", (a: Record<string, unknown>) => { a.start_index = Number(a.end_index) + 1; }],
    ["a negative index", (a: Record<string, unknown>) => { a.start_index = -1; }],
    ["a fractional index", (a: Record<string, unknown>) => { a.end_index = 3.5; }],
    ["a string index", (a: Record<string, unknown>) => { a.end_index = "12"; }],
  ])("omits every position for a response with %s, keeping its sources", (_name, corrupt) => {
    const broken = annotated(["今天晴。", inline("weather.example", WEATHER), "明天阴。", inline("news.example", NEWS)]);
    corrupt(broken.annotations[1]);
    const result = parseProviderResult({ output: [message(broken)] }, "responses");
    expect(result.citationSpans).toBeUndefined();
    expect(result.sources.map(source => source.url)).toEqual([WEATHER, NEWS]);
  });

  it("lists but never places a citation that arrives without any position", () => {
    const result = parseProviderResult({ output: [message({ text: "今天晴。", annotations: [{ type: "url_citation", url: WEATHER, title: "天气" }] })] }, "responses");
    expect(result.sources).toEqual([{ title: "天气", url: WEATHER }]);
    expect(result.citationSpans).toBeUndefined();
  });

  it("resolves code-point versus UTF-16 indices after an emoji only with self-evident inline spans", () => {
    const prefix = "今天☀️😀晴。";
    const link = `([weather.example](${WEATHER}))`;
    const text = `${prefix}${link}`;
    const utf16 = { type: "url_citation", start_index: prefix.length, end_index: text.length, url: WEATHER };
    const codePoints = { type: "url_citation", start_index: [...prefix].length, end_index: [...text].length, url: WEATHER };
    for (const annotation of [utf16, codePoints]) {
      const spans = providerCitationSpans([{ text, annotations: [annotation] }], text);
      expect(spans).toEqual([{ start: prefix.length, end: text.length, url: WEATHER }]);
    }
    // A plain cited sentence carries no evidence of the index unit: omit rather than guess.
    const sentence = `${prefix}明天有雨。`;
    const plain = { type: "url_citation", start_index: [...prefix].length, end_index: [...sentence].length, url: NEWS };
    expect(providerCitationSpans([{ text: sentence, annotations: [plain] }], sentence)).toBeUndefined();
    // Before the first astral character both units agree, so no evidence is needed.
    const early = { type: "url_citation", start_index: 0, end_index: 2, url: NEWS };
    expect(providerCitationSpans([{ text: sentence, annotations: [early] }], sentence)).toEqual([{ start: 0, end: 2, url: NEWS }]);
  });
});

describe("citations on the final visible content", () => {
  const sources = [{ title: "天气", url: WEATHER }, { title: "新闻", url: NEWS }];
  const spanAt = (raw: string, marker: string, url: string) => ({ start: raw.indexOf(marker), end: raw.indexOf(marker) + marker.length, url });

  it("shifts past a filtered leading summary and clamps trailing whitespace", () => {
    const raw = "<analysis_summary>先核对天气来源</analysis_summary>\n今天晴。【天】\n\n";
    const visible = "今天晴。【天】";
    expect(visibleTextOffset(raw, visible)).toBe(raw.indexOf("今天"));
    const trailing = { start: raw.indexOf("今天"), end: raw.length, url: WEATHER };
    expect(citationsForContent(raw, visible, [spanAt(raw, "【天】", WEATHER), trailing], sources)).toEqual([{ n: 1, sourceIndex: 0, end: visible.length }]);
  });

  it("drops a marker whose span ends inside filtered text", () => {
    const raw = "<analysis_summary>来自新闻</analysis_summary>今天晴。";
    expect(citationsForContent(raw, "今天晴。", [spanAt(raw, "来自新闻", NEWS), spanAt(raw, "今天晴。", WEATHER)], sources)).toEqual([{ n: 1, sourceIndex: 0, end: 4 }]);
  });

  it.each([
    ["a private block removed from the middle", "今天晴。<think>核对</think>明天阴。", "今天晴。明天阴。"],
    ["a JSON envelope around the answer", '{"kind":"text","content":"今天晴。明天阴。"}', "今天晴。明天阴。"],
    ["an application rewrite", "今天晴。明天阴。", "已整理图片任务，请确认后生成。"],
  ])("omits all citations after %s", (_name, raw, visible) => {
    expect(citationsForContent(raw, visible, [{ start: 0, end: 4, url: WEATHER }], sources)).toBeUndefined();
  });

  it("skips pages missing from the returned source list and caps the marker count", () => {
    const raw = "甲".repeat(200);
    expect(citationsForContent(raw, raw, [{ start: 0, end: 1, url: "https://unlisted.example/x" }], sources)).toBeUndefined();
    const many = Array.from({ length: 100 }, (_, index) => ({ start: index, end: index + 1, url: index % 2 ? NEWS : `${WEATHER}#part-${index}` }));
    const citations = citationsForContent(raw, raw, many, sources)!;
    expect(citations).toHaveLength(AI_CITATION_LIMITS.citations);
    expect(citations[0]).toEqual({ n: 1, sourceIndex: 0, end: 1 });
    expect(citations.every((citation, index) => index === 0 || citation.end > citations[index - 1].end)).toBe(true);
  });

  it("deduplicates the same page cited twice at one position and never splits an emoji", () => {
    const raw = "晴😀";
    expect(citationsForContent(raw, raw, [{ start: 0, end: 1, url: WEATHER }, { start: 0, end: 1, url: `${WEATHER}?utm_source=x` }, { start: 0, end: 2, url: NEWS }], sources))
      .toEqual([{ n: 1, sourceIndex: 0, end: 1 }]);
  });
});

const sse = (...events: unknown[]) => new Response(new ReadableStream({
  start(controller) {
    const encoder = new TextEncoder();
    for (const value of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    controller.close();
  },
}), { headers: { "content-type": "text/event-stream" } });
const deltas = (text: string, outputIndex = 1) => [...text].map(delta => ({ type: "response.output_text.delta", output_index: outputIndex, content_index: 0, delta }));
const added = (annotation: Record<string, unknown>, annotationIndex: number, outputIndex = 1) => ({ type: "response.output_text.annotation.added", output_index: outputIndex, content_index: 0, annotation_index: annotationIndex, annotation });

describe("streamed annotation events", () => {
  it("merges annotation.added events into a terminal part that reports none", async () => {
    const bare = { text: answer.text, annotations: [] };
    const raw = await consumeProviderResponse(sse(
      ...deltas(answer.text),
      added(answer.annotations[0], 0), added(answer.annotations[0], 0), added(answer.annotations[1], 1),
      { type: "response.completed", response: { status: "completed", output: [search(actionSources), message(bare)], usage } },
    ));
    const result = parseProviderResult(raw, "responses");
    expect(result.citationSpans?.map(span => span.end)).toEqual([firstEnd, secondEnd]);
    expect(citationsForContent(result.content, result.content, result.citationSpans, result.sources)).toEqual([
      { n: 1, sourceIndex: 0, end: firstEnd }, { n: 3, sourceIndex: 3, end: secondEnd }]);
  });

  it("rebuilds streamed parts when the terminal envelope only carries output_text", async () => {
    const raw = await consumeProviderResponse(sse(
      ...deltas(answer.text, 0), added(answer.annotations[1], 1, 0),
      { type: "response.output_text.done", output_index: 0, content_index: 0, text: answer.text },
      { type: "response.completed", response: { status: "completed", output_text: answer.text, usage } },
    ));
    const result = parseProviderResult(raw, "responses");
    expect(result.content).toBe(answer.text);
    expect(result.citationSpans).toEqual([{ start: answer.text.indexOf("([news"), end: secondEnd, url: NEWS }]);
  });

  it("keeps the terminal envelope authoritative and ignores offsets streamed for different text", async () => {
    const own = annotated(["今天晴。", inline("news.example", NEWS)]);
    const authoritative = await consumeProviderResponse(sse(
      ...deltas(own.text), added({ type: "url_citation", start_index: 0, end_index: 2, url: OTHER }, 0),
      { type: "response.completed", response: { status: "completed", output: [search([]), message(own)], usage } },
    ));
    expect(parseProviderResult(authoritative, "responses").citationSpans).toEqual([{ start: 4, end: own.text.length, url: NEWS }]);
    const changed = await consumeProviderResponse(sse(
      ...deltas("完全不同的流式文本"), added({ type: "url_citation", start_index: 0, end_index: 2, url: OTHER }, 0),
      { type: "response.completed", response: { status: "completed", output: [search([]), message({ text: own.text, annotations: [] })], usage } },
    ));
    expect(parseProviderResult(changed, "responses").citationSpans).toBeUndefined();
  });
});

describe("citations through the chat service and persistence", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  const provider: AiProviderInput = { name: "fixture", baseUrl: "https://fixture.example", apiKey: "fixture-not-a-real-key", protocol: "responses", quickModel: "quick", deepModel: "deep", maxOutputTokens: 1024, reasoningEffort: "", enabled: true, webSearchEnabled: true, webSearchQuotaTokens: 100 };
  const chat = (): AiChatRequest => ({ requestId: crypto.randomUUID(), conversationId: "conversation-a", mode: "quick", messages: [{ role: "user", content: "上海天气" }], webSearch: true });
  const completed = (text: string, annotations: unknown[], streamed: unknown[] = []) => sse(
    { type: "response.output_item.added", output_index: 0, item: search([]) },
    ...deltas(text), ...streamed,
    { type: "response.completed", response: { status: "completed", output: [search(actionSources), message({ text, annotations })], usage } },
  );
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-citations-"));
    transport.mockReset();
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    await runtime.service.saveProvider(provider);
    runtime.service.setQuota("member", "admin", { limitTokens: 100_000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("returns, journals and persists citations aligned to the stored answer", async () => {
    const summarized = `<analysis_summary>对比两个天气来源</analysis_summary>\n${answer.text}\n`;
    const shift = summarized.indexOf(answer.text);
    const moved = answer.annotations.map(annotation => ({ ...annotation, start_index: Number(annotation.start_index) + shift, end_index: Number(annotation.end_index) + shift }));
    transport.mockResolvedValueOnce(completed(summarized, moved));
    const events: AiRunEvent[] = [];
    const request = chat();
    const response = await runtime.service.chat("member", request, { stream: true, onEvent: event => events.push(event) });
    const expected = [{ n: 1, sourceIndex: 0, end: firstEnd }, { n: 3, sourceIndex: 3, end: secondEnd }];
    expect(response.content).toBe(answer.text);
    expect(response.analysisSummary).toBe("对比两个天气来源");
    expect(response.citations).toEqual(expected);
    expect(response.content.slice(0, firstEnd).endsWith("utm_source=openai))")).toBe(true);
    // Streaming shows plain answer text only; positioned markers arrive with the terminal result.
    expect(events.flatMap(event => event.type === "answer_delta" ? [event.data.delta] : []).join("").trim()).toBe(answer.text);
    const finished = events.find(event => event.type === "run_finished");
    expect(finished?.type === "run_finished" && finished.data.response.citations).toEqual(expected);
    expect(runtime.service.getRequestResult("member", request.requestId).result?.citations).toEqual(expected);
    runtime.close();
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    expect((await runtime.service.chat("member", request)).citations).toEqual(expected);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("uses streamed annotation events when the terminal part has none", async () => {
    transport.mockResolvedValueOnce(completed(answer.text, [], [added(answer.annotations[1], 0)]));
    const response = await runtime.service.chat("member", chat(), { stream: true, onEvent: () => {} });
    expect(response.sources?.map(source => source.url)).toEqual([WEATHER, OTHER, NEWS]);
    expect(response.citations).toEqual([{ n: 3, sourceIndex: 2, end: secondEnd }]);
  });

  it("keeps the source list but omits citations when the stored answer was transformed inside", async () => {
    const raw = `今天晴。<think>private check</think>${answer.text}`;
    const shift = raw.indexOf(answer.text);
    const moved = answer.annotations.map(annotation => ({ ...annotation, start_index: Number(annotation.start_index) + shift, end_index: Number(annotation.end_index) + shift }));
    transport.mockResolvedValueOnce(completed(raw, moved));
    const response = await runtime.service.chat("member", chat(), { stream: true, onEvent: () => {} });
    expect(response.content).toBe(`今天晴。${answer.text}`);
    expect(response.sources).toHaveLength(4);
    expect(response).not.toHaveProperty("citations");
  });
});

describe("citation persistence validation", () => {
  const content = "上海今天晴。明天转阴。";
  const base = (citations: unknown, withSources = true): AiWorkspaceState => ({
    view: "chat", mode: "quick", projects: [], artifacts: [], drafts: {}, activeConversationId: "chat-a", activeProjectId: null, enabledSkillIds: [],
    conversations: [{ id: "chat-a", title: "天气", timeLabel: "刚刚", messages: [
      { id: "user-a", role: "user", content: "上海天气", time: "10:00" },
      { id: "reply-a", role: "assistant", content, time: "10:01", status: "ready",
        ...(withSources ? { sources: [{ title: "天气", url: WEATHER }, { title: "新闻", url: NEWS }] } : {}),
        citations } as AiWorkspaceState["conversations"][number]["messages"][number],
    ] }],
  });

  it("accepts markers bound to the message content and sources", () => {
    const state = validateAiWorkspaceState(base([{ n: 1, sourceIndex: 0, end: 6 }, { n: 2, sourceIndex: 1, end: content.length }]));
    expect(state.conversations[0].messages[1].citations).toEqual([{ n: 1, sourceIndex: 0, end: 6 }, { n: 2, sourceIndex: 1, end: content.length }]);
  });

  it.each([
    ["no sources", [{ n: 1, sourceIndex: 0, end: 6 }], false],
    ["an offset past the content", [{ n: 1, sourceIndex: 0, end: content.length + 1 }], true],
    ["a zero offset", [{ n: 1, sourceIndex: 0, end: 0 }], true],
    ["a missing source", [{ n: 1, sourceIndex: 2, end: 6 }], true],
    ["a zero number", [{ n: 0, sourceIndex: 0, end: 6 }], true],
    ["a fractional offset", [{ n: 1, sourceIndex: 0, end: 5.5 }], true],
    ["an unknown field", [{ n: 1, sourceIndex: 0, end: 6, url: "javascript:alert(1)" }], true],
    ["a non-array value", { n: 1 }, true],
  ])("rejects %s", (_name, citations, withSources) => {
    expect(() => validateAiWorkspaceState(base(citations, withSources))).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_INVALID" }));
  });

  it("rejects more markers than the shared cap", () => {
    const many = Array.from({ length: AI_CITATION_LIMITS.citations + 1 }, () => ({ n: 1, sourceIndex: 0, end: 6 }));
    expect(() => validateAiWorkspaceState(base(many))).toThrow(expect.objectContaining({ code: "AI_WORKSPACE_TOO_LARGE" }));
  });
});
