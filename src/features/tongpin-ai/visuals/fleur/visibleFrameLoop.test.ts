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
