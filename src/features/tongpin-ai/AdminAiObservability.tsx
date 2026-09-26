import { AlertTriangle, Check, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AI_BUSINESS_TIER_LABELS, AI_HARNESS_CAPABILITY_LABELS, type AiMode, type AiObservabilityAlert, type AiHarnessConfig, type AiObservabilityDashboard } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import { adminAiErrorMessage } from "./adminAiForms";
import { harnessProviderLabel } from "./adminAiLayout";
import { describeAdminAiAlert } from "./adminAiAlertWatch";

const CAPABILITY_LABELS: Record<string, string> = AI_HARNESS_CAPABILITY_LABELS;
const firstVisibleLabel = (milliseconds: number | null | undefined, samples?: number) =>
  typeof milliseconds === "number" && Number.isFinite(milliseconds)
    ? `${(milliseconds / 1000).toFixed(1)} 秒${samples === undefined ? "" : `（${samples}）`}` : "—";

export function AdminAiObservability({ active = true, harnessConfig = null, onDashboard }: {
  active?: boolean;
  harnessConfig?: AiHarnessConfig | null;
  /** Reports each loaded dashboard (used to mark alerts as viewed for the tab red dot). */
  onDashboard?: (dashboard: AiObservabilityDashboard) => void;
}) {
  const onDashboardRef = useRef(onDashboard);
  onDashboardRef.current = onDashboard;
  const { api } = useAuth();
  const [dashboard, setDashboard] = useState<AiObservabilityDashboard | null>(null);
  const [error, setError] = useState("");
  const [acknowledging, setAcknowledging] = useState("");
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const load = () => api<AiObservabilityDashboard>("/api/admin/ai/observability?windowMinutes=60", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) { setDashboard(value); setError(""); onDashboardRef.current?.(value); } })
      .catch((caught: unknown) => { if (!controller.signal.aborted) setError(adminAiErrorMessage(caught, "运行监控读取失败。")); });
    void load();
    const interval = window.setInterval(() => void load(), 15_000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [api, version, active]);
  const acknowledge = async (alert: AiObservabilityAlert) => {
    setAcknowledging(alert.id);
    try {
      await api(`/api/admin/ai/observability/alerts/${encodeURIComponent(alert.id)}/acknowledge`, { method: "PATCH" });
      setError(""); setVersion(value => value + 1);
    } catch (caught) { setError(adminAiErrorMessage(caught, "告警确认失败。")); }
    finally { setAcknowledging(""); }
  };
  return <section className="tp-ai-admin-card" aria-labelledby="tp-ai-observability-title">
    <header className="tp-ai-admin-heading"><div><h2 id="tp-ai-observability-title"><AlertTriangle size={21} />运行监控</h2><p>每 15 秒刷新最近 60 分钟状态；仅保存租户内的档位、能力、响应耗时和稳定错误码，不保存密钥、提示词、服务商响应体或成员正文。</p></div><button className="tp-ai-admin-button" type="button" onClick={() => setVersion(value => value + 1)}><RefreshCw size={16} />刷新</button></header>
    {error ? <p className="tp-ai-admin-error" role="alert">{error}</p> : null}
    {dashboard ? <>
      <div className="tp-ai-admin-quota-preview tp-ai-admin-metrics"><span>请求<strong>{dashboard.totals.requests}</strong></span><span>成功 / 失败<strong>{dashboard.totals.successes} / {dashboard.totals.failures}</strong></span><span>成功率<strong>{dashboard.totals.requests ? `${(dashboard.totals.successRate * 100).toFixed(1)}%` : "—"}</strong></span><span>错误率<strong>{dashboard.totals.requests ? `${(dashboard.totals.errorRate * 100).toFixed(1)}%` : "—"}</strong></span><span>平均响应<strong>{dashboard.totals.requests ? `${(dashboard.totals.averageLatencyMs / 1000).toFixed(1)} 秒` : "—"}</strong></span><span>平均首段可见<strong>{firstVisibleLabel(dashboard.totals.averageFirstVisibleMs)}</strong></span></div>
      <p className="tp-ai-admin-muted">首段可见仅统计实际发出流式正文的请求，当前窗口 {dashboard.totals.firstVisibleSamples ?? 0} 条样本；非流式和历史请求不补造耗时。</p>
      <p className="tp-ai-admin-muted">状态更新：{new Date(dashboard.generatedAt).toLocaleString()}</p>
      {dashboard.alerts.length ? <div className="tp-ai-admin-usage-list">{dashboard.alerts.map(alert => <article className="tp-ai-admin-usage-entry" key={alert.id}><header><strong>{describeAdminAiAlert(alert, id => harnessProviderLabel(harnessConfig, id)).title}</strong><span className="tp-ai-admin-status">{alert.code}</span></header><p>{describeAdminAiAlert(alert, id => harnessProviderLabel(harnessConfig, id)).lines.join("；")} · 本轮阈值命中 {alert.occurrences} 次</p>{alert.acknowledgedAt ? <small>已确认 · {new Date(alert.acknowledgedAt).toLocaleString()}</small> : <button className="tp-ai-admin-button" type="button" disabled={acknowledging === alert.id} onClick={() => void acknowledge(alert)}><Check size={15} />{acknowledging === alert.id ? "正在确认…" : "确认告警"}</button>}</article>)}</div> : <p className="tp-ai-admin-success" role="status">当前窗口没有触发告警。</p>}
      {dashboard.slices.length ? <div className="tp-ai-admin-table-scroll" tabIndex={0}><table className="tp-ai-admin-table"><thead><tr><th>档位</th><th>服务</th><th>能力</th><th>阶段</th><th>请求</th><th>成功率</th><th>错误率</th><th>首段可见</th><th>平均耗时</th><th>最大耗时</th><th>错误码</th></tr></thead><tbody>{dashboard.slices.map(slice => <tr key={`${slice.tier}:${slice.provider}:${slice.capability}:${slice.operation}`}><td>{AI_BUSINESS_TIER_LABELS[slice.tier as AiMode] ?? slice.tier}</td><td title={slice.provider}>{harnessProviderLabel(harnessConfig, slice.provider)}</td><td>{CAPABILITY_LABELS[slice.capability] ?? slice.capability}</td><td>{slice.operation === "planning" ? "规划" : "执行"}</td><td>{slice.requests}</td><td>{(slice.successRate * 100).toFixed(1)}%</td><td>{(slice.errorRate * 100).toFixed(1)}%</td><td>{firstVisibleLabel(slice.averageFirstVisibleMs, slice.firstVisibleSamples ?? 0)}</td><td>{(slice.averageLatencyMs / 1000).toFixed(1)} 秒</td><td>{(slice.maxLatencyMs / 1000).toFixed(1)} 秒</td><td>{slice.errors.length ? slice.errors.map(item => `${item.code} × ${item.count}`).join("、") : "—"}</td></tr>)}</tbody></table></div> : <p className="tp-ai-admin-empty">最近 60 分钟暂无请求记录。</p>}
      {dashboard.alertHistory.length ? <details><summary>告警历史（{dashboard.alertHistory.length}）</summary><div className="tp-ai-admin-usage-list">{dashboard.alertHistory.map(alert => <article className="tp-ai-admin-usage-entry" key={`history:${alert.id}`}><header><strong>{alert.code}</strong><span className="tp-ai-admin-status">{alert.resolvedAt ? "已恢复" : alert.acknowledgedAt ? "已确认" : "处理中"}</span></header><p>{alert.message}</p><small>{new Date(alert.firstSeenAt).toLocaleString()} – {new Date(alert.resolvedAt ?? alert.lastSeenAt).toLocaleString()}</small></article>)}</div></details> : null}
    </> : !error ? <p className="tp-ai-admin-empty" role="status">正在读取运行监控…</p> : null}
  </section>;
}
