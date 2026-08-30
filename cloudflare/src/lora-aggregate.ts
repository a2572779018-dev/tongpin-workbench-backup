import {
  LORA_BURN_ADDRESS,
  LORA_CACHE_STALE_AFTER_MS,
  LORA_PAIR_ADDRESS,
  NODE_BURN_WEI,
} from "../../server/lora-chain/constants";
import {
  formatUnits,
  normalizeAddress,
  parseUnsignedInteger,
  ratioPercent,
} from "../../server/lora-chain/math";
import {
  internalTransactionKey,
  isConfirmedNodeBurn,
  isLargeNativeAmount,
  isOtherBurn,
  isValueMovingInternalTransaction,
} from "../../server/lora-chain/statistics";
import {
  EMPTY_LORA_COLLECTOR_STATE,
  EMPTY_LORA_HEALTH,
  EMPTY_LORA_PRICE,
} from "../../server/lora-chain/state";
import {
  addCalendarDays,
  shanghaiDateKey,
  shanghaiHour,
} from "../../server/lora-chain/time";
import type {
  LoraCollectionBatch,
  LoraCollectorState,
  LoraDailyAddressBaseline,
  LoraDashboardData,
  LoraDataStatus,
  LoraIndexedBlock,
  LoraIndexedInternalTransaction,
  LoraIndexedSwap,
  LoraIndexedTransaction,
  LoraLargeTransferRow,
  LoraPriceSnapshot,
  LoraSourceHealth,
} from "../../server/lora-chain/types";
import {
  ExplorerLoraChainDataSource,
  MAX_PENDING_INTERNAL_TRANSACTIONS,
  normalizePendingInternalTransactions,
} from "../../server/lora-chain/source";

export const LORA_AGGREGATE_OBJECT_KEY = "_internal/lora/aggregate-v2.json";
export const LORA_LEGACY_AGGREGATE_OBJECT_KEY =
  "_internal/lora/aggregate-v1.json";

interface RankedLargeTransfer {
  row: LoraLargeTransferRow;
  wei: string;
}

interface LoraDayAggregate {
  transactionHashes: string[];
  internalKeys: string[];
  blockHeights: number[];
  swapKeys: string[];
  topLevelMovementFingerprints: string[];
  activeAddresses: string[];
  transactionTotal: string;
  transactionSuccess: string;
  transactionFailed: string;
  nativeTransfers: string;
  hourlyTransactions: string[];
  gasUsed: string;
  gasPriceTotalWei: string;
  gasPriceCount: string;
  largeTransferCount: string;
  largeTransferTotalWei: string;
  largeTransferMaxWei: string;
  recentLargeTransfers: RankedLargeTransfer[];
  nodeCount: string;
  nodeBurnWei: string;
  otherBurnWei: string;
  hourlyNodes: string[];
  largeSwaps: LoraIndexedSwap[];
}

interface LoraDayIndexes {
  transactionHashes: Set<string>;
  internalKeys: Set<string>;
  blockHeights: Set<number>;
  swapKeys: Set<string>;
  topLevelMovementFingerprints: Set<string>;
  activeAddresses: Set<string>;
}

interface PersistedPendingInternalTransaction {
  transactionHash: string;
  nextPageParams: Record<string, string | number> | null;
  queuedAt: string;
}

export interface LoraAggregateSnapshot {
  version: 2;
  state: LoraCollectorState;
  price: LoraPriceSnapshot;
  health: LoraSourceHealth;
  currentTotalAddresses: string | null;
  addressBaselines: LoraDailyAddressBaseline[];
  days: Record<string, LoraDayAggregate>;
  burnKeys: string[];
  cumulativeBurnWei: string;
  cumulativeConfirmedCount: string;
  latestSwap: LoraIndexedSwap | null;
  recentBlocks: LoraIndexedBlock[];
  updatedAt: string | null;
}

interface LoadedAggregate {
  snapshot: LoraAggregateSnapshot;
  etag: string | null;
}

type LegacyLoraAggregateSnapshot = Omit<LoraAggregateSnapshot, "version"> & {
  version: 1;
};

function zeroHours(): string[] {
  return Array.from({ length: 24 }, () => "0");
}

function emptyDay(): LoraDayAggregate {
  return {
    transactionHashes: [],
    internalKeys: [],
    blockHeights: [],
    swapKeys: [],
    topLevelMovementFingerprints: [],
    activeAddresses: [],
    transactionTotal: "0",
    transactionSuccess: "0",
    transactionFailed: "0",
    nativeTransfers: "0",
    hourlyTransactions: zeroHours(),
    gasUsed: "0",
    gasPriceTotalWei: "0",
    gasPriceCount: "0",
    largeTransferCount: "0",
    largeTransferTotalWei: "0",
    largeTransferMaxWei: "0",
    recentLargeTransfers: [],
    nodeCount: "0",
    nodeBurnWei: "0",
    otherBurnWei: "0",
    hourlyNodes: zeroHours(),
    largeSwaps: [],
  };
}

function dayIndexes(day: LoraDayAggregate): LoraDayIndexes {
  return {
    transactionHashes: new Set(day.transactionHashes),
    internalKeys: new Set(day.internalKeys),
    blockHeights: new Set(day.blockHeights),
    swapKeys: new Set(day.swapKeys),
    topLevelMovementFingerprints: new Set(day.topLevelMovementFingerprints),
    activeAddresses: new Set(day.activeAddresses),
  };
}

