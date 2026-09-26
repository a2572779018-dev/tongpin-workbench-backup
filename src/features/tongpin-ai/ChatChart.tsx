import { useId, useMemo, useState } from "react";
import { formatReplyNumber, parseReplyChart, type ReplyChart } from "./replyRichBlocks";

const WIDTH = 640;
const HEIGHT = 300;
const PADDING = { top: 24, right: 28, bottom: 40, left: 60 };
const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;
/** Direct value labels only while they stay readable (never on every mark). */
const MAX_LABELLED_BARS = 12;
const MAX_LABELLED_POINTS = 8;
const MAX_AXIS_LABELS = 12;
const TYPE_LABELS: Record<ReplyChart["type"], string> = { bar: "柱状图", line: "折线图", donut: "环形图", pie: "饼图" };

/** Coordinates are rounded so the SVG markup stays small and stable. */
const r2 = (value: number) => Math.round(value * 100) / 100;

export interface ChartScale { min: number; max: number; step: number; ticks: number[]; decimals: number }

/** Zero-based "nice" axis (steps of 1, 2, 2.5 or 5 x 10^n) around the data.
 * Bars must start at zero to be honest; lines share the convention so both
 * read the same. Inputs are already bounded by the parser (|v| <= 1e15). */
export function niceChartScale(values: readonly number[], targetTicks = 5): ChartScale {
  let low = Math.min(0, ...values);
  let high = Math.max(0, ...values);
  if (low === high) high = low + 1;
  const raw = (high - low) / targetTicks;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const mantissa = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = mantissa * magnitude;
  const decimals = Math.min(20, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)) + (mantissa === 2.5 ? 1 : 0));
  low = Math.floor(low / step + 1e-9) * step;
  high = Math.ceil(high / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let index = 0; index <= 12; index += 1) {
    const value = Number((low + step * index).toFixed(decimals));
    if (value > high + step / 2) break;
    ticks.push(value);
  }
  return { min: low, max: high, step, ticks, decimals };
}

const compactNumber = new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 2 });
const shortNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const smallNumber = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 3 });

/** Short axis/label text: 1.25万 instead of 12,500, 0.00123 instead of 0;
 * exact values stay in the tooltip and the data table. Ticks pass the
 * decimals their step needs. */
export function formatChartShort(value: number, decimals?: number): string {
  if (Math.abs(value) >= 1e4) return compactNumber.format(value);
  if (decimals !== undefined) return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: Math.min(20, decimals) }).format(value);
  return (value === 0 || Math.abs(value) >= 1 ? shortNumber : smallNumber).format(value);
}

const percent = new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 });

function shortLabel(label: string, max = 8): string {
  const chars = Array.from(label);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : label;
}

/** Categorical slot for series `index` (1-based, fixed order, never cycled:
 * the parser caps series and slices at the six validated palette slots). */
const slot = (index: number) => String(index + 1);

/** Bar path with a 4px rounded data end and a square baseline end. */
function barPath(x: number, width: number, valueY: number, zeroY: number): string {
  const top = Math.min(valueY, zeroY);
  const bottom = Math.max(valueY, zeroY, top + 1);
  const radius = Math.min(4, width / 2, bottom - top);
  const [left, right] = [r2(x), r2(x + width)];
  if (valueY <= zeroY) {
    return `M${left},${r2(bottom)}V${r2(top + radius)}Q${left},${r2(top)} ${r2(x + radius)},${r2(top)}H${r2(x + width - radius)}Q${right},${r2(top)} ${right},${r2(top + radius)}V${r2(bottom)}Z`;
  }
  return `M${left},${r2(top)}V${r2(bottom - radius)}Q${left},${r2(bottom)} ${r2(x + radius)},${r2(bottom)}H${r2(x + width - radius)}Q${right},${r2(bottom)} ${right},${r2(bottom - radius)}V${r2(top)}Z`;
}

function valueText(value: number | null, unit: string): string {
  return value === null ? "无数据" : `${formatReplyNumber(value)} ${unit}`;
}

