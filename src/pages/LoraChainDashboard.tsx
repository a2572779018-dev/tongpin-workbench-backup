import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, Circle, Cube } from "@phosphor-icons/react";
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

// The source cycle permits 48 external attempts at up to 20 seconds each.
const LORA_MANUAL_REFRESH_TIMEOUT_MS = 17 * 60 * 1_000;

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

function addressBaselineLabel(addresses: LoraDashboardData["addresses"] | undefined): string {
  if (!addresses) return "待建立基线";
  if (addresses.baselineStatus === "ready") return "今日净增";
  if (addresses.baselineStatus === "building") {
    return addresses.todayNew ? "恢复后估算" : "待建立基线";
  }
  if (addresses.baselineStatus === "stale") {
    return addresses.todayNew ? "缓存估算" : "数据延迟";
  }
  if (addresses.baselineStatus === "config-error") return "配置错误";
  if (addresses.baselineStatus === "unavailable") return "暂不可用";
  return "待建立基线";
}

function addressMetricValue(addresses: LoraDashboardData["addresses"] | undefined): string | null {
  const value = addresses?.todayNew ?? null;
  if (!value || addresses?.baselineStatus !== "building" || value.startsWith("≈")) return value;
  return `≈${value}`;
}

function dashboardTimestamp(data: LoraDashboardData): number {
  const parsed = Date.parse(data.dataUpdatedAt ?? data.generatedAt);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function priceStateLabel(data: LoraDashboardData | null): string {
  if (!data) return "等待价格";
  return {
    ready: "1 LRB = USDT",
    stale: "缓存价格",
    building: "价格采集中",
    missing: "暂无成交价格",
    unavailable: "价格不可用",
    "config-error": "价格配置错误",
  }[data.price.status];
}

export function dashboardFromRefresh(payload: unknown): LoraDashboardData | null {
  if (!payload || typeof payload !== "object") return null;
  if ("dashboard" in payload) {
    const dashboard = (payload as { dashboard?: unknown }).dashboard;
    if (dashboard && typeof dashboard === "object" && "reportDate" in dashboard) {
      return dashboard as LoraDashboardData;
    }
    return null;
  }
  return "reportDate" in payload ? payload as LoraDashboardData : null;
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
          title={`${point.hour}:00 ${point.count ?? "—"}`}
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
  const peakIndex = hasData ? values.indexOf(maximum) : 0;
  const peakX = (peakIndex / 23) * 100;
  const peakY = 35 - (values[peakIndex] / maximum) * 30;
  return (
    <div
      className="lora-hourly-line"
      aria-label={hasData
        ? `每小时新增节点趋势，峰值 ${normalized[peakIndex].hour} 时 ${normalized[peakIndex].count ?? "—"}`
        : "每小时新增节点趋势，数据采集中"}
    >
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 5H100M0 15H100M0 25H100M0 35H100" />
        {hasData && (
          <>
            <polygon className="lora-line-area" points={`${line} 100,35 0,35`} />
            <polyline points={line} />
            <circle className="lora-line-point" cx={peakX} cy={peakY} r="1.1" />
          </>
        )}
      </svg>
      {!hasData && <span>采集中</span>}
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
        <b>{today ?? "—"}</b>
        <i style={{ height: `${(todayValue / maximum) * 100}%` }} />
        <span>今日</span>
      </div>
      <div>
        <b>{yesterday ?? "—"}</b>
        <i style={{ height: `${(yesterdayValue / maximum) * 100}%` }} />
        <span>昨日</span>
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
      aria-label={`在区块浏览器打开${kind === "address" ? "地址" : "交易"} ${value!}`}
      onClick={() => void window.tongpin?.openLoraExplorer({ kind, value: value! })}
    >
      {compactExplorerValue(value!)}
    </button>
  );
}

function TransferRows({ rows, loading }: { rows: LoraLargeTransferRow[]; loading: boolean }) {
  if (rows.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={7}>
            <div className="lora-table-empty">{loading ? "采集中" : "暂无转账"}</div>
          </td>
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {rows.map((row) => (
        <tr key={`${row.hash}:${row.time}:${row.type}`}>
          <td>{formatShanghaiDateTime(row.time)}</td>
          <td><ExplorerButton kind="address" value={row.from} /></td>
          <td><ExplorerButton kind="address" value={row.to} /></td>
          <td><b>{displayLoraValue(row.amountLrb, "—")}</b></td>
          <td>{row.type}</td>
          <td><span className="lora-table-tag">{row.status}</span></td>
          <td><ExplorerButton kind="tx" value={row.hash} /></td>
        </tr>
      ))}
    </tbody>
  );
}

function SwapRows({ rows, enabled, loading }: { rows: LoraSwapRow[]; enabled: boolean; loading: boolean }) {
  if (!enabled || rows.length === 0) {
    const message = !enabled ? "Swap 统计已禁用" : loading ? "采集中" : "暂无 Swap";
    return (
      <tbody>
        <tr>
          <td colSpan={8}>
            <div className="lora-table-empty">{message}</div>
          </td>
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {rows.map((row) => (
        <tr key={`${row.hash}:${row.time}`}>
          <td>{formatShanghaiDateTime(row.time)}</td>
          <td><b>{row.side}</b></td>
          <td>{displayLoraValue(row.lrbAmount, "—")}</td>
          <td>{displayLoraValue(row.usdtAmount, "—")}</td>
          <td>{displayLoraValue(row.price, "—")}</td>
          <td><ExplorerButton kind="address" value={row.initiator} /></td>
          <td>{displayLoraValue(row.currentNativeBalanceLrb, "—")}</td>
          <td><ExplorerButton kind="tx" value={row.hash} /></td>
        </tr>
      ))}
    </tbody>
  );
}

function HealthChip({ label, state }: { label: string; state: string }) {
  const ready = state === "ready";
  return (
    <span className={`lora-health-chip is-${state}`}>
      <Circle size={10} weight={ready ? "fill" : "bold"} aria-hidden="true" />
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
  const baselineLabel = data?.baselineStatus === "ready" ? "—" : "采集中";
  const addressState = addressBaselineLabel(data?.addresses);
  const addressValue = addressMetricValue(data?.addresses);
  const trustedPrice =
    data?.price.status === "ready" || data?.price.status === "stale"
      ? data.price.priceUsdt
      : null;
  const transactionHourly = data?.transactions.hourly ?? [];
  const nodeHourly = data?.nodes.hourly ?? [];
  const transfers = data?.largeTransfers.top5?.length
    ? data.largeTransfers.top5
    : (data?.largeTransfers.rows ?? []);
  const swaps = data?.swaps.rows ?? [];
  const dashboardState = busy
    ? data ? "正在刷新数据" : "正在加载数据"
    : error
      ? "暂不可用"
      : !data
        ? "等待数据"
        : data.baselineStatus === "building"
      ? data.dataUpdatedAt
        ? `同步补齐 · 更新 ${formatShanghaiDateTime(data.dataUpdatedAt)}`
        : "采集中"
      : data.stale
        ? "数据延迟"
        : `已更新 ${formatShanghaiDateTime(data.dataUpdatedAt)}`;
  const displayClock = `${(data?.reportDate ?? "").slice(5) || "今日"} ${clock.slice(0, 5)}`;
  const successRate = displayLoraValue(
    data?.transactions.successRateLabel ?? data?.transactions.successRate,
    "—",
  );

  return (
    <div className="lora-dashboard-page" aria-busy={busy}>
      <header className="lora-dashboard-header">
        <div className="lora-dashboard-brand">
          <span className="lora-dashboard-brand__icon" aria-hidden="true">
            <Cube size={20} weight="fill" />
          </span>
          <h1>LORA 驾驶舱</h1>
        </div>
        <div className="lora-dashboard-header__status">
          <span
            className={data?.stale || error ? "lora-dashboard-sync is-stale" : "lora-dashboard-sync"}
            aria-live="polite"
          >
            {dashboardState}
          </span>
          <b className="lora-dashboard-live">
            <Circle className="lora-live-dot" size={10} weight="fill" aria-hidden="true" />
            {displayClock}
          </b>
          <button
            type="button"
            disabled={busy}
            onClick={onRefresh}
            aria-label={busy ? "正在刷新 LORA 链数据" : "刷新 LORA 链数据"}
            aria-busy={busy}
          >
            <ArrowsClockwise size={17} weight="bold" className={busy ? "is-spinning" : ""} />
            {busy ? "刷新中" : "刷新"}
          </button>
        </div>
      </header>

      <section className="lora-kpi-grid" aria-label="链上核心指标">
        <article>
          <span>今日新增节点</span>
          <strong>{displayMetric(data?.nodes.todayCount ?? null, baselineLabel)}</strong>
          <b>销毁 {displayLoraValue(data?.nodes.todayNodeBurnLrb, "—")} LRB</b>
        </article>
        <article>
          <span>{data?.addresses.label ?? "今日新增链上地址"}</span>
          <strong>{displayMetric(addressValue, addressState)}</strong>
          <b>{addressState}</b>
        </article>
        <article>
          <span>今日交易</span>
          <strong>{displayMetric(data?.transactions.todayTotal ?? null, baselineLabel)}</strong>
          <b>昨日 {displayLoraValue(data?.transactions.yesterdayTotal, "—")} · 成功率 {successRate}</b>
        </article>
        <article className="lora-price-kpi">
          <span>LRB / USDT</span>
          <strong>{displayMetric(trustedPrice, "暂无可信价格")}</strong>
          <b>{priceStateLabel(data)}</b>
        </article>
        <article>
          <span>今日活跃地址数</span>
          <strong>{displayMetric(data?.transactions.activeAddresses ?? null, baselineLabel)}</strong>
          <b>去重</b>
        </article>
      </section>

      <h2 className="lora-section-label">趋势 / TRENDS</h2>
      <section className="lora-chart-grid" aria-label="链上趋势图">
        <article className="lora-dashboard-card">
          <header>
            <h2>每小时交易趋势</h2>
            <span>原生转账 {displayLoraValue(data?.transactions.nativeTransfers, "采集中")}</span>
          </header>
          <HourlyBars points={transactionHourly} />
          <footer><span>00</span><span>08</span><span>16</span><span>23</span></footer>
        </article>
        <article className="lora-dashboard-card">
          <header>
            <h2>每小时新增节点趋势</h2>
            <span>销毁 {displayLoraValue(data?.nodes.todayNodeBurnLrb, "采集中")} LRB</span>
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
            <span>今日 / 昨日</span>
          </header>
          <ComparisonBars
            today={data?.transactions.todayTotal ?? null}
            yesterday={data?.transactions.yesterdayTotal ?? null}
          />
        </article>
      </section>

      <h2 className="lora-section-label">明细 / DETAIL</h2>
      <section className="lora-table-grid" aria-label="大额链上活动">
        <article className="lora-dashboard-card lora-table-card">
          <header>
            <h2>超过 100 LRB 的转账 · Top 5</h2>
            <span>
              {displayLoraValue(data?.largeTransfers.count, "—")} 笔 · 总额 {displayLoraValue(data?.largeTransfers.totalLrb, "—")} · 最大 {displayLoraValue(data?.largeTransfers.maxLrb, "—")}
            </span>
          </header>
          <div className="lora-table-scroll" role="region" aria-label="大额转账表格，可横向滚动" tabIndex={0}>
            <table className="lora-data-table lora-transfer-table">
              <caption className="sr-only">超过 100 LRB 的转账记录</caption>
              <thead>
                <tr>
                  <th scope="col">时间</th><th scope="col">From</th><th scope="col">To</th><th scope="col">LRB</th><th scope="col">类型</th><th scope="col">状态</th><th scope="col">交易</th>
                </tr>
              </thead>
              <TransferRows rows={transfers} loading={data?.largeTransfers.count === null} />
            </table>
          </div>
        </article>
        <article className="lora-dashboard-card lora-table-card">
          <header>
            <h2>超过 100 LRB 的 Swap</h2>
            <span>
              最近成交 {displayLoraValue(data?.price.latestSwapPrice ?? data?.swaps.latestPrice, "—")} · {formatShanghaiDateTime(data?.price.latestSwapAt ?? data?.swaps.latestAt ?? null)}
            </span>
          </header>
          <div className="lora-table-scroll" role="region" aria-label="大额 Swap 表格，可横向滚动" tabIndex={0}>
            <table className="lora-data-table lora-swap-table">
              <caption className="sr-only">超过 100 LRB 的 Swap 记录</caption>
              <thead>
                <tr>
                  <th scope="col">时间</th><th scope="col">方向</th><th scope="col">LRB</th><th scope="col">USDT</th><th scope="col">价格</th><th scope="col">发起地址</th><th scope="col">余额</th><th scope="col">交易</th>
                </tr>
              </thead>
              <SwapRows
                rows={swaps}
                enabled={data?.swaps.enabled ?? false}
                loading={data?.swaps.status === "building"}
              />
            </table>
          </div>
        </article>
      </section>

      <footer className="lora-dashboard-footer" aria-label="链上状态">
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
        {error && <span className="lora-dashboard-error" role="status">{error}</span>}
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
  const foregroundRequests = useRef(0);

  const startForegroundRequest = useCallback(() => {
    foregroundRequests.current += 1;
    setBusy(true);
  }, []);

  const finishForegroundRequest = useCallback(() => {
    foregroundRequests.current = Math.max(0, foregroundRequests.current - 1);
    if (foregroundRequests.current === 0) setBusy(false);
  }, []);

  const applyDashboard = useCallback((next: LoraDashboardData) => {
    setData((current) => {
      if (!current || dashboardTimestamp(next) >= dashboardTimestamp(current)) return next;
      return current;
    });
  }, []);

  const load = useCallback(async (
    path = "/api/boss/lora-chain/dashboard",
    foreground = true,
  ) => {
    if (foreground) startForegroundRequest();
    try {
      const result = await api<LoraDashboardData>(path);
      applyDashboard(result);
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "数据暂不可用");
    } finally {
      if (foreground) finishForegroundRequest();
    }
  }, [api, applyDashboard, finishForegroundRequest, startForegroundRequest]);

  const refresh = useCallback(async () => {
    startForegroundRequest();
    try {
      const result = await api<unknown>(
        "/api/boss/lora-chain/refresh",
        { method: "POST" },
        LORA_MANUAL_REFRESH_TIMEOUT_MS,
      );
      const refreshed = dashboardFromRefresh(result);
      if (!refreshed) throw new Error("刷新返回缺少驾驶舱数据");
      applyDashboard(refreshed);
      setError("");
    } catch (caught) {
      if (caught instanceof ApiRequestError && (caught.status === 404 || caught.status === 405)) {
        await load("/api/boss/lora-chain/dashboard?refresh=true", false);
        return;
      }
      setError(caught instanceof Error ? caught.message : "刷新失败");
    } finally {
      finishForegroundRequest();
    }
  }, [api, applyDashboard, finishForegroundRequest, load, startForegroundRequest]);

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
    const handleUpdate = (event: Event) => {
      const pushed = dashboardFromRefresh((event as CustomEvent<unknown>).detail);
      if (pushed) {
        applyDashboard(pushed);
        setError("");
        return;
      }
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void load("/api/boss/lora-chain/dashboard", false), 250);
    };
    window.addEventListener("tongpin:lora-chain-updated", handleUpdate);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("tongpin:lora-chain-updated", handleUpdate);
    };
  }, [applyDashboard, load]);

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
