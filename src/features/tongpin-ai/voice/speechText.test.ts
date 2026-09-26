import { describe, expect, it } from "vitest";
import { hasChineseVoice, markdownToSpeechText, pickSpeechVoice, speechLanguage, splitSpeechChunks } from "./speechText";

describe("markdown to speech text", () => {
  it("reads prose and drops markdown syntax", () => {
    const text = markdownToSpeechText([
      "## 本周结论",
      "",
      "> 这是**重要**提醒，_请注意_，~~旧说法~~不再适用。",
      "- 第一项：[官方文档](https://example.com/docs?a=1)",
      "1. 第二项 `npm test`",
      "- [x] 已完成的任务",
      "---",
      "![截图](https://example.com/a.png)更多见 https://example.com/page 。",
    ].join("\n"));
    expect(text).toBe("本周结论\n\n这是重要提醒，请注意，旧说法不再适用。\n第一项：官方文档\n第二项 npm test\n已完成的任务\n更多见 。");
  });

  it("replaces code, charts, cards and formulas with a short cue and skips followups", () => {
    const text = markdownToSpeechText([
      "先看代码：",
      "```ts",
      "const secret = 1;",
      "```",
      "```chart",
      "{\"type\":\"bar\"}",
      "```",
      "```cards",
      "[]",
      "```",
      "$$",
      "E = mc^2",
      "$$",
      "行内公式 $x^2 + y_1$ 与价格 $5 到 $10。",
      "```followups",
      "[\"下一步？\"]",
      "```",
    ].join("\n"));
    expect(text).toContain("此处省略代码。");
    expect(text).toContain("此处省略图表。");
    expect(text).toContain("此处省略数据卡片。");
    expect(text).toContain("此处省略公式。");
    expect(text).toContain("行内公式 （公式） 与价格 $5 到 $10。");
    expect(text).not.toMatch(/secret|type|下一步/);
  });

  it("removes citation markers, footnotes, HTML and emoji", () => {
    expect(markdownToSpeechText("据报道[1][2, 3]，增长明显【4】【5†source】¹²。<sup>6</sup>来源[^7] ✅🚀<br>完毕")).toBe("据报道，增长明显。来源 完毕");
  });

  it("reads table rows as sentences", () => {
    expect(markdownToSpeechText("| 指标 | 数值 |\n| --- | ---: |\n| 收入 | **120** 万 |")).toBe("指标，数值。\n收入，120 万。");
  });

  it("still explains an unfinished code block and returns empty for nothing readable", () => {
    expect(markdownToSpeechText("说明如下\n```python\nprint(1)")).toBe("说明如下\n此处省略代码。");
    expect(markdownToSpeechText("```followups\n[]\n```\n---\n![a](b)")).toBe("");
  });
});

describe("speech chunking", () => {
  it("cuts at Chinese and Latin sentence ends within the limit", () => {
    const text = "第一句话比较短。第二句话也不长！第三句呢？Fourth sentence here. 第五句";
    const chunks = splitSpeechChunks(text, 20);
    expect(chunks.every(chunk => Array.from(chunk).length <= 20)).toBe(true);
    expect(chunks[0]).toBe("第一句话比较短。第二句话也不长！");
    expect(chunks.join("").replace(/\s/g, "")).toBe(text.replace(/\s/g, ""));
  });

  it("falls back to commas, then a hard cut, without splitting surrogate pairs", () => {
    const commas = splitSpeechChunks("一二三四五六七八，九十一二三四五六七八，九十", 12);
    expect(commas[0]).toBe("一二三四五六七八，");
    const emoji = "😀".repeat(30);
    const chunks = splitSpeechChunks(emoji, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks.every(chunk => Array.from(chunk).length === 10)).toBe(true);
    expect(splitSpeechChunks("   ", 10)).toEqual([]);
  });
});

describe("speech language and voice", () => {
  const voices = [
    { name: "Samantha", lang: "en-US", localService: true },
    { name: "Meijia", lang: "zh-TW", localService: true },
    { name: "Google 普通话", lang: "zh-CN", localService: false },
    { name: "Tingting", lang: "zh-CN", localService: true },
    { name: "Microsoft Huihui", lang: "zh_CN", localService: true, default: true },
  ];
  it("detects Chinese unless the text is mostly Latin", () => {
    expect(speechLanguage("同频 AI 回复")).toBe("zh-CN");
    expect(speechLanguage("Use npm run build to 构建")).toBe("en-US");
    expect(speechLanguage("Hello world")).toBe("en-US");
    expect(speechLanguage("12345")).toBe("zh-CN");
  });
  it("prefers an installed voice in the exact locale", () => {
    expect(pickSpeechVoice(voices, "zh-CN")?.name).toBe("Microsoft Huihui");
    expect(pickSpeechVoice(voices.slice(0, 4), "zh-CN")?.name).toBe("Tingting");
    expect(pickSpeechVoice(voices.slice(0, 2), "zh-CN")?.name).toBe("Meijia");
    expect(pickSpeechVoice(voices, "en-US")?.name).toBe("Samantha");
    expect(pickSpeechVoice([], "zh-CN")).toBeNull();
    expect(hasChineseVoice(voices.slice(0, 1))).toBe(false);
    expect(hasChineseVoice(voices)).toBe(true);
  });
});
