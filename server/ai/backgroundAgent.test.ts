import { describe, expect, it, vi } from "vitest";
import { createAiAgentScheduler } from "./backgroundAgent";

describe("Node AI background scheduler", () => {
  it("single-flights a cycle and waits for it before closing", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const runBackgroundAgentCycle = vi.fn(async () => {
      await gate;
      return { scanned: 0, resumed: 0, completed: 0, waitingApproval: 0, pending: 0, skippedInactive: 0, failed: 0 };
    });
    const scheduler = createAiAgentScheduler({ runBackgroundAgentCycle });
    const first = scheduler.runNow();
    const second = scheduler.runNow();
    expect(first).toBe(second);
    expect(runBackgroundAgentCycle).toHaveBeenCalledTimes(1);
    let stopped = false;
    const closing = scheduler.stop().then(() => { stopped = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    release();
    await closing;
    expect(stopped).toBe(true);
    await scheduler.runNow();
    expect(runBackgroundAgentCycle).toHaveBeenCalledTimes(1);
  });
});
