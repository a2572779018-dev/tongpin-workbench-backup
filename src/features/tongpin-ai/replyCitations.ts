import type { AiCitation, AiSource } from "../../../shared/ai";
import { AI_CITATION_LIMITS, aiSourceNumbers, isAiCitation, sourceIdentity } from "../../../shared/aiCitations";
import { displaySources, sourceLabel } from "./sourceDisplay";

/**
 * Citation markers for settled replies.
 *
 * The remark plugins below are adapted from LibreChat v0.8.7, commit
 * 9e74cc0e57b395926122bd4062c1fcedc48ed465:
 * client/src/components/Web/plugin.ts (MIT, Copyright (c) 2026 LibreChat).
 * Like upstream they splice custom `hName` nodes into parsed text so a
 * marker becomes a React component and never raw HTML. Unlike upstream,
 * Tongpin never asks the model to write private-use marker characters:
 * positions come from verified provider citations (server/ai/citations.ts)
 * and are placed on the already-parsed tree, so no Markdown source is
 * rewritten and code, tables and links keep their exact syntax.
 */

/** One marker position in a reply's `content`, with the source numbers shown there. */
export interface ReplyCitationMarker { offset: number; numbers: number[] }
export interface ReplyCitations { markers: ReplyCitationMarker[]; sourceCount: number }
/** Plugin options for one rendered Markdown block; marker offsets are local to `source`. */
export interface ReplyBlockCitations { source: string; markers: ReplyCitationMarker[]; sourceCount: number }
/** A numbered entry of a reply's source list, as shown in a marker's hover card. */
export interface CitationSourceView { n: number; url: string; label: string; host: string }
export interface CitationFocusRequest { n: number; token: number }

/** Only citations provably bound to this content and source list survive. */
export function sanitizeAiCitations(content: string, sources: readonly AiSource[] | undefined, citations: unknown): AiCitation[] | undefined {
  if (!Array.isArray(citations) || !sources?.length) return undefined;
  const valid = citations.filter((item): item is AiCitation => isAiCitation(item, content, sources.length))
    .slice(0, AI_CITATION_LIMITS.citations).map(({ n, sourceIndex, end }) => ({ n, sourceIndex, end }));
  return valid.length ? valid : undefined;
}

/** A marker attaches right after the cited text, never after trailing whitespace. */
export function markerOffset(content: string, end: number): number {
  let offset = end;
  while (offset > 0 && /\s/.test(content[offset - 1])) offset -= 1;
  return offset;
}

/** Markers of a settled reply, numbered exactly like its source list. Undefined
 * when the reply lists no source (then nothing can be cited or linked). */
export function replyCitations(content: string, citations: readonly AiCitation[] | undefined, sources: readonly AiSource[] | undefined): ReplyCitations | undefined {
  const numbers = aiSourceNumbers(sources);
  if (!numbers.size || !sources) return undefined;
  const grouped = new Map<number, Set<number>>();
  for (const citation of sanitizeAiCitations(content, sources, citations) ?? []) {
    // The list numbers its own pages; a stored `n` from another dedupe rule never wins.
    const n = numbers.get(sourceIdentity(sources[citation.sourceIndex].url));
    const offset = markerOffset(content, citation.end);
    if (n === undefined || offset < 1) continue;
    grouped.set(offset, (grouped.get(offset) ?? new Set<number>()).add(n));
  }
  const markers = [...grouped].sort(([a], [b]) => a - b)
    .map(([offset, group]) => ({ offset, numbers: [...group].sort((a, b) => a - b) }));
  return { markers, sourceCount: numbers.size };
}

/** The part of a reply's markers that falls inside one Markdown block. */
export function blockCitations(citations: ReplyCitations, source: string, start: number): ReplyBlockCitations {
  const markers = citations.markers
    .filter(marker => marker.offset > start && marker.offset <= start + source.length)
    .map(marker => ({ offset: marker.offset - start, numbers: marker.numbers }));
  return { source, markers, sourceCount: citations.sourceCount };
}

