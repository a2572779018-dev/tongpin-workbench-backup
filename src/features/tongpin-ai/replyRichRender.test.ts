import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatChartShort, niceChartScale } from "./ChatChart";
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
const fence = (language: string, body: unknown) => `\`\`\`${language}\n${typeof body === "string" ? body : JSON.stringify(body)}\n\`\`\``;
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("rich reply blocks in the chat renderer", () => {
  it("renders a valid chart and followup chips, and never shows their JSON", () => {
    const html = render(`结论如下。\n\n\`\`\`chart\n${chart}\n\`\`\`\n\n\`\`\`followups\n["按月拆分", "加入去年对比"]\n\`\`\``);
    expect(html).toContain('<figure class="tp-ai-chart" data-type="bar">');
    expect(html).toContain("数据来源：用户提供的表格");
    expect(html).toContain(">按月拆分</button>");
    expect(html).not.toContain("&quot;series&quot;");
    // A single series needs no legend; its bars carry the first palette slot.
    expect(html).not.toContain("tp-ai-chart__legend");
    expect(count(html, 'class="tp-ai-chart__bar"')).toBe(2);
    expect(html).toContain("<title>Q2：18 台</title>");
  });

  it("falls back to readable code with a notice for invalid chart JSON, and drops invalid followups", () => {
    const html = render('```chart\n{"type":"radar","title":"t"}\n```\n\n```followups\n{"not":"a list"}\n```');
    expect(html).not.toContain("tp-ai-chart");
    expect(html).toContain("图表数据格式无效，已显示原文");
    expect(html).toContain("&quot;type&quot;:&quot;radar&quot;");
    expect(html).not.toContain("tp-ai-followups");
    expect(html).not.toContain("&quot;not&quot;");
  });

  it("draws grouped bars with a legend and one tooltip per category listing every series", () => {
    const html = render(fence("chart", { type: "bar", title: "区域营收", unit: "万元", source: "用户上传的报表", labels: ["华东", "华南", "华北"],
      series: [{ name: "2024", values: [120, 98, 76] }, { name: "2025", values: [135, null, 88] }] }));
    expect(html).toContain('<ul class="tp-ai-chart__legend" aria-label="图例">');
    expect(html).toMatch(/<li data-series="1"><span class="tp-ai-chart__key is-bar" aria-hidden="true"><\/span>2024<\/li>/);
    expect(html).toMatch(/<li data-series="2">.*2025<\/li>/);
    // The missing value draws no bar, and says so instead of pretending zero.
    expect(count(html, 'class="tp-ai-chart__bar"')).toBe(5);
    expect(html).toContain("<title>华南\n2024：98 万元\n2025：无数据</title>");
    expect(html).toContain('aria-label="区域营收（单位：万元），柱状图，2 个系列：2024、2025，3 个类别，数据见原始数据表"');
    expect(html).not.toContain("NaN");
    // The raw data table is always one click away (collapsed until asked for).
    const controls = /aria-expanded="false" aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`<table class="tp-ai-chart__data" id="${controls}" hidden="">`);
    expect(html).toContain('<th scope="col">2024（万元）</th><th scope="col">2025（万元）</th>');
    expect(html).toContain('<tr><th scope="row">华南</th><td>98</td><td>—</td></tr>');
  });

  it("breaks a multi-series line at missing points and keeps the axis on round ticks", () => {
    const html = render(fence("chart", { type: "line", title: "周活跃", unit: "人", source: "后台导出", labels: ["W1", "W2", "W3", "W4"],
      series: [{ name: "新用户", values: [30, 45, null, 60] }, { name: "老用户", values: [80, 82, 85, 90] }] }));
    expect(html).toContain('<figure class="tp-ai-chart" data-type="line">');
    expect(html).toContain("tp-ai-chart__key is-line");
    // 新用户 splits into two runs (one line + a lone point), 老用户 is one line.
    expect(count(html, 'class="tp-ai-chart__line"')).toBe(2);
    expect(count(html, 'class="tp-ai-chart__hit"')).toBe(4);
    const ticks = [...html.matchAll(/class="tp-ai-chart__tick">([^<]+)<\/text>/g)].map(match => match[1]);
    expect(ticks).toEqual(["0", "20", "40", "60", "80", "100"]);
    expect(html).not.toContain("tp-ai-chart__area");
    expect(html).not.toContain("NaN");
  });

  it("renders donut and pie charts with labelled shares and a donut total", () => {
    const donut = render(fence("chart", { type: "donut", title: "渠道占比", unit: "万元", source: "财务月报",
      series: [{ label: "直营", value: 45 }, { label: "电商", value: 30 }, { label: "分销", value: 25 }] }));
    expect(donut).toContain('<figure class="tp-ai-chart" data-type="donut">');
    expect(count(donut, 'class="tp-ai-chart__slice"')).toBe(3);
    expect(donut).toContain("<title>直营：45 万元（45%）</title>");
    expect(donut).toContain('class="tp-ai-chart__total-value">100</text>');
    expect(donut).toMatch(/<li data-series="3">.*分销.*25%<\/span><\/li>/);
    expect(donut).toContain('aria-label="渠道占比（单位：万元），环形图：直营 45%，电商 30%，分销 25%"');
    expect(donut).toContain('<th scope="col">数值（万元）</th><th scope="col">占比</th>');
    expect(donut).toContain('<tr><th scope="row">电商</th><td>30</td><td>30%</td></tr>');
    const pie = render(fence("chart", { type: "pie", title: "单项", unit: "个", source: "s", series: [{ label: "全部", value: 7 }, { label: "空", value: 0 }] }));
    expect(pie).not.toContain("tp-ai-chart__total");
    // A zero share keeps its legend row but draws no sliver; a 100% slice is a full disc.
    expect(count(pie, 'class="tp-ai-chart__slice"')).toBe(1);
    expect(pie).toContain(">0%</span>");
    expect(pie).not.toContain("NaN");
  });

  it("renders KPI cards, and falls back to readable code with a notice for invalid cards", () => {
    const html = render(`本月概览：\n\n${fence("cards", [
      { title: "营收", value: 1284000, unit: "元", delta: "+12.5%", note: "较上月" },
      { title: "退款率", value: "1.2%", delta: "-0.3pp", trend: "down" },
      { title: "客单价", value: 86, unit: "元", trend: "flat" },
    ])}`);
    expect(html).toContain('<div class="tp-ai-cards-frame"><ul class="tp-ai-cards" aria-label="指标卡片" data-count="3">');
    expect(count(html, '<li class="tp-ai-card">')).toBe(3);
    expect(html).toContain('<strong class="tp-ai-card__value">1,284,000</strong><span class="tp-ai-card__unit">元</span>');
    expect(html).toContain('class="tp-ai-card__delta is-up"');
    expect(html).toContain('<span class="sr-only">上升</span><span>+12.5%</span>');
    expect(html).toContain('<span class="sr-only">下降</span>');
    expect(html).toContain('<span class="sr-only">持平</span>');
    expect(html).not.toContain("&quot;title&quot;");
    const invalid = render(fence("cards", '[{"title":"营收"}]'));
    expect(invalid).not.toContain("tp-ai-cards");
    expect(invalid).toContain("卡片数据格式无效，已显示原文");
    expect(invalid).toContain("&quot;title&quot;:&quot;营收&quot;");
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
    const partialCards = row("thinking", '概览。\n\n```cards\n[{"title":"营收","val');
    expect(partialCards).toContain("正在生成卡片…");
    expect(partialCards).not.toContain("&quot;title&quot;");
    const doneCards = row("thinking", '概览。\n\n```cards\n[{"title":"营收","value":12}]\n```');
    expect(doneCards).toContain("tp-ai-cards");
    expect(doneCards).not.toContain("正在生成");
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

describe("task lists", () => {
  it("renders GFM task items as a read-only checklist with a done/total count", () => {
    const html = render("上线前：\n\n- [x] 备份数据\n- [ ] 灰度发布\n  - [x] 通知客服\n- [ ] 复盘");
    expect(html).toContain('<div class="tp-ai-tasklist" role="group" aria-label="任务清单，已完成 2/4">');
    expect(html).toContain('<span class="tp-ai-tasklist__count">2/4</span>');
    expect(html).toContain('style="width:50%"');
    // Nested items are counted once, inside the same checklist (one header).
    expect(count(html, "tp-ai-tasklist__head")).toBe(1);
    expect(count(html, 'class="task-list-item tp-ai-task is-done"')).toBe(2);
    expect(count(html, 'class="task-list-item tp-ai-task"')).toBe(2);
    expect(count(html, 'role="img" aria-label="已完成"')).toBe(2);
    expect(count(html, 'role="img" aria-label="未完成"')).toBe(2);
    // Nothing is interactive: no checkbox the reader could tick.
    expect(html).not.toContain("<input");
    expect(html).toContain("灰度发布");
  });

  it("marks a fully done list and handles loose and ordered task lists", () => {
    const done = render("1. [x] 起草\n\n2. [x] 审核");
    expect(done).toContain('class="tp-ai-tasklist is-complete"');
    expect(done).toContain("<ol");
    expect(done).toContain("2/2");
    expect(done).toContain("<p><span class=\"tp-ai-task__box is-checked\"");
  });

  it("leaves ordinary lists untouched", () => {
    const html = render("- 甲\n- 乙\n\n1. 一\n2. 二");
    expect(html).not.toContain("tp-ai-tasklist");
    expect(html).not.toContain("tp-ai-task");
    expect(html).toContain("<ul>\n<li>甲</li>");
    expect(html).toContain("<ol>");
  });
});

describe("chart scale", () => {
  it("builds zero-based round ticks for positive, negative, tiny and huge data", () => {
    expect(niceChartScale([452, 310])).toMatchObject({ min: 0, max: 500, ticks: [0, 100, 200, 300, 400, 500] });
    expect(niceChartScale([-30, 45]).ticks).toEqual([-40, -20, 0, 20, 40, 60]);
    expect(niceChartScale([0, 0])).toMatchObject({ min: 0, max: 1 });
    expect(niceChartScale([0.0012, 0.0031]).ticks).toEqual([0, 0.001, 0.002, 0.003, 0.004]);
    expect(niceChartScale([2.5, 7]).ticks).toEqual([0, 2, 4, 6, 8]);
    for (const values of [[1e15, -1e15], [1e-12], [-3], [7, 7, 7]]) {
      const scale = niceChartScale(values);
      expect(scale.ticks.every(Number.isFinite), String(values)).toBe(true);
      expect(scale.ticks.length).toBeGreaterThanOrEqual(2);
      expect(scale.ticks.length).toBeLessThanOrEqual(13);
      expect(scale.min).toBeLessThanOrEqual(Math.min(0, ...values));
      expect(scale.max).toBeGreaterThanOrEqual(Math.max(0, ...values));
    }
  });

  it("keeps short labels readable without hiding small magnitudes", () => {
    expect(formatChartShort(12_500)).toBe("1.25万");
    expect(formatChartShort(1234.567)).toBe("1,234.57");
    expect(formatChartShort(0.001234)).toBe("0.00123");
    expect(formatChartShort(0)).toBe("0");
    expect(formatChartShort(0.25, 2)).toBe("0.25");
  });
});
