import { useMemo, useState } from "react";
import { parseReplyChart } from "./replyRichBlocks";

const WIDTH = 640;
const HEIGHT = 320;
const PADDING = { top: 28, right: 24, bottom: 56, left: 64 };

/** Renders a labelled SVG bar/line chart from a validated ```chart block.
 * Title, unit and source are mandatory (parseReplyChart enforces them), and
 * the raw numbers stay one click away so the picture can always be checked
 * against its data. Invalid payloads never reach this component. */
export function ChatChart({ body }: { body: string }) {
  const chart = useMemo(() => parseReplyChart(body), [body]);
  const [showData, setShowData] = useState(false);
  if (!chart) return null;

  const { title, unit, source, type, series } = chart;
  const values = series.map(point => point.value);
  const maxValue = Math.max(...values, 0);
  const minValue = Math.min(...values, 0);
  const span = maxValue - minValue || 1;
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = HEIGHT - PADDING.top - PADDING.bottom;
  const yOf = (value: number) => PADDING.top + plotHeight * (1 - (value - minValue) / span);
  const step = series.length > 1 ? plotWidth / (series.length - 1) : 0;
  const xOf = (index: number) => type === "line"
    ? PADDING.left + step * index
    : PADDING.left + (plotWidth / series.length) * (index + 0.5);
  const barWidth = Math.max(8, Math.min(56, plotWidth / series.length * 0.6));
  const zeroY = yOf(0);

  return <figure className="tp-ai-chart">
    <figcaption className="tp-ai-chart__head">
      <strong>{title}</strong>
      <span>单位：{unit}</span>
    </figcaption>
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`${title}（单位：${unit}）`} className="tp-ai-chart__svg">
      {/* horizontal guides keep the magnitude readable without a full axis system */}
      {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
        const value = minValue + span * ratio;
        const y = yOf(value);
        return <g key={ratio}>
          <line x1={PADDING.left} x2={WIDTH - PADDING.right} y1={y} y2={y} className="tp-ai-chart__grid" />
          <text x={PADDING.left - 8} y={y + 4} textAnchor="end" className="tp-ai-chart__tick">{Number(value.toFixed(2))}</text>
        </g>;
      })}
      {type === "bar"
        ? series.map((point, index) => {
          const x = xOf(index) - barWidth / 2;
          const top = yOf(point.value);
          const height = Math.abs(zeroY - top) || 1;
          return <g key={point.label}>
            <rect x={x} y={Math.min(top, zeroY)} width={barWidth} height={height} className="tp-ai-chart__bar" rx={3} />
            <text x={x + barWidth / 2} y={Math.min(top, zeroY) - 6} textAnchor="middle" className="tp-ai-chart__value">{point.value}</text>
            <text x={x + barWidth / 2} y={HEIGHT - PADDING.bottom + 18} textAnchor="middle" className="tp-ai-chart__label">{point.label}</text>
          </g>;
        })
        : <g>
          <polyline className="tp-ai-chart__line" points={series.map((point, index) => `${xOf(index)},${yOf(point.value)}`).join(" ")} />
          {series.map((point, index) => <g key={point.label}>
            <circle cx={xOf(index)} cy={yOf(point.value)} r={4} className="tp-ai-chart__dot" />
            <text x={xOf(index)} y={yOf(point.value) - 10} textAnchor="middle" className="tp-ai-chart__value">{point.value}</text>
            <text x={xOf(index)} y={HEIGHT - PADDING.bottom + 18} textAnchor="middle" className="tp-ai-chart__label">{point.label}</text>
          </g>)}
        </g>}
    </svg>
    <div className="tp-ai-chart__foot">
      <span>数据来源：{source}</span>
      <button type="button" onClick={() => setShowData(current => !current)}>{showData ? "收起原始数据" : "查看原始数据"}</button>
    </div>
    {showData ? <table className="tp-ai-chart__data">
      <thead><tr><th scope="col">项目</th><th scope="col">数值（{unit}）</th></tr></thead>
      <tbody>{series.map(point => <tr key={point.label}><td>{point.label}</td><td>{point.value}</td></tr>)}</tbody>
    </table> : null}
  </figure>;
}
