export type LoraDataStatus =
  | "ready"
  | "building"
  | "missing"
  | "unavailable"
  | "stale"
  | "config-error";

export interface LoraHourlyPoint {
  hour: string;
  count: string | null;
}

export interface LoraLargeTransferRow {
  time: string;
  from: string | null;
  to: string | null;
  amountLrb: string | null;
  type: "普通转账" | "合约调用" | "内部转账" | "节点销毁" | string;
  status: string;
  hash: string;
}

export interface LoraSwapRow {
  time: string;
  side: "买入" | "卖出" | string;
  lrbAmount: string | null;
  usdtAmount: string | null;
  price: string | null;
  initiator: string | null;
  currentNativeBalanceLrb: string | null;
  hash: string;
}

export interface LoraDashboardData {
  reportDate: string;
  timezone: string;
  generatedAt: string;
  dataUpdatedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  stale: boolean;
  baselineStatus: LoraDataStatus;
  nodes: {
    todayCount: string | null;
    todayNodeBurnLrb: string | null;
    todayOtherBurnLrb: string | null;
    cumulativeBurnLrb: string | null;
    cumulativeConfirmedCount: string | null;
    hourly: LoraHourlyPoint[];
  };
  addresses: {
    label: "今日新增钱包地址" | "今日新增链上地址" | string;
    todayNew: string | null;
    baselineStatus: LoraDataStatus;
  };
  transactions: {
    todayTotal: string | null;
    success: string | null;
    failed: string | null;
    successRate: string | null;
    successRateLabel: string | null;
    nativeTransfers: string | null;
    activeAddresses: string | null;
    yesterdayTotal: string | null;
    hourly: LoraHourlyPoint[];
  };
  largeTransfers: {
    count: string | null;
    totalLrb: string | null;
    maxLrb: string | null;
    rows: LoraLargeTransferRow[];
    top5: LoraLargeTransferRow[];
  };
  swaps: {
    enabled: boolean;
    status: LoraDataStatus;
    rows: LoraSwapRow[];
    latestPrice: string | null;
    latestAt: string | null;
  };
  price: {
    status: LoraDataStatus;
    priceUsdt: string | null;
    source: string | null;
    pair: string;
    blockNumber: string | null;
    updatedAt: string | null;
    latestSwapPrice: string | null;
    latestSwapAt: string | null;
  };
  chain: {
    blockHeight: string | null;
    lastBlockAt: string | null;
    averageBlockTime: string | null;
    gasUsed: string | null;
    averageGasPrice: string | null;
  };
  health: {
    rpc: LoraDataStatus;
    explorer: LoraDataStatus;
    collector: LoraDataStatus;
    lastSuccessfulSyncAt: string | null;
  };
}

export interface LoraDailyClaimResult {
  shouldOpen: boolean;
  reportDate: string;
  claimedAt?: string;
  dashboard?: LoraDashboardData;
}

export const LORA_PAIR_ADDRESS =
  "0x55b4Ea7Bc8D22b156381b01cA9c58dBfB6345454";
export const LORA_DASHBOARD_POLL_MS = 60_000;

export function displayLoraValue(
  value: string | null | undefined,
  fallback: string,
): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function statusLabel(status: LoraDataStatus): string {
  return {
    ready: "正常",
    building: "采集中",
    missing: "无日基线",
    unavailable: "不可用",
    stale: "数据已失效",
    "config-error": "配置错误",
  }[status];
}

export function compactExplorerValue(value: string): string {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function chartCount(value: string | null): number {
  if (!value || !/^\d+\+?$/.test(value)) return 0;
  const parsed = Number(value.replace(/\+$/, ""));
  return Number.isSafeInteger(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
