import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LORA_PAIR_ADDRESS,
  LORA_ROUTER_ADDRESS,
  LORA_SWAP_TOPIC,
  LORA_USDT_ADDRESS,
  LORA_WLRB_ADDRESS,
  ONE_LRB_WEI,
} from "./constants";
import {
  boundPendingInternalTransactions,
  buildExplorerBlockByTimeUrl,
  collectPaginatedHead,
  collectInternalDetailRound,
  isPairReserveFresh,
  LORA_SOURCE_REQUEST_BUDGET_LIMITS,
  MAX_PENDING_INTERNAL_TRANSACTIONS,
  normalizePendingInternalTransactions,
  parseExplorerBlockNumberByTime,
  parseExplorerInternalTransaction,
  parseExplorerPagePayload,
  parseExplorerSwap,
  parseExplorerTransaction,
  parseRpcSwapLog,
  RetryingJsonClient,
} from "./source";
import type {
  LoraIndexedTransaction,
  LoraPendingInternalTransaction,
} from "./types";

const FROM = "0x1111111111111111111111111111111111111111";
const TO = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"a".repeat(64)}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fixtureResponse(status: number, body: unknown = { ok: true }): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function indexedTransaction(character: string): LoraIndexedTransaction {
  return {
    hash: `0x${character.repeat(64)}`,
    blockNumber: 10,
    timestamp: "2026-08-14T01:30:00.000Z",
    from: FROM,
    to: TO,
    valueWei: "0",
    success: true,
    gasUsed: "21000",
    gasPriceWei: "1000000000",
    input: "0x1234",
    toIsContract: true,
  };
}

function internalPageItem(
  transaction: LoraIndexedTransaction,
  index: number,
) {
  return {
    transaction_hash: transaction.hash,
    index,
    block_number: transaction.blockNumber,
    timestamp: transaction.timestamp,
    from: { hash: transaction.from },
    to: { hash: transaction.to },
    value: "1",
    success: true,
    type: "call",
  };
}

