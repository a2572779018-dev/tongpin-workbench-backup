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
  from: string;
  to: string;
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
  initiator: string;
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

export interface LoraIndexedBlock {
  height: number;
  hash: string;
  parentHash: string;
  timestamp: string;
  gasUsed: string;
}

export interface LoraIndexedTransaction {
  hash: string;
  blockNumber: number;
  timestamp: string;
  from: string;
  to: string | null;
  valueWei: string;
  success: boolean;
  gasUsed: string;
  gasPriceWei: string;
  input: string;
  /** Explorer contract classification; absent for legacy persisted rows. */
  toIsContract?: boolean;
}

export interface LoraIndexedInternalTransaction {
  transactionHash: string;
  index: string;
  blockNumber: number;
  timestamp: string;
  from: string;
  to: string | null;
  valueWei: string;
  success: boolean;
  callType: "CALL" | "CREATE" | "SELFDESTRUCT" | string;
}

export interface LoraPendingInternalTransaction {
  transaction: LoraIndexedTransaction;
  /** null means the transaction detail has not fetched its first page yet. */
  nextPageParams: Record<string, string | number> | null;
  /** Event time used to expire the daily queue without retaining old work. */
  queuedAt: string;
}

export interface LoraIndexedSwap {
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: string;
  side: "买入" | "卖出";
  lrbWei: string;
  usdtUnits: string;
  priceUsdt: string;
  initiator: string;
  currentNativeBalanceWei: string | null;
}

export interface LoraDailyAddressBaseline {
  reportDate: string;
  totalAddresses: string;
  capturedAt: string;
  blockNumber: number | null;
  /** Estimated baselines must never be presented as an exact midnight count. */
  estimated?: boolean;
  source?:
    | "midnight-window"
    | "carry-forward"
    | "first-observation"
    | "recovered-observation";
}

export interface LoraPriceSnapshot {
  status: LoraDataStatus;
  priceUsdt: string | null;
  reserveUsdt: string | null;
  reserveWlrb: string | null;
  blockNumber: number | null;
  updatedAt: string | null;
  source: string | null;
  configError: string | null;
}

export interface LoraSourceHealth {
  rpc: LoraDataStatus;
  explorer: LoraDataStatus;
  collector: LoraDataStatus;
  lastRpcSuccessAt: string | null;
  lastExplorerSuccessAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastError: string | null;
}

export interface LoraCollectorState {
  checkpointBlock: number | null;
  checkpointHash: string | null;
  blockCursor: Record<string, string | number> | null;
  transactionCursor: Record<string, string | number> | null;
  burnCursor: Record<string, string | number> | null;
  burnHistoryCursor: Record<string, string | number> | null;
  /** Newest fully connected Explorer head item. Historical cursors are separate. */
  headTransactionHash?: string | null;
  headBurnKey?: string | null;
  blockHeadCursor?: Record<string, string | number> | null;
  blockHeadCandidateKey?: string | null;
  transactionHeadCursor?: Record<string, string | number> | null;
  transactionHeadCandidateHash?: string | null;
  burnHeadCursor?: Record<string, string | number> | null;
  burnHeadCandidateKey?: string | null;
  /** Last Pair block whose Swap logs and mandatory proofs were fully indexed. */
  swapCheckpointBlock?: number | null;
  /** Contract transactions whose internal traces have not been fully collected. */
  pendingInternalTransactions?: LoraPendingInternalTransaction[];
  /** True once this report date dropped work at the bounded queue limit. */
  internalQueueOverflow?: boolean;
  internalDetailsComplete?: boolean;
  swapTodayComplete?: boolean;
  bootstrapDate: string | null;
  transactionTodayComplete: boolean;
  transactionYesterdayComplete: boolean;
  burnTodayComplete: boolean;
  blockTodayComplete: boolean;
  todayComplete: boolean;
  yesterdayComplete: boolean;
  historyComplete: boolean;
  nextRunAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  consecutiveFailures: number;
}

export interface BossLoraReportOpen {
  bossUserId: string;
  reportDate: string;
  claimedAt: string;
  trigger:
    | "startup"
    | "login"
    | "08:00"
    | "reconnect"
    | "manual";
}

export interface LoraDashboardCache {
  reportDate: string;
  dashboard: LoraDashboardData;
  generatedAt: string;
  lastSuccessfulSyncAt: string;
}

export interface LoraCollectionBatch {
  blocks: LoraIndexedBlock[];
  transactions: LoraIndexedTransaction[];
  internalTransactions: LoraIndexedInternalTransaction[];
  swaps: LoraIndexedSwap[];
  currentTotalAddresses: string | null;
  addressBaseline?: LoraDailyAddressBaseline;
  price: LoraPriceSnapshot;
  nextTransactionCursor: Record<string, string | number> | null;
  nextBurnCursor: Record<string, string | number> | null;
  nextBurnHistoryCursor: Record<string, string | number> | null;
  nextBlockCursor: Record<string, string | number> | null;
  checkpointBlock: number | null;
  checkpointHash: string | null;
  headTransactionHash?: string | null;
  headBurnKey?: string | null;
  blockHeadCursor?: Record<string, string | number> | null;
  blockHeadCandidateKey?: string | null;
  transactionHeadCursor?: Record<string, string | number> | null;
  transactionHeadCandidateHash?: string | null;
  burnHeadCursor?: Record<string, string | number> | null;
  burnHeadCandidateKey?: string | null;
  swapCheckpointBlock?: number | null;
  pendingInternalTransactions?: LoraPendingInternalTransaction[];
  internalQueueOverflow?: boolean;
  internalDetailsComplete?: boolean;
  swapTodayComplete?: boolean;
  transactionTodayComplete: boolean;
  transactionYesterdayComplete: boolean;
  burnTodayComplete: boolean;
  blockTodayComplete: boolean;
  todayComplete: boolean;
  yesterdayComplete: boolean;
  historyComplete: boolean;
  rpcHealthy: boolean;
  explorerHealthy: boolean;
  collectedAt: string;
}

export interface LoraDashboardInput {
  now: Date;
  blocks: LoraIndexedBlock[];
  transactions: LoraIndexedTransaction[];
  internalTransactions: LoraIndexedInternalTransaction[];
  swaps: LoraIndexedSwap[];
  addressBaselines: LoraDailyAddressBaseline[];
  currentTotalAddresses: string | null;
  price: LoraPriceSnapshot;
  state: LoraCollectorState;
  health: LoraSourceHealth;
}
