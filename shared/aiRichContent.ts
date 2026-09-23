import type { AiRichContentV1 } from "./ai";
import { splitMarkdownIntoBlocks } from "./librechatMarkdownBlocks";

/** Descriptors point into canonical response.content; they contain no duplicated model text. */
export function describeAiRichContent(content: string): AiRichContentV1 {
  try {
    return { version: 1, blocks: splitMarkdownIntoBlocks(content).map(({ start, end }) => ({
      id: `markdown:${start}`, kind: "markdown", start, end,
    })) };
  } catch {
    // Presentation/dispatch already validated the canonical text. A Markdown
    // parser failure must not roll back its usage settlement or reissue work.
    return { version: 1, blocks: content ? [{ id: "markdown:0", kind: "markdown", start: 0, end: content.length }] : [] };
  }
}

/** Old clients ignore this optional projection. New clients fail closed on invalid offsets. */
export function validAiRichContent(content: string, value: unknown): value is AiRichContentV1 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AiRichContentV1>;
  if (candidate.version !== 1 || !Array.isArray(candidate.blocks) || candidate.blocks.length > 512) return false;
  if (!content) return candidate.blocks.length === 0;
  if (!candidate.blocks.length) return false;
  let previousEnd = 0;
  for (const block of candidate.blocks) {
    if (!block || block.kind !== "markdown" || !Number.isSafeInteger(block.start) || !Number.isSafeInteger(block.end) ||
        block.start < previousEnd || block.end <= block.start || block.end > content.length ||
        block.id !== `markdown:${block.start}` || /\S/u.test(content.slice(previousEnd, block.start))) return false;
    previousEnd = block.end;
  }
  return !/\S/u.test(content.slice(previousEnd));
}
