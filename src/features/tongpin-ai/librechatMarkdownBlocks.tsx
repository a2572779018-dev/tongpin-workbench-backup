import { memo, useMemo, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * Adapted from LibreChat v0.8.7, commit
 * 9e74cc0e57b395926122bd4062c1fcedc48ed465:
 * client/src/components/Chat/Messages/Content/splitMarkdown.ts and
 * MarkdownBlocks.tsx (MIT, Copyright (c) 2026 LibreChat).
 *
 * Tongpin currently renders GFM only. Upstream math/directive parsing and its
 * code/artifact index providers are omitted so the splitter and renderer use
 * the same grammar and no unsupported provider state is introduced.
 */
export interface MarkdownBlock {
  /** Exact source slice for this top-level block. */
  raw: string;
}

interface MdastNode {
  type: string;
  children?: MdastNode[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

function containsDefinition(node: MdastNode): boolean {
  if (node.type === "definition" || node.type === "footnoteDefinition") return true;
  return (node.children ?? []).some(containsDefinition);
}

/** Completed source slices stay byte-identical while the last block grows. */
export function splitMarkdownIntoBlocks(content: string): MarkdownBlock[] {
  if (!content) return [];
  const tree = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MdastNode;
  const children = tree.children ?? [];
  if (children.length === 0) return [{ raw: content }];

  // Definitions are document-scoped; separating them breaks reference links.
  // Raw top-level HTML is displayed as escaped text, so retain its separators.
  if (children.some(node => node.type === "html" || containsDefinition(node))) {
    return [{ raw: content }];
  }

  const blocks: MarkdownBlock[] = [];
  for (const node of children) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start === undefined || end === undefined) return [{ raw: content }];
    blocks.push({ raw: content.slice(start, end) });
  }
  return blocks;
}

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
