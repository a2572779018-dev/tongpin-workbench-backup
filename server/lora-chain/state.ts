import {
  LORA_BURN_ADDRESS,
  LORA_BOOTSTRAP_INTERVAL_MS,
  LORA_COLLECT_INTERVAL_MS,
  LORA_PAIR_ADDRESS,
} from "./constants";
import { buildLoraDashboard } from "./statistics";
import { shanghaiDateKey } from "./time";
import type {
  LoraCollectionBatch,
  LoraCollectorState,
  LoraPriceSnapshot,
  LoraSourceHealth,
} from "./types";
import type { DatabaseShape } from "../types";

const LORA_DETAIL_RETENTION_MS = 9 * 24 * 60 * 60 * 1_000;

export const EMPTY_LORA_COLLECTOR_STATE: LoraCollectorState = {
  checkpointBlock: null,
  checkpointHash: null,
  blockCursor: null,
  transactionCursor: null,
  burnCursor: null,
  burnHistoryCursor: null,
  headTransactionHash: null,
  headBurnKey: null,
  blockHeadCursor: null,
  blockHeadCandidateKey: null,
  transactionHeadCursor: null,
  transactionHeadCandidateHash: null,
  burnHeadCursor: null,
  burnHeadCandidateKey: null,
  swapCheckpointBlock: null,
  pendingInternalTransactions: [],
  internalDetailsComplete: false,
  swapTodayComplete: false,
  bootstrapDate: null,
  transactionTodayComplete: false,
  transactionYesterdayComplete: false,
  burnTodayComplete: false,
  blockTodayComplete: false,
  todayComplete: false,
  yesterdayComplete: false,
  historyComplete: false,
  nextRunAt: null,
  lastAttemptAt: null,
  lastSuccessfulSyncAt: null,
  consecutiveFailures: 0,
};

export const EMPTY_LORA_PRICE: LoraPriceSnapshot = {
  status: "unavailable",
  priceUsdt: null,
  reserveUsdt: null,
  reserveWlrb: null,
  blockNumber: null,
  updatedAt: null,
  source: null,
  configError: null,
};

export const EMPTY_LORA_HEALTH: LoraSourceHealth = {
  rpc: "unavailable",
  explorer: "unavailable",
  collector: "building",
  lastRpcSuccessAt: null,
  lastExplorerSuccessAt: null,
  lastSuccessfulSyncAt: null,
  lastError: null,
};

function upsertByKey<T>(
  current: T[],
  incoming: T[],
  key: (value: T) => string,
): T[] {
  const merged = new Map(current.map((value) => [key(value), value]));
  for (const value of incoming) merged.set(key(value), value);
  return [...merged.values()];
}

