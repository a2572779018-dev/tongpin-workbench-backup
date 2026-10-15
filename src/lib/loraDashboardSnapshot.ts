import { LORA_PAIR_ADDRESS, type LoraDashboardData, type LoraDataStatus, type LoraHourlyPoint } from "./loraDashboardData";

export interface LoraDashboardSnapshot {
  data: LoraDashboardData;
  /** Field paths only; never retain the response body or account information. */
  issues: string[];
}

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const statuses = new Set<LoraDataStatus>(["ready", "building", "missing", "unavailable", "stale", "config-error"]);

/** HTTP, refresh and WebSocket responses all cross this same runtime boundary.
 * Missing values stay unknown; a partial snapshot must never manufacture zeros. */
export function readLoraDashboardSnapshot(payload: unknown): LoraDashboardSnapshot | null {
  const envelope = record(payload);
  const source = record(envelope && "dashboard" in envelope ? envelope.dashboard : envelope);
  if (!source || typeof source.reportDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(source.reportDate)) return null;
  const day = Date.parse(`${source.reportDate}T00:00:00.000Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== source.reportDate) return null;
  const groupNames = ["nodes", "transactions", "largeTransfers", "swaps", "price", "chain", "health"];
  if (!groupNames.some(name => record(source[name]))) return null;

  const issues: string[] = [];
  const issue = (path: string) => { if (!issues.includes(path)) issues.push(path); };
  const group = (name: string, optional = false): RecordValue => {
    const value = record(source[name]);
    if (!value && !optional) issue(name);
    return value ?? {};
  };
  const text = (value: unknown, path: string, fallback: string | null = null): string | null => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === "string") return value.trim() || fallback;
    // Older collectors sometimes encoded small numeric metrics as numbers.
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) return String(value);
    issue(path);
    return fallback;
  };
  const date = (value: unknown, path: string): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
    issue(path);
    return null;
  };
  const status = (value: unknown, path: string): LoraDataStatus => {
    if (typeof value === "string" && statuses.has(value as LoraDataStatus)) return value as LoraDataStatus;
    issue(path);
    return "unavailable";
  };
  const rows = (value: unknown, path: string): RecordValue[] => {
    if (!Array.isArray(value)) { issue(path); return []; }
    return value.flatMap((entry, index) => {
      const row = record(entry);
      if (!row) { issue(`${path}.${index}`); return []; }
      return [row];
    });
  };
  const hourly = (value: unknown, path: string): LoraHourlyPoint[] => {
    const byHour = new Map<string, LoraHourlyPoint>();
    for (const [index, point] of rows(value, path).entries()) {
      const hour = typeof point.hour === "string" ? point.hour.match(/^(\d{1,2})(?::00)?$/)?.[1] : undefined;
      if (hour === undefined || Number(hour) > 23) { issue(`${path}.${index}.hour`); continue; }
      const key = hour.padStart(2, "0");
      byHour.set(key, { hour: key, count: text(point.count, `${path}.${index}.count`) });
    }
    return [...byHour.values()];
  };
  const nullableId = (value: unknown, path: string, kind: "address" | "tx"): string | null => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string" && (kind === "address" ? /^0x[\da-f]{40}$/i : /^0x[\da-f]{64}$/i).test(value)) return value;
    issue(path);
    return null;
  };
  const transfers = (value: unknown, path: string): LoraDashboardData["largeTransfers"]["rows"] =>
    rows(value, path).flatMap((row, index) => {
      const hash = nullableId(row.hash, `${path}.${index}.hash`, "tx");
      if (!hash) { issue(`${path}.${index}.hash`); return []; }
      return [{
        hash, time: date(row.time, `${path}.${index}.time`) ?? "",
        from: nullableId(row.from, `${path}.${index}.from`, "address"),
        to: nullableId(row.to, `${path}.${index}.to`, "address"),
        amountLrb: text(row.amountLrb, `${path}.${index}.amountLrb`),
        type: text(row.type, `${path}.${index}.type`, "—")!,
        status: text(row.status, `${path}.${index}.status`, "—")!,
      }];
    });

  const nodes = group("nodes"), addresses = group("addresses", true), transactions = group("transactions");
  const largeTransfers = group("largeTransfers"), swaps = group("swaps"), price = group("price");
  const chain = group("chain"), health = group("health");
  const generatedAt = date(source.generatedAt, "generatedAt");
  if (!generatedAt) issue("generatedAt");
  if (typeof source.stale !== "boolean") issue("stale");
  if (typeof swaps.enabled !== "boolean") issue("swaps.enabled");
  const data: LoraDashboardData = {
    reportDate: source.reportDate, timezone: "Asia/Shanghai", generatedAt: generatedAt ?? "",
    dataUpdatedAt: date(source.dataUpdatedAt, "dataUpdatedAt"),
    lastSuccessfulSyncAt: date(source.lastSuccessfulSyncAt, "lastSuccessfulSyncAt"),
    stale: source.stale !== false, baselineStatus: status(source.baselineStatus, "baselineStatus"),
    nodes: {
      todayCount: text(nodes.todayCount, "nodes.todayCount"),
      todayNodeBurnLrb: text(nodes.todayNodeBurnLrb, "nodes.todayNodeBurnLrb"),
      todayOtherBurnLrb: text(nodes.todayOtherBurnLrb, "nodes.todayOtherBurnLrb"),
      cumulativeBurnLrb: text(nodes.cumulativeBurnLrb, "nodes.cumulativeBurnLrb"),
      cumulativeConfirmedCount: text(nodes.cumulativeConfirmedCount, "nodes.cumulativeConfirmedCount"),
      hourly: hourly(nodes.hourly, "nodes.hourly"),
    },
    addresses: {
      label: text(addresses.label, "addresses.label", "今日新增链上地址")!,
      todayNew: text(addresses.todayNew, "addresses.todayNew"),
      baselineStatus: source.addresses === undefined ? "missing" : status(addresses.baselineStatus, "addresses.baselineStatus"),
    },
    transactions: {
      todayTotal: text(transactions.todayTotal, "transactions.todayTotal"),
      success: text(transactions.success, "transactions.success"), failed: text(transactions.failed, "transactions.failed"),
      successRate: text(transactions.successRate, "transactions.successRate"),
      successRateLabel: text(transactions.successRateLabel, "transactions.successRateLabel"),
      nativeTransfers: text(transactions.nativeTransfers, "transactions.nativeTransfers"),
      activeAddresses: text(transactions.activeAddresses, "transactions.activeAddresses"),
      yesterdayTotal: text(transactions.yesterdayTotal, "transactions.yesterdayTotal"),
      hourly: hourly(transactions.hourly, "transactions.hourly"),
    },
    largeTransfers: {
      count: text(largeTransfers.count, "largeTransfers.count"), totalLrb: text(largeTransfers.totalLrb, "largeTransfers.totalLrb"),
      maxLrb: text(largeTransfers.maxLrb, "largeTransfers.maxLrb"), rows: transfers(largeTransfers.rows, "largeTransfers.rows"),
      top5: largeTransfers.top5 === undefined ? [] : transfers(largeTransfers.top5, "largeTransfers.top5"),
    },
    swaps: {
      enabled: swaps.enabled === true, status: status(swaps.status, "swaps.status"),
      latestPrice: text(swaps.latestPrice, "swaps.latestPrice"), latestAt: date(swaps.latestAt, "swaps.latestAt"),
      rows: rows(swaps.rows, "swaps.rows").flatMap((row, index) => {
        const path = `swaps.rows.${index}`;
        const hash = nullableId(row.hash, `${path}.hash`, "tx");
        if (!hash) { issue(`${path}.hash`); return []; }
        return [{ hash, time: date(row.time, `${path}.time`) ?? "", side: text(row.side, `${path}.side`, "—")!,
          lrbAmount: text(row.lrbAmount, `${path}.lrbAmount`), usdtAmount: text(row.usdtAmount, `${path}.usdtAmount`),
          price: text(row.price, `${path}.price`), initiator: nullableId(row.initiator, `${path}.initiator`, "address"),
          currentNativeBalanceLrb: text(row.currentNativeBalanceLrb, `${path}.currentNativeBalanceLrb`),
        }];
      }),
    },
    price: {
      status: status(price.status, "price.status"), priceUsdt: text(price.priceUsdt, "price.priceUsdt"),
      source: text(price.source, "price.source"), pair: nullableId(price.pair, "price.pair", "address") ?? LORA_PAIR_ADDRESS,
      blockNumber: text(price.blockNumber, "price.blockNumber"), updatedAt: date(price.updatedAt, "price.updatedAt"),
      latestSwapPrice: text(price.latestSwapPrice, "price.latestSwapPrice"), latestSwapAt: date(price.latestSwapAt, "price.latestSwapAt"),
    },
    chain: {
      blockHeight: text(chain.blockHeight, "chain.blockHeight"), lastBlockAt: date(chain.lastBlockAt, "chain.lastBlockAt"),
      averageBlockTime: text(chain.averageBlockTime, "chain.averageBlockTime"), gasUsed: text(chain.gasUsed, "chain.gasUsed"),
      averageGasPrice: text(chain.averageGasPrice, "chain.averageGasPrice"),
    },
    health: {
      rpc: status(health.rpc, "health.rpc"), explorer: status(health.explorer, "health.explorer"),
      collector: status(health.collector, "health.collector"),
      lastSuccessfulSyncAt: date(health.lastSuccessfulSyncAt, "health.lastSuccessfulSyncAt"),
    },
  };
  return { data, issues };
}

const timestamp = (value: string | null) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
};

export function chooseLoraDashboardSnapshot(current: LoraDashboardSnapshot | null, next: LoraDashboardSnapshot): LoraDashboardSnapshot {
  if (!current) return next;
  if (next.data.reportDate !== current.data.reportDate) return next.data.reportDate > current.data.reportDate ? next : current;
  if (!current.issues.length && next.issues.length) return current;
  const nextTime = timestamp(next.data.dataUpdatedAt ?? next.data.generatedAt);
  const currentTime = timestamp(current.data.dataUpdatedAt ?? current.data.generatedAt);
  if (nextTime !== currentTime) return nextTime > currentTime ? next : current;
  if (timestamp(next.data.generatedAt) > timestamp(current.data.generatedAt)) return next;
  if (current.issues.length && !next.issues.length && timestamp(next.data.generatedAt) === timestamp(current.data.generatedAt)) return next;
  return current;
}
