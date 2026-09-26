import type { AiCitation, AiSource } from "../../shared/ai";
import { AI_CITATION_LIMITS, aiSourceNumbers, sourceIdentity } from "../../shared/aiCitations";
import { safeSource } from "./capabilities";

/**
 * Provider url_citation positions → markers on the stored answer.
 *
 * Every offset must be proven against the exact text it claims to index:
 * provider part text, then parseProviderResult's `content`, then the final
 * visible `content` the client stores. Whenever a link in that chain cannot
 * be verified, the whole response goes without positioned citations instead
 * of guessing (the sources list itself is unaffected).
 */

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** One Responses `output_text` part exactly as the provider reported it. */
export interface ProviderTextPart { text: string; annotations: readonly unknown[] }
/** A url_citation span in the coordinates of parseProviderResult's `content`. */
export interface ProviderCitationSpan { start: number; end: number; url: string }

const MAX_SPANS = 256;
const MAX_STREAMED_ANNOTATIONS = 256;

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1), after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

/** UTF-16 offset of every code point boundary; undefined when the text has
 * no astral character, i.e. when both index units coincide. */
function codePointOffsets(text: string): number[] | undefined {
  if (!/[\ud800-\udbff][\udc00-\udfff]/.test(text)) return undefined;
  const offsets = [0];
  for (const char of text) offsets.push(offsets[offsets.length - 1] + char.length);
  return offsets;
}

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase() || undefined; } catch { return undefined; }
}

const INLINE_LINK = /^\(?\[[^\]\n]*\]\(\S+\)\)?$/;

/** OpenAI-style answers cite inline, e.g. "([example.com](https://example.com/…))".
 * Only spans that are exactly such a link to the cited host may settle which
 * index unit a provider used; a span shifted by one character is not. */
function spansAreInlineLinks(text: string, spans: readonly ProviderCitationSpan[]): boolean {
  return spans.every(span => {
    const host = hostOf(span.url);
    const cited = text.slice(span.start, span.end).trim();
    return host !== undefined && INLINE_LINK.test(cited) && cited.toLowerCase().includes(host);
  });
}

/** Spans in UTF-16 units of `part.text`; undefined when any claimed position is unusable. */
function partSpans(part: ProviderTextPart): ProviderCitationSpan[] | undefined {
  const text = part.text;
  const claimed: ProviderCitationSpan[] = [];
  for (const raw of part.annotations) {
    const annotation = record(raw);
    if (annotation.type !== "url_citation") continue;
    const start = annotation.start_index, end = annotation.end_index;
    // A citation reported without any position is still listed as a source, just never placed.
    if (start === undefined && end === undefined) continue;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) < Number(start)) return undefined;
    if (typeof annotation.url === "string") claimed.push({ start: Number(start), end: Number(end), url: annotation.url });
  }
  if (!claimed.length) return [];
  const units = claimed.every(span => span.end <= text.length && !splitsSurrogatePair(text, span.start) && !splitsSurrogatePair(text, span.end)) ? claimed : undefined;
  const points = codePointOffsets(text);
  if (!points) return units;
  const codePoints = claimed.every(span => span.end < points.length)
    ? claimed.map(span => ({ ...span, start: points[span.start], end: points[span.end] })) : undefined;
  if (units && codePoints && units.every((span, index) => span.start === codePoints[index].start && span.end === codePoints[index].end)) return units;
  // After an astral character (emoji) UTF-16 units and code points disagree.
  const evident = [units, codePoints].filter((spans): spans is ProviderCitationSpan[] => spans !== undefined && spansAreInlineLinks(text, spans));
  return evident.length === 1 ? evident[0] : undefined;
}

/** Where each part starts inside `content`, or undefined when that is not provable. */
function partOffsets(parts: readonly ProviderTextPart[], content: string): number[] | undefined {
  let at = 0;
  if (parts.map(part => part.text).join("") === content) return parts.map(part => { const start = at; at += part.text.length; return start; });
  // A gateway's convenience `output_text` may separate parts with whitespace.
  // Accept only an in-order match with nothing but whitespace around each part.
  const offsets: number[] = [];
  for (const part of parts) {
    const found = part.text ? content.indexOf(part.text, at) : at;
    if (found < 0 || /\S/.test(content.slice(at, found))) return undefined;
    offsets.push(found);
    at = found + part.text.length;
  }
  return /\S/.test(content.slice(at)) ? undefined : offsets;
}

