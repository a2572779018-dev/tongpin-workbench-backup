import { describe, expect, it } from "vitest";
import {
  applyLoraAggregateBatch,
  buildLoraAggregateDashboard,
  createEmptyLoraAggregateSnapshot,
} from "./lora-aggregate";
import type { LoraCollectionBatch } from "../../server/lora-chain/types";

const NOW = new Date("2026-08-15T06:00:00.000Z");
const ADDRESS_A = `0x${"1".repeat(40)}`;
const ADDRESS_B = `0x${"2".repeat(40)}`;
const DEAD = "0x000000000000000000000000000000000000dead";
const HASH_A = `0x${"a".repeat(64)}`;
const HASH_B = `0x${"b".repeat(64)}`;
const HASH_C = `0x${"c".repeat(64)}`;
const HASH_D = `0x${"d".repeat(64)}`;

function batch(overrides: Partial<LoraCollectionBatch> = {}): LoraCollectionBatch {
  return {
    blocks: [],
    transactions: [],
    internalTransactions: [],
    swaps: [],
    currentTotalAddresses: null,
    price: {
      status: "ready",
      priceUsdt: "0.14",
      reserveUsdt: "140000000000000000000",
      reserveWlrb: "1000000000000000000000",
      blockNumber: 100,
      updatedAt: NOW.toISOString(),
      source: "WLRB/USDT Pair getReserves",
      configError: null,
    },
    nextTransactionCursor: null,
    nextBurnCursor: null,
    nextBurnHistoryCursor: null,
    nextBlockCursor: null,
    checkpointBlock: 100,
    checkpointHash: HASH_D,
    transactionTodayComplete: false,
    transactionYesterdayComplete: false,
    burnTodayComplete: false,
    blockTodayComplete: false,
    todayComplete: false,
    yesterdayComplete: false,
    historyComplete: false,
    internalDetailsComplete: false,
    swapTodayComplete: false,
    rpcHealthy: true,
    explorerHealthy: true,
    collectedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("LORA R2 aggregate", () => {
  it("deduplicates batches and keeps honest partial lower bounds", () => {
    const exact100 = "100000000000000000000";
    const over100 = "100000000000000000001";
    const nodeBurn = "1000000000000000000000";
    const otherBurn = "5000000000000000000";
    const topLevel = {
      hash: HASH_A,
      blockNumber: 100,
      timestamp: "2026-08-15T05:20:00.000Z",
      from: ADDRESS_A,
      to: ADDRESS_B,
      valueWei: over100,
      success: true,
      gasUsed: "21000",
      gasPriceWei: "1000000000",
      input: "0x",
    };
    const snapshot = applyLoraAggregateBatch(
      createEmptyLoraAggregateSnapshot(),
      batch({
        blocks: [
          {
            height: 100,
            hash: HASH_D,
            parentHash: HASH_C,
            timestamp: "2026-08-15T05:20:00.000Z",
            gasUsed: "42000",
          },
        ],
        transactions: [
          topLevel,
          topLevel,
          {
            ...topLevel,
            hash: HASH_B,
            valueWei: exact100,
            timestamp: "2026-08-15T05:21:00.000Z",
          },
        ],
        internalTransactions: [
          {
            transactionHash: HASH_A,
            index: "0",
            blockNumber: 100,
            timestamp: "2026-08-15T05:20:00.000Z",
            from: ADDRESS_A,
            to: ADDRESS_B,
            valueWei: over100,
            success: true,
            callType: "CALL",
          },
          {
            transactionHash: HASH_C,
            index: "1",
            blockNumber: 100,
            timestamp: "2026-08-15T05:22:00.000Z",
            from: ADDRESS_A,
            to: DEAD,
            valueWei: nodeBurn,
            success: true,
            callType: "CALL",
          },
          {
            transactionHash: HASH_D,
            index: "2",
            blockNumber: 100,
            timestamp: "2026-08-15T05:23:00.000Z",
            from: ADDRESS_A,
            to: DEAD,
            valueWei: otherBurn,
            success: true,
            callType: "CALL",
          },
        ],
      }),
      NOW,
    );
    applyLoraAggregateBatch(snapshot, batch({
      transactions: [topLevel],
      internalTransactions: [
        {
          transactionHash: HASH_C,
          index: "1",
          blockNumber: 100,
          timestamp: "2026-08-15T05:22:00.000Z",
          from: ADDRESS_A,
          to: DEAD,
          valueWei: nodeBurn,
          success: true,
          callType: "CALL",
        },
      ],
    }), NOW);

    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.transactions.todayTotal).toBe("2+");
    expect(dashboard.largeTransfers.count).toBe("2+");
    expect(dashboard.nodes.todayCount).toBe("1+");
    expect(dashboard.nodes.todayOtherBurnLrb).toBe("5+");
    expect(dashboard.nodes.cumulativeBurnLrb).toBe("1005+");
    expect(dashboard.nodes.cumulativeConfirmedCount).toBe("1+");
    expect(dashboard.chain.gasUsed).toBe("42000+");
  });

  it("removes lower-bound markers only after the source reports completeness", () => {
    const snapshot = applyLoraAggregateBatch(
      createEmptyLoraAggregateSnapshot(),
      batch({
        transactions: [
          {
            hash: HASH_A,
            blockNumber: 100,
            timestamp: "2026-08-15T05:20:00.000Z",
            from: ADDRESS_A,
            to: ADDRESS_B,
            valueWei: "1",
            success: true,
            gasUsed: "21000",
            gasPriceWei: "1000000000",
            input: "0x",
          },
        ],
        transactionTodayComplete: true,
        transactionYesterdayComplete: true,
        burnTodayComplete: true,
        blockTodayComplete: true,
        internalDetailsComplete: true,
        swapTodayComplete: true,
        todayComplete: true,
        yesterdayComplete: true,
        historyComplete: true,
      }),
      NOW,
    );
    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.transactions.todayTotal).toBe("1");
    expect(dashboard.transactions.nativeTransfers).toBe("1");
    expect(dashboard.nodes.todayCount).toBe("0");
    expect(dashboard.nodes.cumulativeBurnLrb).toBe("0");
  });

  it("disables Swap and price rows when Pair validation fails", () => {
    const snapshot = applyLoraAggregateBatch(
      createEmptyLoraAggregateSnapshot(),
      batch({
        price: {
          status: "config-error",
          priceUsdt: null,
          reserveUsdt: null,
          reserveWlrb: null,
          blockNumber: 100,
          updatedAt: NOW.toISOString(),
          source: "WLRB/USDT Pair getReserves",
          configError: "token order mismatch",
        },
      }),
      NOW,
    );
    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.price.status).toBe("config-error");
    expect(dashboard.swaps.enabled).toBe(false);
    expect(dashboard.swaps.rows).toEqual([]);
  });
});
