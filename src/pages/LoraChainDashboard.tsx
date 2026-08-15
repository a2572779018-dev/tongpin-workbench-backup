import { useCallback, useEffect, useState } from "react";
import { Activity, RefreshCw } from "lucide-react";
import { useAuth } from "../auth/AuthContext";
import { ApiRequestError } from "../lib/api";
import {
  LORA_PAIR_ADDRESS,
  LORA_DASHBOARD_POLL_MS,
  chartCount,
  compactExplorerValue,
  displayLoraValue,
  statusLabel,
  type LoraDashboardData,
  type LoraHourlyPoint,
  type LoraLargeTransferRow,
  type LoraSwapRow,
} from "../lib/loraDashboardData";

const SHANGHAI_CLOCK = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const SHANGHAI_DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function formatShanghaiDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : SHANGHAI_DATE_TIME.format(date);
}

function displayMetric(value: string | null, state: string): string {
  return displayLoraValue(value, state);
}

function normalizeHourly(points: LoraHourlyPoint[]): LoraHourlyPoint[] {
  const byHour = new Map(points.map((point) => [point.hour.slice(0, 2), point]));
  return Array.from({ length: 24 }, (_, hour) => {
    const key = String(hour).padStart(2, "0");
    return byHour.get(key) ?? { hour: key, count: null };
  });
}

function HourlyBars({ points }: { points: LoraHourlyPoint[] }) {
  const normalized = normalizeHourly(points);
  const values = normalized.map((point) => chartCount(point.count));
  const maximum = Math.max(1, ...values);
  const hasData = normalized.some((point) => point.count !== null);
  return (
    <div className="lora-hourly-bars" aria-label="每小时交易趋势">
      {normalized.map((point, index) => (
        <span
          key={point.hour}
          className={point.count === null ? "is-missing" : ""}
          style={{
            height: hasData ? `${Math.max(3, (values[index] / maximum) * 100)}%` : "3%",
          }}
          title={`${point.hour}:00 ${point.count ?? "暂无数据"}`}
        />
      ))}
    </div>
  );
}

