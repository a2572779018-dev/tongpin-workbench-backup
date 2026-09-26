import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AiChatResponse, AiCitation, AiSource } from "../../../shared/ai";
import { aiSourceNumbers, sourceIdentity } from "../../../shared/aiCitations";
import { ChatMessageRow } from "./ChatMessageRow";
import { completedReply, replaceChatMessage } from "./chatRequests";
import { MarkdownReply } from "./MarkdownReply";
import { citationCardPosition, ReplyCitationScope } from "./ReplyCitation";
import { blockCitations, citationListTarget, markerNumbers, nextCitationFocus, replyCitations, sanitizeAiCitations } from "./replyCitations";
import { displaySources } from "./sourceDisplay";
import type { TongpinAIConversation, TongpinAIMessage } from "./types";

const WEATHER = "https://weather.example/sh";
const NEWS = "https://news.example/a";
const WIKI = "https://wiki.example/b";
const sources: AiSource[] = [{ title: "上海天气", url: WEATHER }, { title: "新闻", url: NEWS }, { title: "百科", url: WIKI }];
const cite = (end: number, sourceIndex: number): AiCitation => ({ n: sourceIndex + 1, sourceIndex, end });
const render = (content: string, citations: AiCitation[], list: AiSource[] = sources, streaming = false) => renderToStaticMarkup(
  createElement(ReplyCitationScope, { sources: list }, createElement(MarkdownReply, { content, streaming, citations: replyCitations(content, citations, list) })));
/** Replaces each rendered marker button with "[n]" so placement is easy to read. */
const markers = (html: string) => html.replace(/<sup class="tp-ai-cite-group">(.*?)<\/sup>/g, (_all, inner: string) =>
  `^${[...inner.matchAll(/data-n="(\d+)"/g)].map(match => match[1]).join(",")}`);

describe("reply citation marker data", () => {
  it("snaps markers to the preceding text, groups one position and numbers like the source list", () => {
    const list = [{ title: "上海天气", url: WEATHER }, { title: "", url: `${WEATHER}?utm_source=openai` }, { title: "新闻", url: NEWS }];
    const content = "今天晴。\n\n明天阴。";
    // A stored n from another dedupe rule never overrides the list's own numbering.
    const result = replyCitations(content, [{ n: 1, sourceIndex: 0, end: 6 }, { n: 3, sourceIndex: 2, end: 6 }, { n: 2, sourceIndex: 1, end: content.length }], list);
    expect(result).toEqual({ markers: [{ offset: 4, numbers: [1, 2] }, { offset: content.length, numbers: [1] }], sourceCount: 2 });
    expect(displaySources(list).visible.map(source => aiSourceNumbers(list).get(sourceIdentity(source.url)))).toEqual([1, 2]);
  });

  it("keeps only citations bound to this content and source list", () => {
    const content = "今天晴😀";
    // Past the end, splitting the emoji's surrogate pair, a missing source, an extra field, not an object.
    const raw = [cite(2, 0), cite(content.length + 1, 0), cite(4, 1), { n: 1, sourceIndex: 3, end: 2 }, { ...cite(2, 0), url: "javascript:alert(1)" }, "bad"];
    expect(sanitizeAiCitations(content, sources, raw)).toEqual([cite(2, 0)]);
    expect(sanitizeAiCitations(content, [], [cite(2, 0)])).toBeUndefined();
    expect(replyCitations(content, [cite(2, 0)], undefined)).toBeUndefined();
  });

  it("splits reply markers into block-local offsets", () => {
    const citations = { markers: [{ offset: 4, numbers: [1] }, { offset: 10, numbers: [2] }, { offset: 12, numbers: [3] }], sourceCount: 3 };
    expect(blockCitations(citations, "明天阴。", 8)).toEqual({ source: "明天阴。", markers: [{ offset: 2, numbers: [2] }, { offset: 4, numbers: [3] }], sourceCount: 3 });
    expect(markerNumbers("2 1 2 x -1")).toEqual([2, 1]);
  });
});

