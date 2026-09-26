import { isUnclosedMathFence } from "../../../shared/librechatMarkdownBlocks";

/** Parsers for the optional rich-content fenced blocks a model may emit in a
 * reply: a ```chart data block, a ```cards KPI block and a ```followups
 * suggestion block.
 *
 * Every parser is total and conservative: any malformed, oversized or
 * suspicious payload degrades to plain code-block rendering (chart, cards) or
 * to no chips at all (followups). Nothing here can execute, fetch or authorize
 * anything - a followup chip only ever fills the composer draft. */

export type ReplyChartType = "bar" | "line" | "donut" | "pie";

/** One named series; `null` marks a missing value (no bar, a gap in a line). */
export interface ReplyChartSeries { name: string; values: (number | null)[] }

/** Normalized chart: every series has exactly one value per label. Donut and
 * pie charts always carry a single series of non-negative values. */
export interface ReplyChart {
  title: string;
  unit: string;
  source: string;
  type: ReplyChartType;
  labels: string[];
  series: ReplyChartSeries[];
}

export type ReplyCardTrend = "up" | "down" | "flat";

export interface ReplyCard {
  title: string;
  value: string;
  unit: string;
  delta: string;
  trend: ReplyCardTrend | null;
  note: string;
}

/** Categories on a bar/line axis; one block cannot stall the message. */
export const MAX_CHART_LABELS = 24;
/** Series per bar/line chart: the validated categorical palette has six
 * slots. The model instructions ask for at most four; the renderer tolerates
 * up to the palette size instead of discarding a readable chart. */
export const MAX_CHART_SERIES = 6;
/** Part-to-whole reads at a glance only with a handful of slices. */
export const MAX_CHART_SLICES = 6;
export const MAX_REPLY_CARDS = 6;
const MAX_TEXT_LENGTH = 120;
const MAX_FOLLOWUPS = 3;
/** Keeps the SVG scale finite: larger magnitudes (or +/-1e308 pairs whose
 * span overflows to Infinity) would otherwise draw NaN coordinates. */
const MAX_CHART_MAGNITUDE = 1e15;
const CHART_TYPES: readonly ReplyChartType[] = ["bar", "line", "donut", "pie"];
const CARD_TRENDS: readonly ReplyCardTrend[] = ["up", "down", "flat"];

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_CHART_MAGNITUDE ? value : null;
}

function boundedText(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Legacy / part-to-whole shape: `series: [{ label, value }]`. */
function pointSeries(entries: unknown[], maxPoints: number): { labels: string[]; values: number[] } | null {
  if (!entries.length || entries.length > maxPoints) return null;
  const labels: string[] = [];
  const values: number[] = [];
  for (const entry of entries) {
    const point = record(entry);
    const label = boundedText(point?.label, 40);
    const value = finiteNumber(point?.value);
    if (!label || value === null) return null;
    labels.push(label);
    values.push(value);
  }
  return { labels, values };
}

/** Multi-series shape: `labels: [...]` plus `series: [{ name, values }]`. */
function namedSeries(rawLabels: unknown[], entries: unknown[], maxLabels: number): { labels: string[]; series: ReplyChartSeries[] } | null {
  if (!rawLabels.length || rawLabels.length > maxLabels || !entries.length || entries.length > MAX_CHART_SERIES) return null;
  const labels: string[] = [];
  for (const raw of rawLabels) {
    const label = boundedText(raw, 40);
    if (!label) return null;
    labels.push(label);
  }
  const series: ReplyChartSeries[] = [];
  for (const entry of entries) {
    const item = record(entry);
    if (!item || !Array.isArray(item.values) || item.values.length !== labels.length) return null;
    // A lone series may stay unnamed (the title names it); a legend needs names.
    const name = boundedText(item.name, 40) ?? (entries.length === 1 ? "" : null);
    if (name === null) return null;
    const values: (number | null)[] = [];
    for (const raw of item.values) {
      if (raw === null) { values.push(null); continue; }
      const value = finiteNumber(raw);
      if (value === null) return null;
      values.push(value);
    }
    series.push({ name, values });
  }
  return { labels, series };
}

/** Parse the body of a ```chart fenced block. Returns null for anything that
 * would render a misleading picture: no title, no unit, no source, an unknown
 * chart type, mismatched or oversized data, non-finite numbers, a chart with
 * no values at all, or a negative / empty part-to-whole chart.
 *
 * Accepted shapes (unknown extra fields are ignored):
 * - bar/line: `{ labels: [..], series: [{ name, values: [number|null] }] }`
 * - any type: `{ series: [{ label, value }] }` (single series; the original
 *   format, so stored replies keep rendering). */
export function parseReplyChart(raw: string): ReplyChart | null {
  if (raw.length > 8_000) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  const input = record(data);
  if (!input) return null;
  const title = boundedText(input.title);
  const unit = boundedText(input.unit, 20);
  const source = boundedText(input.source);
  if (!title || !unit || !source) return null;
  const type = CHART_TYPES.find(candidate => candidate === input.type);
  if (!type || !Array.isArray(input.series)) return null;
  const partToWhole = type === "donut" || type === "pie";
  const maxLabels = partToWhole ? MAX_CHART_SLICES : MAX_CHART_LABELS;

  let labels: string[];
  let series: ReplyChartSeries[];
  if (Array.isArray(input.labels)) {
    const named = namedSeries(input.labels, input.series, maxLabels);
    if (!named) return null;
    ({ labels, series } = named);
  } else {
    const points = pointSeries(input.series, maxLabels);
    if (!points) return null;
    labels = points.labels;
    series = [{ name: "", values: points.values }];
  }

  const present = series.flatMap(item => item.values).filter((value): value is number => value !== null);
  if (!present.length) return null;
  if (partToWhole) {
    // A slice has no meaning for a missing, negative or all-zero share.
    if (series.length !== 1 || series[0].values.some(value => value === null || value < 0)) return null;
    if (present.reduce((sum, value) => sum + value, 0) <= 0) return null;
  }
  return { title, unit, source, type, labels, series };
}

const plainNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 20 });
const signedNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 20, signDisplay: "exceptZero" });

