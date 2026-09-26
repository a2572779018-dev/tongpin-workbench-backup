import { describe, expect, it } from "vitest";
import { planMotion } from "./motionPlan";

describe("planMotion (reduced-motion path)", () => {
  it("collapses any duration to an instant state change under reduced motion", () => {
    expect(planMotion(800, true)).toEqual({ durationMs: 0, instant: true });
    expect(planMotion(0, true)).toEqual({ durationMs: 0, instant: true });
    expect(planMotion(5000, true)).toEqual({ durationMs: 0, instant: true });
  });

  it("keeps the designed duration when motion is not reduced", () => {
    expect(planMotion(800, false)).toEqual({ durationMs: 800, instant: false });
  });

  it("never returns a negative duration for a bad input", () => {
    expect(planMotion(-50, false).durationMs).toBe(0);
  });
});