function persistDayIndexes(
  day: LoraDayAggregate,
  indexes: LoraDayIndexes,
): void {
  day.transactionHashes = [...indexes.transactionHashes];
  day.internalKeys = [...indexes.internalKeys];
  day.blockHeights = [...indexes.blockHeights];
  day.swapKeys = [...indexes.swapKeys];
  day.topLevelMovementFingerprints = [
    ...indexes.topLevelMovementFingerprints,
  ];
  day.activeAddresses = [...indexes.activeAddresses];
}

export function createEmptyLoraAggregateSnapshot(): LoraAggregateSnapshot {
  return {
    version: 2,
    state: structuredClone(EMPTY_LORA_COLLECTOR_STATE),
    price: structuredClone(EMPTY_LORA_PRICE),
    health: structuredClone(EMPTY_LORA_HEALTH),
    currentTotalAddresses: null,
    addressBaselines: [],
    days: {},
    burnKeys: [],
    cumulativeBurnWei: "0",
    cumulativeConfirmedCount: "0",
    latestSwap: null,
    recentBlocks: [],
    updatedAt: null,
  };
}

function asAggregateSnapshot(value: unknown): LoraAggregateSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LoraAggregateSnapshot>;
  if (
    candidate.version !== 2 ||
    !candidate.state ||
    !candidate.price ||
    !candidate.health ||
    !candidate.days ||
    !Array.isArray(candidate.burnKeys) ||
    !Array.isArray(candidate.addressBaselines) ||
    !Array.isArray(candidate.recentBlocks)
  ) {
    return null;
  }
  const snapshot = candidate as LoraAggregateSnapshot;
  const bounded = boundedAggregatePending(snapshot.state);
  snapshot.state.pendingInternalTransactions = bounded.pending;
  snapshot.state.internalQueueOverflow = bounded.overflow;
  if (bounded.overflow) {
    snapshot.state.internalDetailsComplete = false;
    snapshot.state.todayComplete = false;
  }
  return snapshot;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function asLegacyAggregateSnapshot(
  value: unknown,
): LegacyLoraAggregateSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<LegacyLoraAggregateSnapshot>;
  if (
    candidate.version !== 1 ||
    !candidate.state ||
    !candidate.price ||
    !candidate.health ||
    !candidate.days ||
    !Array.isArray(candidate.burnKeys) ||
    !Array.isArray(candidate.addressBaselines) ||
    !Array.isArray(candidate.recentBlocks)
  ) {
    return null;
  }
  return candidate as LegacyLoraAggregateSnapshot;
}

function pendingTransactionHash(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  const compactHash =
    typeof record.transactionHash === "string"
      ? record.transactionHash
      : null;
  const transaction = asRecord(record.transaction) ?? record;
  const hash =
    compactHash ??
    (typeof transaction.hash === "string" ? transaction.hash : null);
  return hash && /^0x[0-9a-f]{64}$/i.test(hash)
    ? hash.toLowerCase()
    : null;
}

function pendingQueuedAt(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.queuedAt === "string") return record.queuedAt;
  const transaction = asRecord(record.transaction) ?? record;
  return typeof transaction.timestamp === "string"
    ? transaction.timestamp
    : null;
}

function legacyPendingForCurrentDay(
  legacy: LegacyLoraAggregateSnapshot,
  now: Date,
): {
  pending: ReturnType<typeof normalizePendingInternalTransactions>;
  overflow: boolean;
} {
  const reportDate = shanghaiDateKey(now);
  if (legacy.state.bootstrapDate !== reportDate) {
    return { pending: [], overflow: false };
  }
  const currentDayHashes = new Set(
    (legacy.days[reportDate]?.transactionHashes ?? []).map((hash) =>
      hash.toLowerCase(),
    ),
  );
  const legacyUpdatedAt =
    legacy.updatedAt && timestampDate(legacy.updatedAt) === reportDate
      ? legacy.updatedAt
      : new Date(`${reportDate}T00:00:00+08:00`).toISOString();
  const rawPending = Array.isArray(legacy.state.pendingInternalTransactions)
    ? (legacy.state.pendingInternalTransactions as unknown[])
    : [];
  const pending: ReturnType<typeof normalizePendingInternalTransactions> = [];
  const seen = new Set<string>();
  let overflow = Boolean(legacy.state.internalQueueOverflow);

  for (const raw of rawPending) {
    const hash = pendingTransactionHash(raw);
    if (!hash || seen.has(hash)) continue;
    const rawQueuedAt = pendingQueuedAt(raw);
    const belongsToCurrentDay =
      (rawQueuedAt !== null && timestampDate(rawQueuedAt) === reportDate) ||
      currentDayHashes.has(hash);
    if (!belongsToCurrentDay) continue;
    if (pending.length >= MAX_PENDING_INTERNAL_TRANSACTIONS) {
      overflow = true;
      break;
    }
    const normalized = normalizePendingInternalTransactions([raw])[0];
    if (!normalized) continue;
    seen.add(hash);
    pending.push({
      ...normalized,
      queuedAt:
        timestampDate(normalized.queuedAt) === reportDate
          ? normalized.queuedAt
          : legacyUpdatedAt,
    });
  }
  return { pending, overflow };
}

export function migrateLegacyLoraAggregateSnapshot(
  value: unknown,
  now = new Date(),
): LoraAggregateSnapshot | null {
  const legacy = asLegacyAggregateSnapshot(value);
  if (!legacy) return null;
  const bounded = legacyPendingForCurrentDay(legacy, now);
  return asAggregateSnapshot({
    ...legacy,
    version: 2,
    state: {
      ...legacy.state,
      pendingInternalTransactions: bounded.pending,
      internalQueueOverflow: bounded.overflow,
      internalDetailsComplete: bounded.overflow
        ? false
        : legacy.state.internalDetailsComplete,
      todayComplete: bounded.overflow
        ? false
        : legacy.state.todayComplete,
    },
  });
}

