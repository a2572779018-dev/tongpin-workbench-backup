export const FLEUR_MAX_FPS = 30;
const FRAME_MS = 1000 / FLEUR_MAX_FPS;

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
  let visibleMs = 0;
  const schedule = () => { if (active && !disposed && raf === null) raf = scheduler.request(frame); };
  const frame = (now: number) => {
    raf = null;
    if (!active || disposed) return;
    if (previous === null) previous = now;
    const delta = Math.max(0, now - previous);
    if (delta + 0.001 >= FRAME_MS) {
      previous = now;
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