describe("reply citation rendering", () => {
  it("renders superscript markers inside the answer text", () => {
    const content = "今天晴。明天阴。";
    const html = render(content, [cite(4, 0), cite(8, 1), cite(8, 2)]);
    expect(markers(html)).toContain("<p>今天晴。^1明天阴。^2,3</p>");
    expect(html).toContain('aria-label="来源 1：上海天气（weather.example），查看来源列表"');
    expect(html).not.toContain("<a");
  });

  it("never enters code blocks and keeps their text exact", () => {
    const content = "说明如下：\n\n```js\nconst a = 1; // [1]\n```\n\n结束。";
    const html = render(content, [cite(content.indexOf("= 1"), 0), cite(content.length, 1)]);
    expect(html).toContain("const a = 1; // [1]\n</code>");
    expect(markers(html)).toContain("<p>结束。^2</p>");
    expect(html.match(/data-n=/g)).toHaveLength(1);
  });

  it("keeps GFM tables intact and places markers inside cells", () => {
    const content = "| 城市 | 天气 |\n| --- | --- |\n| 上海 | 晴 |";
    const html = markers(render(content, [cite(content.indexOf("晴") + 1, 0), cite(content.length, 1)]));
    expect(html).toContain("<th>城市</th><th>天气</th>");
    expect(html).toContain("<td>上海</td><td>晴^1,2</td>");
    expect(html).not.toContain("---");
  });

  it("places markers after links, never inside them, and leaves hrefs unchanged", () => {
    const content = "见[**上海天气**](https://weather.example/sh)说明。([news.example](https://news.example/a?utm_source=openai))";
    const html = markers(render(content, [cite(content.indexOf("天气"), 0), cite(content.indexOf("example"), 1), cite(content.length, 1)]));
    expect(html).toContain('href="https://weather.example/sh"');
    expect(html).toContain('href="https://news.example/a?utm_source=openai"');
    expect(html).toContain("<strong>上海天气</strong></a>^1,2说明。(");
    expect(html).toContain(">news.example</a>)^2</p>");
    expect(html).not.toMatch(/<a [^>]*>[^<]*(?:<strong>[^<]*<\/strong>)?\^/);
  });

  it("steps past inline code, math and closed emphasis", () => {
    const content = "运行 `npm test` 后，公式 $E=mc^2$ 与 **结论**，完毕";
    const html = markers(render(content, [cite(content.indexOf("test"), 0), cite(content.indexOf("mc"), 1), cite(content.indexOf("**，") + 2, 2)]));
    expect(html).toContain("<code>npm test</code>^1 后");
    expect(html).toMatch(/<\/span><\/span><\/span>\^2 与/);
    expect(html).toContain("<strong>结论</strong>^3，完毕");
  });

  it("maps offsets across escaped Markdown and currency dollars", () => {
    const content = "星号 \\*不是加粗\\* 结论；票价 $5 到 $10 之间。";
    const html = markers(render(content, [cite(content.indexOf("不是") + 2, 0), cite(content.indexOf("结论") + 2, 1), cite(content.indexOf("之间") + 2, 2)]));
    expect(html).toContain("<p>星号 *不是^1加粗* 结论^2；票价 $5 到 $10 之间^3。</p>");
  });

  it("places markers across blocks, lists and quotes by their offset in the whole reply", () => {
    const content = "# 标题\n\n- 第一点\n- 第二点\n\n> 引用内容";
    const html = markers(render(content, [cite(content.indexOf("第一点") + 3, 0), cite(content.length, 2)]));
    expect(html).toContain("<li>第一点^1</li>");
    expect(html).toContain("<p>引用内容^3</p>");
  });

  it("shows plain text while streaming even when citations are passed", () => {
    const content = "今天晴[1]。明天阴。";
    const html = render(content, [cite(4, 0)], sources, true);
    expect(html).toContain("今天晴[1]。明天阴。");
    expect(html).not.toContain("tp-ai-cite");
  });

  it("links model-written [n] and 【n】 only to existing sources and outside code, links and reference lines", () => {
    const content = "今天晴[1][2]。明天阴【3】【9】。arr[1] 不变。\n\n[1] 上海天气 参考列表\n\n`[1]` 与 [见[2]](https://x.example/)";
    const html = markers(render(content, []));
    expect(html).toContain("<p>今天晴^1,2。明天阴^3【9】。arr[1] 不变。</p>");
    expect(html).toContain("<p>[1] 上海天气 参考列表</p>");
    expect(html).toContain("<code>[1]</code>");
    expect(html).toContain(">见[2]</a>");
    // Without any listed source nothing is linked.
    expect(render(content, [], [])).not.toContain("tp-ai-cite");
    // Outside a citation scope the model's own text is kept.
    expect(renderToStaticMarkup(createElement(MarkdownReply, { content: "今天晴[1]。", citations: replyCitations("今天晴[1]。", [], sources) }))).toContain("今天晴[1]。");
  });
});