function boundedAggregatePending(state: LoraCollectorState): {
  pending: ReturnType<typeof normalizePendingInternalTransactions>;
  overflow: boolean;
} {
  const normalized = normalizePendingInternalTransactions(
    state.pendingInternalTransactions,
  );
  const currentDay = state.bootstrapDate
    ? normalized.filter(
        (entry) => timestampDate(entry.queuedAt) === state.bootstrapDate,
      )
    : [];
  return {
    pending: currentDay.slice(0, MAX_PENDING_INTERNAL_TRANSACTIONS),
    overflow:
      Boolean(state.internalQueueOverflow) ||
      currentDay.length > MAX_PENDING_INTERNAL_TRANSACTIONS,
  };
}

export function serializeLoraAggregateSnapshot(
  snapshot: LoraAggregateSnapshot,
): string {
  const bounded = boundedAggregatePending(snapshot.state);
  const pending: PersistedPendingInternalTransaction[] = bounded.pending.map(
    (entry) => ({
      transactionHash: entry.transaction.hash,
      nextPageParams: entry.nextPageParams,
      queuedAt: entry.queuedAt,
    }),
  );
  return JSON.stringify({
    ...snapshot,
    state: {
      ...snapshot.state,
      pendingInternalTransactions: pending,
      internalQueueOverflow: bounded.overflow,
      internalDetailsComplete: bounded.overflow
        ? false
        : snapshot.state.internalDetailsComplete,
      todayComplete: bounded.overflow ? false : snapshot.state.todayComplete,
    },
  });
}

export async function loadLoraAggregateSnapshot(
  bucket: R2Bucket,
  now = new Date(),
): Promise<LoadedAggregate> {
  const object = await bucket.get(LORA_AGGREGATE_OBJECT_KEY);
  if (object) {
    try {
      const snapshot = asAggregateSnapshot(await object.json<unknown>());
      return {
        snapshot: snapshot ?? createEmptyLoraAggregateSnapshot(),
        etag: object.etag,
      };
    } catch {
      return {
        snapshot: createEmptyLoraAggregateSnapshot(),
        etag: object.etag,
      };
    }
  }

  const legacyObject = await bucket.get(LORA_LEGACY_AGGREGATE_OBJECT_KEY);
  if (!legacyObject) {
    return { snapshot: createEmptyLoraAggregateSnapshot(), etag: null };
  }
  let migrated: LoraAggregateSnapshot | null = null;
  try {
    migrated = migrateLegacyLoraAggregateSnapshot(
      await legacyObject.json<unknown>(),
      now,
    );
  } catch {
    // Invalid legacy data is treated like a clean bootstrap.
  }
  if (!migrated) {
    return { snapshot: createEmptyLoraAggregateSnapshot(), etag: null };
  }
  const result = await bucket.put(
    LORA_AGGREGATE_OBJECT_KEY,
    serializeLoraAggregateSnapshot(migrated),
    {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, no-store",
      },
    },
  );
  if (result) return { snapshot: migrated, etag: result.etag };

  const concurrentObject = await bucket.get(LORA_AGGREGATE_OBJECT_KEY);
  if (concurrentObject) {
    try {
      const concurrentSnapshot = asAggregateSnapshot(
        await concurrentObject.json<unknown>(),
      );
      if (concurrentSnapshot) {
        return { snapshot: concurrentSnapshot, etag: concurrentObject.etag };
      }
    } catch {
      // The regular conditional update below will repair an invalid v2 object.
    }
  }
  return {
    snapshot: migrated,
    etag: concurrentObject?.etag ?? null,
  };
}

function addDecimal(left: string, right: string): string {
  return (parseUnsignedInteger(left) + parseUnsignedInteger(right)).toString();
}

function increment(value: string): string {
  return (parseUnsignedInteger(value) + 1n).toString();
}

function timestampDate(timestamp: string): string | null {
  const value = new Date(timestamp);
  return Number.isFinite(value.getTime()) ? shanghaiDateKey(value) : null;
}

function movementFingerprint(values: {
  transactionHash: string;
  from: string;
  to: string | null;
  valueWei: string;
}): string {
  return [
    values.transactionHash.toLowerCase(),
    normalizeAddress(values.from) ?? values.from.toLowerCase(),
    normalizeAddress(values.to) ?? "",
    parseUnsignedInteger(values.valueWei).toString(),
  ].join(":");
}

function topLevelLargeRow(
  transaction: LoraIndexedTransaction,
): LoraLargeTransferRow {
  return {
    time: transaction.timestamp,
    from: transaction.from,
    to: transaction.to ?? "",
    amountLrb: formatUnits(transaction.valueWei),
    type:
      transaction.input && transaction.input !== "0x"
        ? "合约调用"
        : "普通转账",
    status: transaction.success ? "成功" : "失败",
    hash: transaction.hash,
  };
}

function internalLargeRow(
  transaction: LoraIndexedInternalTransaction,
): LoraLargeTransferRow {
  return {
    time: transaction.timestamp,
    from: transaction.from,
    to: transaction.to ?? "",
    amountLrb: formatUnits(transaction.valueWei),
    type: isConfirmedNodeBurn(transaction) ? "节点销毁" : "内部转账",
    status: transaction.success ? "成功" : "失败",
    hash: transaction.transactionHash,
  };
}

