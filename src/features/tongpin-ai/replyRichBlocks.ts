import { isUnclosedMathFence } from "../../../shared/librechatMarkdownBlocks";

/** Parsers for the optional rich-content fenced blocks a model may emit at the
 * end of a reply: a ```chart data block and a ```followups suggestion block.
 *
 * Every parser is total and conservative: any malformed, oversized or
 * suspicious payload degrades to plain code-block rendering (chart) or to no
 * chips at all (followups). Nothing here can execute, fetch or authorize
 * anything - a followup chip only ever fills the composer draft. */

export interface ReplyChartSeriesPoint { label: string; value: number }

export interface ReplyChart {
  title: string;
  unit: string;
  source: string;
  type: "bar" | "line";
  series: ReplyChartSeriesPoint[];
}

const MAX_SERIES_POINTS = 24;
const MAX_TEXT_LENGTH = 120;
const MAX_FOLLOWUPS = 3;
/** Keeps the SVG scale finite: larger magnitudes (or +/-1e308 pairs whose
 * span overflows to Infinity) would otherwise draw NaN coordinates. */
const MAX_CHART_MAGNITUDE = 1e15;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedText(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

/** Parse the body of a ```chart fenced block. Returns null for anything that
 * would render a misleading picture: no title, no unit, no source, an unknown
 * chart type, or series data that is not a small list of finite numbers. */
export function parseReplyChart(raw: string): ReplyChart | null {
  if (raw.length > 8_000) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  const title = boundedText(record.title);
  const unit = boundedText(record.unit, 20);
  const source = boundedText(record.source);
  if (!title || !unit || !source) return null;
  const type = record.type === "bar" || record.type === "line" ? record.type : null;
  if (!type || !Array.isArray(record.series) || !record.series.length || record.series.length > MAX_SERIES_POINTS) return null;
  const series: ReplyChartSeriesPoint[] = [];
  for (const entry of record.series) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const { label, value } = entry as Record<string, unknown>;
    const safeLabel = boundedText(label, 40);
    const safeValue = finiteNumber(value);
    if (!safeLabel || safeValue === null || Math.abs(safeValue) > MAX_CHART_MAGNITUDE) return null;
    series.push({ label: safeLabel, value: safeValue });
  }
  return { title, unit, source, type, series };
}

/** Parse the body of a ```followups fenced block into at most three short
 * suggestion strings. Extra, empty, oversized or non-string entries are
 * dropped; a block with no valid entries yields no chips. */
export function parseReplyFollowups(raw: string): string[] {
  if (raw.length > 2_000) return [];
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const chips: string[] = [];
  for (const entry of data) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (text && text.length <= MAX_TEXT_LENGTH) chips.push(text);
    if (chips.length >= MAX_FOLLOWUPS) break;
  }
  return chips;
}

/** What an unfinished final block would turn into once the stream completes.
 * Only these constructs change shape when their closing syntax arrives, so
 * only they get a placeholder instead of their raw, half-written source:
 * - "chart" / "followups": an open ```chart or ```followups fence (raw JSON);
 * - "fence": an opened code fence with no body yet (an empty box whose
 *   language label is still being typed);
 * - "math": an open $$ display formula (would render as a KaTeX error);
 * - "table": pipe rows still waiting for a valid GFM delimiter row.
 * Everything else streams as normal Markdown. */
export type PendingReplyTail = "chart" | "followups" | "fence" | "math" | "table" | null;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;

function tableCells(line: string): number {
  const trimmed = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return trimmed.split(/(?<!\\)\|/).length;
}

function isDelimiterRow(line: string, cells: number): boolean {
  if (!/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) return false;
  return tableCells(line) === cells;
}

export function pendingReplyTail(raw: string): PendingReplyTail {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const fence = FENCE_OPEN.exec(lines[0]);
  if (fence) {
    const [, marker, info] = fence;
    const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
    if (lines.slice(1).some(line => close.test(line))) return null;
    const language = info.toLowerCase();
    if (language === "chart" || language === "followups") return language;
    return lines.length < 2 ? "fence" : null;
  }
  if (isUnclosedMathFence(lines.join("\n"))) return "math";
  if (lines.every(line => line.trimStart().startsWith("|"))) {
    if (lines.length >= 2 && isDelimiterRow(lines[1], tableCells(lines[0]))) return null;
    return "table";
  }
  return null;
}
