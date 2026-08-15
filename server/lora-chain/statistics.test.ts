import { describe, expect, it } from "vitest";
import {
  LARGE_TRANSFER_THRESHOLD_WEI,
  LORA_BURN_ADDRESS,
  LORA_PAIR_ADDRESS,
  LORA_ROUTER_ADDRESS,
  LORA_USDT_ADDRESS,
  LORA_WLRB_ADDRESS,
  NODE_BURN_WEI,
  ONE_LRB_WEI,
} from "./constants";
import { divideToDecimal, formatUnits } from "./math";
import {
  buildLoraDashboard,
  dedupeInternalTransactions,
  dedupeTransactions,
  isConfirmedNodeBurn,
  isLargeNativeAmount,
} from "./statistics";
import {
  appendExplorerQuery,
  parseExplorerSwap,
  validatePairConfiguration,
} from "./source";
import {
  nextShanghaiClock,
  shanghaiDateKey,
  shanghaiDayBounds,
} from "./time";
import type {
  LoraCollectorState,
  LoraDashboardInput,
  LoraIndexedInternalTransaction,
  LoraIndexedTransaction,
  LoraSourceHealth,
} from "./types";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const TX_A = `0x${"a".repeat(64)}`;
const TX_B = `0x${"b".repeat(64)}`;

function internal(
  overrides: Partial<LoraIndexedInternalTransaction> = {},
): LoraIndexedInternalTransaction {
  return {
    transactionHash: TX_A,
    index: "1",
    blockNumber: 10,
    timestamp: "2026-08-14T01:30:00.000Z",
    from: FROM,
    to: LORA_BURN_ADDRESS,
    valueWei: NODE_BURN_WEI.toString(),
    success: true,
    callType: "CALL",
    ...overrides,
  };
}

function transaction(
  overrides: Partial<LoraIndexedTransaction> = {},
): LoraIndexedTransaction {
  return {
    hash: TX_A,
    blockNumber: 10,
    timestamp: "2026-08-14T01:30:00.000Z",
    from: FROM,
    to: TO,
    valueWei: "1",
    success: true,
    gasUsed: "21000",
    gasPriceWei: "1000000000",
    input: "0x",
    ...overrides,
  };
}

function completeState(): LoraCollectorState {
  return {
    checkpointBlock: 10,
    checkpointHash: TX_A,
    blockCursor: null,
    transactionCursor: null,
    burnCursor: null,
    burnHistoryCursor: null,
    internalDetailsComplete: true,
    swapTodayComplete: true,
    bootstrapDate: "2026-08-14",
    transactionTodayComplete: true,
    transactionYesterdayComplete: true,
    burnTodayComplete: true,
    blockTodayComplete: true,
    todayComplete: true,
    yesterdayComplete: true,
    historyComplete: true,
    nextRunAt: null,
    lastAttemptAt: "2026-08-14T02:00:00.000Z",
    lastSuccessfulSyncAt: "2026-08-14T02:00:00.000Z",
    consecutiveFailures: 0,
  };
}

function healthy(): LoraSourceHealth {
  return {
    rpc: "ready",
    explorer: "ready",
    collector: "ready",
    lastRpcSuccessAt: "2026-08-14T02:00:00.000Z",
    lastExplorerSuccessAt: "2026-08-14T02:00:00.000Z",
    lastSuccessfulSyncAt: "2026-08-14T02:00:00.000Z",
    lastError: null,
  };
}

describe("LORA fixed-point and time boundaries", () => {
  it("never uses binary floating point for Wei, price or percentages", () => {
    expect(formatUnits(100_000_001_000_000_000_000n)).toBe("100.000001");
    expect(divideToDecimal(3_4184n, 247_474n, 8)).toBe("0.13813168");
  });

  it("uses Asia/Shanghai 00:00 and 08:00 boundaries", () => {
    expect(shanghaiDateKey(new Date("2026-08-13T15:59:59.999Z"))).toBe(
      "2026-08-13",
    );
    expect(shanghaiDateKey(new Date("2026-08-13T16:00:00.000Z"))).toBe(
      "2026-08-14",
    );
    const bounds = shanghaiDayBounds(new Date("2026-08-14T00:00:00.000Z"));
    expect(bounds.todayStart.toISOString()).toBe("2026-08-13T16:00:00.000Z");
    expect(
      nextShanghaiClock(
        new Date("2026-08-13T23:59:59.999Z"),
        8,
      ).toISOString(),
    ).toBe("2026-08-14T00:00:00.000Z");
    expect(
      nextShanghaiClock(
        new Date("2026-08-14T00:00:00.000Z"),
        8,
      ).toISOString(),
    ).toBe("2026-08-15T00:00:00.000Z");
  });
});