/** The numbered source list (same dedupe and order as AiSourceList). */
export function citationSourceViews(sources: readonly AiSource[] | undefined): CitationSourceView[] {
  const { visible, folded } = displaySources(sources);
  return [...visible, ...folded].map((source, index) => {
    let host = source.url;
    try { host = new URL(source.url).hostname.replace(/^www\./, ""); } catch { /* keep the raw value */ }
    return { n: index + 1, url: source.url, label: sourceLabel(source), host };
  });
}

/** Every activation is a new request, so clicking the same marker twice still scrolls. */
export function nextCitationFocus(current: CitationFocusRequest | null, n: number): CitationFocusRequest {
  return { n, token: (current?.token ?? 0) + 1 };
}

/** Which list item a marker points at, and whether the folded part must open first. */
export function citationListTarget(n: number, visibleCount: number, foldedCount: number): { index: number; needsExpand: boolean } | null {
  if (!Number.isSafeInteger(n) || n < 1 || n > visibleCount + foldedCount) return null;
  return { index: n - 1, needsExpand: n > visibleCount };
}

interface MdPoint { line: number; column: number; offset?: number }
interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: MdPoint; end: MdPoint };
  data?: Record<string, unknown>;
}
interface Container { node: MdNode; parent: MdNode }
/** A positioned phrasing leaf and its enclosing inline containers, outermost first. */
interface Leaf { node: MdNode; parent: MdNode; containers: Container[] }

const INLINE_CONTAINERS = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);
const PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell", ...INLINE_CONTAINERS]);
const BLOCK_PHRASING_PARENTS = new Set(["paragraph", "heading", "tableCell"]);
const PHRASING_LEAVES = new Set(["text", "inlineCode", "inlineMath", "break", "image", "imageReference", "footnoteReference", "html"]);
const LINKS = new Set(["link", "linkReference"]);

const CITATION_NODE = "tongpinCitation";

/** `original` keeps replaced model text in the hast tree (e.g. for table export). */
function citationNode(numbers: readonly number[], origin: "provider" | "model", original?: string): MdNode {
  return { type: CITATION_NODE, data: { hName: "tongpin-cite", hProperties: { dataNumbers: numbers.join(" "), dataOrigin: origin },
    ...(original ? { hChildren: [{ type: "text", value: original }] } : {}) } };
}

function citationParts(node: MdNode): { numbers: number[]; origin: "provider" | "model"; original: string } {
  const properties = (node.data?.hProperties ?? {}) as { dataNumbers?: unknown; dataOrigin?: unknown };
  const hidden = node.data?.hChildren as Array<{ value?: unknown }> | undefined;
  return { numbers: markerNumbers(properties.dataNumbers), origin: properties.dataOrigin === "model" ? "model" : "provider",
    original: typeof hidden?.[0]?.value === "string" ? hidden[0].value : "" };
}

/** Markers that ended up side by side (e.g. two spans relocated after one link) read as one "¹²" group. */
function mergeAdjacentMarkers(parent: MdNode): void {
  const children = parent.children;
  if (!children) return;
  for (let index = 0; index < children.length; index += 1) {
    const next = children[index + 1];
    if (children[index].type === CITATION_NODE && next?.type === CITATION_NODE) {
      const a = citationParts(children[index]), b = citationParts(next);
      const numbers = [...new Set([...a.numbers, ...b.numbers])].sort((x, y) => x - y);
      children.splice(index, 2, citationNode(numbers, a.origin === "model" && b.origin === "model" ? "model" : "provider", a.original + b.original));
      index -= 1;
    } else mergeAdjacentMarkers(children[index]);
  }
}

/** escapeCurrencyDollars only inserts "\" before some "$". Map original block
 * offsets across those insertions; undefined for any other difference. */
