import type { JsonStore } from "../store";
import type { RealtimeHub } from "../routes/boss";
import { LORA_COLLECT_INTERVAL_MS } from "./constants";
import {
  applyLoraCollectionBatch,
  markLoraCollectionFailure,
} from "./state";
import { buildLoraDashboard } from "./statistics";
import { shanghaiDateKey } from "./time";
import type {
  LoraCollectionBatch,
  LoraCollectorState,
  LoraDashboardData,
} from "./types";

export interface LoraCollectionContext {
  state: Readonly<LoraCollectorState>;
  now: Date;
  knownTransactionHashes?: ReadonlySet<string>;
}

export interface LoraChainDataSource {
  collect(context: LoraCollectionContext): Promise<LoraCollectionBatch>;
}

export function dashboardFromDatabase(
  database: Parameters<Parameters<JsonStore["read"]>[0]>[0],
  now = new Date(),
): LoraDashboardData {
  return buildLoraDashboard({
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
}

export class LoraChainCollector {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<LoraDashboardData> | null = null;
  private running = false;

  constructor(
    private readonly store: JsonStore,
    private readonly source: LoraChainDataSource,
    private readonly realtime: RealtimeHub,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(25);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  refresh(): Promise<LoraDashboardData> {
    if (this.inFlight) return this.inFlight;
    const operation = this.collectOnce();
    this.inFlight = operation.finally(() => {
      this.inFlight = null;
      if (this.running) this.schedule(LORA_COLLECT_INTERVAL_MS);
    });
    return this.inFlight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => undefined);
    }, Math.max(1, delayMs));
    this.timer.unref();
  }

  private async collectOnce(): Promise<LoraDashboardData> {
    const now = this.clock();
    const context = await this.store.read((database) => ({
      state: database.loraCollectorState,
      knownTransactionHashes: new Set(
        database.loraTransactions
          .filter(
            (transaction) =>
              shanghaiDateKey(new Date(transaction.timestamp)) ===
              shanghaiDateKey(now),
          )
          .map((transaction) => transaction.hash.toLowerCase()),
      ),
    }));
    try {
      const batch = await this.source.collect({ ...context, now });
      const result = await this.store.mutate((database) => {
        applyLoraCollectionBatch(database, batch, now);
        return {
          dashboard: dashboardFromDatabase(database, now),
          recipients: database.users
            .filter(
              (user) =>
                user.status === "active" &&
                user.role === "boss",
            )
            .map((user) => user.id),
        };
      });
      for (const userId of result.recipients) {
        this.realtime.pushUser(userId, "lora-chain:updated", {
          dashboard: result.dashboard,
        });
      }
      return result.dashboard;
    } catch (error) {
      return this.store.mutate((database) => {
        markLoraCollectionFailure(database, error, now);
        return dashboardFromDatabase(database, now);
      });
    }
  }
}
