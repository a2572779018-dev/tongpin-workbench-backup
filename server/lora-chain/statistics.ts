import {
  LARGE_TRANSFER_THRESHOLD_WEI,
  LORA_BURN_ADDRESS,
  LORA_BUSINESS_TIME_ZONE,
  LORA_CACHE_STALE_AFTER_MS,
  LORA_PAIR_ADDRESS,
  NODE_BURN_WEI,
} from "./constants";
import {
  divideToDecimal,
  formatUnits,
  normalizeAddress,
  parseUnsignedInteger,
  ratioPercent,
} from "./math";
import {
  addCalendarDays,
  shanghaiDateKey,
  shanghaiDayBounds,
  shanghaiDayStart,
  timestampInRange,
} from "./time";
import type {
  LoraDashboardData,
  LoraDashboardInput,
  LoraHourlyPoint,
  LoraIndexedInternalTransaction,
  LoraIndexedTransaction,
  LoraLargeTransferRow,
} from "./types";

export function dedupeTransactions(
  transactions: LoraIndexedTransaction[],
): LoraIndexedTransaction[] {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    const key = transaction.hash.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function internalTransactionKey(
  transaction: Pick<LoraIndexedInternalTransaction, "transactionHash" | "index">,
): string {
  return `${transaction.transactionHash.toLowerCase()}:${transaction.index}`;
}

export function dedupeInternalTransactions(
  transactions: LoraIndexedInternalTransaction[],
): LoraIndexedInternalTransaction[] {
  const seen = new Set<string>();
  return transactions.filter((transaction) => {
    const key = internalTransactionKey(transaction);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isConfirmedNodeBurn(
  transaction: LoraIndexedInternalTransaction,
): boolean {
  return (
    isValueMovingInternalTransaction(transaction) &&
    transaction.success &&
    normalizeAddress(transaction.to) === LORA_BURN_ADDRESS &&
    parseUnsignedInteger(transaction.valueWei) === NODE_BURN_WEI
  );
}

export function isOtherBurn(
  transaction: LoraIndexedInternalTransaction,
): boolean {
  return (
    isValueMovingInternalTransaction(transaction) &&
    transaction.success &&
    normalizeAddress(transaction.to) === LORA_BURN_ADDRESS &&
    parseUnsignedInteger(transaction.valueWei) !== NODE_BURN_WEI
  );
}

export function isValueMovingInternalTransaction(
  transaction: Pick<LoraIndexedInternalTransaction, "callType">,
): boolean {
  return ["CALL", "CREATE", "CREATE2", "SELFDESTRUCT"].includes(
    transaction.callType.toUpperCase(),
  );
}

export function isLargeNativeAmount(valueWei: string): boolean {
  return parseUnsignedInteger(valueWei) > LARGE_TRANSFER_THRESHOLD_WEI;
}

function hourKey(timestamp: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: LORA_BUSINESS_TIME_ZONE,
      hour: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(timestamp))
      .map((part) => [part.type, part.value]),
  );
  return parts.hour;
}

function hourlyPoints(
  timestamps: string[],
  available: boolean,
): LoraHourlyPoint[] {
  const counts = new Map<string, bigint>();
  for (const timestamp of timestamps) {
    const hour = hourKey(timestamp);
    counts.set(hour, (counts.get(hour) ?? 0n) + 1n);
  }
  return Array.from({ length: 24 }, (_, hour) => {
    const key = String(hour).padStart(2, "0");
    return {
      hour: key,
      count: available ? (counts.get(key) ?? 0n).toString() : null,
    };
  });
}

function inToday(timestamp: string, input: LoraDashboardInput): boolean {
  const { todayStart } = shanghaiDayBounds(input.now);
  return timestampInRange(timestamp, todayStart, input.now);
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

function nativeMovementFingerprint(values: {
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

function averageBlockTimeSeconds(
  timestamps: string[],
): string | null {
  const sorted = timestamps
    .map(Date.parse)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (sorted.length < 2) return null;
  let totalMilliseconds = 0n;
  let intervals = 0n;
  for (let index = 1; index < sorted.length; index += 1) {
    const difference = sorted[index] - sorted[index - 1];
    if (difference <= 0) continue;
    totalMilliseconds += BigInt(difference);
    intervals += 1n;
  }
  return intervals === 0n
    ? null
    : divideToDecimal(totalMilliseconds, intervals * 1_000n, 2);
}

export function buildLoraDashboard(
  input: LoraDashboardInput,
): LoraDashboardData {
  const { reportDate, todayStart, yesterdayStart, yesterdayEnd } =
    shanghaiDayBounds(input.now);
  const stateMatchesReportDate = input.state.bootstrapDate === reportDate;
  const transactions = dedupeTransactions(input.transactions);
  const internalTransactions = dedupeInternalTransactions(
    input.internalTransactions,
  );
  const todayTransactions = transactions.filter((transaction) =>
    timestampInRange(transaction.timestamp, todayStart, input.now),
  );
  const yesterdayTransactions = transactions.filter((transaction) =>
    timestampInRange(
      transaction.timestamp,
      yesterdayStart,
      yesterdayEnd,
    ),
  );
  const todayInternal = internalTransactions.filter((transaction) =>
    timestampInRange(transaction.timestamp, todayStart, input.now),
  );
  const topLevelMovementFingerprints = new Set(
    todayTransactions
      .filter(
        (transaction) =>
          transaction.success &&
          parseUnsignedInteger(transaction.valueWei) > 0n,
      )
      .map((transaction) =>
        nativeMovementFingerprint({
          transactionHash: transaction.hash,
          from: transaction.from,
          to: transaction.to,
          valueWei: transaction.valueWei,
        }),
      ),
  );
  const todayInternalWithoutTopLevelDuplicates = todayInternal.filter(
    (transaction) =>
      !topLevelMovementFingerprints.has(
        nativeMovementFingerprint({
          transactionHash: transaction.transactionHash,
          from: transaction.from,
          to: transaction.to,
          valueWei: transaction.valueWei,
        }),
      ),
  );
  const todayComplete = stateMatchesReportDate && input.state.todayComplete;
  const historyComplete = input.state.historyComplete;

  const todayNodeBurns = todayInternal.filter(isConfirmedNodeBurn);
  const todayOtherBurns = todayInternal.filter(isOtherBurn);
  const allNodeBurns = internalTransactions.filter(isConfirmedNodeBurn);
  const allBurns = internalTransactions.filter(
    (transaction) =>
      isValueMovingInternalTransaction(transaction) &&
      transaction.success &&
      normalizeAddress(transaction.to) === LORA_BURN_ADDRESS,
  );

  const successCount = BigInt(
    todayTransactions.filter((transaction) => transaction.success).length,
  );
  const transactionCount = BigInt(todayTransactions.length);
  const failedCount = transactionCount - successCount;
  const successRate = todayComplete
    ? ratioPercent(successCount, transactionCount, 2)
    : null;

  const activeAddresses = new Set<string>();
  for (const transaction of todayTransactions) {
    const from = normalizeAddress(transaction.from);
    const to = normalizeAddress(transaction.to);
    if (from) activeAddresses.add(from);
    if (to) activeAddresses.add(to);
  }

  const largeTopLevel = todayTransactions.filter(
    (transaction) => transaction.success && isLargeNativeAmount(transaction.valueWei),
  );
  const largeInternal = todayInternalWithoutTopLevelDuplicates.filter(
    (transaction) =>
      isValueMovingInternalTransaction(transaction) &&
      transaction.success &&
      isLargeNativeAmount(transaction.valueWei),
  );
  const largeValues = [
    ...largeTopLevel.map((transaction) => parseUnsignedInteger(transaction.valueWei)),
    ...largeInternal.map((transaction) => parseUnsignedInteger(transaction.valueWei)),
  ];
  const largeRows = [
    ...largeTopLevel.map(topLevelLargeRow),
    ...largeInternal.map(internalLargeRow),
  ].sort((left, right) => right.time.localeCompare(left.time));
  const rankedLargeRows = [
    ...largeTopLevel.map((transaction) => ({
      row: topLevelLargeRow(transaction),
      wei: parseUnsignedInteger(transaction.valueWei),
    })),
    ...largeInternal.map((transaction) => ({
      row: internalLargeRow(transaction),
      wei: parseUnsignedInteger(transaction.valueWei),
    })),
  ]
    .sort((left, right) =>
      left.wei === right.wei ? 0 : left.wei > right.wei ? -1 : 1,
    )
    .map(({ row }) => row);

  const todaySwaps = input.swaps
    .filter((swap) => inToday(swap.timestamp, input))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  const largeSwaps = todaySwaps.filter((swap) => isLargeNativeAmount(swap.lrbWei));
  const latestSwapCandidate = [...input.swaps].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  )[0];

  const baseline = input.addressBaselines.find(
    (candidate) => candidate.reportDate === reportDate,
  );
  let addressStatus: LoraDashboardData["addresses"]["baselineStatus"] = "missing";
  let todayNewAddresses: string | null = null;
  if (baseline && input.currentTotalAddresses !== null) {
    const difference =
      parseUnsignedInteger(input.currentTotalAddresses) -
      parseUnsignedInteger(baseline.totalAddresses);
    if (difference >= 0n) {
      addressStatus = "ready";
      todayNewAddresses = difference.toString();
    } else {
      addressStatus = "unavailable";
    }
  }

  const lastSuccessfulSyncAt =
    input.health.lastSuccessfulSyncAt ?? input.state.lastSuccessfulSyncAt;
  const stale =
    !lastSuccessfulSyncAt ||
    input.now.getTime() - Date.parse(lastSuccessfulSyncAt) >
      LORA_CACHE_STALE_AFTER_MS;
  const baselineStatus = todayComplete ? (stale ? "stale" : "ready") : "building";
  const sourceStatus = (
    status: LoraDashboardData["health"]["rpc"],
  ): LoraDashboardData["health"]["rpc"] =>
    status === "ready" && stale ? "stale" : status;
  const priceStale =
    !input.price.updatedAt ||
    input.now.getTime() - Date.parse(input.price.updatedAt) >
      LORA_CACHE_STALE_AFTER_MS;
  const priceStatus =
    input.price.status === "ready" && priceStale
      ? "stale"
      : input.price.status;
  const pairMetricsEnabled =
    priceStatus === "ready" || priceStatus === "stale";
  const latestSwap = pairMetricsEnabled ? latestSwapCandidate : undefined;

  const latestBlock = [...input.blocks].sort(
    (left, right) => right.height - left.height,
  )[0];
  const todayBlocks = input.blocks.filter((block) =>
    timestampInRange(block.timestamp, todayStart, input.now),
  );
  const gasUsed = todayBlocks.reduce(
    (total, block) => total + parseUnsignedInteger(block.gasUsed),
    0n,
  );
  const gasPrices = todayTransactions.map((transaction) =>
    parseUnsignedInteger(transaction.gasPriceWei),
  );
  const averageGasPriceWei =
    gasPrices.length === 0
      ? null
      : gasPrices.reduce((total, value) => total + value, 0n) /
        BigInt(gasPrices.length);

  const totalLargeWei = largeValues.reduce((total, value) => total + value, 0n);
  const maxLargeWei = largeValues.reduce(
    (maximum, value) => (value > maximum ? value : maximum),
    0n,
  );
  const dayValue = <T>(value: T): T | null => (todayComplete ? value : null);

  return {
    reportDate,
    timezone: LORA_BUSINESS_TIME_ZONE,
    generatedAt: input.now.toISOString(),
    dataUpdatedAt: lastSuccessfulSyncAt,
    lastSuccessfulSyncAt,
    stale,
    baselineStatus,
    nodes: {
      todayCount: dayValue(String(todayNodeBurns.length)),
      todayNodeBurnLrb: dayValue(
        formatUnits(BigInt(todayNodeBurns.length) * NODE_BURN_WEI),
      ),
      todayOtherBurnLrb: dayValue(
        formatUnits(
          todayOtherBurns.reduce(
            (total, transaction) =>
              total + parseUnsignedInteger(transaction.valueWei),
            0n,
          ),
        ),
      ),
      cumulativeBurnLrb: historyComplete
        ? formatUnits(
            allBurns.reduce(
              (total, transaction) =>
                total + parseUnsignedInteger(transaction.valueWei),
              0n,
            ),
          )
        : null,
      cumulativeConfirmedCount: historyComplete
        ? String(allNodeBurns.length)
        : null,
      hourly: hourlyPoints(
        todayNodeBurns.map((transaction) => transaction.timestamp),
        todayComplete,
      ),
    },
    addresses: {
      label: "今日新增链上地址",
      todayNew: todayNewAddresses,
      baselineStatus: addressStatus,
    },
    transactions: {
      todayTotal: dayValue(transactionCount.toString()),
      success: dayValue(successCount.toString()),
      failed: dayValue(failedCount.toString()),
      successRate: dayValue(successRate),
      successRateLabel: dayValue(successRate ? `${successRate}%` : null),
      nativeTransfers: dayValue(
        String(
          todayTransactions.filter(
            (transaction) =>
              transaction.success && parseUnsignedInteger(transaction.valueWei) > 0n,
          ).length +
            todayInternalWithoutTopLevelDuplicates.filter(
              (transaction) =>
                isValueMovingInternalTransaction(transaction) &&
                transaction.success &&
                parseUnsignedInteger(transaction.valueWei) > 0n,
            ).length,
        ),
      ),
      activeAddresses: dayValue(String(activeAddresses.size)),
      yesterdayTotal: stateMatchesReportDate && input.state.yesterdayComplete
        ? String(yesterdayTransactions.length)
        : null,
      hourly: hourlyPoints(
        todayTransactions.map((transaction) => transaction.timestamp),
        todayComplete,
      ),
    },
    largeTransfers: {
      count: dayValue(String(largeRows.length)),
      totalLrb: dayValue(formatUnits(totalLargeWei)),
      maxLrb: dayValue(formatUnits(maxLargeWei)),
      rows: todayComplete ? largeRows : [],
      top5: todayComplete ? rankedLargeRows.slice(0, 5) : [],
    },
    swaps: {
      enabled: pairMetricsEnabled,
      status:
        input.price.status === "config-error"
          ? "config-error"
          : !pairMetricsEnabled
            ? "unavailable"
          : todayComplete
            ? priceStatus
            : "building",
      rows: todayComplete && pairMetricsEnabled
        ? largeSwaps.map((swap) => ({
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
      priceUsdt: input.price.priceUsdt,
      source: input.price.source,
      pair: LORA_PAIR_ADDRESS,
      blockNumber:
        input.price.blockNumber === null
          ? null
          : String(input.price.blockNumber),
      updatedAt: input.price.updatedAt,
      latestSwapPrice: latestSwap?.priceUsdt ?? null,
      latestSwapAt: latestSwap?.timestamp ?? null,
    },
    chain: {
      blockHeight: latestBlock ? String(latestBlock.height) : null,
      lastBlockAt: latestBlock?.timestamp ?? null,
      averageBlockTime: (() => {
        const seconds = averageBlockTimeSeconds(
          input.blocks.map((block) => block.timestamp),
        );
        return seconds === null ? null : `${seconds} 秒`;
      })(),
      gasUsed: todayComplete ? gasUsed.toString() : null,
      averageGasPrice:
        todayComplete && averageGasPriceWei !== null
          ? `${formatUnits(averageGasPriceWei, 9, 4)} Gwei`
          : null,
    },
    health: {
      rpc: sourceStatus(input.health.rpc),
      explorer: sourceStatus(input.health.explorer),
      collector: sourceStatus(input.health.collector),
      lastSuccessfulSyncAt,
    },
  };
}

export function baselineDateForNextMidnight(now: Date): string {
  return addCalendarDays(shanghaiDateKey(now), 1);
}

export function baselineCaptureTime(reportDate: string): Date {
  return shanghaiDayStart(reportDate);
}