function parsedOffsets(original: string, parsed: string): ((offset: number) => number) | undefined {
  if (original === parsed) return offset => offset;
  const inserted: number[] = [];
  let i = 0;
  for (let j = 0; j < parsed.length; j += 1) {
    if (i < original.length && original[i] === parsed[j]) i += 1;
    else if (parsed[j] === "\\" && original[i] === "$") inserted.push(i);
    else return undefined;
  }
  if (i !== original.length) return undefined;
  return offset => offset + inserted.filter(index => index < offset).length;
}

function pointAt(lineStarts: readonly number[], offset: number): MdPoint {
  let low = 0, high = lineStarts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (lineStarts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1, offset };
}

/** Index into a text node's value for a source offset inside it: values drop
 * escape backslashes, entity syntax and continuation-line indentation. */
function valueIndex(raw: string, value: string, local: number): number {
  if (raw === value) return local;
  let j = 0;
  for (let i = 0; i < local && j < value.length; i += 1) if (raw[i] === value[j]) j += 1;
  return j;
}

/** Phrasing leaves in document order, each with its inline containers. */
function collectLeaves(root: MdNode): Leaf[] {
  const leaves: Leaf[] = [];
  const walk = (parent: MdNode, containers: Container[]) => {
    for (const node of parent.children ?? []) {
      if (PHRASING_LEAVES.has(node.type)) {
        const start = node.position?.start.offset, end = node.position?.end.offset;
        if (PHRASING_PARENTS.has(parent.type) && typeof start === "number" && typeof end === "number") leaves.push({ node, parent, containers });
      } else if (node.children) walk(node, INLINE_CONTAINERS.has(node.type) ? [...containers, { node, parent }] : containers);
    }
  };
  walk(root, []);
  return leaves;
}

/** Where a marker goes after `leaf`: past the outermost link (a marker button is
 * never nested in an anchor), else past every emphasis that already ended. */
function markerAnchor(leaf: Leaf, offset: number): Container {
  const link = leaf.containers.find(container => LINKS.has(container.node.type));
  if (link) return link;
  const closed = leaf.containers.find(container => (container.node.position?.end.offset ?? Infinity) <= offset);
  return closed ?? { node: leaf.node, parent: leaf.parent };
}

function placeMarker(leaf: Leaf, offset: number, marker: MdNode, parsed: string, lineStarts: readonly number[]): void {
  const { node, parent } = leaf;
  const start = node.position!.start.offset!, end = node.position!.end.offset!;
  const anchor = markerAnchor(leaf, offset);
  if (anchor.node === node && node.type === "text" && typeof node.value === "string" && offset < end) {
    const value = node.value;
    let index = valueIndex(parsed.slice(start, end), value, offset - start);
    const high = value.charCodeAt(index - 1), low = value.charCodeAt(index);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) index += 1;
    const siblings = parent.children!;
    if (index <= 0) { siblings.splice(siblings.indexOf(node), 0, marker); return; }
    if (index < value.length) {
      const split = pointAt(lineStarts, offset);
      const rest: MdNode = { type: "text", value: value.slice(index), position: { start: split, end: node.position!.end } };
      node.value = value.slice(0, index);
      node.position = { start: node.position!.start, end: split };
      siblings.splice(siblings.indexOf(node) + 1, 0, marker, rest);
      return;
    }
  }
  const siblings = anchor.parent.children!;
  siblings.splice(siblings.indexOf(anchor.node) + 1, 0, marker);
}

/** Places verified provider markers after the text that precedes each offset.
 * Offsets inside code, math, images or link syntax move to just after that
 * construct; a block with no preceding prose (e.g. a lone code block) gets none.
 * Runs first, while every parsed node still carries its source position. */