function recordLargeTransfer(
  day: LoraDayAggregate,
  row: LoraLargeTransferRow,
  valueWei: string,
): void {
  const value = parseUnsignedInteger(valueWei);
  day.largeTransferCount = increment(day.largeTransferCount);
  day.largeTransferTotalWei = addDecimal(day.largeTransferTotalWei, valueWei);
  if (value > parseUnsignedInteger(day.largeTransferMaxWei)) {
    day.largeTransferMaxWei = value.toString();
  }
  day.recentLargeTransfers = [
    ...day.recentLargeTransfers,
    { row, wei: value.toString() },
  ]
    .sort((left, right) => right.row.time.localeCompare(left.row.time))
    .slice(0, 30);
}

function recordTransaction(
  snapshot: LoraAggregateSnapshot,
  transaction: LoraIndexedTransaction,
  retainedDates: Set<string>,
  indexesByDate: Map<string, LoraDayIndexes>,
): void {
  const date = timestampDate(transaction.timestamp);
  if (!date || !retainedDates.has(date)) return;
  const day = (snapshot.days[date] ??= emptyDay());
  const indexes = indexesByDate.get(date) ?? dayIndexes(day);
  indexesByDate.set(date, indexes);
  const hash = transaction.hash.toLowerCase();
  if (indexes.transactionHashes.has(hash)) return;
  indexes.transactionHashes.add(hash);
  day.transactionTotal = increment(day.transactionTotal);
  if (transaction.success) day.transactionSuccess = increment(day.transactionSuccess);
  else day.transactionFailed = increment(day.transactionFailed);
  day.hourlyTransactions[shanghaiHour(new Date(transaction.timestamp))] = increment(
    day.hourlyTransactions[shanghaiHour(new Date(transaction.timestamp))],
  );
  const from = normalizeAddress(transaction.from);
  const to = normalizeAddress(transaction.to);
  if (from) indexes.activeAddresses.add(from);
  if (to) indexes.activeAddresses.add(to);
  day.gasPriceTotalWei = addDecimal(day.gasPriceTotalWei, transaction.gasPriceWei);
  day.gasPriceCount = increment(day.gasPriceCount);

  const value = parseUnsignedInteger(transaction.valueWei);
  if (transaction.success && value > 0n) {
    day.nativeTransfers = increment(day.nativeTransfers);
    indexes.topLevelMovementFingerprints.add(
      movementFingerprint({
        transactionHash: transaction.hash,
        from: transaction.from,
        to: transaction.to,
        valueWei: transaction.valueWei,
      }),
    );
  }
  if (transaction.success && isLargeNativeAmount(transaction.valueWei)) {
    recordLargeTransfer(
      day,
      topLevelLargeRow(transaction),
      transaction.valueWei,
    );
  }
}

function recordInternalTransaction(
  snapshot: LoraAggregateSnapshot,
  transaction: LoraIndexedInternalTransaction,
  retainedDates: Set<string>,
  indexesByDate: Map<string, LoraDayIndexes>,
  burnKeys: Set<string>,
): void {
  const key = internalTransactionKey(transaction);
  const isBurn =
    isValueMovingInternalTransaction(transaction) &&
    transaction.success &&
    normalizeAddress(transaction.to) === LORA_BURN_ADDRESS;
  if (isBurn) {
    if (!burnKeys.has(key)) {
      burnKeys.add(key);
      snapshot.cumulativeBurnWei = addDecimal(
        snapshot.cumulativeBurnWei,
        transaction.valueWei,
      );
      if (isConfirmedNodeBurn(transaction)) {
        snapshot.cumulativeConfirmedCount = increment(
          snapshot.cumulativeConfirmedCount,
        );
      }
    }
  }

  const date = timestampDate(transaction.timestamp);
  if (!date || !retainedDates.has(date)) return;
  const day = (snapshot.days[date] ??= emptyDay());
  const indexes = indexesByDate.get(date) ?? dayIndexes(day);
  indexesByDate.set(date, indexes);
  if (indexes.internalKeys.has(key)) return;
  indexes.internalKeys.add(key);

  if (isConfirmedNodeBurn(transaction)) {
    day.nodeCount = increment(day.nodeCount);
    day.nodeBurnWei = addDecimal(day.nodeBurnWei, transaction.valueWei);
    const hour = shanghaiHour(new Date(transaction.timestamp));
    day.hourlyNodes[hour] = increment(day.hourlyNodes[hour]);
  } else if (isOtherBurn(transaction)) {
    day.otherBurnWei = addDecimal(day.otherBurnWei, transaction.valueWei);
  }

  if (!transaction.success || !isValueMovingInternalTransaction(transaction)) {
    return;
  }
  const fingerprint = movementFingerprint({
    transactionHash: transaction.transactionHash,
    from: transaction.from,
    to: transaction.to,
    valueWei: transaction.valueWei,
  });
  if (indexes.topLevelMovementFingerprints.has(fingerprint)) return;
  if (parseUnsignedInteger(transaction.valueWei) > 0n) {
    day.nativeTransfers = increment(day.nativeTransfers);
  }
  if (isLargeNativeAmount(transaction.valueWei)) {
    recordLargeTransfer(
      day,
      internalLargeRow(transaction),
      transaction.valueWei,
    );
  }
}