describe("LORA source bounded HTTP retry fixtures", () => {
  it.each([429, 500])(
    "retries HTTP %s once and then returns the successful JSON",
    async (status) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(fixtureResponse(status))
        .mockResolvedValueOnce(fixtureResponse(200, { value: "fixture" }));
      vi.stubGlobal("fetch", fetchMock);
      const client = new RetryingJsonClient();
      client.beginCycle();

      await expect(client.request("https://fixture.invalid/data")).resolves.toEqual({
        value: "fixture",
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("retries one AbortError and succeeds without using live network", async () => {
    const abortError = Object.assign(new Error("fixture abort"), {
      name: "AbortError",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce(fixtureResponse(200, { recovered: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RetryingJsonClient();
    client.beginCycle();

    await expect(client.request("https://fixture.invalid/abort")).resolves.toEqual({
      recovered: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-429 4xx response", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(fixtureResponse(404));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RetryingJsonClient();
    client.beginCycle();

    await expect(
      client.request("https://fixture.invalid/missing"),
    ).rejects.toThrow("HTTP 404");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the finite attempt limit on repeated 5xx responses", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(fixtureResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    const client = new RetryingJsonClient();
    client.beginCycle();

    await expect(
      client.request("https://fixture.invalid/unavailable"),
    ).rejects.toThrow("HTTP 503");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("LORA internal detail cursor queue fixtures", () => {
  it("upgrades legacy bare transactions and preserves per-transaction cursors", () => {
    const legacy = indexedTransaction("1");
    const current = indexedTransaction("2");
    expect(
      normalizePendingInternalTransactions([
        legacy,
        {
          transaction: current,
          nextPageParams: { block_number: 10, index: 50 },
        },
      ]),
    ).toEqual([
      {
        transaction: legacy,
        nextPageParams: null,
        queuedAt: legacy.timestamp,
      },
      {
        transaction: current,
        nextPageParams: { block_number: 10, index: 50 },
        queuedAt: current.timestamp,
      },
    ]);
  });

  it("restores compact aggregate queue entries without losing cursors", () => {
    const transaction = indexedTransaction("4");
    const [restored] = normalizePendingInternalTransactions([
      {
        transactionHash: transaction.hash,
        nextPageParams: { block_number: 20, index: 7 },
        queuedAt: "2026-08-15T01:02:03.000Z",
      },
    ]);
    expect(restored.transaction.hash).toBe(transaction.hash);
    expect(restored.nextPageParams).toEqual({ block_number: 20, index: 7 });
    expect(restored.queuedAt).toBe("2026-08-15T01:02:03.000Z");
  });

  it("expires old compact entries and caps a production-scale daily queue", () => {
    const todayStart = new Date("2026-08-14T16:00:00.000Z");
    const now = new Date("2026-08-15T06:00:00.000Z");
    const legacyCompact = normalizePendingInternalTransactions([
      { transactionHash: HASH, nextPageParams: null },
    ]);
    expect(legacyCompact[0].queuedAt).toBe("1970-01-01T00:00:00.000Z");

    const currentDay = Array.from(
      { length: MAX_PENDING_INTERNAL_TRANSACTIONS + 100 },
      (_, index) => {
        const transaction = {
          ...indexedTransaction("4"),
          hash: `0x${index.toString(16).padStart(64, "0")}`,
          timestamp: "2026-08-15T05:00:00.000Z",
        };
        return {
          transaction,
          nextPageParams: null,
          queuedAt: transaction.timestamp,
        } satisfies LoraPendingInternalTransaction;
      },
    );
    const bounded = boundPendingInternalTransactions(
      [
        ...legacyCompact,
        ...currentDay,
        {
          transaction: {
            ...indexedTransaction("5"),
            timestamp: "2026-08-15T07:00:00.000Z",
          },
          nextPageParams: null,
          queuedAt: "2026-08-15T07:00:00.000Z",
        },
      ],
      todayStart,
      now,
    );
    expect(bounded.queue).toHaveLength(MAX_PENDING_INTERNAL_TRANSACTIONS);
    expect(bounded.overflow).toBe(true);
    expect(
      bounded.queue.every(
        (entry) =>
          Date.parse(entry.queuedAt) >= todayStart.getTime() &&
          Date.parse(entry.queuedAt) <= now.getTime(),
      ),
    ).toBe(true);
    expect(
      boundPendingInternalTransactions(
        bounded.queue.slice(0, 1),
        todayStart,
        now,
        bounded.overflow,
      ).overflow,
    ).toBe(true);
  });

  it("rotates failed and incomplete work behind untouched transactions", async () => {
    const first = indexedTransaction("1");
    const broken = indexedTransaction("2");
    const later = indexedTransaction("3");
    let queue: LoraPendingInternalTransaction[] = [first, broken, later].map(
      (transaction) => ({
        transaction,
        nextPageParams: null,
        queuedAt: transaction.timestamp,
      }),
    );

    const firstRound = await collectInternalDetailRound({
      queue,
      maxTransactions: 2,
      fetchPage: async (transaction, cursor) => {
        expect(cursor).toBeNull();
        if (transaction.hash === broken.hash) {
          throw new Error("fixture detail unavailable");
        }
        return {
          items: [internalPageItem(transaction, 1)],
          next: { index: 2 },
          oldestTimestamp: transaction.timestamp,
        };
      },
    });
    expect(firstRound.failed).toBe(1);
    expect(firstRound.items).toHaveLength(1);
    expect(
      firstRound.pending.map((entry) => entry.transaction.hash),
    ).toEqual([later.hash, first.hash, broken.hash]);
    expect(firstRound.pending[1].nextPageParams).toEqual({ index: 2 });

    queue = firstRound.pending;
    const secondRound = await collectInternalDetailRound({
      queue,
      maxTransactions: 3,
      fetchPage: async (transaction, cursor) => {
        if (transaction.hash === broken.hash) {
          throw new Error("fixture still unavailable");
        }
        if (transaction.hash === first.hash) {
          expect(cursor).toEqual({ index: 2 });
        }
        return {
          items: [internalPageItem(transaction, 2)],
          next: null,
          oldestTimestamp: transaction.timestamp,
        };
      },
    });
    expect(secondRound.items).toHaveLength(2);
    expect(secondRound.pending).toEqual([
      {
        transaction: broken,
        nextPageParams: null,
        queuedAt: broken.timestamp,
      },
    ]);
  });

  it("does not advance a cursor when a critical item schema fails", async () => {
    const transaction = indexedTransaction("4");
    const entry = {
      transaction,
      nextPageParams: { index: 50 },
      queuedAt: transaction.timestamp,
    } satisfies LoraPendingInternalTransaction;
    const result = await collectInternalDetailRound({
      queue: [entry],
      maxTransactions: 1,
      fetchPage: async () => ({
        items: [{}],
        next: { index: 100 },
        oldestTimestamp: transaction.timestamp,
      }),
    });
    expect(result.failed).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.pending).toEqual([entry]);
  });

  it("continues beyond 100 pages across ticks until next_page_params is null", async () => {
    const transaction = indexedTransaction("5");
    let queue: LoraPendingInternalTransaction[] = [
      {
        transaction,
        nextPageParams: null,
        queuedAt: transaction.timestamp,
      },
    ];
    let requests = 0;
    let indexed = 0;
    while (queue.length > 0) {
      const round = await collectInternalDetailRound({
        queue,
        maxTransactions: 1,
        fetchPage: async (_transaction, cursor) => {
          expect(cursor).toEqual(
            requests === 0 ? null : { page: requests },
          );
          requests += 1;
          return {
            items: [internalPageItem(transaction, requests)],
            next: requests <= 100 ? { page: requests } : null,
            oldestTimestamp: transaction.timestamp,
          };
        },
      });
      indexed += round.items.length;
      queue = round.pending;
    }
    expect(requests).toBe(101);
    expect(indexed).toBe(101);
  });
});

describe("LORA source production request budget", () => {
  it("leaves bounded room for Swap proofs and internal details", () => {
    const limits = LORA_SOURCE_REQUEST_BUDGET_LIMITS;
    const nominalScanAttempts =
      limits.priceRequests +
      limits.explorerHeadStreams * limits.headPagesPerStream +
      limits.coreHistoryStreams * limits.coreHistoryPagesPerStream +
      limits.burnDailyPages +
      limits.burnLifetimePages +
      limits.statsRequests +
      limits.pairBoundaryRequests +
      limits.pairLogWindows;
    expect(nominalScanAttempts).toBe(28);
    expect(limits.totalAttempts - nominalScanAttempts).toBeGreaterThanOrEqual(20);
  });

  it("locates the Swap boundary with Blockscout's single decimal response", () => {
    const url = new URL(
      buildExplorerBlockByTimeUrl(
        "https://explorer.lorachain.org/api/v2",
        1_777_568_400,
      ),
    );
    expect(url.origin + url.pathname).toBe("https://explorer.lorachain.org/api");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      module: "block",
      action: "getblocknobytime",
      timestamp: "1777568400",
      closest: "after",
    });
    expect(
      parseExplorerBlockNumberByTime({
        message: "OK",
        result: { blockNumber: "15588962" },
        status: "1",
      }),
    ).toBe(15_588_962);
  });
});

describe("LORA source head continuation fixtures", () => {
  it("persists a catch-up cursor beyond the page budget and commits only after reconnect", async () => {
    type Item = { id: string; timestamp: string };
    const ids = Array.from({ length: 150 }, (_, index) => 150 - index);
    const makePage = (slice: number[], next: string | null) => ({
      items: slice.map((id) => ({
        id: `id-${id}`,
        timestamp: new Date(1_800_000_000_000 - id * 1_000).toISOString(),
      })),
      next: next ? { cursor: next } : null,
      oldestTimestamp: new Date(
        1_800_000_000_000 - Math.min(...slice) * 1_000,
      ).toISOString(),
    });
    const pages = new Map([
      ["head", makePage(ids.slice(0, 50), "p2")],
      ["p2", makePage(ids.slice(50, 100), "p3")],
      ["p3", makePage(ids.slice(100), null)],
    ]);
    const calls: string[] = [];
    const fetchPage = async (cursor: Record<string, string | number> | null) => {
      const key = cursor ? String(cursor.cursor) : "head";
      calls.push(key);
      const page = pages.get(key);
      if (!page) throw new Error(`missing fixture page ${key}`);
      return page;
    };
    const parse = (value: unknown): Item | null => {
      const item = value as Partial<Item>;
      return typeof item.id === "string" && typeof item.timestamp === "string"
        ? (item as Item)
        : null;
    };

    const first = await collectPaginatedHead({
      fetchPage,
      parse,
      key: (item) => item.id,
      previousKey: "id-1",
      label: "fixture",
      maxPages: 2,
    });
    expect(first).toMatchObject({
      connected: false,
      newestKey: "id-150",
      pendingNewestKey: "id-150",
      resumeCursor: { cursor: "p3" },
    });
    expect(first.items).toHaveLength(100);

    const second = await collectPaginatedHead({
      fetchPage,
      parse,
      key: (item) => item.id,
      previousKey: "id-1",
      resumeCursor: first.resumeCursor,
      pendingNewestKey: first.pendingNewestKey,
      label: "fixture",
      maxPages: 2,
    });
    expect(second).toMatchObject({
      connected: true,
      newestKey: "id-150",
      pendingNewestKey: null,
      resumeCursor: null,
    });
    expect(second.items).toHaveLength(49);
    expect(calls).toEqual(["head", "p2", "p3"]);

    pages.set(
      "head",
      makePage([151, 150, 149, 148], "p2"),
    );
    const arrivalsDuringCatchUp = await collectPaginatedHead({
      fetchPage,
      parse,
      key: (item) => item.id,
      previousKey: second.newestKey,
      label: "fixture",
      maxPages: 2,
    });
    expect(arrivalsDuringCatchUp.connected).toBe(true);
    expect(arrivalsDuringCatchUp.items.map((item) => item.id)).toEqual([
      "id-151",
    ]);
  });
});

describe("LORA source strict schema fixtures", () => {
  const transactionFixture = {
    hash: HASH,
    block_number: 10,
    timestamp: "2026-08-14T01:30:00.000Z",
    from: { hash: FROM, is_contract: false },
    to: { hash: TO, is_contract: true },
    value: "0",
    gas_used: "21000",
    gas_price: "1000000000",
    raw_input: "0x",
    status: "ok",
    result: "success",
  };

  it("requires parseable timestamps, contract classification and internal type", () => {
    expect(parseExplorerTransaction(transactionFixture)).toMatchObject({
      toIsContract: true,
    });
    expect(
      parseExplorerTransaction({
        ...transactionFixture,
        timestamp: "not-a-date",
      }),
    ).toBeNull();
    expect(
      parseExplorerTransaction({
        ...transactionFixture,
        to: { hash: TO },
      }),
    ).toBeNull();
    expect(
      parseExplorerTransaction({
        ...transactionFixture,
        status: undefined,
      }),
    ).toBeNull();
    expect(
      parseExplorerTransaction({
        ...transactionFixture,
        result: undefined,
      }),
    ).toBeNull();
    expect(
      parseExplorerTransaction({
        ...transactionFixture,
        status: "error",
        result: "execution reverted",
      }),
    ).toMatchObject({ success: false });

    const internalFixture = {
      transaction_hash: HASH,
      index: 1,
      block_number: 10,
      timestamp: "2026-08-14T01:30:00.000Z",
      from: { hash: FROM },
      to: { hash: TO },
      value: "1",
      success: true,
      type: "call",
    };
    expect(parseExplorerInternalTransaction(internalFixture)).toMatchObject({
      callType: "CALL",
    });
    expect(
      parseExplorerInternalTransaction({
        ...internalFixture,
        type: undefined,
      }),
    ).toBeNull();
    expect(
      parseExplorerInternalTransaction({
        ...internalFixture,
        success: undefined,
      }),
    ).toBeNull();
  });

  it("rejects malformed page items and pagination cursors instead of treating them as empty", () => {
    expect(
      parseExplorerPagePayload({
        items: [],
        next_page_params: { block_number: 10, index: 2 },
      }),
    ).toMatchObject({
      items: [],
      next: { block_number: 10, index: 2 },
    });
    expect(() =>
      parseExplorerPagePayload({ items: {}, next_page_params: null }),
    ).toThrow("items schema mismatch");
    expect(() =>
      parseExplorerPagePayload({ items: [], next_page_params: "cursor" }),
    ).toThrow("next_page_params schema mismatch");
    expect(() =>
      parseExplorerPagePayload({ items: [], next_page_params: ["cursor"] }),
    ).toThrow("next_page_params schema mismatch");
    expect(() => parseExplorerPagePayload({ items: [] })).toThrow(
      "next_page_params schema mismatch",
    );
    expect(() =>
      parseExplorerPagePayload({
        items: [],
        next_page_params: { block_number: false },
      }),
    ).toThrow("next_page_params value schema mismatch");
  });

  it("uses the Pair reserve timestamp instead of the request time", () => {
    expect(isPairReserveFresh(1_000n, 1_600n)).toBe(true);
    expect(isPairReserveFresh(1_000n, 1_601n)).toBe(false);
    expect(isPairReserveFresh(1_601n, 1_600n)).toBe(false);
  });
});

describe("LORA source Swap proof fixtures", () => {
  const topicAddress = (address: string) =>
    `0x${address.slice(2).padStart(64, "0")}`;
  const amounts = [20n * ONE_LRB_WEI, 0n, 0n, 200n * ONE_LRB_WEI];
  const data = `0x${amounts
    .map((value) => value.toString(16).padStart(64, "0"))
    .join("")}`;
  const rpcLog = {
    address: LORA_PAIR_ADDRESS,
    transactionHash: HASH,
    blockNumber: "0xa",
    logIndex: "0x4",
    removed: false,
    data,
    topics: [
      LORA_SWAP_TOPIC,
      topicAddress(LORA_ROUTER_ADDRESS),
      topicAddress(TO),
    ],
  };

  it("accepts only the exact Swap topic and exposes the WLRB leg as BigInt", () => {
    expect(parseRpcSwapLog(rpcLog)).toMatchObject({
      transactionHash: HASH,
      blockNumber: 10,
      logIndex: 4,
      lrbWei: 200n * ONE_LRB_WEI,
    });
    expect(
      parseRpcSwapLog({
        ...rpcLog,
        topics: [`0x${"f".repeat(64)}`, ...rpcLog.topics.slice(1)],
      }),
    ).toBeNull();
  });

  it("does not let a decoded method label bypass strict topic0 validation", () => {
    const transaction = {
      hash: HASH,
      blockNumber: 10,
      timestamp: "2026-08-14T01:30:00.000Z",
      from: FROM,
      to: LORA_ROUTER_ADDRESS,
      valueWei: "0",
      success: true,
      gasUsed: "21000",
      gasPriceWei: "1000000000",
      input: "0x1234",
      toIsContract: true,
    };
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
    expect(
      parseExplorerSwap(
        transaction,
        {
          address: { hash: LORA_PAIR_ADDRESS },
          index: 4,
          data,
          decoded: { method_id: "d78ad95f" },
          topics: [
            `0x${"f".repeat(64)}`,
            topicAddress(LORA_ROUTER_ADDRESS),
          ],
        },
        [
          transfer(
            LORA_USDT_ADDRESS,
            FROM,
            LORA_PAIR_ADDRESS,
            20n * ONE_LRB_WEI,
          ),
          transfer(
            LORA_WLRB_ADDRESS,
            LORA_PAIR_ADDRESS,
            LORA_ROUTER_ADDRESS,
            200n * ONE_LRB_WEI,
          ),
        ],
        null,
      ),
    ).toBeNull();
  });
});