export function applyLoraCollectionBatch(
  database: DatabaseShape,
  batch: LoraCollectionBatch,
  now = new Date(batch.collectedAt),
): void {
  database.loraBlocks = upsertByKey(
    database.loraBlocks,
    batch.blocks,
    (block) => String(block.height),
  );
  database.loraTransactions = upsertByKey(
    database.loraTransactions,
    batch.transactions,
    (transaction) => transaction.hash.toLowerCase(),
  );
  database.loraInternalTransactions = upsertByKey(
    database.loraInternalTransactions,
    batch.internalTransactions,
    (transaction) =>
      `${transaction.transactionHash.toLowerCase()}:${transaction.index}`,
  );
  database.loraSwaps = upsertByKey(
    database.loraSwaps,
    batch.swaps,
    (swap) => `${swap.transactionHash.toLowerCase()}:${swap.logIndex}`,
  );
  const retentionCutoff = now.getTime() - LORA_DETAIL_RETENTION_MS;
  database.loraBlocks = database.loraBlocks.filter(
    (block) => Date.parse(block.timestamp) >= retentionCutoff,
  );
  database.loraTransactions = database.loraTransactions.filter(
    (transaction) => Date.parse(transaction.timestamp) >= retentionCutoff,
  );
  database.loraInternalTransactions = database.loraInternalTransactions.filter(
    (transaction) =>
      transaction.to?.toLowerCase() === LORA_BURN_ADDRESS ||
      Date.parse(transaction.timestamp) >= retentionCutoff,
  );
  const swapsByNewest = [...database.loraSwaps].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  );
  const newestSwapKey = swapsByNewest[0]
    ? `${swapsByNewest[0].transactionHash.toLowerCase()}:${swapsByNewest[0].logIndex}`
    : null;
  database.loraSwaps = database.loraSwaps.filter(
    (swap) =>
      Date.parse(swap.timestamp) >= retentionCutoff ||
      `${swap.transactionHash.toLowerCase()}:${swap.logIndex}` === newestSwapKey,
  );
  if (batch.addressBaseline) {
    const alreadyCaptured = database.loraAddressBaselines.some(
      (baseline) => baseline.reportDate === batch.addressBaseline?.reportDate,
    );
    if (!alreadyCaptured) {
      database.loraAddressBaselines.push(batch.addressBaseline);
    }
  }
  if (batch.currentTotalAddresses !== null) {
    database.loraCurrentTotalAddresses = batch.currentTotalAddresses;
  }
  if (batch.price.status === "ready") {
    database.loraPrice = batch.price;
  } else if (batch.price.status === "config-error") {
    database.loraPrice = batch.price;
  } else if (!database.loraPrice.updatedAt) {
    database.loraPrice = batch.price;
  } else {
    // Keep the last successful value for diagnosis, but never present it as live
    // after the current RPC cycle failed or the reserve timestamp became old.
    database.loraPrice = {
      ...database.loraPrice,
      status: "stale",
    };
  }

  const successful = batch.rpcHealthy && batch.explorerHealthy;
  database.loraCollectorState = {
    ...database.loraCollectorState,
    checkpointBlock: batch.checkpointBlock,
    checkpointHash: batch.checkpointHash,
    blockCursor: batch.nextBlockCursor,
    transactionCursor: batch.nextTransactionCursor,
    burnCursor: batch.nextBurnCursor,
    burnHistoryCursor: batch.nextBurnHistoryCursor,
    headTransactionHash:
      batch.headTransactionHash ?? database.loraCollectorState.headTransactionHash ?? null,
    headBurnKey:
      batch.headBurnKey ?? database.loraCollectorState.headBurnKey ?? null,
    blockHeadCursor:
      batch.blockHeadCursor === undefined
        ? database.loraCollectorState.blockHeadCursor ?? null
        : batch.blockHeadCursor,
    blockHeadCandidateKey:
      batch.blockHeadCandidateKey === undefined
        ? database.loraCollectorState.blockHeadCandidateKey ?? null
        : batch.blockHeadCandidateKey,
    transactionHeadCursor:
      batch.transactionHeadCursor === undefined
        ? database.loraCollectorState.transactionHeadCursor ?? null
        : batch.transactionHeadCursor,
    transactionHeadCandidateHash:
      batch.transactionHeadCandidateHash === undefined
        ? database.loraCollectorState.transactionHeadCandidateHash ?? null
        : batch.transactionHeadCandidateHash,
    burnHeadCursor:
      batch.burnHeadCursor === undefined
        ? database.loraCollectorState.burnHeadCursor ?? null
        : batch.burnHeadCursor,
    burnHeadCandidateKey:
      batch.burnHeadCandidateKey === undefined
        ? database.loraCollectorState.burnHeadCandidateKey ?? null
        : batch.burnHeadCandidateKey,
    swapCheckpointBlock:
      batch.swapCheckpointBlock === undefined
        ? database.loraCollectorState.swapCheckpointBlock ?? null
        : batch.swapCheckpointBlock,
    pendingInternalTransactions:
      batch.pendingInternalTransactions ??
      database.loraCollectorState.pendingInternalTransactions ??
      [],
    internalDetailsComplete:
      batch.internalDetailsComplete ??
      database.loraCollectorState.internalDetailsComplete ??
      false,
    swapTodayComplete:
      batch.swapTodayComplete ?? database.loraCollectorState.swapTodayComplete ?? false,
    bootstrapDate: shanghaiDateKey(now),
    transactionTodayComplete: batch.transactionTodayComplete,
    transactionYesterdayComplete: batch.transactionYesterdayComplete,
    burnTodayComplete: batch.burnTodayComplete,
    blockTodayComplete: batch.blockTodayComplete,
    todayComplete: batch.todayComplete,
    yesterdayComplete: batch.yesterdayComplete,
    historyComplete: batch.historyComplete,
    nextRunAt: new Date(
      now.getTime() +
        (batch.todayComplete
          ? LORA_COLLECT_INTERVAL_MS
          : LORA_BOOTSTRAP_INTERVAL_MS),
    ).toISOString(),
    lastAttemptAt: now.toISOString(),
    lastSuccessfulSyncAt: successful
      ? now.toISOString()
      : database.loraCollectorState.lastSuccessfulSyncAt,
    consecutiveFailures: successful
      ? 0
      : database.loraCollectorState.consecutiveFailures + 1,
  };
  database.loraHealth = {
    rpc: batch.rpcHealthy ? "ready" : database.loraPrice.status === "config-error" ? "config-error" : "unavailable",
    explorer: batch.explorerHealthy ? "ready" : "unavailable",
    collector: successful ? "ready" : "unavailable",
    lastRpcSuccessAt: batch.rpcHealthy
      ? now.toISOString()
      : database.loraHealth.lastRpcSuccessAt,
    lastExplorerSuccessAt: batch.explorerHealthy
      ? now.toISOString()
      : database.loraHealth.lastExplorerSuccessAt,
    lastSuccessfulSyncAt: successful
      ? now.toISOString()
      : database.loraHealth.lastSuccessfulSyncAt,
    lastError:
      batch.rpcHealthy && batch.explorerHealthy
        ? null
        : !batch.rpcHealthy && !batch.explorerHealthy
          ? "RPC_AND_EXPLORER_UNAVAILABLE"
          : !batch.rpcHealthy
            ? "RPC_UNAVAILABLE"
            : "EXPLORER_UNAVAILABLE",
  };

  const dashboard = buildLoraDashboard({
    now,
    blocks: database.loraBlocks,
    transactions: database.loraTransactions,
    internalTransactions: database.loraInternalTransactions,
    swaps: database.loraSwaps,
    addressBaselines: database.loraAddressBaselines,
    currentTotalAddresses: database.loraCurrentTotalAddresses,
    price: database.loraPrice,
    state: database.loraCollectorState,
    health: database.loraHealth,
  });
  database.loraDashboardCaches = upsertByKey(
    database.loraDashboardCaches,
    [
      {
        reportDate: dashboard.reportDate,
        dashboard,
        generatedAt: dashboard.generatedAt,
        lastSuccessfulSyncAt:
          database.loraHealth.lastSuccessfulSyncAt ?? dashboard.generatedAt,
      },
    ],
    (cache) => cache.reportDate,
  ).slice(-8);
}

