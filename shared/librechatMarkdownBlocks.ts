import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

/**
 * Adapted from LibreChat v0.8.7, commit
 * 9e74cc0e57b395926122bd4062c1fcedc48ed465:
 * client/src/components/Chat/Messages/Content/splitMarkdown.ts
 * (MIT, Copyright (c) 2026 LibreChat).
 *
 * The exact UTF-16 source offsets let the server describe committed blocks
 * without duplicating model text in every SSE event. The client renders the
 * same GFM grammar and continues to treat `content` as canonical.
 */
export interface MarkdownBlock {
  raw: string;
  start: number;
  end: number;
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

/** Completed source slices stay byte-identical while the final block grows. */
export function splitMarkdownIntoBlocks(content: string): MarkdownBlock[] {
  if (!content) return [];
  const whole = [{ raw: content, start: 0, end: content.length }];
  const tree = fromMarkdown(content, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  }) as MdastNode;
  const children = tree.children ?? [];
  if (children.length === 0 || children.length > 512) return whole;

  // Definitions are document-scoped; separating them breaks reference links.
  // Raw top-level HTML is displayed as escaped text, so retain its separators.
  if (children.some(node => node.type === "html" || containsDefinition(node))) return whole;

  const blocks: MarkdownBlock[] = [];
  for (const node of children) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start === undefined || end === undefined || start < 0 || end <= start || end > content.length) return whole;
    blocks.push({ raw: content.slice(start, end), start, end });
  }
  return blocks;
}