function recordBlock(
  snapshot: LoraAggregateSnapshot,
  block: LoraIndexedBlock,
  retainedDates: Set<string>,
  indexesByDate: Map<string, LoraDayIndexes>,
  recentBlocks: Map<number, LoraIndexedBlock>,
): void {
  const date = timestampDate(block.timestamp);
  if (date && retainedDates.has(date)) {
    const day = (snapshot.days[date] ??= emptyDay());
    const indexes = indexesByDate.get(date) ?? dayIndexes(day);
    indexesByDate.set(date, indexes);
    if (!indexes.blockHeights.has(block.height)) {
      indexes.blockHeights.add(block.height);
      day.gasUsed = addDecimal(day.gasUsed, block.gasUsed);
    }
  }
  recentBlocks.set(block.height, block);
}

function recordSwap(
  snapshot: LoraAggregateSnapshot,
  swap: LoraIndexedSwap,
  retainedDates: Set<string>,
  indexesByDate: Map<string, LoraDayIndexes>,
): void {
  if (!snapshot.latestSwap || swap.timestamp > snapshot.latestSwap.timestamp) {
    snapshot.latestSwap = swap;
  }
  const date = timestampDate(swap.timestamp);
  if (!date || !retainedDates.has(date)) return;
  const day = (snapshot.days[date] ??= emptyDay());
  const indexes = indexesByDate.get(date) ?? dayIndexes(day);
  indexesByDate.set(date, indexes);
  const key = `${swap.transactionHash.toLowerCase()}:${swap.logIndex}`;
  if (indexes.swapKeys.has(key)) return;
  indexes.swapKeys.add(key);
  if (isLargeNativeAmount(swap.lrbWei)) {
    day.largeSwaps = [...day.largeSwaps, swap]
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp))
      .slice(0, 50);
  }
}

function applyBatchState(
  snapshot: LoraAggregateSnapshot,
  batch: LoraCollectionBatch,
  now: Date,
): void {
  const previous = snapshot.state;
  const reportDate = shanghaiDateKey(now);
  const internalQueueOverflow =
    batch.internalQueueOverflow ??
    (previous.bootstrapDate === reportDate
      ? previous.internalQueueOverflow ?? false
      : false);
  const rpcReachable = batch.rpcHealthy || batch.price.status === "config-error";
  const sourceCycleSuccessful = rpcReachable && batch.explorerHealthy;
  snapshot.state = {
    ...previous,
    checkpointBlock: batch.checkpointBlock,
    checkpointHash: batch.checkpointHash,
    blockCursor: batch.nextBlockCursor,
    transactionCursor: batch.nextTransactionCursor,
    burnCursor: batch.nextBurnCursor,
    burnHistoryCursor: batch.nextBurnHistoryCursor,
    headTransactionHash: batch.headTransactionHash ?? previous.headTransactionHash ?? null,
    headBurnKey: batch.headBurnKey ?? previous.headBurnKey ?? null,
    blockHeadCursor:
      batch.blockHeadCursor === undefined
        ? previous.blockHeadCursor ?? null
        : batch.blockHeadCursor,
    blockHeadCandidateKey:
      batch.blockHeadCandidateKey === undefined
        ? previous.blockHeadCandidateKey ?? null
        : batch.blockHeadCandidateKey,
    transactionHeadCursor:
      batch.transactionHeadCursor === undefined
        ? previous.transactionHeadCursor ?? null
        : batch.transactionHeadCursor,
    transactionHeadCandidateHash:
      batch.transactionHeadCandidateHash === undefined
        ? previous.transactionHeadCandidateHash ?? null
        : batch.transactionHeadCandidateHash,
    burnHeadCursor:
      batch.burnHeadCursor === undefined
        ? previous.burnHeadCursor ?? null
        : batch.burnHeadCursor,
    burnHeadCandidateKey:
      batch.burnHeadCandidateKey === undefined
        ? previous.burnHeadCandidateKey ?? null
        : batch.burnHeadCandidateKey,
    swapCheckpointBlock:
      batch.swapCheckpointBlock === undefined
        ? previous.swapCheckpointBlock ?? null
        : batch.swapCheckpointBlock,
    pendingInternalTransactions:
      batch.pendingInternalTransactions ?? previous.pendingInternalTransactions ?? [],
    internalQueueOverflow,
    internalDetailsComplete:
      internalQueueOverflow
        ? false
        : batch.internalDetailsComplete ?? previous.internalDetailsComplete ?? false,
    swapTodayComplete:
      batch.swapTodayComplete ?? previous.swapTodayComplete ?? false,
    bootstrapDate: reportDate,
    transactionTodayComplete: batch.transactionTodayComplete,
    transactionYesterdayComplete: batch.transactionYesterdayComplete,
    burnTodayComplete: batch.burnTodayComplete,
    blockTodayComplete: batch.blockTodayComplete,
    todayComplete: internalQueueOverflow ? false : batch.todayComplete,
    yesterdayComplete: batch.yesterdayComplete,
    historyComplete: batch.historyComplete,
    nextRunAt: new Date(now.getTime() + 60_000).toISOString(),
    lastAttemptAt: now.toISOString(),
    lastSuccessfulSyncAt: sourceCycleSuccessful
      ? now.toISOString()
      : previous.lastSuccessfulSyncAt,
    consecutiveFailures: sourceCycleSuccessful
      ? 0
      : previous.consecutiveFailures + 1,
  };

  if (
    batch.price.status === "ready" ||
    batch.price.status === "config-error" ||
    !snapshot.price.updatedAt
  ) {
    snapshot.price = batch.price;
  } else {
    snapshot.price = { ...snapshot.price, status: "stale" };
  }
  snapshot.health = {
    rpc: batch.rpcHealthy
      ? "ready"
      : batch.price.status === "config-error"
        ? "config-error"
        : "unavailable",
    explorer: batch.explorerHealthy ? "ready" : "unavailable",
    collector: sourceCycleSuccessful ? "ready" : "unavailable",
    lastRpcSuccessAt: rpcReachable
      ? now.toISOString()
      : snapshot.health.lastRpcSuccessAt,
    lastExplorerSuccessAt: batch.explorerHealthy
      ? now.toISOString()
      : snapshot.health.lastExplorerSuccessAt,
    lastSuccessfulSyncAt: sourceCycleSuccessful
      ? now.toISOString()
      : snapshot.health.lastSuccessfulSyncAt,
    lastError: sourceCycleSuccessful
      ? null
      : !rpcReachable && !batch.explorerHealthy
        ? "RPC_AND_EXPLORER_UNAVAILABLE"
        : !rpcReachable
          ? "RPC_UNAVAILABLE"
          : "EXPLORER_UNAVAILABLE",
  };
  snapshot.updatedAt = now.toISOString();
}

