import { ArrowDownToLine, ArrowUpFromLine, ChevronRight, Info, RefreshCw, Sigma, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AiUsageEntry } from "../../../shared/ai";
import { useAuth } from "../../auth/AuthContext";
import type { User } from "../../types";
import { UserAvatar } from "../../components/UserAvatar";
import type { TongpinAIUsage } from "./types";
import { aiDiagnosticDescription, aiUsageDescription, aiUsageTotal } from "./usageFormatting";
import { AI_QUOTA_BILLING_NOTE, formatAiPoints, quotaPercent } from "./quotaFormatting";
import { TongpinAIQuotaSummary } from "./TongpinAIQuotaSummary";

const number = (value: number) => value.toLocaleString("zh-CN");
const statusLabel: Record<AiUsageEntry["status"], string> = {
  completed: "已完成", failed: "未完成", uncertain: "用量待核对", adjusted: "管理员调整",
};

export function TongpinAIAccountUsage({ usage, user, quotaSynced = false, onRefresh }: {
  usage: TongpinAIUsage;
  user: User;
  quotaSynced?: boolean;
  onRefresh?: () => Promise<void>;
}) {
  const { api } = useAuth();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [entries, setEntries] = useState<AiUsageEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const generationRef = useRef(0);
  const usedPercent = quotaPercent(usage.usedTokens, usage.limitTokens) ?? 0;
  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError("");
    try {
      const [result] = await Promise.all([api<{ entries: AiUsageEntry[] }>("/api/ai/usage"), onRefresh?.()]);
      if (generation === generationRef.current) setEntries(result.entries);
    } catch (caught) {
      if (generation === generationRef.current) setError(caught instanceof Error ? caught.message : "使用记录暂时无法获取");
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [api, onRefresh]);

  useEffect(() => {
    if (!detailsOpen) return;
    void refresh();
    closeRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setDetailsOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      generationRef.current += 1;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [detailsOpen, refresh]);

  function closeDetails() {
    setDetailsOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }

  return <>
    <div className="tp-ai-account">
      <TongpinAIQuotaSummary usage={usage} quotaSynced={quotaSynced} />
      <button ref={triggerRef} type="button" className="tp-ai-account__trigger"
        aria-label={user.name + "，个人账户，查看使用详情"} aria-haspopup="dialog"
        aria-expanded={detailsOpen} aria-controls="tp-ai-token-details" aria-describedby="tp-ai-quota-summary"
        onClick={() => setDetailsOpen(true)}>
        <UserAvatar user={user} className="tp-ai-account__avatar" />
        <span className="tp-ai-account__identity"><strong>{user.name}</strong><small>个人账户</small></span>
        <ChevronRight size={16} aria-hidden="true" />
      </button>
    </div>
    {detailsOpen ? createPortal(<div className="tp-ai-usage-layer">
      <div className="tp-ai-usage-layer__backdrop" aria-hidden="true" onClick={closeDetails} />
      <section ref={dialogRef} className="tp-ai-usage-dialog" id="tp-ai-token-details" role="dialog" aria-modal="true" aria-labelledby="tp-ai-token-details-title">
        <header className="tp-ai-usage-dialog__header">
          <span><h2 id="tp-ai-token-details-title">使用详情</h2><small>{user.email} · 同频点与 Token 明细</small></span>
          <button ref={closeRef} type="button" aria-label="关闭使用详情" onClick={closeDetails}><X size={18} /></button>
        </header>
        <div className="tp-ai-usage-dialog__overview">
          <article><small>总限额</small><strong>{quotaSynced ? number(usage.limitTokens) : "—"}</strong><span>同频点</span></article>
          <article><small>已经使用</small><strong>{quotaSynced ? number(usage.usedTokens) : "—"}</strong><span>{quotaSynced ? "同频点" : "尚未同步"}</span></article>
          <article className={quotaSynced ? usage.remainingTokens === 0 ? "is-empty" : "is-available" : undefined}>
            <small>当前可用</small><strong>{quotaSynced ? number(usage.remainingTokens) : "—"}</strong>
            <span>{!quotaSynced ? "尚未同步" : usage.remainingTokens === 0 ? usage.reservedTokens > 0 ? "同频点 · 有任务待结算" : "同频点 · 请联系管理员加额" : "同频点"}</span>
          </article>
        </div>
        {quotaSynced && <div className="tp-ai-usage-dialog__progress"><span style={{ width: usedPercent + "%" }} /></div>}
        <div className="tp-ai-usage-dialog__breakdown">
          <header><strong>文本 Token 与处理中预留</strong><small>文本 1 Token = 1 同频点</small></header>
          {[
            {icon: ArrowDownToLine, label: "输入 Token", value: usage.inputTokens},
            {icon: ArrowUpFromLine, label: "输出 Token", value: usage.outputTokens},
            {icon: Sigma, label: "处理中预留 · 同频点", value: usage.reservedTokens},
          ].map(({icon: Icon, label, value}) => <div key={label}><span><Icon size={15} aria-hidden="true" />{label}</span><strong>{quotaSynced ? number(value) : "—"}</strong></div>)}
        </div>
        <section className="tp-ai-usage-history" aria-label="最近用量记录">
          <header><strong>最近记录</strong><button type="button" disabled={loading} onClick={() => void refresh()} aria-label="刷新用量记录"><RefreshCw size={16} /></button></header>
          {loading ? <p role="status">正在读取…</p> : error ? <p role="alert">{error}</p> : entries.length === 0 ? <p>暂无使用记录</p> : <ul>
            {entries.map(entry => <li key={entry.id}>
              <span><strong>{entry.kind === "quota" ? "额度调整" : entry.model || "AI 对话"}</strong><small>{new Date(entry.createdAt).toLocaleString("zh-CN", { hour12: false })} · {statusLabel[entry.status]}</small>
                {entry.diagnostic && <small>{aiDiagnosticDescription(entry.diagnostic)}</small>}
              </span>
              <span>{entry.kind === "quota" ? "总限额 " + formatAiPoints(entry.limitTokens ?? 0) : aiUsageTotal(entry)}
                <small>{entry.kind !== "quota" ? aiUsageDescription(entry) : entry.reason}</small>
              </span>
            </li>)}
          </ul>}
        </section>
        <p className="tp-ai-usage-dialog__notice"><Info size={15} aria-hidden="true" />{AI_QUOTA_BILLING_NOTE}处理中预留不是实际扣费。同频点不会自动补充。</p>
      </section>
    </div>, triggerRef.current?.closest(".tp-ai-page") ?? document.body) : null}
  </>;
}
