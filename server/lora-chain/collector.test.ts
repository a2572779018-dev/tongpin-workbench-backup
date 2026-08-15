import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { silentRealtimeHub } from "../routes/boss";
import { JsonStore } from "../store";
import { LORA_BURN_ADDRESS, NODE_BURN_WEI } from "./constants";
import {
  LoraChainCollector,
  type LoraChainDataSource,
} from "./collector";
import type { LoraCollectionBatch } from "./types";

const roots: string[] = [];
const HASH = `0x${"1".repeat(64)}`;
const PARENT = `0x${"2".repeat(64)}`;
const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
      throw new Error("拒绝清理非临时目录");
    }
    await rm(resolved, { recursive: true, force: true });
  }
});

function fixedBatch(): LoraCollectionBatch {
  return {
    blocks: [
      {
        height: 99,
        hash: HASH,
        parentHash: PARENT,
        timestamp: "2026-08-14T01:59:58.000Z",
        gasUsed: "21000",
      },
    ],
    transactions: [
      {
        hash: HASH,
        blockNumber: 99,
        timestamp: "2026-08-14T01:59:58.000Z",
        from: FROM,
        to: TO,
        valueWei: "1",
        success: true,
        gasUsed: "21000",
        gasPriceWei: "1000000000",
        input: "0x",
      },
    ],
    internalTransactions: [
      {
        transactionHash: HASH,
        index: "1",
        blockNumber: 99,
        timestamp: "2026-08-14T01:59:58.000Z",
        from: FROM,
        to: "0x000000000000000000000000000000000000dead",
        valueWei: NODE_BURN_WEI.toString(),
        success: true,
        callType: "CALL",
      },
    ],
    swaps: [],
    currentTotalAddresses: "1000",
    price: {
      status: "ready",
      priceUsdt: "0.2",
      reserveUsdt: "2",
      reserveWlrb: "10",
      blockNumber: 99,
      updatedAt: "2026-08-14T02:00:00.000Z",
      source: "pair",
      configError: null,
    },
    nextTransactionCursor: null,
    nextBurnCursor: null,
    nextBurnHistoryCursor: null,
    nextBlockCursor: null,
    checkpointBlock: 99,
    checkpointHash: HASH,
    transactionTodayComplete: true,
    transactionYesterdayComplete: true,
    burnTodayComplete: true,
    blockTodayComplete: true,
    todayComplete: true,
    yesterdayComplete: true,
    historyComplete: true,
    rpcHealthy: true,
    explorerHealthy: true,
    collectedAt: "2026-08-14T02:00:00.000Z",
  };
}

