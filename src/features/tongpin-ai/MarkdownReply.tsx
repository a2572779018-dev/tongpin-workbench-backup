import { Children, cloneElement, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { AiSourceAnchor } from "./AiSourceLink";
import { ChatChart } from "./ChatChart";
import { splitMarkdownIntoBlocks, StableMarkdownBlocks } from "./librechatMarkdownBlocks";
import { codeBlockFromHast } from "./replyCodeData";
import { escapeCurrencyDollars, remarkReplyEmphasis, replyUrlTransform } from "./replyMarkdown";
import { ReplyFollowups } from "./ReplyFollowups";
import { parseReplyChart, parseReplyFollowups, pendingReplyTail, type PendingReplyTail } from "./replyRichBlocks";
import { tableRowsFromHast, tableToCsv, tableToMarkdown, tableToTsv } from "./replyTableData";
import { TypewriterText } from "./TypewriterText";
import "./reply-markdown.css";
import "katex/dist/katex.min.css";

const plugins = [remarkGfm, remarkReplyEmphasis, remarkMath];
// Model text is untrusted input: KaTeX renders with extensions off, errors
// inline instead of throwing, and never executes links or scripts.
const rehype = [[rehypeKatex, { throwOnError: false, errorColor: "#a33b2e", strict: false, trust: false, output: "html" }]] as unknown as NonNullable<Parameters<typeof Markdown>[0]>["rehypePlugins"];

function ReplyTable({ node, children }: { node: unknown; children: ReactNode }) {
  const rows = useMemo(() => tableRowsFromHast(node), [node]);
  const [feedback, setFeedback] = useState("");
  const copy = async (format: "markdown" | "tsv") => {
    try {
      await navigator.clipboard.writeText(format === "markdown" ? tableToMarkdown(rows) : tableToTsv(rows));
      setFeedback(format === "markdown" ? "已复制 Markdown" : "已复制 TSV");
    } catch { setFeedback("复制失败，请手动选择表格内容。"); }
  };
  const downloadCsv = () => {
    try {
      const url = URL.createObjectURL(new Blob([tableToCsv(rows)], { type: "text/csv;charset=utf-8" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "同频AI-表格.csv";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setFeedback("下载已开始，请到下载目录确认文件。");
    } catch { setFeedback("下载未开始，请重试。"); }
  };
  return <div className="tp-ai-markdown-table">
    <div className="tp-ai-markdown-table__actions">
      <button type="button" disabled={!rows.length} onClick={() => void copy("markdown")}>复制 Markdown</button>
      <button type="button" disabled={!rows.length} onClick={() => void copy("tsv")}>复制 TSV</button>
      <button type="button" disabled={!rows.length} onClick={downloadCsv}>下载 CSV</button>
      <span role="status" aria-live="polite">{feedback}</span>
    </div>
    <div className="tp-ai-markdown-table__scroll" tabIndex={0} role="region" aria-label="回复中的表格"><table>{children}</table></div>
  </div>;
}

function ReplyCode({ node, children }: { node: unknown; children: ReactNode }) {
  const { text, language } = useMemo(() => codeBlockFromHast(node), [node]);
  const [feedback, setFeedback] = useState("");
  // Optional rich blocks ride the fenced-code channel: a valid ```chart block
  // becomes a labelled chart, a valid ```followups block becomes chips. A
  // malformed chart keeps rendering as plain code (with a notice) so its data
  // stays readable; malformed followups are only suggestions and are dropped.
  // The parser result (not the element, which is always truthy) decides the
  // branch, and the hooks above stay unconditional so render order is stable.
  const chartInvalid = language === "chart" && !parseReplyChart(text);
  if (language === "chart" && !chartInvalid) return <ChatChart body={text} />;
  if (language === "followups") return parseReplyFollowups(text).length ? <ReplyFollowups body={text} /> : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("已复制代码");
    } catch { setFeedback("复制失败，请手动选择代码。"); }
  };
  return <div className="tp-ai-markdown-code">
    <div className="tp-ai-markdown-code__actions">
      <span>{language || "代码"}</span>
      {chartInvalid ? <small className="tp-ai-markdown-code__notice">图表数据格式无效，已显示原文</small> : null}
      <button type="button" onClick={() => void copy()}>复制代码</button>
      <span role="status" aria-live="polite">{feedback}</span>
    </div>
    <pre>{children}</pre>
  </div>;
}

const components: Components = {
  a: ({ href, children }) => <AiSourceAnchor className="tp-ai-inline-source" href={href ?? ""}>{children}</AiSourceAnchor>,
  // Remote images in model text must not initiate network requests on display.
  img: ({ src, alt }) => <AiSourceAnchor href={typeof src === "string" ? src : ""}>{alt || "查看图片"}</AiSourceAnchor>,
  pre: ({ node, children }) => <ReplyCode node={node} children={children} />,
  table: ({ node, children }) => <ReplyTable node={node} children={children} />,
};

function renderReplyBlock(content: string): ReactNode {
  return Markdown({ children: escapeCurrencyDollars(content), remarkPlugins: plugins, rehypePlugins: rehype,
    components, skipHtml: true, urlTransform: replyUrlTransform });
}

const PENDING_LABELS: Record<Exclude<PendingReplyTail, null | "fence" | "followups">, string> = {
  chart: "正在生成图表…",
  math: "正在生成公式…",
  table: "正在生成表格…",
};

/** Final block of a still-streaming reply: an unfinished chart, formula or
 * table header shows a short placeholder instead of raw syntax that would
 * flicker into a widget; followup chips and empty code boxes wait silently. */
function renderStreamingTail(content: string): ReactNode {
  const pending = pendingReplyTail(content);
  if (pending === "fence" || pending === "followups") return null;
  if (pending) return <p className="tp-ai-markdown-pending">{PENDING_LABELS[pending]}</p>;
  return renderReplyBlock(content);
}

export function replyTreeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return replyTreeText(node.props.children);
  if (Array.isArray(node)) return node.map(replyTreeText).join("");
  return "";
}

/** Reveal already-parsed text. No partial Markdown syntax or parser per timer tick. */
export function revealReplyTree(node: ReactNode, visible: number): ReactNode {
  let remaining = visible;
  function reveal(value: ReactNode): ReactNode {
    if (remaining <= 0) return null;
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value);
      const shown = text.slice(0, remaining);
      remaining -= shown.length;
      return shown;
    }
    if (Array.isArray(value)) return Children.map(value, reveal);
    if (isValidElement<{ children?: ReactNode }>(value)) {
      if (value.props.children === undefined) return value;
      return cloneElement(value, undefined, reveal(value.props.children));
    }
    return value;
  }
  return reveal(node);
}

export const MarkdownReply = memo(function MarkdownReply({ content, typing = false, streaming = false }: { content: string; typing?: boolean; streaming?: boolean }) {
  // During the post-response typewriter effect, reveal a single parsed tree.
  // The active SSE path below uses LibreChat's stable completed-block rendering.
  const tree = useMemo(() => typing
    ? splitMarkdownIntoBlocks(content).map(block => renderReplyBlock(block.raw))
    : null, [content, typing]);
  const text = useMemo(() => replyTreeText(tree), [tree]);
  return <div className="tp-ai-markdown">
    {typing ? <TypewriterText content={text} render={offset => revealReplyTree(tree, offset)} />
      : <StableMarkdownBlocks content={content} renderBlock={renderReplyBlock} renderTail={streaming ? renderStreamingTail : undefined} />}
    {typing && <span className="tp-ai-message__typing-caret" aria-hidden="true" />}
  </div>;
});