describe("LORA burn, threshold and de-duplication rules", () => {
  it("counts only successful exact 1000 LRB value-moving internal burns", () => {
    expect(isConfirmedNodeBurn(internal())).toBe(true);
    expect(
      isConfirmedNodeBurn(
        internal({ valueWei: (NODE_BURN_WEI + 1n).toString() }),
      ),
    ).toBe(false);
    expect(isConfirmedNodeBurn(internal({ success: false }))).toBe(false);
    expect(isConfirmedNodeBurn(internal({ callType: "DELEGATECALL" }))).toBe(
      false,
    );
  });

  it("uses strict >100 for top-level and internal native transfers", () => {
    expect(isLargeNativeAmount(LARGE_TRANSFER_THRESHOLD_WEI.toString())).toBe(
      false,
    );
    expect(
      isLargeNativeAmount((LARGE_TRANSFER_THRESHOLD_WEI + 1n).toString()),
    ).toBe(true);
  });

  it("deduplicates transaction hash and internal hash+index", () => {
    expect(dedupeTransactions([transaction(), transaction()])).toHaveLength(1);
    expect(
      dedupeInternalTransactions([
        internal(),
        internal(),
        internal({ index: "2" }),
      ]),
    ).toHaveLength(2);
  });

  it("does not count the same native movement twice across top-level and internal indexes", () => {
    const valueWei = (101n * ONE_LRB_WEI).toString();
    const dashboard = buildLoraDashboard({
      now: new Date("2026-08-14T02:01:00.000Z"),
      blocks: [],
      transactions: [transaction({ valueWei })],
      internalTransactions: [
        internal({
          transactionHash: TX_A,
          from: FROM,
          to: TO,
          valueWei,
          callType: "CALL",
        }),
      ],
      swaps: [],
      addressBaselines: [],
      currentTotalAddresses: null,
      price: {
        status: "unavailable",
        priceUsdt: null,
        reserveUsdt: null,
        reserveWlrb: null,
        blockNumber: null,
        updatedAt: null,
        source: null,
        configError: null,
      },
      state: completeState(),
      health: healthy(),
    });

    expect(dashboard.transactions.nativeTransfers).toBe("1");
    expect(dashboard.largeTransfers).toMatchObject({
      count: "1",
      totalLrb: "101",
      maxLrb: "101",
    });
    expect(dashboard.largeTransfers.rows).toHaveLength(1);
  });

  it("does not derive node count from cumulative burn divided by 1000", () => {
    const input: LoraDashboardInput = {
      now: new Date("2026-08-14T02:01:00.000Z"),
      blocks: [
        {
          height: 10,
          hash: TX_A,
          parentHash: TX_B,
          timestamp: "2026-08-14T02:00:00.000Z",
          gasUsed: "21000",
        },
      ],
      transactions: [],
      internalTransactions: [
        internal(),
        internal({
          transactionHash: TX_B,
          index: "2",
          valueWei: (500n * ONE_LRB_WEI).toString(),
        }),
      ],
      swaps: [],
      addressBaselines: [],
      currentTotalAddresses: null,
      price: {
        status: "unavailable",
        priceUsdt: null,
        reserveUsdt: null,
        reserveWlrb: null,
        blockNumber: null,
        updatedAt: null,
        source: null,
        configError: null,
      },
      state: completeState(),
      health: healthy(),
    };
    const dashboard = buildLoraDashboard(input);
    expect(dashboard.nodes.todayCount).toBe("1");
    expect(dashboard.nodes.todayNodeBurnLrb).toBe("1000");
    expect(dashboard.nodes.todayOtherBurnLrb).toBe("500");
    expect(dashboard.nodes.cumulativeBurnLrb).toBe("1500");
    expect(dashboard.nodes.cumulativeConfirmedCount).toBe("1");
  });
});

