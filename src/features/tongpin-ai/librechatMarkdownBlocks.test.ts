import { describe, expect, it } from "vitest";
import { splitMarkdownIntoBlocks } from "./librechatMarkdownBlocks";

const raws = (content: string) => splitMarkdownIntoBlocks(content).map(block => block.raw);

// Adapted from LibreChat v0.8.7 splitMarkdown.test.ts; the Tongpin renderer
// enables GFM but deliberately does not enable upstream math/artifact directives.
describe("LibreChat-derived streamed Markdown blocks", () => {
  it("keeps completed paragraphs stable while the trailing paragraph grows", () => {
    expect(raws("第一段。\n\n第二")).toEqual(["第一段。", "第二"]);
    expect(raws("第一段。\n\n第二段。")).toEqual(["第一段。", "第二段。"]);
    expect(splitMarkdownIntoBlocks("")).toEqual([]);
  });

  it("keeps a GFM table and fenced code atomic even across blank lines", () => {
    const table = "| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |";
    const code = "```ts\nconst a = 1;\n\nconst b = 2;\n```";
    expect(raws(`说明。\n\n${table}\n\n${code}\n\n结论。`)).toEqual(["说明。", table, code, "结论。"]);
  });

  it("keeps lists intact and preserves document-scoped link definitions", () => {
    expect(raws("- 一\n- 二\n- 三")).toEqual(["- 一\n- 二\n- 三"]);
    const reference = "详见 [文档][d]。\n\n[d]: https://example.com/docs";
    expect(raws(reference)).toEqual([reference]);
    const footnote = "结论。[^1]\n\n[^1]: 来源说明";
    expect(raws(footnote)).toEqual([footnote]);
  });

  it("falls back to one block for top-level raw HTML rather than changing its semantics", () => {
    const html = "<div>a</div>\n\n<div>b</div>";
    expect(raws(html)).toEqual([html]);
  });
});
