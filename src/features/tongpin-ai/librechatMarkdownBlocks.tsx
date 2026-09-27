import { memo, useMemo, type ReactNode } from "react";
import { splitMarkdownIntoBlocks } from "../../../shared/librechatMarkdownBlocks";
export { splitMarkdownIntoBlocks } from "../../../shared/librechatMarkdownBlocks";
export type { MarkdownBlock } from "../../../shared/librechatMarkdownBlocks";

/**
 * Adapted from LibreChat v0.8.7, commit
 * 9e74cc0e57b395926122bd4062c1fcedc48ed465:
 * client/src/components/Chat/Messages/Content/splitMarkdown.ts and
 * MarkdownBlocks.tsx (MIT, Copyright (c) 2026 LibreChat).
 *
 * Tongpin renders GFM plus `$`/`$$` math. The source splitter lives in
 * shared/ so the settled server response and this real chat renderer agree
 * on blocks (display math stays one block). Upstream directive and
 * code/artifact providers remain omitted.
 */
/** `start` is the block's UTF-16 offset in the full reply (used to place citation markers). */
type RenderBlock = (source: string, start: number) => ReactNode;

/** Memoized block from LibreChat's completed-block rendering pattern. */
const CompletedMarkdownBlock = memo(function CompletedMarkdownBlock({ source, start, renderBlock }: {
  source: string;
  start: number;
  renderBlock: RenderBlock;
}) {
  return renderBlock(source, start);
}, (previous, next) => previous.source === next.source && previous.start === next.start && previous.renderBlock === next.renderBlock);

/** Main chat renderer: only the changing final block re-parses during SSE.
 * While streaming, the still-growing final block may use `renderTail` so an
 * unfinished construct (an open chart fence, a table header without its
 * delimiter row) is not shown as raw syntax that then jumps into a widget. */
export const StableMarkdownBlocks = memo(function StableMarkdownBlocks({ content, renderBlock, renderTail, visible }: {
  content: string;
  renderBlock: RenderBlock;
  renderTail?: RenderBlock;
  /** Render only this much of `content` (a streamed reply catching up):
   * blocks before it stay memoized and only the cut block re-parses. */
  visible?: number;
}) {
  const blocks = useMemo(() => splitMarkdownIntoBlocks(content), [content]);
  const limit = visible === undefined ? content.length : Math.max(0, Math.min(visible, content.length));
  const shown = limit >= content.length ? blocks : blocks.filter(block => block.start < limit);
  return <>{shown.map((block, index) => <CompletedMarkdownBlock key={index}
    source={block.end > limit ? block.raw.slice(0, limit - block.start) : block.raw} start={block.start}
    renderBlock={renderTail && index === shown.length - 1 ? renderTail : renderBlock} />)}</>;
});