describe("LORA pair, Swap and cache honesty", () => {
  it("publishes each completed metric while the remaining baseline is still syncing", () => {
    const state = {
      ...completeState(),
      transactionTodayComplete: false,
      internalDetailsComplete: false,
      swapTodayComplete: false,
      todayComplete: false,
    };
    const dashboard = buildLoraDashboard({
      now: new Date("2026-08-14T02:01:00.000Z"),
      blocks: [],
      transactions: [transaction()],
      internalTransactions: [internal()],
      swaps: [],
      addressBaselines: [],
      currentTotalAddresses: null,
      price: {
        status: "ready",
        priceUsdt: "0.2",
        reserveUsdt: "2",
        reserveWlrb: "10",
        blockNumber: 10,
        updatedAt: "2026-08-14T02:00:00.000Z",
        source: "pair",
        configError: null,
      },
      state,
      health: healthy(),
    });

    expect(dashboard.baselineStatus).toBe("building");
    expect(dashboard.nodes.todayCount).toBe("1");
    expect(dashboard.price.priceUsdt).toBe("0.2");
    expect(dashboard.transactions.todayTotal).toBe("1+");
    expect(dashboard.transactions.successRateLabel).toBe("≈100%");
    expect(dashboard.largeTransfers.count).toBe("1+");
    expect(dashboard.largeTransfers.rows).toHaveLength(1);
    expect(dashboard.swaps.status).toBe("building");
  });

  it("validates token order, decimals and zero reserves", () => {
    const base = {
      chainId: "0x18d7",
      token0: LORA_USDT_ADDRESS,
      token1: LORA_WLRB_ADDRESS,
      token0Decimals: 18n,
      token1Decimals: 18n,
      reserve0: 2_000n * ONE_LRB_WEI,
      reserve1: 10_000n * ONE_LRB_WEI,
      blockNumber: 100,
      updatedAt: "2026-08-14T02:00:00.000Z",
    };
    expect(validatePairConfiguration(base)).toMatchObject({
      status: "ready",
      priceUsdt: "0.2",
    });
    expect(
      validatePairConfiguration({
        ...base,
        token0: LORA_WLRB_ADDRESS,
        token1: LORA_USDT_ADDRESS,
      }).status,
    ).toBe("config-error");
    expect(
      validatePairConfiguration({ ...base, token0Decimals: 6n }).status,
    ).toBe("config-error");
    expect(
      validatePairConfiguration({ ...base, reserve1: 0n }).status,
    ).toBe("unavailable");
  });

  it("recognizes a Router-allowlisted raw Pair Swap only with both token legs", () => {
    const tx = transaction({
      hash: TX_B,
      to: LORA_ROUTER_ADDRESS,
      input: "0x1234",
      valueWei: "0",
    });
    const words = [
      20n * ONE_LRB_WEI,
      0n,
      0n,
      200n * ONE_LRB_WEI,
    ]
      .map((value) => value.toString(16).padStart(64, "0"))
      .join("");
    const topicAddress = (address: string) =>
      `0x${address.slice(2).padStart(64, "0")}`;
    const transfer = (
      token: string,
      from: string,
      to: string,
      amount: bigint,
    ) => ({
      token: { address_hash: token },
      from: { hash: from },
      to: { hash: to },
      total: { value: amount.toString() },
    });
    const parsed = parseExplorerSwap(
      tx,
      {
        address: { hash: LORA_PAIR_ADDRESS },
        index: 4,
        data: `0x${words}`,
        topics: [
          "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
          topicAddress(LORA_ROUTER_ADDRESS),
        ],
      },
      [
        transfer(LORA_USDT_ADDRESS, FROM, LORA_PAIR_ADDRESS, 20n * ONE_LRB_WEI),
        transfer(LORA_WLRB_ADDRESS, LORA_PAIR_ADDRESS, LORA_ROUTER_ADDRESS, 200n * ONE_LRB_WEI),
      ],
      "5",
    );
    expect(parsed).toMatchObject({
      side: "买入",
      lrbWei: (200n * ONE_LRB_WEI).toString(),
      usdtUnits: (20n * ONE_LRB_WEI).toString(),
      priceUsdt: "0.1",
    });
    expect(
      parseExplorerSwap(
        tx,
        {
          address: { hash: LORA_PAIR_ADDRESS },
          index: 4,
          data: `0x${words}`,
          topics: [
            "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
            topicAddress(TO),
          ],
        },
        [],
        null,
      ),
    ).toBeNull();
  });

  it("preserves next_page_params without renaming or dropping fields", () => {
    const url = new URL(
      appendExplorerQuery(
        "https://explorer.lorachain.org/api/v2/addresses/x/internal-transactions",
        { filter: "to" },
        { block_number: 10, index: 7, items_count: 50 },
      ),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filter: "to",
      block_number: "10",
      index: "7",
      items_count: "50",
    });
  });

  it("keeps cached values but marks stale, and leaves absent baselines null", () => {
    const dashboard = buildLoraDashboard({
      now: new Date("2026-08-14T02:10:00.000Z"),
      blocks: [],
      transactions: [],
      internalTransactions: [],
      swaps: [],
      addressBaselines: [],
      currentTotalAddresses: "100",
      price: {
        status: "ready",
        priceUsdt: "0.2",
        reserveUsdt: "2",
        reserveWlrb: "10",
        blockNumber: 10,
        updatedAt: "2026-08-14T02:00:00.000Z",
        source: "pair",
        configError: null,
      },
      state: completeState(),
      health: healthy(),
    });
    expect(dashboard.stale).toBe(true);
    expect(dashboard.price).toMatchObject({ status: "stale", priceUsdt: "0.2" });
    expect(dashboard.swaps.enabled).toBe(true);
    expect(dashboard.addresses).toMatchObject({
      label: "今日新增链上地址",
      todayNew: null,
      baselineStatus: "missing",
    });
  });

  it("keeps Pair metrics disabled until the startup configuration check succeeds", () => {
    const dashboard = buildLoraDashboard({
      now: new Date("2026-08-14T02:01:00.000Z"),
      blocks: [],
      transactions: [],
      internalTransactions: [],
      swaps: [],
      addressBaselines: [],
      currentTotalAddresses: null,
      price: {
        status: "unavailable",
        priceUsdt: null,
        reserveUsdt: null,
        reserveWlrb: null,
        blockNumber: null,
        updatedAt: null,
        source: null,
        configError: null,
      },
      state: completeState(),
      health: healthy(),
    });
    expect(dashboard.swaps).toMatchObject({
      enabled: false,
      status: "unavailable",
    });
    expect(dashboard.price.priceUsdt).toBeNull();
  });

  it("does not expose cached Swap rows or prices after a Pair configuration error", () => {
    const dashboard = buildLoraDashboard({
      now: new Date("2026-08-14T02:01:00.000Z"),
      blocks: [],
      transactions: [],
      internalTransactions: [],
      swaps: [
        {
          transactionHash: TX_A,
          logIndex: 1,
          blockNumber: 10,
          timestamp: "2026-08-14T01:30:00.000Z",
          side: "买入",
          lrbWei: (101n * ONE_LRB_WEI).toString(),
          usdtUnits: (20n * ONE_LRB_WEI).toString(),
          priceUsdt: "0.1980198",
          initiator: FROM,
          currentNativeBalanceWei: null,
        },
      ],
      addressBaselines: [],
      currentTotalAddresses: null,
      price: {
        status: "config-error",
        priceUsdt: null,
        reserveUsdt: null,
        reserveWlrb: null,
        blockNumber: 10,
        updatedAt: "2026-08-14T02:00:00.000Z",
        source: "pair",
        configError: "PAIR_CONFIGURATION_MISMATCH",
      },
      state: completeState(),
      health: healthy(),
    });

    expect(dashboard.swaps).toMatchObject({
      enabled: false,
      status: "config-error",
      rows: [],
      latestPrice: null,
      latestAt: null,
    });
    expect(dashboard.price.latestSwapPrice).toBeNull();
    expect(dashboard.price.latestSwapAt).toBeNull();
  });

  it("forces new-day metrics back to building before the first successful collection", () => {
    const dashboard = buildLoraDashboard({
      now: new Date("2026-08-14T16:01:00.000Z"),
      blocks: [],
      transactions: [],
      internalTransactions: [],
      swaps: [],
      addressBaselines: [],
      currentTotalAddresses: null,
      price: {
        status: "unavailable",
        priceUsdt: null,
        reserveUsdt: null,
        reserveWlrb: null,
        blockNumber: null,
        updatedAt: null,
        source: null,
        configError: null,
      },
      state: completeState(),
      health: healthy(),
    });

    expect(dashboard.reportDate).toBe("2026-08-15");
    expect(dashboard.baselineStatus).toBe("building");
    expect(dashboard.nodes.todayCount).toBeNull();
    expect(dashboard.transactions).toMatchObject({
      todayTotal: null,
      success: null,
      failed: null,
      yesterdayTotal: null,
    });
    expect(dashboard.largeTransfers.rows).toEqual([]);
  });
});
