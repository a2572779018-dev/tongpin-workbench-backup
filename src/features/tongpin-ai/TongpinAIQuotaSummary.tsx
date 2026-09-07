import { Gauge } from "lucide-react";
import type { AiQuota } from "../../../shared/ai";
import { quotaRemainingSummary } from "./quotaFormatting";

export function TongpinAIQuotaSummary({ usage, quotaSynced }: { usage: AiQuota; quotaSynced: boolean }) {
  const summary = quotaRemainingSummary(usage, quotaSynced);
  return <div className="tp-ai-account__quota-summary" id="tp-ai-quota-summary" role="tooltip">
    <header><span><Gauge size={15} aria-hidden="true" />{summary.label}</span></header>
    {summary.percent !== null ? <div className="tp-ai-account__quota-track" aria-hidden="true"><span style={{ width: summary.percent + "%" }} /></div> : null}
    {summary.note ? <p>{summary.note}</p> : null}
    <small>点击查看使用详情</small>
  </div>;
}
