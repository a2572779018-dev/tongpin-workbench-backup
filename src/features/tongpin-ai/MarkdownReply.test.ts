import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownReply, replyTreeText, revealReplyTree } from "./MarkdownReply";
import { ChatMessageRow } from "./ChatMessageRow";
import { replyUrlTransform } from "./replyMarkdown";

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownReply, { content }));
describe("AI reply formatting", () => {
  it("renders Chinese emphasis and the screenshot's citations without exposing Markdown", () => {
    const html = render('小秋，**这是一段结论**。\n\n([sz.ifeng.com](https://sz.ifeng.com/c/example?utm_source=openai))\n\n**结论：请核实。 **');
    expect(html).toContain("<strong>这是一段结论</strong>");
    expect(html).toContain("<strong>结论：请核实。</strong>");
    expect(html).not.toContain("**");
    expect(html).not.toContain("[sz.ifeng.com]");
    expect(html).toContain('href="https://sz.ifeng.com/c/example?utm_source=openai"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain(">sz.ifeng.com</a>");
  });
  it("supports lists, headings, quotes and horizontally scrollable tables", () => {
    const html = render('## 下一步\n\n1. **核实资料**\n2. 保留记录\n\n> 提示\n\n| 项目 | 状态 |\n| --- | --- |\n| 测试 | 完成 |');
    for (const tag of ["<h2>", "<ol>", "<li>", "<blockquote>", "<table>", "<th>", "<td>"]) expect(html).toContain(tag);
    expect(html).toContain('aria-label="回复中的表格"');
    for (const label of ["复制 Markdown", "复制 TSV", "下载 CSV"]) expect(html).toContain(`>${label}</button>`);
  });
  it("does not rewrite code or deliberately escaped asterisks", () => {
    const html = render('`**不是加粗**`\n\n```js\nconst s = "**保留。 **";\n```\n\n\\*\\*原样标记\\*\\*');
    expect(html).toContain("<code>**不是加粗**</code>");
    expect(html).toContain("**保留。 **");
    expect(html).toContain("**原样标记**");
    expect(html).not.toContain("<strong>");
  });
  it("never executes HTML, unsafe URLs or loads remote tracking images", () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://tracker.example/pixel" onerror="alert(1)">\n\n[危险](javascript:alert%281%29)\n\n[文件](file:///tmp/private)\n\n![示意图](https://example.com/image.png)');
    for (const bad of ["<script", "<img", "onerror=", 'href="javascript:', 'href="file:']) expect(html).not.toContain(bad);
    expect(html).toContain('href="https://example.com/image.png"');
    expect(replyUrlTransform("https://user:secret@example.com/")).toBe("");
    expect(replyUrlTransform("//example.com/")).toBe("");
    expect(replyUrlTransform("data:text/html,hi")).toBe("");
  });
  it("reveals formatted text without showing a partial link or Markdown markers", () => {
    const tree = createElement("p", null, "你好", createElement("strong", null, "同频"), createElement("a", { href: "https://example.com" }, "来源"));
    expect(replyTreeText(tree)).toBe("你好同频来源");
    expect(renderToStaticMarkup(revealReplyTree(tree, 3))).toBe("<p>你好<strong>同</strong></p>");
    expect(renderToStaticMarkup(revealReplyTree(tree, 5))).toContain('href="https://example.com">来</a>');
    expect(renderToStaticMarkup(revealReplyTree(tree, 0))).toBe("");
  });
  it("formats existing assistant replies but keeps user input and errors as plain text", () => {
    const base = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false,
      onCopy: () => {}, onOpenArtifact: () => {}, onRetry: () => {} };
    const row = (role: "assistant" | "user", status: "ready" | "error") => renderToStaticMarkup(createElement(ChatMessageRow, {
      ...base, message: { id: "old", role, status, content: "**保留**", time: "12:00" },
    }));
    expect(row("assistant", "ready")).toContain("<strong>保留</strong>");
    expect(row("user", "ready")).toContain("<p>**保留**</p>");
    expect(row("assistant", "error")).toContain("<p>**保留**</p>");
  });
  it("shows a completed rich table on the real chat row before the stream ends and after reopening", () => {
    const base = { assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false,
      onCopy: () => {}, onOpenArtifact: () => {}, onRetry: () => {} };
    const prefix = "正在整理。\n\n| 项目 | 状态 |\n| --- | --- |\n| 视频 | 已完成 |";
    const row = (status: "thinking" | "ready", content: string) => renderToStaticMarkup(createElement(ChatMessageRow, {
      ...base, message: { id: "streamed-reply", role: "assistant", status, content, time: "12:00", startedAt: Date.now() },
    }));
    const duringStream = row("thinking", `${prefix}\n\n结`);
    const afterReopen = row("ready", `${prefix}\n\n结论。`);
    for (const html of [duringStream, afterReopen]) {
      expect(html).toContain("<table>");
      expect(html).toContain("<th>项目</th>");
      expect(html).toContain("<td>已完成</td>");
      expect(html).not.toContain("| --- |");
    }
    expect(duringStream).toContain("结</p>");
    expect(afterReopen).toContain("结论。</p>");
  });
});