function AxisChart({ chart, label }: { chart: ReplyChart; label: string }) {
  const { type, labels, series, unit } = chart;
  const values = series.flatMap(item => item.values).filter((value): value is number => value !== null);
  const scale = niceChartScale(values);
  const yOf = (value: number) => PADDING.top + PLOT_HEIGHT * (1 - (value - scale.min) / (scale.max - scale.min));
  const zeroY = yOf(0);
  const count = labels.length;
  const band = PLOT_WIDTH / count;
  // Line points span the plot edge to edge (inset a little); bars sit in bands.
  const inset = 12;
  const xOf = (index: number) => type === "line"
    ? count > 1 ? PADDING.left + inset + (PLOT_WIDTH - inset * 2) * index / (count - 1) : PADDING.left + PLOT_WIDTH / 2
    : PADDING.left + band * (index + 0.5);
  const gap = series.length > 1 ? 2 : 0;
  const barWidth = Math.max(2, Math.min(24, (band * 0.72 - gap * (series.length - 1)) / series.length));
  const groupWidth = barWidth * series.length + gap * (series.length - 1);
  const labelEvery = count > MAX_AXIS_LABELS ? Math.ceil(count / MAX_AXIS_LABELS) : 1;
  const single = series.length === 1;
  const hitBounds = (index: number) => type === "line"
    ? [index === 0 ? PADDING.left : (xOf(index - 1) + xOf(index)) / 2, index === count - 1 ? WIDTH - PADDING.right : (xOf(index) + xOf(index + 1)) / 2]
    : [PADDING.left + band * index, PADDING.left + band * (index + 1)];
  const tooltip = (index: number) => single
    ? `${labels[index]}：${valueText(series[0].values[index], unit)}`
    : [labels[index], ...series.map(item => `${item.name}：${valueText(item.values[index], unit)}`)].join("\n");

  // Line value labels: every point for a short single series, otherwise the
  // last point of each series (plus the peak of a single series), skipping any
  // label that would collide with one already placed.
  const lineLabels: { key: string; x: number; y: number; text: string; anchor: "start" | "middle" | "end" }[] = [];
  if (type === "line") {
    const placed: { x: number; y: number }[] = [];
    const add = (seriesIndex: number, index: number) => {
      const value = series[seriesIndex].values[index];
      if (value === null) return;
      const x = xOf(index);
      const y = yOf(value) - 10;
      if (placed.some(point => Math.abs(point.y - y) < 13 && Math.abs(point.x - x) < 44)) return;
      placed.push({ x, y });
      lineLabels.push({ key: `${seriesIndex}-${index}`, x: r2(x), y: r2(y), text: formatChartShort(value),
        anchor: count > 1 && index === 0 ? "start" : count > 1 && index === count - 1 ? "end" : "middle" });
    };
    if (single && count <= MAX_LABELLED_POINTS) {
      labels.forEach((_, index) => add(0, index));
    } else {
      series.forEach((item, seriesIndex) => {
        let last = item.values.length - 1;
        while (last >= 0 && item.values[last] === null) last -= 1;
        if (last >= 0) add(seriesIndex, last);
      });
      if (single) {
        let peak = -1;
        series[0].values.forEach((value, index) => {
          if (value !== null && (peak < 0 || value > (series[0].values[peak] ?? value))) peak = index;
        });
        if (peak >= 0) add(0, peak);
      }
    }
  }

  return <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={label} className="tp-ai-chart__svg">
    {scale.ticks.map(tick => {
      const y = r2(yOf(tick));
      return <g key={tick}>
        <line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} className={tick === 0 ? "tp-ai-chart__baseline" : "tp-ai-chart__grid"} />
        <text x={PADDING.left - 8} y={y + 4} textAnchor="end" className="tp-ai-chart__tick">{formatChartShort(tick, scale.decimals)}</text>
      </g>;
    })}
    {labels.map((text, index) => index % labelEvery === 0
      ? <text key={index} x={r2(xOf(index))} y={HEIGHT - PADDING.bottom + 18} textAnchor="middle" className="tp-ai-chart__label">{shortLabel(text)}</text>
      : null)}
    {type === "bar"
      ? series.map((item, seriesIndex) => <g key={seriesIndex} data-series={slot(seriesIndex)}>
        {item.values.map((value, index) => {
          if (value === null) return null;
          const x = PADDING.left + band * index + (band - groupWidth) / 2 + seriesIndex * (barWidth + gap);
          return <path key={index} d={barPath(x, barWidth, yOf(value), zeroY)} className="tp-ai-chart__bar" />;
        })}
      </g>)
      : series.map((item, seriesIndex) => {
        const segments: { x: number; y: number }[][] = [];
        item.values.forEach((value, index) => {
          if (value === null) { segments.push([]); return; }
          if (!segments.length) segments.push([]);
          segments[segments.length - 1].push({ x: r2(xOf(index)), y: r2(yOf(value)) });
        });
        const runs = segments.filter(run => run.length);
        const showDots = count <= MAX_AXIS_LABELS;
        return <g key={seriesIndex} data-series={slot(seriesIndex)}>
          {single ? runs.filter(run => run.length > 1).map((run, index) => <path key={`area-${index}`} className="tp-ai-chart__area"
            d={`M${run[0].x},${r2(zeroY)}${run.map(point => `L${point.x},${point.y}`).join("")}L${run[run.length - 1].x},${r2(zeroY)}Z`} />) : null}
          {runs.map((run, index) => run.length > 1
            ? <polyline key={`line-${index}`} className="tp-ai-chart__line" points={run.map(point => `${point.x},${point.y}`).join(" ")} />
            : null)}
          {runs.flatMap((run, runIndex) => run.map((point, index) => showDots || run.length === 1 || (runIndex === runs.length - 1 && index === run.length - 1)
            ? <circle key={`dot-${runIndex}-${index}`} cx={point.x} cy={point.y} r={4} className="tp-ai-chart__dot" />
            : null))}
        </g>;
      })}
    {type === "bar" && labels.length * series.length <= MAX_LABELLED_BARS
      ? series.map((item, seriesIndex) => item.values.map((value, index) => {
        if (value === null) return null;
        const x = PADDING.left + band * index + (band - groupWidth) / 2 + seriesIndex * (barWidth + gap) + barWidth / 2;
        const y = value >= 0 ? yOf(value) - 6 : yOf(value) + 14;
        return <text key={`${seriesIndex}-${index}`} x={r2(x)} y={r2(y)} textAnchor="middle" className="tp-ai-chart__value">{formatChartShort(value)}</text>;
      }))
      : null}
    {lineLabels.map(item => <text key={item.key} x={item.x} y={item.y} textAnchor={item.anchor} className="tp-ai-chart__value">{item.text}</text>)}
    {/* One hover target per category: a hairline crosshair plus a native
        tooltip listing every series (the data table keeps it reachable). */}
    {labels.map((_, index) => {
      const [left, right] = hitBounds(index);
      const x = r2(xOf(index));
      return <g key={index} className="tp-ai-chart__hit">
        <title>{tooltip(index)}</title>
        <rect x={r2(left)} y={PADDING.top} width={r2(right - left)} height={PLOT_HEIGHT} />
        {type === "line" ? <line x1={x} x2={x} y1={PADDING.top} y2={PADDING.top + PLOT_HEIGHT} /> : null}
      </g>;
    })}
  </svg>;
}