export function markLoraCollectionFailure(
  database: DatabaseShape,
  error: unknown,
  now = new Date(),
): void {
  const message = error instanceof Error ? error.message : "collection failed";
  database.loraCollectorState.lastAttemptAt = now.toISOString();
  database.loraCollectorState.nextRunAt = new Date(
    now.getTime() + LORA_COLLECT_INTERVAL_MS,
  ).toISOString();
  database.loraCollectorState.consecutiveFailures += 1;
  database.loraHealth.collector = "unavailable";
  database.loraHealth.lastError = message.slice(0, 300);
}

export function createEmptyLoraDatabaseFields(): Pick<
  DatabaseShape,
  | "bossLoraReportOpens"
  | "loraBlocks"
  | "loraTransactions"
  | "loraInternalTransactions"
  | "loraSwaps"
  | "loraAddressBaselines"
  | "loraCollectorState"
  | "loraCurrentTotalAddresses"
  | "loraPrice"
  | "loraHealth"
  | "loraDashboardCaches"
> {
  return {
    bossLoraReportOpens: [],
    loraBlocks: [],
    loraTransactions: [],
    loraInternalTransactions: [],
    loraSwaps: [],
    loraAddressBaselines: [],
    loraCollectorState: structuredClone(EMPTY_LORA_COLLECTOR_STATE),
    loraCurrentTotalAddresses: null,
    loraPrice: {
      ...structuredClone(EMPTY_LORA_PRICE),
      source: `WLRB/USDT Pair ${LORA_PAIR_ADDRESS}`,
    },
    loraHealth: structuredClone(EMPTY_LORA_HEALTH),
    loraDashboardCaches: [],
  };
}
