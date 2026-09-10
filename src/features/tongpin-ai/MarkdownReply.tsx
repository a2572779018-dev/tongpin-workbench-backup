import { Children, cloneElement, isValidElement, memo, useMemo, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { AiSourceAnchor } from "./AiSourceLink";
import { remarkReplyEmphasis, replyUrlTransform } from "./replyMarkdown";
import { TypewriterText } from "./TypewriterText";
import "./reply-markdown.css";

const plugins = [remarkGfm, remarkReplyEmphasis];
const components: Components = {
  a: ({ href, children }) => <AiSourceAnchor className="tp-ai-inline-source" href={href ?? ""}>{children}</AiSourceAnchor>,
  // Remote images in model text must not initiate network requests on display.
  img: ({ src, alt }) => <AiSourceAnchor href={typeof src === "string" ? src : ""}>{alt || "查看图片"}</AiSourceAnchor>,
  table: ({ children }) => <div className="tp-ai-markdown-table" tabIndex={0} role="region" aria-label="回复中的表格"><table>{children}</table></div>,
};

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

export const MarkdownReply = memo(function MarkdownReply({ content, typing = false }: { content: string; typing?: boolean }) {
  // Markdown is a synchronous, hook-free parser; memoize the complete render tree.
  const tree = useMemo(() => Markdown({ children: content, remarkPlugins: plugins,
    components, skipHtml: true, urlTransform: replyUrlTransform }), [content]);
  const text = useMemo(() => replyTreeText(tree), [tree]);
  return <div className="tp-ai-markdown">
    {typing ? <TypewriterText content={text} render={offset => revealReplyTree(tree, offset)} /> : tree}
    {typing && <span className="tp-ai-message__typing-caret" aria-hidden="true" />}
  </div>;
});
