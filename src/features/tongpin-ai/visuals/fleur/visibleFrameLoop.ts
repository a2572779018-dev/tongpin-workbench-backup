export const FLEUR_MAX_FPS = 30;
const FRAME_MS = 1000 / FLEUR_MAX_FPS;
// RAF timestamps can be rounded to 0.1ms; don't miss a full display frame for
// a sub-millisecond rounding difference at an otherwise exact deadline.
const CLOCK_TOLERANCE_MS = 0.25;

export interface FrameScheduler {
  request(callback: (now: number) => void): number;
  cancel(id: number): void;
}

/** A visible-only clock. Stopping cancels RAF; resuming never counts hidden wall time. */
export function createVisibleFrameLoop(draw: (visibleMs: number, deltaMs: number) => void, scheduler: FrameScheduler) {
  let active = false;
  let disposed = false;
  let raf: number | null = null;
  let previous: number | null = null;
  let nextPaintAt = 0;
  let visibleMs = 0;
  const schedule = () => { if (active && !disposed && raf === null) raf = scheduler.request(frame); };
  const frame = (now: number) => {
    raf = null;
    if (!active || disposed) return;
    if (previous === null) { previous = now; nextPaintAt = now + FRAME_MS; }
    const delta = Math.max(0, now - previous);
    if (now + CLOCK_TOLERANCE_MS >= nextPaintAt) {
      previous = now;
      // Preserve the 30fps deadline phase instead of adding a full interval
      // to a rounded RAF timestamp (which regularly dropped 60Hz to 20fps).
      const elapsedSlots = Math.floor(Math.max(0, now + CLOCK_TOLERANCE_MS - nextPaintAt) / FRAME_MS) + 1;
      // Lock a nearly coincident deadline back to the actual display phase.
      // Real 60Hz clocks drift slightly from exact 1000/60; a permanently fixed
      // phase otherwise turns that tiny drift into alternating 3/1-frame gaps.
      nextPaintAt = Math.abs(now - nextPaintAt) <= CLOCK_TOLERANCE_MS
        ? now + FRAME_MS
        : nextPaintAt + elapsedSlots * FRAME_MS;
      visibleMs += delta;
      draw(visibleMs, delta);
    }
    schedule();
  };
  return {
    get visibleMs() { return visibleMs; },
    redraw() { if (!disposed) draw(visibleMs, 0); },
    setActive(value: boolean) {
      if (disposed || value === active) return;
      active = value;
      previous = null;
      if (!active && raf !== null) { scheduler.cancel(raf); raf = null; }
      schedule();
    },
    dispose() {
      disposed = true;
      active = false;
      previous = null;
      if (raf !== null) { scheduler.cancel(raf); raf = null; }
    },
  };
}

export type VisibleFrameLoop = ReturnType<typeof createVisibleFrameLoop>;