export function applyLoraAggregateBatch(
  snapshot: LoraAggregateSnapshot,
  batch: LoraCollectionBatch,
  now = new Date(batch.collectedAt),
): LoraAggregateSnapshot {
  const reportDate = shanghaiDateKey(now);
  const retainedDates = new Set([reportDate, addCalendarDays(reportDate, -1)]);
  for (const date of Object.keys(snapshot.days)) {
    if (!retainedDates.has(date)) delete snapshot.days[date];
  }
  snapshot.days[reportDate] ??= emptyDay();
  snapshot.days[addCalendarDays(reportDate, -1)] ??= emptyDay();
  const indexesByDate = new Map(
    [...retainedDates].map((date) => [
      date,
      dayIndexes(snapshot.days[date] ??= emptyDay()),
    ]),
  );
  const burnKeys = new Set(snapshot.burnKeys);
  const recentBlocks = new Map(
    snapshot.recentBlocks.map((item) => [item.height, item]),
  );
  for (const block of batch.blocks) {
    recordBlock(
      snapshot,
      block,
      retainedDates,
      indexesByDate,
      recentBlocks,
    );
  }
  for (const transaction of batch.transactions) {
    recordTransaction(snapshot, transaction, retainedDates, indexesByDate);
  }
  for (const transaction of batch.internalTransactions) {
    recordInternalTransaction(
      snapshot,
      transaction,
      retainedDates,
      indexesByDate,
      burnKeys,
    );
  }
  for (const swap of batch.swaps) {
    recordSwap(snapshot, swap, retainedDates, indexesByDate);
  }
  for (const [date, indexes] of indexesByDate) {
    persistDayIndexes(snapshot.days[date], indexes);
  }
  snapshot.burnKeys = [...burnKeys];
  snapshot.recentBlocks = [...recentBlocks.values()]
    .sort((left, right) => right.height - left.height)
    .slice(0, 180);
  const previousTotalAddresses = snapshot.currentTotalAddresses;
  const previousSnapshotDate = snapshot.state.bootstrapDate;
  const previousUpdatedAt = snapshot.updatedAt;
  const baselineIndex = snapshot.addressBaselines.findIndex(
    (baseline) => baseline.reportDate === reportDate,
  );
  const exactBaseline =
    batch.addressBaseline?.reportDate === reportDate
      ? {
          ...batch.addressBaseline,
          estimated: false,
          source: batch.addressBaseline.source ?? "midnight-window",
        }
      : null;
  if (exactBaseline) {
    if (baselineIndex < 0) {
      snapshot.addressBaselines.push(exactBaseline);
    } else if (snapshot.addressBaselines[baselineIndex].estimated) {
      snapshot.addressBaselines[baselineIndex] = exactBaseline;
    }
  } else if (baselineIndex < 0) {
    if (previousTotalAddresses !== null) {
      snapshot.addressBaselines.push({
        reportDate,
        totalAddresses: previousTotalAddresses,
        capturedAt: previousUpdatedAt ?? now.toISOString(),
        blockNumber: null,
        estimated: true,
        source:
          previousSnapshotDate === reportDate
            ? "recovered-observation"
            : "carry-forward",
      });
    } else if (batch.currentTotalAddresses !== null) {
      snapshot.addressBaselines.push({
        reportDate,
        totalAddresses: batch.currentTotalAddresses,
        capturedAt: now.toISOString(),
        blockNumber: batch.checkpointBlock,
        estimated: true,
        source: "first-observation",
      });
    }
  }
  if (batch.currentTotalAddresses !== null) {
    snapshot.currentTotalAddresses = batch.currentTotalAddresses;
  }
  snapshot.addressBaselines = snapshot.addressBaselines
    .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
    .slice(0, 8);
  applyBatchState(snapshot, batch, now);
  return snapshot;
}

function partialValue(
  complete: boolean,
  hasData: boolean,
  value: string,
): string | null {
  return complete ? value : hasData ? `${value}+` : null;
}

function hourly(counts: string[], available: boolean) {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour: String(hour).padStart(2, "0"),
    count: available ? counts[hour] ?? "0" : null,
  }));
}