/** Positions the url_citation annotations of all output_text parts inside
 * parseProviderResult's `content`. Undefined when there is nothing to place
 * or any claimed position cannot be verified. */
export function providerCitationSpans(parts: readonly ProviderTextPart[], content: string): ProviderCitationSpan[] | undefined {
  if (!parts.some(part => part.annotations.length)) return undefined;
  const local = parts.map(partSpans);
  if (local.some(spans => spans === undefined) || !local.some(spans => spans!.length)) return undefined;
  const offsets = partOffsets(parts, content);
  if (!offsets) return undefined;
  const spans = local.flatMap((items, index) => items!.map(span => ({ ...span, start: span.start + offsets[index], end: span.end + offsets[index] })));
  return spans.slice(0, MAX_SPANS);
}

interface StreamedPart {
  outputIndex: number;
  contentIndex: number;
  text: string;
  done: boolean;
  annotations: Map<number, Record<string, unknown>>;
}

/** Collects Responses `response.output_text.annotation.added` events (plus the
 * part text they index) for gateways whose terminal envelope omits them. */
export function createStreamedAnnotations() {
  const parts = new Map<string, StreamedPart>();
  let annotationCount = 0;
  const partFor = (event: Record<string, unknown>): StreamedPart | undefined => {
    const outputIndex = event.output_index, contentIndex = event.content_index;
    if (!Number.isSafeInteger(outputIndex) || !Number.isSafeInteger(contentIndex) || Number(outputIndex) < 0 || Number(contentIndex) < 0) return undefined;
    const key = `${outputIndex}:${contentIndex}`;
    let part = parts.get(key);
    if (!part) {
      part = { outputIndex: Number(outputIndex), contentIndex: Number(contentIndex), text: "", done: false, annotations: new Map() };
      parts.set(key, part);
    }
    return part;
  };
  const sortedAnnotations = (part: StreamedPart) => [...part.annotations].sort(([a], [b]) => a - b).map(([, annotation]) => annotation);
  return {
    observe(event: Record<string, unknown>): void {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        const part = partFor(event);
        if (part && !part.done) part.text += event.delta;
      } else if (event.type === "response.output_text.done" && typeof event.text === "string") {
        const part = partFor(event);
        if (part) { part.text = event.text; part.done = true; }
      } else if (event.type === "response.output_text.annotation.added") {
        const annotation = record(event.annotation);
        if (annotation.type !== "url_citation" || annotationCount >= MAX_STREAMED_ANNOTATIONS) return;
        const part = partFor(event);
        if (!part) return;
        const index = Number.isSafeInteger(event.annotation_index) && Number(event.annotation_index) >= 0 ? Number(event.annotation_index) : part.annotations.size;
        if (part.annotations.has(index)) return;
        part.annotations.set(index, annotation);
        annotationCount += 1;
      }
    },
    /** The terminal envelope stays authoritative wherever it reports annotations itself. */
    attach(response: Record<string, unknown>): Record<string, unknown> {
      if (!annotationCount) return response;
      const output = Array.isArray(response.output) ? response.output : [];
      const hasTextParts = output.some(item => {
        const content = record(item).content;
        return Array.isArray(content) && content.some(part => record(part).type === "output_text");
      });
      if (hasTextParts) {
        let changed = false;
        const merged = output.map((raw, outputIndex) => {
          const item = record(raw);
          if (!Array.isArray(item.content)) return raw;
          let itemChanged = false;
          const content = item.content.map((rawPart, contentIndex) => {
            const part = record(rawPart);
            const streamed = parts.get(`${outputIndex}:${contentIndex}`);
            if (!streamed?.annotations.size || part.type !== "output_text" || typeof part.text !== "string") return rawPart;
            if (Array.isArray(part.annotations) && part.annotations.length) return rawPart;
            // Offsets index the text they were streamed with; a different final text voids them.
            if (streamed.text && streamed.text !== part.text) return rawPart;
            itemChanged = true;
            return { ...part, annotations: sortedAnnotations(streamed) };
          });
          if (!itemChanged) return raw;
          changed = true;
          return { ...item, content };
        });
        return changed ? { ...response, output: merged } : response;
      }
      // Some gateways end with only the convenience `output_text`. Rebuild the
      // streamed parts; parseProviderResult then proves them against that text.
      if (typeof response.output_text !== "string") return response;
      const items = new Map<number, StreamedPart[]>();
      for (const part of [...parts.values()].filter(part => part.text).sort((a, b) => a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex)) {
        items.set(part.outputIndex, [...(items.get(part.outputIndex) ?? []), part]);
      }
      if (![...items.values()].some(group => group.some(part => part.annotations.size))) return response;
      const rebuilt = [...items.values()].map(group => ({ type: "message", role: "assistant",
        content: group.map(part => ({ type: "output_text", text: part.text, annotations: sortedAnnotations(part) })) }));
      return { ...response, output: [...output, ...rebuilt] };
    },
  };
}

