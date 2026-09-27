import { Children, cloneElement, Fragment, isValidElement, memo, useMemo, useState, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { AiSourceAnchor } from "./AiSourceLink";
import { ChatChart } from "./ChatChart";
import { splitMarkdownIntoBlocks, StableMarkdownBlocks } from "./librechatMarkdownBlocks";
import { codeBlockClosed, codeBlockFromHast } from "./replyCodeData";
import { escapeCurrencyDollars, remarkReplyEmphasis, replyUrlTransform } from "./replyMarkdown";
import { ReplyFollowups } from "./ReplyFollowups";
import { parseReplyCards, parseReplyChart, parseReplyFollowups, pendingReplyTail, type PendingReplyTail } from "./replyRichBlocks";
import { ReplyCards } from "./ReplyCards";
import { ReplyListItem, ReplyOrderedList, ReplyTaskCheckbox, ReplyUnorderedList } from "./ReplyTaskList";
import { useReplyHighlight } from "./useReplyHighlight";
import { tableRowsFromHast, tableToCsv, tableToMarkdown, tableToTsv } from "./replyTableData";
import { TypewriterText } from "./TypewriterText";
import { useStreamReveal } from "./streamReveal";
import { saveBlobWithFeedback } from "./downloadFeedback";
import { ReplyCitationMarker } from "./ReplyCitation";
import { blockCitations, remarkReplyCitationAnchors, remarkReplyModelCitations, type ReplyBlockCitations, type ReplyCitations } from "./replyCitations";
import "./reply-markdown.css";
import "katex/dist/katex.min.css";

const plugins = [remarkGfm, remarkReplyEmphasis, remarkMath];
// Model text is untrusted input: KaTeX renders with extensions off, errors
// inline instead of throwing, and never executes links or scripts.
const rehype = [[rehypeKatex, { throwOnError: false, errorColor: "#a33b2e", strict: false, trust: false, output: "html" }]] as unknown as NonNullable<Parameters<typeof Markdown>[0]>["rehypePlugins"];

/** A distinct, timestamped name so a new export never collides with an older one. */
export function csvFilename(rows: readonly (readonly string[])[], now = new Date()): string {
  const header = (rows[0]?.[0] ?? "").replace(/[\\/:*?"<>|\s]+/g, "").slice(0, 12);
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `同频AI-表格${header ? `-${header}` : ""}-${stamp}.csv`;
}

function ReplyTable({ node, children }: { node: unknown; children: ReactNode }) {
  const rows = useMemo(() => tableRowsFromHast(node), [node]);
  const [feedback, setFeedback] = useState("");
  const copy = async (format: "markdown" | "tsv") => {
    try {
      await navigator.clipboard.writeText(format === "markdown" ? tableToMarkdown(rows) : tableToTsv(rows));
      setFeedback(format === "markdown" ? "已复制 Markdown" : "已复制 TSV");
    } catch { setFeedback("复制失败，请手动选择表格内容。"); }
  };
  // Same save path as generated images/videos: the desktop app reports the
  // real outcome (saved path / cancelled / failed) instead of assuming success.
  const downloadCsv = async () => {
    try {
      // A UTF-8 BOM keeps Chinese headers readable when the CSV opens in Excel.
      const blob = new Blob(["\uFEFF", tableToCsv(rows)], { type: "text/csv;charset=utf-8" });
      const result = await saveBlobWithFeedback(blob, csvFilename(rows));
      setFeedback(result.message);
    } catch { setFeedback("下载未开始，请重试。"); }
  };
  return <div className="tp-ai-markdown-table">
    <div className="tp-ai-markdown-table__actions">
      <button type="button" disabled={!rows.length} onClick={() => void copy("markdown")}>复制 Markdown</button>
      <button type="button" disabled={!rows.length} onClick={() => void copy("tsv")}>复制 TSV</button>
      <button type="button" disabled={!rows.length} onClick={() => void downloadCsv()}>下载 CSV</button>
      <span role="status" aria-live="polite">{feedback}</span>
    </div>
    <div className="tp-ai-markdown-table__scroll" tabIndex={0} role="region" aria-label="回复中的表格"><table>{children}</table></div>
  </div>;
}

function ReplyCode({ node, children }: { node: unknown; children: ReactNode }) {
  const { text, language } = useMemo(() => codeBlockFromHast(node), [node]);
  const closed = useMemo(() => codeBlockClosed(node), [node]);
  const [feedback, setFeedback] = useState("");
  // Optional rich blocks ride the fenced-code channel: a valid ```chart block
  // becomes a labelled chart, ```cards becomes KPI cards and a valid
  // ```followups block becomes chips. A malformed chart or card set keeps
  // rendering as plain code (with a notice) so its data stays readable;
  // malformed followups are only suggestions and are dropped. The parser
  // result (not the element, which is always truthy) decides the branch, and
  // every hook stays unconditional so render order is stable.
  const rich = language === "chart" || language === "cards" || language === "followups";
  const invalid = useMemo(() => language === "chart" ? !parseReplyChart(text)
    : language === "cards" ? !parseReplyCards(text) : false, [language, text]);
  // Highlight settled code only: a fence still streaming stays plain until its
  // closing line arrives (no per-chunk re-colouring), as does code the
  // typewriter is still revealing (its children then hold a prefix).
  const settled = closed && replyTreeText(children).length >= text.length;
  const highlighted = useReplyHighlight(settled && !rich ? text : null, rich ? "" : language);
  if (language === "chart" && !invalid) return <ChatChart body={text} />;
  if (language === "cards" && !invalid) return <ReplyCards body={text} />;
  if (language === "followups") return parseReplyFollowups(text).length ? <ReplyFollowups body={text} /> : null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setFeedback("已复制代码");
    } catch { setFeedback("复制失败，请手动选择代码。"); }
  };
  return <div className="tp-ai-markdown-code">
    <div className="tp-ai-markdown-code__actions">
      <span className="tp-ai-markdown-code__lang">{language || "代码"}</span>
      {invalid ? <small className="tp-ai-markdown-code__notice">{language === "cards" ? "卡片" : "图表"}数据格式无效，已显示原文</small> : null}
      <button type="button" onClick={() => void copy()}>复制代码</button>
      <span role="status" aria-live="polite">{feedback}</span>
    </div>
    <pre>{highlighted ? <code className={`hljs language-${language}`}>{highlighted}</code> : children}</pre>
  </div>;
}

const components: Components = {
  a: ({ href, children }) => <AiSourceAnchor className="tp-ai-inline-source" href={href ?? ""}>{children}</AiSourceAnchor>,
  // Remote images in model text must not initiate network requests on display.
  img: ({ src, alt }) => <AiSourceAnchor href={typeof src === "string" ? src : ""}>{alt || "查看图片"}</AiSourceAnchor>,
  pre: ({ node, children }) => <ReplyCode node={node} children={children} />,
  // GFM task lists become a read-only checklist; other lists render as before.
  ul: ({ node, className, children }) => <ReplyUnorderedList node={node} className={className} children={children} />,
  ol: ({ node, className, start, children }) => <ReplyOrderedList node={node} className={className} start={start} children={children} />,
  li: ({ node, id, className, children }) => <ReplyListItem node={node} id={id} className={className} children={children} />,
  input: ({ type, checked }) => <ReplyTaskCheckbox type={type} checked={checked} />,
  table: ({ node, children }) => <ReplyTable node={node} children={children} />,
};

// `tongpin-cite` elements exist only when a settled reply's own citation plugins created them.
const citedComponents = { ...components, "tongpin-cite": ReplyCitationMarker } as Components;
type RemarkPlugins = NonNullable<Parameters<typeof Markdown>[0]>["remarkPlugins"];
/** Provider markers are placed first, on positioned nodes; model-written "[n]" last. */
const citationPlugins = (citations: ReplyBlockCitations) =>
  [[remarkReplyCitationAnchors, citations], ...plugins, [remarkReplyModelCitations, citations]] as RemarkPlugins;

function renderReplyBlock(content: string, citations?: ReplyBlockCitations): ReactNode {
  return Markdown({ children: escapeCurrencyDollars(content), remarkPlugins: citations ? citationPlugins(citations) : plugins, rehypePlugins: rehype,
    components: citedComponents, skipHtml: true, urlTransform: replyUrlTransform });
}
const renderPlainBlock = (source: string) => renderReplyBlock(source);

const PENDING_LABELS: Record<Exclude<PendingReplyTail, null | "fence" | "followups">, string> = {
  chart: "正在生成图表…",
  cards: "正在生成卡片…",
  math: "正在生成公式…",
  table: "正在生成表格…",
};

/** Final block of a still-streaming reply: an unfinished chart, card set,
 * formula or table header shows a short placeholder instead of raw syntax
 * that would flicker into a widget; followup chips and empty code boxes wait
 * silently. An open code fence streams as plain code (see ReplyCode). */
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

/** `citations` belong to a settled reply only: a streaming reply shows plain text. */
export const MarkdownReply = memo(function MarkdownReply({ content, typing = false, streaming = false, citations }: { content: string; typing?: boolean; streaming?: boolean; citations?: ReplyCitations }) {
  // Streamed text catches up at a steady pace instead of jumping per network
  // burst, and keeps rendering as live until it has caught up.
  const reveal = useStreamReveal(content, streaming && !typing);
  const live = streaming || reveal.revealing;
  // Keyed by value: an equal marker set on a re-created message keeps every memoized block.
  const citationKey = citations && !live ? JSON.stringify(citations) : "";
  const renderBlock = useMemo<(source: string, start: number) => ReactNode>(() => {
    if (!citationKey) return renderPlainBlock;
    const markers = JSON.parse(citationKey) as ReplyCitations;
    return (source: string, start: number) => renderReplyBlock(source, blockCitations(markers, source, start));
  }, [citationKey]);
  // During the post-response typewriter effect, reveal a single parsed tree.
  // The active SSE path below uses LibreChat's stable completed-block rendering.
  const tree = useMemo(() => typing
    ? splitMarkdownIntoBlocks(content).map(block => <Fragment key={block.start}>{renderBlock(block.raw, block.start)}</Fragment>)
    : null, [content, typing, renderBlock]);
  const text = useMemo(() => replyTreeText(tree), [tree]);
  return <div className={`tp-ai-markdown${live || typing ? " is-live" : ""}`}>
    {typing ? <TypewriterText content={text} render={offset => revealReplyTree(tree, offset)} />
      : <StableMarkdownBlocks content={content} visible={live ? reveal.visible : undefined} renderBlock={renderBlock} renderTail={live ? renderStreamingTail : undefined} />}
    {typing && <span className="tp-ai-message__typing-caret" aria-hidden="true" />}
  </div>;
});
