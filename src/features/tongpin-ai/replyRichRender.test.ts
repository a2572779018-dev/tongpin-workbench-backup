import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "./ChatMessageRow";
import { splitMarkdownIntoBlocks } from "./librechatMarkdownBlocks";
import { MarkdownReply } from "./MarkdownReply";
import { escapeCurrencyDollars } from "./replyMarkdown";
import { parseReplyChart, pendingReplyTail } from "./replyRichBlocks";

const render = (content: string, streaming = false) => renderToStaticMarkup(createElement(MarkdownReply, { content, streaming }));
const row = (status: "thinking" | "ready", content: string) => renderToStaticMarkup(createElement(ChatMessageRow, {
  assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false,
  onCopy: () => {}, onOpenArtifact: () => {}, onRetry: () => {},
  message: { id: "rich", role: "assistant", status, content, time: "12:00", startedAt: Date.now() },
}));

const chart = JSON.stringify({ type: "bar", title: "季度销量", unit: "台", source: "用户提供的表格", series: [{ label: "Q1", value: 12 }, { label: "Q2", value: 18 }] });

describe("rich reply blocks in the chat renderer", () => {
  it("renders a valid chart and followup chips, and never shows their JSON", () => {
    const html = render(`结论如下。\n\n\`\`\`chart\n${chart}\n\`\`\`\n\n\`\`\`followups\n["按月拆分", "加入去年对比"]\n\`\`\``);
    expect(html).toContain('<figure class="tp-ai-chart">');
    expect(html).toContain("数据来源：用户提供的表格");
    expect(html).toContain(">按月拆分</button>");
    expect(html).not.toContain("&quot;series&quot;");
  });

  it("falls back to readable code with a notice for invalid chart JSON, and drops invalid followups", () => {
    const html = render('```chart\n{"type":"pie","title":"t"}\n```\n\n```followups\n{"not":"a list"}\n```');
    expect(html).not.toContain("tp-ai-chart");
    expect(html).toContain("图表数据格式无效，已显示原文");
    expect(html).toContain("&quot;type&quot;:&quot;pie&quot;");
    expect(html).not.toContain("tp-ai-followups");
    expect(html).not.toContain("&quot;not&quot;");
  });

  it("rejects chart magnitudes that would overflow the SVG scale", () => {
    const huge = (value: number) => JSON.stringify({ type: "bar", title: "t", unit: "u", source: "s", series: [{ label: "a", value }, { label: "b", value: -value }] });
    expect(parseReplyChart(huge(1e308))).toBeNull();
    expect(parseReplyChart(huge(1e12))).not.toBeNull();
    const html = render(`\`\`\`chart\n${JSON.stringify({ type: "line", title: "单点", unit: "个", source: "s", series: [{ label: "a", value: -3 }] })}\n\`\`\``);
    expect(html).toContain("tp-ai-chart");
    expect(html).not.toContain("NaN");
  });
});

describe("streaming tail stability", () => {
  it("classifies only unfinished constructs that would change shape", () => {
    expect(pendingReplyTail('```chart\n{"title":"月')).toBe("chart");
    expect(pendingReplyTail('```followups\n["a"')).toBe("followups");
    expect(pendingReplyTail("```ty")).toBe("fence");
    expect(pendingReplyTail("```ts\nconst a = 1")).toBeNull();
    expect(pendingReplyTail("```chart\n{}\n```")).toBeNull();
    expect(pendingReplyTail("$$\n\\frac{a}{")).toBe("math");
    expect(pendingReplyTail("$$\na=1\n$$")).toBeNull();
    expect(pendingReplyTail("| 项目 | 状态 |")).toBe("table");
    expect(pendingReplyTail("| 项目 | 状态 |\n| --")).toBe("table");
    expect(pendingReplyTail("| 项目 | 状态 |\n| --- | --- |")).toBeNull();
    expect(pendingReplyTail("普通文字 | 带竖线")).toBeNull();
  });

  it("shows a placeholder instead of raw chart JSON, table pipes or a broken formula while streaming", () => {
    const partialChart = row("thinking", `结论。\n\n\`\`\`chart\n{"type":"bar","title":"季`);
    expect(partialChart).toContain("正在生成图表…");
    expect(partialChart).not.toContain("&quot;type&quot;");
    expect(partialChart).toContain("<p>结论。</p>");
    expect(row("thinking", "对比：\n\n| 项目 | 状态 |")).toContain("正在生成表格…");
    const partialMath = row("thinking", "推导：\n\n$$\n\\frac{a}{");
    expect(partialMath).toContain("正在生成公式…");
    expect(partialMath).not.toContain("katex");
    const partialChips = row("thinking", '正文。\n\n```followups\n["继续');
    expect(partialChips).not.toContain("继续");
    expect(partialChips).not.toContain("tp-ai-markdown-pending");
    expect(row("thinking", "代码：\n\n```ts\nconst a = 1")).toContain("const a = 1");
  });

  it("renders the finished widget once the fence closes, and settled replies never use placeholders", () => {
    const done = row("thinking", `结论。\n\n\`\`\`chart\n${chart}\n\`\`\`\n\n补`);
    expect(done).toContain("tp-ai-chart");
    expect(done).not.toContain("正在生成");
    // An interrupted reply stays inspectable after it settles.
    const interrupted = row("ready", '结论。\n\n```chart\n{"type":"bar"');
    expect(interrupted).not.toContain("正在生成");
    expect(interrupted).toContain("图表数据格式无效，已显示原文");
  });
});

describe("math and currency", () => {
  it("does not turn currency amounts into formulas but still renders real math", () => {
    const prices = render("价格从 $5 到 $10 不等，大单约 $1,200。");
    expect(prices).not.toContain("katex");
    expect(prices).toContain("$5 到 $10");
    expect(render("质能方程 $E=mc^2$。")).toContain('class="katex"');
    expect(render("答案是 $10$。")).toContain('class="katex"');
    expect(escapeCurrencyDollars("`echo $5 x`")).toBe("`echo $5 x`");
    expect(escapeCurrencyDollars("```sh\necho $5\n```")).toBe("```sh\necho $5\n```");
    expect(escapeCurrencyDollars("$2x+1$")).toBe("$2x+1$");
  });

  it("keeps a display formula with a blank line in one block", () => {
    const formula = "$$\na = 1\n\nb = 2\n$$";
    expect(splitMarkdownIntoBlocks(`前文。\n\n${formula}\n\n后文。`).map(block => block.raw)).toEqual(["前文。", formula, "后文。"]);
    const html = render(`前文。\n\n${formula}`);
    expect(html.match(/katex-display/g)).toHaveLength(1);
  });

  it("scrolls wide formulas and tables instead of overflowing the reply column", () => {
    const css = readFileSync(new URL("./reply-markdown.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.tp-ai-markdown \.katex-display \{[^}]*overflow-x: auto/);
    expect(css).toMatch(/\.tp-ai-markdown-table__scroll \{[^}]*overflow-x: auto/);
    const wide = `| ${Array.from({ length: 14 }, (_, i) => `列${i}`).join(" | ")} |\n| ${Array.from({ length: 14 }, () => "---").join(" | ")} |`;
    expect(render(wide)).toContain('class="tp-ai-markdown-table__scroll"');
  });
});
