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
 * Tongpin currently renders GFM only. The source splitter lives in shared/
 * so the settled server response and this real chat renderer agree on blocks.
 * Upstream math/directive and code/artifact providers remain omitted.
 */
type RenderBlock = (source: string) => ReactNode;

/** Memoized block from LibreChat's completed-block rendering pattern. */
const CompletedMarkdownBlock = memo(function CompletedMarkdownBlock({ source, renderBlock }: {
  source: string;
  renderBlock: RenderBlock;
}) {
  return renderBlock(source);
}, (previous, next) => previous.source === next.source && previous.renderBlock === next.renderBlock);

/** Main chat renderer: only the changing final block re-parses during SSE. */
export const StableMarkdownBlocks = memo(function StableMarkdownBlocks({ content, renderBlock }: {
  content: string;
  renderBlock: RenderBlock;
}) {
  const blocks = useMemo(() => splitMarkdownIntoBlocks(content), [content]);
  return <>{blocks.map((block, index) => <CompletedMarkdownBlock key={index} source={block.raw} renderBlock={renderBlock} />)}</>;
});