describe("chat row citations and numbered sources", () => {
  const base = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false, onCopy: () => {}, onOpenArtifact: () => {}, onRetry: () => {} };
  const reply = (status: TongpinAIMessage["status"]): TongpinAIMessage => ({ id: "reply", role: "assistant", status, time: "12:00", content: "今天晴。明天阴。",
    sources: [...sources, { title: "", url: `${WEATHER}#top` }, { title: "四", url: "https://four.example/" }, { title: "五", url: "https://five.example/" }, { title: "六", url: "https://six.example/" }],
    citations: [cite(4, 0), { n: 6, sourceIndex: 6, end: 8 }] });
  const row = (message: TongpinAIMessage) => renderToStaticMarkup(createElement(ChatMessageRow, { ...base, message }));

  it("numbers the deduplicated list to match the markers, including a folded source", () => {
    const html = row(reply("ready"));
    expect(markers(html)).toContain("<p>今天晴。^1明天阴。^6</p>");
    expect([...html.matchAll(/tp-ai-message-sources__n">(\d+)</g)].map(match => Number(match[1]))).toEqual([1, 2, 3, 4, 5]);
    expect(html).toContain("展开其余 1 个来源");
    expect(html).toContain('aria-label="来源 6：六（six.example），查看来源列表"');
  });

  it("keeps a streaming reply plain", () => {
    expect(row(reply("thinking"))).not.toContain("tp-ai-cite");
  });
});

describe("click-to-source behavior", () => {
  it("targets the numbered item and unfolds only for folded sources", () => {
    expect(citationListTarget(2, 5, 3)).toEqual({ index: 1, needsExpand: false });
    expect(citationListTarget(7, 5, 3)).toEqual({ index: 6, needsExpand: true });
    for (const n of [0, 9, 1.5, Number.NaN]) expect(citationListTarget(n, 5, 3)).toBeNull();
  });

  it("treats each activation as a new request so a repeated click scrolls again", () => {
    const first = nextCitationFocus(null, 3);
    const again = nextCitationFocus(first, 3);
    expect(first).toEqual({ n: 3, token: 1 });
    expect(again).toEqual({ n: 3, token: 2 });
  });

  it("keeps the hover card inside the viewport and flips it above near the bottom", () => {
    expect(citationCardPosition({ left: 100, top: 200, bottom: 220 }, { width: 1200, height: 800 })).toEqual({ left: 88, width: 288, top: 226 });
    expect(citationCardPosition({ left: 1150, top: 740, bottom: 760 }, { width: 1200, height: 800 })).toEqual({ left: 904, width: 288, bottom: 66 });
    expect(citationCardPosition({ left: 2, top: 10, bottom: 30 }, { width: 240, height: 800 })).toEqual({ left: 8, width: 224, top: 36 });
  });
});

describe("client persistence of citations", () => {
  const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimated: false };
  const response = (citations?: unknown): AiChatResponse => ({ requestId: "request-a", content: "今天晴。", model: "快速", usage, sources,
    quota: { limitTokens: 10, usedTokens: 2, remainingTokens: 8, reservedTokens: 0, inputTokens: 1, outputTokens: 1 },
    ...(citations === undefined ? {} : { citations: citations as AiCitation[] }) });

  it("stores only verified citations and clears older ones when a reply has none", () => {
    expect(completedReply(response([cite(4, 0), cite(99, 1)])).citations).toEqual([cite(4, 0)]);
    // JSON-safe when assigned directly: no explicit undefined key.
    expect(completedReply(response([cite(99, 1)]))).not.toHaveProperty("citations");
    const conversations: TongpinAIConversation[] = [{ id: "c", title: "", timeLabel: "", messages: [{ id: "m", role: "assistant", content: "今天晴。", time: "", citations: [cite(3, 0)], sources }] }];
    const next = replaceChatMessage(conversations, "c", "m", completedReply(response()));
    expect(next[0].messages[0]).not.toHaveProperty("citations");
    expect(replaceChatMessage(conversations, "c", "m", completedReply(response([cite(2, 1)])))[0].messages[0].citations).toEqual([cite(2, 1)]);
  });

  it("lets only a patch that sets the text decide its citations", () => {
    const conversations: TongpinAIConversation[] = [{ id: "c", title: "", timeLabel: "", messages: [{ id: "m", role: "assistant", content: "今天晴。", time: "", citations: [cite(4, 0)], sources }] }];
    expect(replaceChatMessage(conversations, "c", "m", { status: "ready", taskPhase: "completed" })[0].messages[0].citations).toEqual([cite(4, 0)]);
    expect(replaceChatMessage(conversations, "c", "m", { content: "连接中断" })[0].messages[0]).not.toHaveProperty("citations");
  });
});