/** Grouped, full-precision display of a validated number (1,234.5). */
export function formatReplyNumber(value: number): string {
  return plainNumber.format(value);
}

function cardValue(value: unknown): string | null {
  const number = finiteNumber(value);
  if (number !== null) return formatReplyNumber(number);
  return boundedText(value, 24);
}

/** undefined = omitted (absent, null or blank); null = present but invalid. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  return boundedText(value, max);
}

/** Direction implied by a signed delta when the model omits `trend`. */
function trendFromDelta(raw: unknown, delta: string): ReplyCardTrend | null {
  if (typeof raw === "number") return raw > 0 ? "up" : raw < 0 ? "down" : "flat";
  if (/^[+＋↑▲]/.test(delta)) return "up";
  if (/^[-−－↓▼]/.test(delta)) return "down";
  return null;
}

/** Parse the body of a ```cards fenced block: a JSON array of 1-6 KPI cards
 * `{ title, value, unit?, delta?, trend?: "up"|"down"|"flat", note? }`.
 * Returns null for malformed or oversized payloads so the caller can fall back
 * to showing the raw text. Optional fields may be omitted or null. */
export function parseReplyCards(raw: string): ReplyCard[] | null {
  if (raw.length > 4_000) return null;
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(data) || !data.length || data.length > MAX_REPLY_CARDS) return null;
  const cards: ReplyCard[] = [];
  for (const entry of data) {
    const item = record(entry);
    const title = boundedText(item?.title, 40);
    const value = cardValue(item?.value);
    if (!item || !title || !value) return null;
    const unit = optionalText(item.unit, 12);
    const note = optionalText(item.note, 80);
    const deltaNumber = finiteNumber(item.delta);
    const delta = deltaNumber !== null ? signedNumber.format(deltaNumber) : optionalText(item.delta, 16);
    if (unit === null || note === null || delta === null) return null;
    let trend: ReplyCardTrend | null = null;
    if (item.trend !== undefined && item.trend !== null) {
      const known = CARD_TRENDS.find(candidate => candidate === item.trend);
      if (!known) return null;
      trend = known;
    } else if (delta) {
      trend = trendFromDelta(item.delta, delta);
    }
    cards.push({ title, value, unit: unit ?? "", delta: delta ?? "", trend, note: note ?? "" });
  }
  return cards;
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
 * - "chart" / "cards" / "followups": an open rich fence (raw JSON);
 * - "fence": an opened code fence with no body yet (an empty box whose
 *   language label is still being typed);
 * - "math": an open $$ display formula (would render as a KaTeX error);
 * - "table": pipe rows still waiting for a valid GFM delimiter row.
 * Everything else streams as normal Markdown; an open code fence streams as
 * plain, unhighlighted code until its closing line arrives. */
export type PendingReplyTail = "chart" | "cards" | "followups" | "fence" | "math" | "table" | null;

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
const RICH_FENCES = new Set(["chart", "cards", "followups"]);

/** Lower-cased info-string language of a still-open fenced code block (""
 * when unlabelled), or null when `raw` does not start with a fence or the
 * fence has already been closed. */
export function openFenceLanguage(raw: string): string | null {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const fence = FENCE_OPEN.exec(lines[0]);
  if (!fence) return null;
  const [, marker, info] = fence;
  const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
  return lines.slice(1).some(line => close.test(line)) ? null : info.toLowerCase();
}

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
  if (FENCE_OPEN.test(lines[0])) {
    const language = openFenceLanguage(raw);
    if (language === null) return null;
    if (RICH_FENCES.has(language)) return language as "chart" | "cards" | "followups";
    return lines.length < 2 ? "fence" : null;
  }
  if (isUnclosedMathFence(lines.join("\n"))) return "math";
  if (lines.every(line => line.trimStart().startsWith("|"))) {
    if (lines.length >= 2 && isDelimiterRow(lines[1], tableCells(lines[0]))) return null;
    return "table";
  }
  return null;
}
