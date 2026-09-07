import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createVisibleFrameLoop, FLEUR_MAX_FPS } from "./visibleFrameLoop";

function fixture() {
  let id = 0;
  const pending = new Map<number, (now: number) => void>();
  const draw = vi.fn();
  const loop = createVisibleFrameLoop(draw, {
    request(callback) { const next = ++id; pending.set(next, callback); return next; },
    cancel(key) { pending.delete(key); },
  });
  return { loop, draw, pending, frame(now: number) { const callbacks = [...pending.values()]; pending.clear(); for (const callback of callbacks) callback(now); } };
}

describe("Fleur visible-only SVG animation clock", () => {
  it("draws one static frame without starting any RAF when paused", () => {
    const f = fixture();
    f.loop.redraw();
    f.loop.setActive(false);
    expect(f.draw).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(f.pending.size).toBe(0);
  });
  it("caps animated paints at 30 fps on a 120Hz screen", () => {
    const f = fixture();
    f.loop.setActive(true);
    for (let i = 0; i <= 120; i++) f.frame(i * 1000 / 120);
    expect(FLEUR_MAX_FPS).toBe(30);
    expect(f.draw).toHaveBeenCalledTimes(30);
    expect(f.loop.visibleMs).toBeCloseTo(1000);
    for (const [, delta] of f.draw.mock.calls) expect(delta).toBeGreaterThanOrEqual(1000 / 30 - 0.001);
  });
  it.each([60, 120, 144])("retains the 30fps deadline phase with rounded %iHz RAF timestamps", hz => {
    const f = fixture();
    f.loop.setActive(true);
    for (let i = 0; i <= hz * 10; i++) f.frame(Math.round(i * 1000 / hz * 10) / 10);
    expect(f.draw.mock.calls.length).toBeGreaterThanOrEqual(299);
    expect(f.draw.mock.calls.length).toBeLessThanOrEqual(300);
    expect(f.loop.visibleMs).toBeCloseTo(10_000);
    let previous = 0;
    for (const [visible, delta] of f.draw.mock.calls) {
      expect(delta).toBeCloseTo(visible - previous);
      previous = visible;
    }
  });
  it.each([0, 16.7])("does not alternate short/long paint gaps at rounded 60Hz (start %ims)", start => {
    const f = fixture(); f.loop.setActive(true);
    for (let i = 0; i <= 600; i++) f.frame(start + Math.round(i * 1000 / 60 * 10) / 10);
    const intervals = f.draw.mock.calls.map(([, delta]) => delta as number);
    expect(Math.min(...intervals)).toBeGreaterThan(33.2);
    expect(Math.max(...intervals)).toBeLessThan(33.5);
    expect(intervals).toHaveLength(300);
  });
  it.each(["cpu1", "cpu4"] as const)("keeps even spacing when replaying the real Chrome %s RAF trace", scenario => {
    // Isolated Chrome 2026-09-07: timestamp offsets only, no mouse coordinates,
    // accounts or page data. Both traces reproduced the old 16.6/50ms jitter.
    const traces = JSON.parse(readFileSync(new URL("./visibleFrameLoop.raf-fixture.json", import.meta.url), "utf8")) as Record<string, number[]>;
    const f = fixture(); f.loop.setActive(true);
    for (const timestamp of traces[scenario]) f.frame(timestamp);
    const deltas = f.draw.mock.calls.map(([, delta]) => delta as number);
    expect(deltas).toHaveLength(135);
    expect(Math.min(...deltas)).toBeGreaterThan(33.1);
    expect(Math.max(...deltas)).toBeLessThan(33.6);
    expect(f.loop.visibleMs).toBeCloseTo(traces[scenario].at(-1)!);
  });
  it.each([60, 120, 144])("maintains its budget under slowly drifting %iHz timestamps for a full minute", hz => {
    const f = fixture(); f.loop.setActive(true);
    for (let i = 0; i <= hz * 60; i++) f.frame(Math.round(i * (1000 / hz - 0.0012) * 10) / 10);
    const deltas = f.draw.mock.calls.map(([, delta]) => delta as number);
    expect(deltas.length).toBeGreaterThanOrEqual(1799);
    expect(deltas.length).toBeLessThanOrEqual(1801);
    expect(Math.min(...deltas)).toBeGreaterThan(25);
    expect(Math.max(...deltas)).toBeLessThan(35.5);
  });
  it("skips missed deadlines without a catch-up burst and passes the actual elapsed time", () => {
    const f = fixture(); f.loop.setActive(true); f.frame(0); f.frame(40); f.frame(500);
    expect(f.draw).toHaveBeenCalledTimes(2);
    expect(f.draw).toHaveBeenLastCalledWith(500, 460);
    f.frame(501); expect(f.draw).toHaveBeenCalledTimes(2);
    f.frame(534); expect(f.draw).toHaveBeenLastCalledWith(534, 34);
  });
  it.each(["paused", "document hidden", "offscreen", "reduced motion"])("cancels scheduled RAF for %s and excludes hidden wall time when resuming", () => {
    const f = fixture();
    f.loop.setActive(true); f.frame(0); f.frame(40);
    expect(f.loop.visibleMs).toBe(40);
    f.loop.setActive(false);
    expect(f.pending.size).toBe(0);
    f.frame(60_000);
    expect(f.loop.visibleMs).toBe(40);
    f.loop.setActive(true); f.frame(60_000);
    expect(f.loop.visibleMs).toBe(40);
    f.frame(60_040);
    expect(f.loop.visibleMs).toBe(80);
    expect(f.draw).toHaveBeenLastCalledWith(80, 40);
  });
  it("does not restart the clock on repeated visibility notifications", () => {
    const f = fixture();
    f.loop.setActive(true); f.frame(0); f.loop.setActive(true); f.frame(40);
    expect(f.loop.visibleMs).toBe(40);
    expect(f.pending.size).toBe(1);
  });
  it("uses the latest drawing state and permits an explicit static redraw without advancing time", () => {
    const f = fixture();
    f.loop.setActive(true); f.frame(0); f.frame(40);
    f.loop.setActive(false); f.loop.redraw();
    expect(f.draw).toHaveBeenLastCalledWith(40, 0);
    expect(f.loop.visibleMs).toBe(40);
  });
  it("cleans up and cannot schedule or repaint after disposal", () => {
    const f = fixture();
    f.loop.setActive(true); f.loop.dispose();
    f.loop.setActive(true); f.loop.redraw(); f.frame(1000);
    expect(f.pending.size).toBe(0);
    expect(f.draw).not.toHaveBeenCalled();
  });
});