export function remarkReplyCitationAnchors(options: ReplyBlockCitations) {
  return (tree: unknown, file: { value?: unknown }) => {
    if (!options.markers.length) return;
    const parsed = String(file.value ?? "");
    const toParsed = parsedOffsets(options.source, parsed);
    if (!toParsed) return;
    const leaves = collectLeaves(tree as MdNode);
    const lineStarts = [0];
    for (let index = parsed.indexOf("\n"); index >= 0; index = parsed.indexOf("\n", index + 1)) lineStarts.push(index + 1);
    // Descending order keeps every earlier leaf's start offset valid while splitting.
    for (const marker of [...options.markers].sort((a, b) => b.offset - a.offset)) {
      const offset = toParsed(marker.offset);
      let leaf: Leaf | undefined;
      for (const candidate of leaves) {
        if (candidate.node.position!.start.offset! >= offset) break;
        leaf = candidate;
      }
      if (leaf) placeMarker(leaf, offset, citationNode(marker.numbers, "provider"), parsed, lineStarts);
    }
    mergeAdjacentMarkers(tree as MdNode);
  };
}

const MODEL_MARKER_RUN = /(?:\[\d{1,3}\]|【\d{1,3}】)+/g;
const MODEL_MARKER = /\[(\d{1,3})\]|【(\d{1,3})】/g;

/** Model-written "[1]" / "【1】" runs become markers only for numbers that exist in
 * the source list. "arr[1]" (identifier before the bracket) and "[1] 标题" at the
 * start of a line (a written reference list) stay text, as does anything in links. */
function modelMarkerParts(value: string, sourceCount: number, atBlockStart: boolean): MdNode[] | undefined {
  const parts: MdNode[] = [];
  let last = 0;
  for (const run of value.matchAll(MODEL_MARKER_RUN)) {
    const start = run.index!;
    const before = start > 0 ? value[start - 1] : "";
    if (/[A-Za-z0-9_]/.test(before) || (start === 0 ? atBlockStart : before === "\n")) continue;
    let group: number[] = [], groupStart = -1, groupEnd = -1;
    const flush = () => {
      if (!group.length) return;
      if (groupStart > last) parts.push({ type: "text", value: value.slice(last, groupStart) });
      parts.push(citationNode([...new Set(group)].sort((a, b) => a - b), "model", value.slice(groupStart, groupEnd)));
      last = groupEnd;
      group = [];
    };
    for (const item of run[0].matchAll(MODEL_MARKER)) {
      const n = Number(item[1] ?? item[2]);
      const at = start + item.index!;
      if (n < 1 || n > sourceCount) { flush(); continue; }
      if (!group.length) groupStart = at;
      group.push(n);
      groupEnd = at + item[0].length;
    }
    flush();
  }
  if (!parts.length) return undefined;
  if (last < value.length) parts.push({ type: "text", value: value.slice(last) });
  return parts;
}

/** Runs last, after remarkReplyEmphasis, and only reads text values. */
export function remarkReplyModelCitations(options: ReplyBlockCitations) {
  return (tree: unknown) => {
    if (options.sourceCount < 1) return;
    const visit = (parent: MdNode, inLink: boolean) => {
      const children = parent.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const node = children[index];
        if (node.type === "text" && !inLink && PHRASING_PARENTS.has(parent.type) && node.value) {
          const parts = modelMarkerParts(node.value, options.sourceCount, index === 0 && BLOCK_PHRASING_PARENTS.has(parent.type));
          if (parts) { children.splice(index, 1, ...parts); index += parts.length - 1; }
        } else if (node.children) visit(node, inLink || LINKS.has(node.type));
      }
    };
    visit(tree as MdNode, false);
    mergeAdjacentMarkers(tree as MdNode);
  };
}

/** The numbers carried by one rendered marker element (hast property `dataNumbers`). */
export function markerNumbers(value: unknown): number[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(" ").map(Number).filter(n => Number.isSafeInteger(n) && n > 0))].slice(0, AI_CITATION_LIMITS.sources);
}