const FILTERED_BLOCK = /<(analysis_summary|think|reasoning_content|tool_request)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const FILTERED_TAG = /<\/?(?:analysis_summary|think|reasoning_content|tool_request)\b[^>]*>/gi;
const FILTERED_TAIL = /<(?:think|reasoning_content|tool_request)\b[^>]*>[\s\S]*$/i;

/** True when the service's public-text filters (publicExplanation.ts) would remove all of `text`. */
function removedByFilters(text: string, tail: boolean): boolean {
  let rest = text.replace(FILTERED_BLOCK, "");
  if (tail) rest = rest.replace(FILTERED_TAIL, "");
  return !/\S/.test(rest.replace(FILTERED_TAG, ""));
}

/** Where the final visible answer sits in the raw provider text: only a
 * unique placement surrounded by filtered wrappers or whitespace counts.
 * Text changed anywhere inside (a removed <think> block, an unescaped JSON
 * envelope) has no provable placement. */
export function visibleTextOffset(raw: string, visible: string): number | undefined {
  if (raw === visible) return 0;
  if (!visible) return undefined;
  let found: number | undefined, seen = 0;
  for (let at = raw.indexOf(visible); at >= 0; at = raw.indexOf(visible, at + 1)) {
    if (++seen > 16) return undefined;
    if (!removedByFilters(raw.slice(0, at), false) || !removedByFilters(raw.slice(at + visible.length), true)) continue;
    if (found !== undefined) return undefined;
    found = at;
  }
  return found;
}

/** Maps verified provider spans onto the stored answer. `sources` must be the
 * exact list returned with it; a cited page that is not listed is not placed. */
export function citationsForContent(raw: string, visible: string, spans: readonly ProviderCitationSpan[] | undefined, sources: readonly AiSource[]): AiCitation[] | undefined {
  if (!spans?.length || !sources.length || !visible) return undefined;
  const shift = visibleTextOffset(raw, visible);
  if (shift === undefined) return undefined;
  const numbers = aiSourceNumbers(sources);
  const firstIndex = new Map<string, number>();
  sources.forEach((source, index) => {
    const key = sourceIdentity(source.url);
    if (!firstIndex.has(key)) firstIndex.set(key, index);
  });
  const seen = new Set<string>();
  const citations: AiCitation[] = [];
  for (const span of spans) {
    const source = safeSource({ url: span.url });
    const key = source ? sourceIdentity(source.url) : undefined;
    const n = key === undefined ? undefined : numbers.get(key);
    const sourceIndex = key === undefined ? undefined : firstIndex.get(key);
    if (n === undefined || sourceIndex === undefined) continue;
    let end = span.end - shift;
    // A marker trailing the visible text by whitespace moves to its end; a span
    // ending inside filtered text has no visible anchor at all.
    if (end > visible.length) {
      if (/\S/.test(raw.slice(shift + visible.length, span.end))) continue;
      end = visible.length;
    }
    if (end < 1 || splitsSurrogatePair(visible, end)) continue;
    const marker = `${end}:${n}`;
    if (seen.has(marker)) continue;
    seen.add(marker);
    citations.push({ n, sourceIndex, end });
  }
  citations.sort((a, b) => a.end - b.end || a.n - b.n);
  return citations.length ? citations.slice(0, AI_CITATION_LIMITS.citations) : undefined;
}
