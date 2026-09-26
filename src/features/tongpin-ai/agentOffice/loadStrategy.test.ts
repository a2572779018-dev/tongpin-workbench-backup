import { describe, expect, it } from "vitest";
import { attemptLoadPixi } from "./loadStrategy";

describe("attemptLoadPixi (DOM-fallback decision with a mocked/failing pixi import)", () => {
  it("succeeds when the loader resolves — the canvas scene can mount", async () => {
    const fakeModule = { Application: class {} };
    const result = await attemptLoadPixi(async () => fakeModule, 0);
    expect(result).toEqual({ ok: true, module: fakeModule });
  });

  it("a busy-GPU failure retries rather than falling back immediately", async () => {
    const loadPixi = async () => { throw new Error("This browser does not support WebGL. Try using the canvas renderer"); };
    const result = await attemptLoadPixi(loadPixi, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.plan).toEqual({ action: "retry", delayMs: 1500, attempt: 1 });
  });

  it("falls back to the DOM list once the busy-GPU retry budget is spent", async () => {
    const loadPixi = async () => { throw new Error("WebGL not supported"); };
    const result = await attemptLoadPixi(loadPixi, 3); // DEFAULT_MAX_INIT_RETRIES already used
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.plan).toEqual({ action: "give-up" });
  });

  it("a real bug in the loader (not a WebGL problem) is reported, never silently retried forever", async () => {
    const loadPixi = async () => { throw new TypeError("recipeForWorker is not a function"); };
    const result = await attemptLoadPixi(loadPixi, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.plan).toEqual({ action: "report" });
  });

  it("a rejection with no Error object at all still resolves to a plan, not a thrown exception", async () => {
    const loadPixi = async () => { throw "network blocked"; };
    const result = await attemptLoadPixi(loadPixi, 0);
    expect(result.ok).toBe(false);
  });
});