function averageBlockTime(blocks: LoraIndexedBlock[]): string | null {
  const sorted = [...blocks]
    .sort((left, right) => left.height - right.height)
    .map((block) => Date.parse(block.timestamp))
    .filter(Number.isFinite);
  if (sorted.length < 2) return null;
  let total = 0n;
  let count = 0n;
  for (let index = 1; index < sorted.length; index += 1) {
    const difference = sorted[index] - sorted[index - 1];
    if (difference <= 0) continue;
    total += BigInt(difference);
    count += 1n;
  }
  if (count === 0n) return null;
  const hundredths = (total * 100n) / (count * 1_000n);
  const whole = hundredths / 100n;
  const fraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} 秒`;
}

function staleStatus(status: LoraDataStatus, stale: boolean): LoraDataStatus {
  return stale && status === "ready" ? "stale" : status;
}

export function buildLoraAggregateDashboard(
  snapshot: LoraAggregateSnapshot,
  now = new Date(),
): LoraDashboardData {
  const reportDate = shanghaiDateKey(now);
  const day = snapshot.days[reportDate] ?? emptyDay();
  const yesterday = snapshot.days[addCalendarDays(reportDate, -1)] ?? emptyDay();
  const stateMatches = snapshot.state.bootstrapDate === reportDate;
  const transactionComplete = stateMatches && snapshot.state.transactionTodayComplete;
  const burnComplete = stateMatches && snapshot.state.burnTodayComplete;
  const blockComplete = stateMatches && snapshot.state.blockTodayComplete;
  const internalComplete = stateMatches && Boolean(snapshot.state.internalDetailsComplete);
  const largeComplete = transactionComplete && internalComplete;
  const swapComplete = stateMatches && Boolean(snapshot.state.swapTodayComplete);
  const lastSuccessfulSyncAt =
    snapshot.health.lastSuccessfulSyncAt ?? snapshot.state.lastSuccessfulSyncAt;
  const stale =
    !lastSuccessfulSyncAt ||
    now.getTime() - Date.parse(lastSuccessfulSyncAt) > LORA_CACHE_STALE_AFTER_MS;
  const priceStale =
    !snapshot.price.updatedAt ||
    now.getTime() - Date.parse(snapshot.price.updatedAt) > LORA_CACHE_STALE_AFTER_MS;
  const priceStatus = staleStatus(snapshot.price.status, priceStale);
  const pairEnabled = priceStatus === "ready" || priceStatus === "stale";
  const txTotal = parseUnsignedInteger(day.transactionTotal);
  const success = parseUnsignedInteger(day.transactionSuccess);
  const successRate = ratioPercent(success, txTotal, 2);
  const gasPriceCount = parseUnsignedInteger(day.gasPriceCount);
  const averageGasPriceWei =
    gasPriceCount === 0n
      ? null
      : parseUnsignedInteger(day.gasPriceTotalWei) / gasPriceCount;
  const baseline = snapshot.addressBaselines.find(
    (item) => item.reportDate === reportDate,
  );
  let addressStatus: LoraDataStatus = "missing";
  let addressToday: string | null = null;
  if (baseline && snapshot.currentTotalAddresses !== null) {
    const difference =
      parseUnsignedInteger(snapshot.currentTotalAddresses) -
      parseUnsignedInteger(baseline.totalAddresses);
    if (difference >= 0n) {
      addressStatus = baseline.estimated ? "building" : "ready";
      addressToday = `${baseline.estimated ? "≈" : ""}${difference.toString()}`;
    } else {
      addressStatus = "unavailable";
    }
  }
  const latestBlock = snapshot.recentBlocks[0];
  const largeTop5 = [...day.recentLargeTransfers]
    .sort((left, right) => {
      const leftWei = parseUnsignedInteger(left.wei);
      const rightWei = parseUnsignedInteger(right.wei);
      return leftWei === rightWei ? 0 : leftWei > rightWei ? -1 : 1;
    })
    .slice(0, 5)
    .map((item) => item.row);
  const hasTransactions = parseUnsignedInteger(day.transactionTotal) > 0n;
  const hasBlocks = day.blockHeights.length > 0;
  const hasBurns =
    parseUnsignedInteger(day.nodeCount) > 0n ||
    parseUnsignedInteger(day.otherBurnWei) > 0n;
  const hasLarge = parseUnsignedInteger(day.largeTransferCount) > 0n;
  const hasHistory = snapshot.burnKeys.length > 0;
  const latestSwap = pairEnabled ? snapshot.latestSwap : null;

  return {
    reportDate,
    timezone: "Asia/Shanghai",
    generatedAt: now.toISOString(),
    dataUpdatedAt: lastSuccessfulSyncAt,
    lastSuccessfulSyncAt,
    stale,
    baselineStatus:
      stateMatches && snapshot.state.todayComplete
        ? stale
          ? "stale"
          : "ready"
        : "building",
    nodes: {
      todayCount: partialValue(burnComplete, hasBurns, day.nodeCount),
      todayNodeBurnLrb: partialValue(
        burnComplete,
        hasBurns,
        formatUnits(day.nodeBurnWei),
      ),
      todayOtherBurnLrb: partialValue(
        burnComplete,
        hasBurns,
        formatUnits(day.otherBurnWei),
      ),
      cumulativeBurnLrb: snapshot.state.historyComplete
        ? formatUnits(snapshot.cumulativeBurnWei)
        : hasHistory
          ? `${formatUnits(snapshot.cumulativeBurnWei)}+`
          : null,
      cumulativeConfirmedCount: snapshot.state.historyComplete
        ? snapshot.cumulativeConfirmedCount
        : hasHistory
          ? `${snapshot.cumulativeConfirmedCount}+`
          : null,
      hourly: hourly(day.hourlyNodes, burnComplete || hasBurns),
    },
    addresses: {
      label: "今日新增链上地址",
      todayNew: addressToday,
      baselineStatus: addressStatus,
    },
    transactions: {
      todayTotal: partialValue(transactionComplete, hasTransactions, day.transactionTotal),
      success: partialValue(transactionComplete, hasTransactions, day.transactionSuccess),
      failed: partialValue(transactionComplete, hasTransactions, day.transactionFailed),
      successRate,
      successRateLabel: successRate
        ? `${transactionComplete ? "" : "≈"}${successRate}%`
        : null,
      nativeTransfers: partialValue(largeComplete, hasTransactions, day.nativeTransfers),
      activeAddresses: partialValue(
        transactionComplete,
        hasTransactions,
        String(day.activeAddresses.length),
      ),
      yesterdayTotal:
        stateMatches && snapshot.state.yesterdayComplete
          ? yesterday.transactionTotal
          : parseUnsignedInteger(yesterday.transactionTotal) > 0n
            ? `${yesterday.transactionTotal}+`
            : null,
      hourly: hourly(day.hourlyTransactions, transactionComplete || hasTransactions),
    },
    largeTransfers: {
      count: partialValue(largeComplete, hasLarge || hasTransactions, day.largeTransferCount),
      totalLrb: partialValue(
        largeComplete,
        hasLarge || hasTransactions,
        formatUnits(day.largeTransferTotalWei),
      ),
      maxLrb: partialValue(
        largeComplete,
        hasLarge || hasTransactions,
        formatUnits(day.largeTransferMaxWei),
      ),
      rows: day.recentLargeTransfers.map((item) => item.row),
      top5: largeTop5,
    },
    swaps: {
      enabled: pairEnabled,
      status:
        snapshot.price.status === "config-error"
          ? "config-error"
          : !pairEnabled
            ? "unavailable"
            : swapComplete
              ? priceStatus
              : "building",
      rows: pairEnabled
        ? day.largeSwaps.map((swap) => ({
            time: swap.timestamp,
            side: swap.side,
            lrbAmount: formatUnits(swap.lrbWei),
            usdtAmount: formatUnits(swap.usdtUnits),
            price: swap.priceUsdt,
            initiator: swap.initiator,
            currentNativeBalanceLrb:
              swap.currentNativeBalanceWei === null
                ? null
                : formatUnits(swap.currentNativeBalanceWei),
            hash: swap.transactionHash,
          }))
        : [],
      latestPrice: latestSwap?.priceUsdt ?? null,
      latestAt: latestSwap?.timestamp ?? null,
    },
    price: {
      status: priceStatus,
      priceUsdt: snapshot.price.priceUsdt,
      source: snapshot.price.source,
      pair: LORA_PAIR_ADDRESS,
      blockNumber:
        snapshot.price.blockNumber === null
          ? null
          : String(snapshot.price.blockNumber),
      updatedAt: snapshot.price.updatedAt,
      latestSwapPrice: latestSwap?.priceUsdt ?? null,
      latestSwapAt: latestSwap?.timestamp ?? null,
    },
    chain: {
      blockHeight: latestBlock ? String(latestBlock.height) : null,
      lastBlockAt: latestBlock?.timestamp ?? null,
      averageBlockTime: averageBlockTime(snapshot.recentBlocks),
      gasUsed: partialValue(blockComplete, hasBlocks, day.gasUsed),
      averageGasPrice:
        averageGasPriceWei === null
          ? null
          : `${transactionComplete ? "" : "≈"}${formatUnits(
              averageGasPriceWei,
              9,
              4,
            )} Gwei`,
    },
    health: {
      rpc: staleStatus(snapshot.health.rpc, stale),
      explorer: staleStatus(snapshot.health.explorer, stale),
      collector: staleStatus(snapshot.health.collector, stale),
      lastSuccessfulSyncAt,
    },
  };
}

export async function readLoraAggregateDashboard(
  bucket: R2Bucket,
  now = new Date(),
): Promise<LoraDashboardData | null> {
  const object = await bucket.get(LORA_AGGREGATE_OBJECT_KEY);
  if (!object) return null;
  try {
    const snapshot = asAggregateSnapshot(await object.json<unknown>());
    return snapshot ? buildLoraAggregateDashboard(snapshot, now) : null;
  } catch {
    return null;
  }
}

export async function collectLoraAggregateSnapshot(options: {
  bucket: R2Bucket;
  source: ExplorerLoraChainDataSource;
  now?: Date;
}): Promise<LoraDashboardData> {
  const now = options.now ?? new Date();
  const loaded = await loadLoraAggregateSnapshot(options.bucket, now);
  const batch = await options.source.collect({ state: loaded.snapshot.state, now });
  const snapshot = applyLoraAggregateBatch(loaded.snapshot, batch, now);
  const result = await options.bucket.put(
    LORA_AGGREGATE_OBJECT_KEY,
    serializeLoraAggregateSnapshot(snapshot),
    {
      onlyIf: loaded.etag
        ? { etagMatches: loaded.etag }
        : { etagDoesNotMatch: "*" },
      httpMetadata: {
        contentType: "application/json",
        cacheControl: "private, no-store",
      },
    },
  );
  if (!result) {
    return (
      (await readLoraAggregateDashboard(options.bucket, now)) ??
      buildLoraAggregateDashboard(snapshot, now)
    );
  }
  return buildLoraAggregateDashboard(snapshot, now);
}
