import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_INIT_RETRIES,
  DEFAULT_MAX_REBUILDS,
  DEFAULT_REBUILD_DELAY_MS,
  installContextLossRecovery,
  isContextUnavailableError,
  planInitFailure,
} from "./glRecovery";

// Adapted (vitest, not node:test) from the upstream munder-difflin project's
// own office-gl-recovery test suite — same scenarios, since this module was
// ported close to verbatim (see glRecovery.ts's header comment).

function fakeCanvas(): EventTarget { return new EventTarget(); }
function lose(canvas: EventTarget): Event {
  const e = new Event("webglcontextlost", { cancelable: true });
  canvas.dispatchEvent(e);
  return e;
}
function fakeClock() {
  const queue: Array<{ fn: () => void; ms: number }> = [];
  return {
    schedule: (fn: () => void, ms: number) => { queue.push({ fn, ms }); return queue.length; },
    runAll: () => { const q = queue.splice(0); q.forEach((j) => j.fn()); return q; },
    get pending() { return queue.length; },
    get delays() { return queue.map((j) => j.ms); },
  };
}

describe("installContextLossRecovery", () => {
  it("defers the rebuild rather than firing it immediately", () => {
    const canvas = fakeCanvas();
    const clock = fakeClock();
    let rebuilds = 0;
    installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {} });
    lose(canvas);
    expect(rebuilds).toBe(0);
    expect(clock.pending).toBe(1);
    clock.runAll();
    expect(rebuilds).toBe(1);
  });

  it("calls preventDefault — without it the browser never hands the context back", () => {
    const canvas = fakeCanvas();
    installContextLossRecovery(canvas, { onRebuild: () => {}, schedule: () => {}, log: () => {} });
    expect(lose(canvas).defaultPrevented).toBe(true);
  });

  it("delays the rebuild long enough to not race an eviction storm", () => {
    const canvas = fakeCanvas();
    const clock = fakeClock();
    installContextLossRecovery(canvas, { onRebuild: () => {}, schedule: clock.schedule, log: () => {} });
    lose(canvas);
    expect(clock.delays[0]).toBe(DEFAULT_REBUILD_DELAY_MS);
  });

  it("caps retries, then gives up loudly instead of staying silently blank", () => {
    const canvas = fakeCanvas();
    const clock = fakeClock();
    let rebuilds = 0, gaveUp = 0;
    const logs: string[] = [];
    installContextLossRecovery(canvas, {
      onRebuild: () => rebuilds++, onGiveUp: () => gaveUp++,
      schedule: clock.schedule, log: (m) => logs.push(m),
    });
    for (let i = 0; i < DEFAULT_MAX_REBUILDS; i++) { lose(canvas); clock.runAll(); }
    expect(rebuilds).toBe(DEFAULT_MAX_REBUILDS);
    expect(gaveUp).toBe(0);

    lose(canvas); clock.runAll();
    expect(gaveUp).toBe(1);
    expect(rebuilds).toBe(DEFAULT_MAX_REBUILDS);
    expect(logs.some((m) => /giving up/i.test(m))).toBe(true);

    lose(canvas); clock.runAll();
    expect(gaveUp).toBe(1); // stays given-up, no infinite fight
  });

  it("uninstalling stops recovery — a torn-down scene must not resurrect itself", () => {
    const canvas = fakeCanvas();
    const clock = fakeClock();
    let rebuilds = 0;
    const off = installContextLossRecovery(canvas, { onRebuild: () => rebuilds++, schedule: clock.schedule, log: () => {} });
    lose(canvas);
    off();
    clock.runAll();
    expect(rebuilds).toBe(0);
    lose(canvas);
    expect(clock.pending).toBe(0);
  });
});

describe("isContextUnavailableError", () => {
  it("recognizes the family of busy-GPU / no-context messages", () => {
    expect(isContextUnavailableError(new Error("This browser does not support WebGL. Try using the canvas renderer"))).toBe(true);
    expect(isContextUnavailableError(new Error("WebGL not supported"))).toBe(true);
    expect(isContextUnavailableError(new Error("WebGPU is not available"))).toBe(true);
    expect(isContextUnavailableError(new Error("Unable to create a WebGL context"))).toBe(true);
    expect(isContextUnavailableError(new Error("renderer boot failed", { cause: new Error("WebGL not supported") }))).toBe(true);
  });

  it("does not mistake an unrelated bug for a busy GPU", () => {
    expect(isContextUnavailableError(new Error("failed to load recipe"))).toBe(false);
    expect(isContextUnavailableError(new TypeError("workers is not iterable"))).toBe(false);
    expect(isContextUnavailableError(undefined)).toBe(false);
    expect(isContextUnavailableError(null)).toBe(false);
  });
});

describe("planInitFailure", () => {
  it("retries a busy-GPU init failure with the shared rebuild delay", () => {
    const err = new Error("This browser does not support WebGL. Try using the canvas renderer");
    const plan = planInitFailure(err, 0);
    expect(plan).toEqual({ action: "retry", delayMs: DEFAULT_REBUILD_DELAY_MS, attempt: 1 });
  });

  it("gives up once the retry budget is spent", () => {
    const err = new Error("WebGL not supported");
    for (let used = 0; used < DEFAULT_MAX_INIT_RETRIES; used++) {
      expect(planInitFailure(err, used)).toEqual({ action: "retry", delayMs: DEFAULT_REBUILD_DELAY_MS, attempt: used + 1 });
    }
    expect(planInitFailure(err, DEFAULT_MAX_INIT_RETRIES)).toEqual({ action: "give-up" });
  });

  it("reports (never retries) a real bug", () => {
    const bug = new TypeError("map.tilesets is not iterable");
    expect(planInitFailure(bug, 0)).toEqual({ action: "report" });
    expect(planInitFailure(bug, DEFAULT_MAX_INIT_RETRIES)).toEqual({ action: "report" });
  });
});
