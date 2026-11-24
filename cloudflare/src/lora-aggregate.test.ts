import { describe, expect, it, vi } from "vitest";
import {
  applyLoraAggregateBatch,
  buildLoraAggregateDashboard,
  createEmptyLoraAggregateSnapshot,
  loadLoraAggregateSnapshot,
  LORA_AGGREGATE_OBJECT_KEY,
  LORA_COVERAGE_REVISION,
  LORA_LEGACY_AGGREGATE_OBJECT_KEY,
  migrateLoraCoverageSnapshot,
  migrateLegacyLoraAggregateSnapshot,
  serializeLoraAggregateSnapshot,
} from "./lora-aggregate";
import { MAX_PENDING_INTERNAL_TRANSACTIONS } from "../../server/lora-chain/source";
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
    blockHeadConnected: false,
    transactionHeadConnected: false,
    burnHeadConnected: false,
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
  it("invalidates legacy coverage once while retaining de-duplicated lower bounds", () => {
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
      }),
      NOW,
    );
    snapshot.coverageRevision = 0;
    snapshot.currentTotalAddresses = "1001";
    snapshot.addressBaselines = [
      {
        reportDate: "2026-08-15",
        totalAddresses: "1000",
        capturedAt: "2026-08-14T16:00:55.000Z",
        blockNumber: 100,
        estimated: false,
        source: "midnight-window",
      },
    ];
    snapshot.state = {
      ...snapshot.state,
      checkpointBlock: 100,
      checkpointHash: HASH_A,
      transactionCursor: { block_number: 90 },
      transactionTodayComplete: true,
      transactionYesterdayComplete: true,
      blockTodayComplete: true,
      burnTodayComplete: true,
      historyComplete: true,
      todayComplete: true,
    };

    const migrated = migrateLoraCoverageSnapshot(snapshot);
    expect(migrated.coverageRevision).toBe(LORA_COVERAGE_REVISION);
    expect(migrated.state).toMatchObject({
      checkpointBlock: null,
      checkpointHash: null,
      transactionCursor: null,
      transactionTodayComplete: false,
      transactionYesterdayComplete: true,
      blockTodayComplete: false,
      burnTodayComplete: false,
      historyComplete: false,
      todayComplete: false,
    });
    expect(migrated.days["2026-08-15"].transactionHashes).toEqual([HASH_A]);
    expect(migrated.addressBaselines[0].estimated).toBe(true);
    expect(buildLoraAggregateDashboard(migrated, NOW).addresses).toMatchObject({
      todayNew: "≈1",
      baselineStatus: "building",
    });

    migrated.state.transactionTodayComplete = true;
    expect(migrateLoraCoverageSnapshot(migrated).state.transactionTodayComplete).toBe(
      true,
    );
  });

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
        blockHeadConnected: true,
        transactionHeadConnected: true,
        burnHeadConnected: true,
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

  it("recovers a dated pool quote after a network mismatch even if the pool is idle", () => {
    const verified = batch().price;
    const wrongNetwork = batch({ price: { ...verified, status: "config-error", priceUsdt: null, configError: "CHAIN_ID_MISMATCH" } });
    const initial = applyLoraAggregateBatch(createEmptyLoraAggregateSnapshot(), wrongNetwork, NOW);
    expect(buildLoraAggregateDashboard(initial, NOW).price.priceUsdt).toBeNull();

    const updatedAt = new Date(NOW.getTime() - 86_400_000).toISOString();
    const recovered = applyLoraAggregateBatch(initial, batch({ price: { ...verified, updatedAt } }), NOW);
    expect(buildLoraAggregateDashboard(recovered, NOW).price).toMatchObject({
      status: "stale", priceUsdt: verified.priceUsdt, updatedAt,
    });
  });

  it("uses the live RPC head and never treats sparse block samples as adjacent", () => {
    const snapshot = applyLoraAggregateBatch(
      createEmptyLoraAggregateSnapshot(),
      batch({
        blocks: [
          {
            height: 100,
            hash: HASH_A,
            parentHash: HASH_B,
            timestamp: "2026-08-15T00:00:00.000Z",
            gasUsed: "1",
          },
          {
            height: 101,
            hash: HASH_B,
            parentHash: HASH_A,
            timestamp: "2026-08-15T00:00:02.000Z",
            gasUsed: "1",
          },
          {
            height: 10_884,
            hash: HASH_C,
            parentHash: HASH_B,
            timestamp: "2026-08-15T05:59:28.000Z",
            gasUsed: "1",
          },
        ],
        price: {
          ...batch().price,
          blockNumber: 20_000,
          blockTimestamp: NOW.toISOString(),
          averageBlockTimeMs: null,
        },
      }),
      NOW,
    );

    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.chain.blockHeight).toBe("20000");
    expect(dashboard.chain.lastBlockAt).toBe(NOW.toISOString());
    expect(dashboard.chain.averageBlockTime).toBe("2 秒");

    snapshot.price.averageBlockTimeMs = "2000";
    expect(buildLoraAggregateDashboard(snapshot, NOW).chain.averageBlockTime).toBe(
      "2 秒",
    );
  });

  it("uses the fresh RPC burn-address balance for cumulative burn", () => {
    const snapshot = applyLoraAggregateBatch(
      createEmptyLoraAggregateSnapshot(),
      batch({
        burnBalanceWei: "44309933970257000000000000",
        burnBalanceBlockNumber: 15_750_292,
        burnBalanceUpdatedAt: NOW.toISOString(),
      }),
      NOW,
    );
    expect(buildLoraAggregateDashboard(snapshot, NOW).nodes.cumulativeBurnLrb).toBe(
      "44309933.970257",
    );
    expect(
      buildLoraAggregateDashboard(
        snapshot,
        new Date(NOW.getTime() + 20 * 60_000),
      ).nodes.cumulativeBurnLrb,
    ).toBe("44309933.970257+");
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

  it("carries forward a missing daily address baseline as an explicit estimate", () => {
    const snapshot = createEmptyLoraAggregateSnapshot();
    snapshot.currentTotalAddresses = "1000";
    snapshot.state.bootstrapDate = "2026-08-14";
    snapshot.updatedAt = "2026-08-14T15:59:00.000Z";

    applyLoraAggregateBatch(
      snapshot,
      batch({ currentTotalAddresses: "1012" }),
      NOW,
    );

    expect(snapshot.addressBaselines).toContainEqual({
      reportDate: "2026-08-15",
      totalAddresses: "1000",
      capturedAt: "2026-08-14T15:59:00.000Z",
      blockNumber: null,
      estimated: true,
      source: "carry-forward",
    });
    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.addresses.todayNew).toBe("≈12");
    expect(dashboard.addresses.baselineStatus).toBe("building");
  });

  it("replaces a recovered estimate when an exact midnight baseline arrives", () => {
    const snapshot = createEmptyLoraAggregateSnapshot();
    snapshot.currentTotalAddresses = "1000";
    snapshot.state.bootstrapDate = "2026-08-14";
    snapshot.updatedAt = "2026-08-14T15:59:00.000Z";
    applyLoraAggregateBatch(
      snapshot,
      batch({ currentTotalAddresses: "1012" }),
      NOW,
    );

    applyLoraAggregateBatch(
      snapshot,
      batch({
        currentTotalAddresses: "1015",
        addressBaseline: {
          reportDate: "2026-08-15",
          totalAddresses: "1001",
          capturedAt: "2026-08-14T16:01:00.000Z",
          blockNumber: 99,
          estimated: false,
          source: "midnight-window",
        },
      }),
      NOW,
    );

    expect(snapshot.addressBaselines[0].source).toBe("midnight-window");
    expect(snapshot.addressBaselines[0].estimated).toBe(false);
    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.addresses.todayNew).toBe("14");
    expect(dashboard.addresses.baselineStatus).toBe("ready");
  });

  it("stores a first observation as approximate instead of inventing midnight precision", () => {
    const snapshot = applyLoraAggregateBatch(
      createEmptyLoraAggregateSnapshot(),
      batch({ currentTotalAddresses: "1012" }),
      NOW,
    );
    expect(snapshot.addressBaselines[0].source).toBe("first-observation");
    expect(snapshot.addressBaselines[0].capturedAt).toBe(NOW.toISOString());
    const dashboard = buildLoraAggregateDashboard(snapshot, NOW);
    expect(dashboard.addresses.todayNew).toBe("≈0");
    expect(dashboard.addresses.baselineStatus).toBe("building");
  });

  it("writes aggregate v2 with a compact bounded queue and honest partial flags", () => {
    const snapshot = createEmptyLoraAggregateSnapshot();
    snapshot.state.bootstrapDate = "2026-08-15";
    snapshot.state.internalDetailsComplete = true;
    snapshot.state.todayComplete = true;
    snapshot.state.pendingInternalTransactions = Array.from(
      { length: MAX_PENDING_INTERNAL_TRANSACTIONS + 1_000 },
      (_, index) => ({
        transaction: {
          hash: `0x${index.toString(16).padStart(64, "0")}`,
          blockNumber: 100,
          timestamp: NOW.toISOString(),
          from: ADDRESS_A,
          to: ADDRESS_B,
          valueWei: "0",
          success: true,
          gasUsed: "21000",
          gasPriceWei: "1",
          input: "0x1234",
          toIsContract: true,
        },
        nextPageParams: null,
        queuedAt: NOW.toISOString(),
      }),
    );

    const serialized = serializeLoraAggregateSnapshot(snapshot);
    const persisted = JSON.parse(serialized) as {
      version: number;
      state: {
        pendingInternalTransactions: Array<{
          transactionHash: string;
          nextPageParams: unknown;
          queuedAt: string;
        }>;
        internalQueueOverflow: boolean;
        internalDetailsComplete: boolean;
        todayComplete: boolean;
      };
    };
    expect(LORA_AGGREGATE_OBJECT_KEY).toBe("_internal/lora/aggregate-v2.json");
    expect(persisted.version).toBe(2);
    expect(persisted.state.pendingInternalTransactions).toHaveLength(
      MAX_PENDING_INTERNAL_TRANSACTIONS,
    );
    expect(persisted.state.pendingInternalTransactions[0]).toEqual({
      transactionHash: `0x${"0".repeat(64)}`,
      nextPageParams: null,
      queuedAt: NOW.toISOString(),
    });
    expect(persisted.state.internalQueueOverflow).toBe(true);
    expect(persisted.state.internalDetailsComplete).toBe(false);
    expect(persisted.state.todayComplete).toBe(false);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(1_000_000);
  });

  it("migrates legacy v1 once while preserving mature aggregates and bounded current-day work", async () => {
    const snapshot = createEmptyLoraAggregateSnapshot();
    snapshot.state.bootstrapDate = "2026-08-15";
    snapshot.state.checkpointBlock = 998_877;
    snapshot.state.checkpointHash = HASH_D;
    snapshot.cumulativeBurnWei = "12345000000000000000000";
    snapshot.cumulativeConfirmedCount = "321";
    snapshot.currentTotalAddresses = "877038";
    snapshot.addressBaselines = [
      {
        reportDate: "2026-08-15",
        totalAddresses: "876900",
        capturedAt: "2026-08-14T16:01:00.000Z",
        blockNumber: 998_000,
        estimated: false,
        source: "midnight-window",
      },
    ];
    applyLoraAggregateBatch(snapshot, batch(), NOW);
    snapshot.state.checkpointBlock = 998_877;
    snapshot.state.checkpointHash = HASH_D;
    const currentHashes = Array.from(
      { length: MAX_PENDING_INTERNAL_TRANSACTIONS + 1 },
      (_, index) => `0x${index.toString(16).padStart(64, "0")}`,
    );
    snapshot.days["2026-08-15"].transactionHashes = currentHashes;
    const legacyPayload = {
      ...snapshot,
      version: 1,
      state: {
        ...snapshot.state,
        pendingInternalTransactions: [
          {
            transactionHash: HASH_C,
            nextPageParams: null,
            queuedAt: "2026-08-14T05:00:00.000Z",
          },
          ...currentHashes.map((transactionHash) => ({
            transactionHash,
            nextPageParams: null,
          })),
        ],
      },
    };

    const migrated = migrateLegacyLoraAggregateSnapshot(legacyPayload, NOW);
    expect(migrated).not.toBeNull();
    expect(migrated).toMatchObject({
      version: 2,
      cumulativeBurnWei: "12345000000000000000000",
      cumulativeConfirmedCount: "321",
      currentTotalAddresses: "877038",
      state: {
        checkpointBlock: 998_877,
        checkpointHash: HASH_D,
        internalQueueOverflow: true,
        internalDetailsComplete: false,
        todayComplete: false,
      },
    });
    expect(migrated?.addressBaselines).toEqual(snapshot.addressBaselines);
    expect(migrated?.state.pendingInternalTransactions).toHaveLength(
      MAX_PENDING_INTERNAL_TRANSACTIONS,
    );
    expect(
      migrated?.state.pendingInternalTransactions?.every(
        (entry) => entry.queuedAt === snapshot.updatedAt,
      ),
    ).toBe(true);

    const objects = new Map<string, { body: string; etag: string }>([
      [
        LORA_LEGACY_AGGREGATE_OBJECT_KEY,
        { body: JSON.stringify(legacyPayload), etag: "legacy-etag" },
      ],
    ]);
    const get = vi.fn(async (key: string) => {
      const stored = objects.get(key);
      return stored
        ? ({
            etag: stored.etag,
            json: async () => JSON.parse(stored.body) as unknown,
          } as unknown as R2ObjectBody)
        : null;
    });
    const put = vi.fn(async (key: string, value: unknown) => {
      const etag = `etag-${put.mock.calls.length}`;
      objects.set(key, { body: String(value), etag });
      return { etag } as unknown as R2Object;
    });
    const bucket = { get, put } as unknown as R2Bucket;

    const first = await loadLoraAggregateSnapshot(bucket, NOW);
    const second = await loadLoraAggregateSnapshot(bucket, NOW);
    expect(first.snapshot.version).toBe(2);
    expect(second.snapshot.state.checkpointBlock).toBe(998_877);
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      get.mock.calls.filter(
        ([key]) => key === LORA_LEGACY_AGGREGATE_OBJECT_KEY,
      ),
    ).toHaveLength(1);
  }, 45_000);
});
