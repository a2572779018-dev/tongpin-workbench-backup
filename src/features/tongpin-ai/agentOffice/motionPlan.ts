// Pure reduced-motion policy, kept separate from both Pixi and React so it is
// trivial to unit test. `prefersReducedMotion()` is the only part that touches
// the browser; everything else is plain data in → data out.

export interface MotionPlan {
  /** Tween length in ms. 0 means "apply the end state on the next frame". */
  durationMs: number;
  instant: boolean;
}

/** Turn a designed duration into an instant one when motion is reduced. Used
 *  for every one-shot flourish (envelope flight, cheer, fade) so the caller
 *  never special-cases reduced motion itself — it just asks "how long". */
export function planMotion(baseDurationMs: number, reducedMotion: boolean): MotionPlan {
  if (reducedMotion) return { durationMs: 0, instant: true };
  return { durationMs: Math.max(0, baseDurationMs), instant: baseDurationMs <= 0 };
}

/** Reads the live system/browser preference. Guarded for non-browser
 *  environments (tests, SSR) where `window.matchMedia` does not exist. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}
