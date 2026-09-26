import type { AiService } from "./service";

export interface AiAgentScheduler {
  start(): void;
  runNow(): Promise<void>;
  stop(): Promise<void>;
}

/** Process-local fallback for self-hosted Node deployments. Cloudflare uses
 * its scheduler to invoke the same service cycle inside the Durable Object. */
export function createAiAgentScheduler(
  service: Pick<AiService, "runBackgroundAgentCycle"> & Partial<Pick<AiService, "runBackgroundMediaCycle" | "runBackgroundMemoryCycle">>,
  options: { intervalMs?: number; batchSize?: number; initialDelayMs?: number } = {},
): AiAgentScheduler {
  const intervalMs = Math.max(5_000, Math.min(5 * 60_000, options.intervalMs ?? 15_000));
  const initialDelayMs = Math.max(250, Math.min(intervalMs, options.initialDelayMs ?? 1_000));
  const batchSize = Math.max(1, Math.min(8, Math.round(options.batchSize ?? 4)));
  let active: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let started = false;
  let stopped = false;

  const schedule = (delay: number) => {
    if (!started || stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runNow();
    }, delay);
    timer.unref?.();
  };
  const runNow = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = Promise.allSettled([
      service.runBackgroundAgentCycle(batchSize),
      ...(service.runBackgroundMediaCycle ? [service.runBackgroundMediaCycle(batchSize)] : []),
      ...(service.runBackgroundMemoryCycle ? [service.runBackgroundMemoryCycle(batchSize)] : []),
    ])
      .then(() => undefined)
      // A failed tick is isolated; persisted runs remain available to a later
      // bounded tick and provider requests are protected by stored idempotency.
      .catch(() => undefined)
      .finally(() => {
        active = undefined;
        schedule(intervalMs);
      });
    return active;
  };
  return {
    start() {
      if (started || stopped) return;
      started = true;
      schedule(initialDelayMs);
    },
    runNow,
    async stop() {
      if (stopped) return active;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await active;
    },
  };
}