/** Donut / pie slice (angles in radians, clockwise from 12 o'clock). */
function slicePath(cx: number, cy: number, inner: number, outer: number, start: number, end: number): string {
  if (end - start >= Math.PI * 2 - 1e-6) {
    const ring = `M${cx + outer},${cy}A${outer},${outer} 0 1 1 ${cx - outer},${cy}A${outer},${outer} 0 1 1 ${cx + outer},${cy}Z`;
    return inner ? `${ring}M${cx + inner},${cy}A${inner},${inner} 0 1 0 ${cx - inner},${cy}A${inner},${inner} 0 1 0 ${cx + inner},${cy}Z` : ring;
  }
  const large = end - start > Math.PI ? 1 : 0;
  const at = (radius: number, angle: number) => `${r2(cx + radius * Math.cos(angle))},${r2(cy + radius * Math.sin(angle))}`;
  if (!inner) return `M${cx},${cy}L${at(outer, start)}A${outer},${outer} 0 ${large} 1 ${at(outer, end)}Z`;
  return `M${at(outer, start)}A${outer},${outer} 0 ${large} 1 ${at(outer, end)}L${at(inner, end)}A${inner},${inner} 0 ${large} 0 ${at(inner, start)}Z`;
}

function PartChart({ chart, label }: { chart: ReplyChart; label: string }) {
  const { labels, unit, type } = chart;
  const values = chart.series[0].values.map(value => value ?? 0);
  const total = values.reduce((sum, value) => sum + value, 0);
  const size = 220;
  const center = size / 2;
  const outer = 100;
  const inner = type === "donut" ? 62 : 0;
  let angle = -Math.PI / 2;
  const slices = values.map((value, index) => {
    const start = angle;
    angle += value / total * Math.PI * 2;
    return { index, value, start, end: angle };
  });
  return <div className="tp-ai-chart__part">
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className="tp-ai-chart__pie">
      {slices.map(slice => slice.value > 0
        ? <path key={slice.index} data-series={slot(slice.index)} className="tp-ai-chart__slice" fillRule="evenodd"
          d={slicePath(center, center, inner, outer, slice.start, slice.end)}>
          <title>{`${labels[slice.index]}：${valueText(slice.value, unit)}（${percent.format(slice.value / total)}）`}</title>
        </path>
        : null)}
      {inner ? <g className="tp-ai-chart__total">
        <text x={center} y={center - 12} textAnchor="middle" className="tp-ai-chart__total-label">合计</text>
        <text x={center} y={center + 12} textAnchor="middle" className="tp-ai-chart__total-value">{formatChartShort(total)}</text>
        <text x={center} y={center + 30} textAnchor="middle" className="tp-ai-chart__total-label">{shortLabel(unit, 6)}</text>
      </g> : null}
    </svg>
    <ul className="tp-ai-chart__parts" aria-label="各项占比">
      {labels.map((item, index) => <li key={index} data-series={slot(index)}>
        <span className="tp-ai-chart__key is-slice" aria-hidden="true" />
        <span className="tp-ai-chart__part-label">{item}</span>
        <span className="tp-ai-chart__part-value">{formatReplyNumber(values[index])}</span>
        <span className="tp-ai-chart__part-share">{percent.format(values[index] / total)}</span>
      </li>)}
    </ul>
  </div>;
}

