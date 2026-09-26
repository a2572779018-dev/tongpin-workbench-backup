import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "./ChatMessageRow";
import { MarkdownReply } from "./MarkdownReply";
import { highlightReplyTree, isReplyHighlightLanguage, MAX_HIGHLIGHT_LENGTH, REPLY_HIGHLIGHT_GRAMMARS } from "./replyCodeHighlight";
import { loadReplyHighlighter } from "./useReplyHighlight";

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownReply, { content }));
const row = (status: "thinking" | "ready", content: string) => renderToStaticMarkup(createElement(ChatMessageRow, {
  assistantName: "同频 AI", copied: false, retryable: false, retryDisabled: false,
  onCopy: () => {}, onOpenArtifact: () => {}, onRetry: () => {},
  message: { id: "code", role: "assistant", status, content, time: "12:00", startedAt: Date.now() },
}));
const source = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");

describe("highlight language registration", () => {
  it("registers exactly the curated grammar set", () => {
    expect([...REPLY_HIGHLIGHT_GRAMMARS].sort()).toEqual(["bash", "css", "diff", "go", "java", "javascript", "json", "markdown", "python", "rust", "sql", "typescript", "xml", "yaml"]);
  });

  it("resolves the names and aliases models actually write, in any case", () => {
    for (const language of ["js", "jsx", "javascript", "ts", "tsx", "TypeScript", "json", "jsonc", "py", "python", "sql", "mysql", "postgresql",
      "bash", "sh", "zsh", "shell", "html", "xml", "svg", "css", "java", "go", "golang", "rust", "rs", "yaml", "yml", "markdown", "md", "diff", "patch"]) {
      expect(isReplyHighlightLanguage(language), language).toBe(true);
    }
  });

  it("leaves everything else plain: no auto-detection, no extra bundles", () => {
    for (const language of ["", "text", "plaintext", "c", "cpp", "php", "ruby", "kotlin", "swift", "cobol", "constructor", "__proto__", "chart"]) {
      expect(isReplyHighlightLanguage(language), language).toBe(false);
      expect(highlightReplyTree("x = 1", language), language).toBeNull();
    }
    expect(highlightReplyTree("", "ts")).toBeNull();
    expect(highlightReplyTree("a".repeat(MAX_HIGHLIGHT_LENGTH + 1), "ts")).toBeNull();
  });

  it("keeps highlight.js out of the chat chunk and never pulls lowlight's full grammar sets", () => {
    const module = source("./replyCodeHighlight.ts");
    expect(module).toMatch(/import \{ createLowlight \} from "lowlight";/);
    expect(module).not.toMatch(/\b(?:common|all)\b[^\n]*from "lowlight"/);
    expect(module).not.toContain('"highlight.js"');
    expect(source("./useReplyHighlight.ts")).toContain('import("./replyCodeHighlight")');
    // Only type imports may reference the highlighter statically.
    for (const file of ["./useReplyHighlight.ts", "./MarkdownReply.tsx"]) {
      expect(source(file)).not.toMatch(/^import (?!type)[^\n]*from "\.\/replyCodeHighlight"/m);
    }
  });
});

describe("highlighted code blocks", () => {
  const snippet = "```ts\nconst total: number = add(1, 2); // 合计\n```";

  it("shows plain code until the lazy highlighter has loaded", () => {
    const html = render(snippet);
    expect(html).not.toContain("hljs");
    expect(html).toContain("const total: number = add(1, 2); // 合计");
  });

  it("highlights settled code with the curated grammar once loaded", async () => {
    expect(await loadReplyHighlighter()).not.toBeNull();
    const html = render(snippet);
    expect(html).toContain('<code class="hljs language-ts">');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-built_in">number</span>');
    expect(html).toContain('<span class="hljs-comment">// 合计</span>');
    // Copy and the language label are unchanged.
    expect(html).toContain('<span class="tp-ai-markdown-code__lang">ts</span>');
    expect(html).toContain(">复制代码</button>");
  });

  it("escapes code text: highlighted HTML never becomes markup", () => {
    const html = render('```html\n<script>alert("x")</script>\n<img src=x onerror=alert(1)>\n```');
    expect(html).toContain('<code class="hljs language-html">');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;<span class=\"hljs-name\">script</span>&gt;");
  });

  it("keeps unknown and unlabelled fences plain", () => {
    for (const block of ["```cobol\nDISPLAY 'HI'.\n```", "```\nconst a = 1\n```"]) {
      const html = render(block);
      expect(html).not.toContain("hljs");
      expect(html).toContain("tp-ai-markdown-code");
    }
  });

  it("does not colour a fence while it is still streaming, and highlights it once closed", () => {
    const open = row("thinking", "代码：\n\n```ts\nconst a = \"unterminated");
    expect(open).toContain("const a = &quot;unterminated");
    expect(open).not.toContain("hljs");
    const closedTail = row("thinking", "代码：\n\n```ts\nconst a = 1\n```");
    expect(closedTail).toContain('<span class="hljs-keyword">const</span>');
    // A chunk that ends right after a newline is still an open fence.
    expect(row("thinking", "代码：\n\n```ts\nconst a = 1\n")).not.toContain("hljs");
    expect(row("thinking", "> ```py\n> print('x')")).not.toContain("hljs");
    const nested = row("thinking", "步骤：\n\n1. 安装依赖\n   ```bash\n   npm install \"unterminated");
    expect(nested).toContain("npm install");
    expect(nested).not.toContain("hljs");
    expect(row("thinking", "步骤：\n\n1. 安装依赖\n   ```bash\n   npm install\n   ```")).toContain('<code class="hljs language-bash">');
    const earlierBlock = row("thinking", "```py\nprint('hi')\n```\n\n还在输出");
    expect(earlierBlock).toContain('<span class="hljs-built_in">print</span>');
    expect(row("ready", "```ts\nconst a = 1\n```")).toContain('<span class="hljs-keyword">const</span>');
  });

  it("marks diff additions and deletions", () => {
    const html = render("```diff\n- old\n+ new\n```");
    expect(html).toContain('<span class="hljs-deletion">- old</span>');
    expect(html).toContain('<span class="hljs-addition">+ new</span>');
  });

  it("styles every token class it emits on the warm light theme", () => {
    const css = source("./reply-markdown.css");
    for (const token of ["hljs-keyword", "hljs-string", "hljs-number", "hljs-comment", "hljs-title", "hljs-built_in", "hljs-attr", "hljs-addition", "hljs-deletion"]) {
      expect(css).toMatch(new RegExp(`\\.tp-ai-markdown-code \\.${token}\\b`));
    }
  });
});