function HourlyLine({ points }: { points: LoraHourlyPoint[] }) {
  const normalized = normalizeHourly(points);
  const values = normalized.map((point) => chartCount(point.count));
  const maximum = Math.max(1, ...values);
  const hasData = normalized.some((point) => point.count !== null);
  const line = normalized
    .map((point, index) => {
      const x = (index / 23) * 100;
      const y = 35 - (values[index] / maximum) * 30;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  return (
    <div className="lora-hourly-line" aria-label="每小时新增节点趋势">
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 35H100" />
        {hasData && <polyline points={line} />}
      </svg>
      {!hasData && <span>基线建立中</span>}
    </div>
  );
}

function ComparisonBars({ today, yesterday }: { today: string | null; yesterday: string | null }) {
  const todayValue = chartCount(today);
  const yesterdayValue = chartCount(yesterday);
  const maximum = Math.max(1, todayValue, yesterdayValue);
  return (
    <div className="lora-comparison-bars" aria-label="今日与昨日交易量对比">
      <div>
        <span>今日</span>
        <i style={{ height: `${(todayValue / maximum) * 100}%` }} />
        <b>{today ?? "—"}</b>
      </div>
      <div>
        <span>昨日</span>
        <i style={{ height: `${(yesterdayValue / maximum) * 100}%` }} />
        <b>{yesterday ?? "—"}</b>
      </div>
    </div>
  );
}

function ExplorerButton({ kind, value }: { kind: "address" | "tx"; value: string | null }) {
  const valid =
    typeof value === "string" &&
    (kind === "address"
      ? /^0x[0-9a-fA-F]{40}$/.test(value)
      : /^0x[0-9a-fA-F]{64}$/.test(value));
  if (!valid) return <span>—</span>;
  return (
    <button
      className="lora-explorer-link"
      type="button"
      title={value!}
      onClick={() => void window.tongpin?.openLoraExplorer({ kind, value: value! })}
    >
      {compactExplorerValue(value!)}
    </button>
  );
}

function TransferRows({ rows }: { rows: LoraLargeTransferRow[] }) {
  if (rows.length === 0) return <div className="lora-table-empty">暂无符合条件的转账</div>;
  return (
    <div className="lora-data-rows">
      {rows.map((row) => (
        <div className="lora-transfer-row" key={`${row.hash}:${row.time}:${row.type}`}>
          <span>{formatShanghaiDateTime(row.time)}</span>
          <ExplorerButton kind="address" value={row.from} />
          <ExplorerButton kind="address" value={row.to} />
          <b>{displayLoraValue(row.amountLrb, "—")}</b>
          <span>{row.type}</span>
          <span>{row.status}</span>
          <ExplorerButton kind="tx" value={row.hash} />
        </div>
      ))}
    </div>
  );
}

function SwapRows({ rows, enabled }: { rows: LoraSwapRow[]; enabled: boolean }) {
  if (!enabled) return <div className="lora-table-empty">Swap 统计已禁用</div>;
  if (rows.length === 0) return <div className="lora-table-empty">暂无符合条件的 Swap</div>;
  return (
    <div className="lora-data-rows">
      {rows.map((row) => (
        <div className="lora-swap-row" key={`${row.hash}:${row.time}`}>
          <span>{formatShanghaiDateTime(row.time)}</span>
          <b>{row.side}</b>
          <span>{displayLoraValue(row.lrbAmount, "—")}</span>
          <span>{displayLoraValue(row.usdtAmount, "—")}</span>
          <span>{displayLoraValue(row.price, "—")}</span>
          <ExplorerButton kind="address" value={row.initiator} />
          <span>{displayLoraValue(row.currentNativeBalanceLrb, "—")}</span>
          <ExplorerButton kind="tx" value={row.hash} />
        </div>
      ))}
    </div>
  );
}

function HealthChip({ label, state }: { label: string; state: string }) {
  return (
    <span className={`lora-health-chip is-${state}`}>
      <i aria-hidden="true" />
      {label} {statusLabel(state as Parameters<typeof statusLabel>[0])}
    </span>
  );
}

export function LoraChainDashboardView({
  data,
  clock,
  busy,
  error,
  onRefresh,
}: {
  data: LoraDashboardData | null;
  clock: string;
  busy: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const baselineLabel = data ? statusLabel(data.baselineStatus) : "基线建立中";
  const addressState = data ? statusLabel(data.addresses.baselineStatus) : "暂无完整日基线";
  const trustedPrice =
    data?.price.status === "ready" ? data.price.priceUsdt : null;
  const transactionHourly = data?.transactions.hourly ?? [];
  const nodeHourly = data?.nodes.hourly ?? [];
  const transfers = data?.largeTransfers.top5?.length
    ? data.largeTransfers.top5
    : (data?.largeTransfers.rows ?? []);
  const swaps = data?.swaps.rows ?? [];

  return (
    <div className="lora-dashboard-page">
      <header className="lora-dashboard-header">
        <div>
          <h1>LORA 链数据驾驶舱</h1>
          <span>{data?.reportDate ?? "今日"} · Asia/Shanghai</span>
        </div>
        <div className="lora-dashboard-header__status">
          <span className={data?.stale || error ? "is-stale" : ""}>
            {data?.stale || error ? "数据已失效" : `更新 ${formatShanghaiDateTime(data?.dataUpdatedAt ?? null)}`}
          </span>
          <b>{clock}</b>
          <button type="button" disabled={busy} onClick={onRefresh}>
            <RefreshCw size={16} className={busy ? "is-spinning" : ""} />
            {busy ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>

      <section className="lora-kpi-grid" aria-label="链上核心指标">
        <article>
          <span>按 1000 LRB 销毁规则统计</span>
          <strong>{displayMetric(data?.nodes.todayCount ?? null, baselineLabel)}</strong>
          <b>今日新增节点</b>
        </article>
        <article>
          <span>{data?.addresses.label ?? "今日新增链上地址"}</span>
          <strong>{displayMetric(data?.addresses.todayNew ?? null, addressState)}</strong>
          <b>00:00 至当前</b>
        </article>
        <article>
          <span>今日链上交易总数</span>
          <strong>{displayMetric(data?.transactions.todayTotal ?? null, baselineLabel)}</strong>
          <b>昨日 {displayLoraValue(data?.transactions.yesterdayTotal, "—")}</b>
        </article>
        <article className="lora-price-kpi">
          <span>LRB / USDT 实时价格</span>
          <strong>{displayMetric(trustedPrice, "暂无可信价格")}</strong>
          <b>1 LRB · {data?.price.source ?? "暂无可信价格"}</b>
        </article>
        <article>
          <span>今日活跃地址数</span>
          <strong>{displayMetric(data?.transactions.activeAddresses ?? null, baselineLabel)}</strong>
          <b>去重地址</b>
        </article>
        <article>
          <span>今日交易成功率</span>
          <strong>
            {displayMetric(
              data?.transactions.successRateLabel ?? data?.transactions.successRate ?? null,
              baselineLabel,
            )}
          </strong>
          <b>
            成功 {displayLoraValue(data?.transactions.success, "—")} · 失败 {displayLoraValue(data?.transactions.failed, "—")}
          </b>
        </article>
      </section>

      <section className="lora-chart-grid" aria-label="链上趋势图">
        <article className="lora-dashboard-card">
          <header>
            <h2>每小时交易趋势</h2>
            <span>原生转账 {displayLoraValue(data?.transactions.nativeTransfers, "—")}</span>
          </header>
          <HourlyBars points={transactionHourly} />
          <footer><span>00</span><span>08</span><span>16</span><span>23</span></footer>
        </article>
        <article className="lora-dashboard-card">
          <header>
            <h2>每小时新增节点趋势</h2>
            <span>节点销毁 {displayLoraValue(data?.nodes.todayNodeBurnLrb, "—")} LRB</span>
          </header>
          <HourlyLine points={nodeHourly} />
          <div className="lora-node-facts">
            <span>其他销毁 {displayLoraValue(data?.nodes.todayOtherBurnLrb, "—")}</span>
            <span>累计销毁 {displayLoraValue(data?.nodes.cumulativeBurnLrb, "—")}</span>
            <span>累计可确认 {displayLoraValue(data?.nodes.cumulativeConfirmedCount, "—")}</span>
          </div>
        </article>
        <article className="lora-dashboard-card">
          <header>
            <h2>今日与昨日交易量</h2>
            <span>00:00 至当前 / 昨日完整</span>
          </header>
          <ComparisonBars
            today={data?.transactions.todayTotal ?? null}
            yesterday={data?.transactions.yesterdayTotal ?? null}
          />
        </article>
      </section>

      <section className="lora-table-grid" aria-label="大额链上活动">
        <article className="lora-dashboard-card lora-table-card">
          <header>
            <h2>超过 100 LRB 的转账 · Top 5</h2>
            <span>
              {displayLoraValue(data?.largeTransfers.count, "—")} 笔 · 总额 {displayLoraValue(data?.largeTransfers.totalLrb, "—")} · 最大 {displayLoraValue(data?.largeTransfers.maxLrb, "—")}
            </span>
          </header>
          <div className="lora-transfer-row lora-table-head" aria-hidden="true">
            <span>时间</span><span>From</span><span>To</span><span>LRB</span><span>类型</span><span>状态</span><span>交易</span>
          </div>
          <TransferRows rows={transfers} />
        </article>
        <article className="lora-dashboard-card lora-table-card">
          <header>
            <h2>超过 100 LRB 的 Swap</h2>
            <span>
              最近成交 {displayLoraValue(data?.price.latestSwapPrice ?? data?.swaps.latestPrice, "—")} · {formatShanghaiDateTime(data?.price.latestSwapAt ?? data?.swaps.latestAt ?? null)}
            </span>
          </header>
          <div className="lora-swap-row lora-table-head" aria-hidden="true">
            <span>时间</span><span>方向</span><span>LRB</span><span>USDT</span><span>价格</span><span>发起地址</span><span>余额</span><span>交易</span>
          </div>
          <SwapRows rows={swaps} enabled={data?.swaps.enabled ?? false} />
        </article>
      </section>

      <footer className="lora-dashboard-footer">
        <span>区块 {displayLoraValue(data?.chain.blockHeight, "—")}</span>
        <span>最后出块 {formatShanghaiDateTime(data?.chain.lastBlockAt ?? null)}</span>
        <span>平均出块 {displayLoraValue(data?.chain.averageBlockTime, "—")}</span>
        <span>今日 Gas {displayLoraValue(data?.chain.gasUsed, "—")}</span>
        <span>Gas Price {displayLoraValue(data?.chain.averageGasPrice, "—")}</span>
        <button type="button" onClick={() => void window.tongpin?.openLoraExplorer({ kind: "address", value: data?.price.pair || LORA_PAIR_ADDRESS })}>
          Pair {compactExplorerValue(data?.price.pair || LORA_PAIR_ADDRESS)}
        </button>
        <span>价格区块 {displayLoraValue(data?.price.blockNumber, "—")}</span>
        <span>价格时间 {formatShanghaiDateTime(data?.price.updatedAt ?? null)}</span>
        <HealthChip label="RPC" state={data?.health.rpc ?? "unavailable"} />
        <HealthChip label="Explorer" state={data?.health.explorer ?? "unavailable"} />
        <HealthChip label="采集器" state={data?.health.collector ?? "unavailable"} />
        <span>同步 {formatShanghaiDateTime(data?.health.lastSuccessfulSyncAt ?? data?.lastSuccessfulSyncAt ?? null)}</span>
        {error && <span className="lora-dashboard-error">{error}</span>}
      </footer>
    </div>
  );
}

export function LoraChainDashboard() {
  const { api } = useAuth();
  const [data, setData] = useState<LoraDashboardData | null>(null);
  const [clock, setClock] = useState(() => SHANGHAI_CLOCK.format(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async (
    path = "/api/boss/lora-chain/dashboard",
    foreground = true,
  ) => {
    if (foreground) setBusy(true);
    try {
      const result = await api<LoraDashboardData>(path);
      setData(result);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "数据暂不可用");
    } finally {
      if (foreground) setBusy(false);
    }
  }, [api]);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      await api("/api/boss/lora-chain/refresh", { method: "POST" });
      await load();
    } catch (caught) {
      if (caught instanceof ApiRequestError && (caught.status === 404 || caught.status === 405)) {
        await load("/api/boss/lora-chain/dashboard?refresh=true");
        return;
      }
      setError(caught instanceof Error ? caught.message : "刷新失败");
      setBusy(false);
    }
  }, [api, load]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(SHANGHAI_CLOCK.format(new Date())), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(
      () => void load("/api/boss/lora-chain/dashboard", false),
      LORA_DASHBOARD_POLL_MS,
    );
    return () => window.clearInterval(timer);
  }, [load]);

  useEffect(() => {
    let timer: number | null = null;
    const handleUpdate = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load(), 250);
    };
    window.addEventListener("tongpin:lora-chain-updated", handleUpdate);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("tongpin:lora-chain-updated", handleUpdate);
    };
  }, [load]);

  return (
    <LoraChainDashboardView
      data={data}
      clock={clock}
      busy={busy}
      error={error}
      onRefresh={() => void refresh()}
    />
  );
}