/** Accessible name: what the chart is, then enough of the data to follow it. */
export function chartAccessibleLabel(chart: ReplyChart): string {
  const head = `${chart.title}（单位：${chart.unit}），${TYPE_LABELS[chart.type]}`;
  if (chart.type === "donut" || chart.type === "pie") {
    const values = chart.series[0].values.map(value => value ?? 0);
    const total = values.reduce((sum, value) => sum + value, 0);
    return `${head}：${chart.labels.map((item, index) => `${item} ${percent.format(values[index] / total)}`).join("，")}`;
  }
  const names = chart.series.length > 1 ? `，${chart.series.length} 个系列：${chart.series.map(item => item.name).join("、")}` : "";
  return `${head}${names}，${chart.labels.length} 个类别，数据见原始数据表`;
}

/** Renders a labelled SVG chart from a validated ```chart block: grouped bars,
 * multi-series lines, donut or pie. Title, unit and source are mandatory
 * (parseReplyChart enforces them), identity never relies on colour alone (a
 * legend for 2+ series, labelled slices), and the raw numbers stay one click
 * away so the picture can always be checked against its data. Invalid
 * payloads never reach this component. */
export function ChatChart({ body }: { body: string }) {
  const chart = useMemo(() => parseReplyChart(body), [body]);
  const [showData, setShowData] = useState(false);
  const tableId = useId();
  if (!chart) return null;

  const { title, unit, source, type, labels, series } = chart;
  const partToWhole = type === "donut" || type === "pie";
  const label = chartAccessibleLabel(chart);
  const total = partToWhole ? series[0].values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : 0;

  return <figure className="tp-ai-chart" data-type={type}>
    <figcaption className="tp-ai-chart__head">
      <strong>{title}</strong>
      <span>单位：{unit}</span>
    </figcaption>
    {!partToWhole && series.length > 1 ? <ul className="tp-ai-chart__legend" aria-label="图例">
      {series.map((item, index) => <li key={index} data-series={slot(index)}>
        <span className={`tp-ai-chart__key ${type === "line" ? "is-line" : "is-bar"}`} aria-hidden="true" />{item.name}
      </li>)}
    </ul> : null}
    {partToWhole ? <PartChart chart={chart} label={label} /> : <AxisChart chart={chart} label={label} />}
    <div className="tp-ai-chart__foot">
      <span>数据来源：{source}</span>
      <button type="button" aria-expanded={showData} aria-controls={tableId} onClick={() => setShowData(current => !current)}>{showData ? "收起原始数据" : "查看原始数据"}</button>
    </div>
    <table className="tp-ai-chart__data" id={tableId} hidden={!showData}>
      <thead><tr>
        <th scope="col">项目</th>
        {partToWhole
          ? <><th scope="col">数值（{unit}）</th><th scope="col">占比</th></>
          : series.length > 1
            ? series.map((item, index) => <th key={index} scope="col">{item.name}（{unit}）</th>)
            : <th scope="col">数值（{unit}）</th>}
      </tr></thead>
      <tbody>{labels.map((item, index) => <tr key={`${index}-${item}`}>
        <th scope="row">{item}</th>
        {series.map((entry, seriesIndex) => {
          const value = entry.values[index];
          return <td key={seriesIndex}>{value === null ? "—" : formatReplyNumber(value)}</td>;
        })}
        {partToWhole ? <td>{percent.format((series[0].values[index] ?? 0) / total)}</td> : null}
      </tr>)}</tbody>
    </table>
  </figure>;
}
