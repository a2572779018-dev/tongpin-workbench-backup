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
    if (!safeLabel || safeValue === null) return null;
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
