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
export const StableMarkdownBlocks = memo(function StableMarkdownBlocks({ content, renderBlock, renderTail }: {
  content: string;
  renderBlock: RenderBlock;
  renderTail?: RenderBlock;
}) {
  const blocks = useMemo(() => splitMarkdownIntoBlocks(content), [content]);
  return <>{blocks.map((block, index) => <CompletedMarkdownBlock key={index} source={block.raw} start={block.start}
    renderBlock={renderTail && index === blocks.length - 1 ? renderTail : renderBlock} />)}</>;
});