describe("LORA singleton collector persistence and cache fallback", () => {
  it("coalesces concurrent runs, persists checkpoint, de-dupes and resumes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-collector-"));
    roots.push(root);
    const file = path.join(root, "database.json");
    const store = await JsonStore.open(file);
    let calls = 0;
    const source: LoraChainDataSource = {
      async collect() {
        calls += 1;
        return fixedBatch();
      },
    };
    const collector = new LoraChainCollector(
      store,
      source,
      silentRealtimeHub,
      () => new Date("2026-08-14T02:00:00.000Z"),
    );
    const [first, second] = await Promise.all([
      collector.refresh(),
      collector.refresh(),
    ]);
    expect(calls).toBe(1);
    expect(first.nodes.todayCount).toBe("1");
    expect(second.transactions.todayTotal).toBe("1");

    await collector.refresh();
    expect(calls).toBe(2);
    const reopened = await JsonStore.open(file);
    const persisted = await reopened.read((database) => ({
      state: database.loraCollectorState,
      transactions: database.loraTransactions,
      internals: database.loraInternalTransactions,
      caches: database.loraDashboardCaches,
    }));
    expect(persisted.state.checkpointBlock).toBe(99);
    expect(persisted.transactions).toHaveLength(1);
    expect(persisted.internals).toHaveLength(1);
    expect(persisted.caches).toHaveLength(1);
  });

  it("returns the last successful cache as stale instead of replacing failure with zero", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-cache-"));
    roots.push(root);
    const store = await JsonStore.open(path.join(root, "database.json"));
    const good = new LoraChainCollector(
      store,
      { collect: async () => fixedBatch() },
      silentRealtimeHub,
      () => new Date("2026-08-14T02:00:00.000Z"),
    );
    await good.refresh();
    const failing = new LoraChainCollector(
      store,
      {
        collect: async () => {
          throw new Error("fixture explorer timeout");
        },
      },
      silentRealtimeHub,
      () => new Date("2026-08-14T02:10:00.000Z"),
    );
    const dashboard = await failing.refresh();
    expect(dashboard.stale).toBe(true);
    expect(dashboard.nodes.todayCount).toBe("1");
    expect(dashboard.price.priceUsdt).toBe("0.2");
    expect(dashboard.health.collector).not.toBe("ready");
  });

  it("clears the persisted Swap checkpoint when a new Shanghai day starts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-day-rollover-"));
    roots.push(root);
    const store = await JsonStore.open(path.join(root, "database.json"));
    let run = 0;
    const collector = new LoraChainCollector(
      store,
      {
        async collect() {
          run += 1;
          return {
            ...fixedBatch(),
            collectedAt:
              run === 1
                ? "2026-08-14T15:59:00.000Z"
                : "2026-08-14T16:01:00.000Z",
            swapCheckpointBlock: run === 1 ? 99 : null,
          };
        },
      },
      silentRealtimeHub,
      () =>
        new Date(
          run === 0
            ? "2026-08-14T15:59:00.000Z"
            : "2026-08-14T16:01:00.000Z",
        ),
    );

    await collector.refresh();
    await collector.refresh();

    const checkpoint = await store.read(
      (database) => database.loraCollectorState.swapCheckpointBlock,
    );
    expect(checkpoint).toBeNull();
  });

  it("keeps the first address baseline captured for a Shanghai date", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-baseline-"));
    roots.push(root);
    const store = await JsonStore.open(path.join(root, "database.json"));
    let run = 0;
    const collector = new LoraChainCollector(
      store,
      {
        async collect() {
          run += 1;
          return {
            ...fixedBatch(),
            addressBaseline: {
              reportDate: "2026-08-14",
              totalAddresses: run === 1 ? "1000" : "1001",
              capturedAt: `2026-08-13T16:0${run - 1}:00.000Z`,
              blockNumber: 99 + run,
            },
          };
        },
      },
      silentRealtimeHub,
      () => new Date("2026-08-13T16:01:00.000Z"),
    );

    await collector.refresh();
    await collector.refresh();

    const baselines = await store.read((database) => database.loraAddressBaselines);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]).toMatchObject({
      reportDate: "2026-08-14",
      totalAddresses: "1000",
      blockNumber: 100,
    });
  });

  it("advances overall synchronization time only when both required sources succeed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-health-"));
    roots.push(root);
    const store = await JsonStore.open(path.join(root, "database.json"));
    const firstAt = new Date("2026-08-14T02:00:00.000Z");
    const secondAt = new Date("2026-08-14T02:05:00.000Z");
    await new LoraChainCollector(
      store,
      { collect: async () => fixedBatch() },
      silentRealtimeHub,
      () => firstAt,
    ).refresh();
    await new LoraChainCollector(
      store,
      {
        collect: async () => ({
          ...fixedBatch(),
          explorerHealthy: false,
          collectedAt: secondAt.toISOString(),
        }),
      },
      silentRealtimeHub,
      () => secondAt,
    ).refresh();

    const health = await store.read((database) => database.loraHealth);
    expect(health).toMatchObject({
      collector: "unavailable",
      lastSuccessfulSyncAt: firstAt.toISOString(),
      lastRpcSuccessAt: secondAt.toISOString(),
      lastExplorerSuccessAt: firstAt.toISOString(),
      lastError: "EXPLORER_UNAVAILABLE",
    });
  });

  it("prunes old detail rows while preserving cumulative burn history and the latest Swap", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tongpin-lora-retention-"));
    roots.push(root);
    const store = await JsonStore.open(path.join(root, "database.json"));
    const batch = fixedBatch();
    batch.blocks = [
      { ...batch.blocks[0], timestamp: "2026-07-01T00:00:00.000Z" },
    ];
    batch.transactions = [
      { ...batch.transactions[0], timestamp: "2026-07-01T00:00:00.000Z" },
    ];
    batch.internalTransactions = [
      {
        ...batch.internalTransactions[0],
        timestamp: "2026-07-01T00:00:00.000Z",
        to: LORA_BURN_ADDRESS,
      },
      {
        ...batch.internalTransactions[0],
        transactionHash: PARENT,
        index: "2",
        timestamp: "2026-07-01T00:00:00.000Z",
        to: TO,
      },
    ];
    batch.swaps = [
      {
        transactionHash: HASH,
        logIndex: 1,
        blockNumber: 1,
        timestamp: "2026-07-01T00:00:00.000Z",
        side: "买入",
        lrbWei: NODE_BURN_WEI.toString(),
        usdtUnits: NODE_BURN_WEI.toString(),
        priceUsdt: "1",
        initiator: FROM,
        currentNativeBalanceWei: null,
      },
      {
        transactionHash: PARENT,
        logIndex: 2,
        blockNumber: 2,
        timestamp: "2026-07-02T00:00:00.000Z",
        side: "卖出",
        lrbWei: NODE_BURN_WEI.toString(),
        usdtUnits: NODE_BURN_WEI.toString(),
        priceUsdt: "1",
        initiator: FROM,
        currentNativeBalanceWei: null,
      },
    ];
    await new LoraChainCollector(
      store,
      { collect: async () => batch },
      silentRealtimeHub,
      () => new Date("2026-08-14T02:00:00.000Z"),
    ).refresh();

    const persisted = await store.read((database) => ({
      blocks: database.loraBlocks,
      transactions: database.loraTransactions,
      internals: database.loraInternalTransactions,
      swaps: database.loraSwaps,
    }));
    expect(persisted.blocks).toEqual([]);
    expect(persisted.transactions).toEqual([]);
    expect(persisted.internals).toHaveLength(1);
    expect(persisted.internals[0]?.to).toBe(LORA_BURN_ADDRESS);
    expect(persisted.swaps).toHaveLength(1);
    expect(persisted.swaps[0]?.transactionHash).toBe(PARENT);
  });
});
