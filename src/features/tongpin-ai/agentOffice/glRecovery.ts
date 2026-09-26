/**
 * Surviving a lost WebGL context.
 *
 * Chromium caps how many WebGL contexts one renderer process may hold (~16) and,
 * when a new one pushes past the cap, it EVICTS THE OLDEST — logging only
 * "WARNING: Too many active WebGL contexts. Oldest context will be lost."
 * Pixi does not notice on its own: no exception, no rejected promise, no
 * failure banner — the canvas simply stops drawing. This module is only the
 * event wiring, kept separate from the scene so the recovery policy — cancel
 * the event, debounce, cap the retries, give up loudly — is testable against a
 * plain EventTarget with no browser, no GPU and no Pixi.
 *
 * Ported (adapted) from the MIT-licensed chaitanyagiri/munder-difflin project's
 * `src/renderer/src/scene/office/glRecovery.ts` — see THIRD_PARTY_NOTICES.md.
 * This module is pure event/decision logic; nothing here is tied to that
 * project's map, cast or assets.
 */

export interface GlRecoveryOptions {
  /** Rebuild attempts before we stop fighting for a context. */
  maxRebuilds?: number;
  /** Wait before rebuilding: the eviction arrives mid-storm (several contexts
   *  are usually created at once), and claiming one back immediately just races
   *  whatever displaced us. */
  delayMs?: number;
  /** Rebuild the scene (bump the caller's mount generation). */
  onRebuild: () => void;
  /** Called once, when the retry budget is spent — the caller should say
   *  something visible rather than leaving a silently blank canvas. */
  onGiveUp?: () => void;
  /** Injectable for tests. */
  schedule?: (fn: () => void, ms: number) => unknown;
  log?: (msg: string) => void;
}

export const DEFAULT_MAX_REBUILDS = 3;
export const DEFAULT_REBUILD_DELAY_MS = 1500;

/** Listen for context loss on `canvas` and rebuild. Returns an uninstall fn;
 *  call it from the effect cleanup so a torn-down scene stops responding. */
export function installContextLossRecovery(
  canvas: EventTarget,
  opts: GlRecoveryOptions,
): () => void {
  const max = opts.maxRebuilds ?? DEFAULT_MAX_REBUILDS;
  const delay = opts.delayMs ?? DEFAULT_REBUILD_DELAY_MS;
  const schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const log = opts.log ?? ((m: string) => console.warn(m));

  let rebuilds = 0;
  let live = true;

  const onLost = (e: Event) => {
    // WITHOUT preventDefault the browser will never hand the context back — the
    // canvas is dead for good. This one line is the difference between a
    // recoverable scene and a permanently blank one.
    e.preventDefault();
    if (!live) return;
    if (rebuilds >= max) {
      log(`[AgentOffice] WebGL context lost again after ${max} rebuilds — giving up until the reply is re-opened`);
      opts.onGiveUp?.();
      live = false;
      return;
    }
    rebuilds += 1;
    log(`[AgentOffice] WebGL context lost — rebuilding the scene, attempt ${rebuilds}/${max}`);
    schedule(() => { if (live) opts.onRebuild(); }, delay);
  };

  canvas.addEventListener("webglcontextlost", onLost as EventListener, false);
  return () => {
    live = false;
    canvas.removeEventListener("webglcontextlost", onLost as EventListener, false);
  };
}

/* ─── Failing to GET a context in the first place ──────────────────────────────
 *
 * The recovery above only starts listening once `app.init()` has resolved, so it
 * cannot help when the REBUILD it schedules cannot get a context either. That is
 * what happens when the GPU process dies rather than when a context is evicted:
 * the rebuild fires later, and Chromium is still bringing the GPU process back.
 * getContext() returns null and Pixi turns that into
 *
 *   Error: This browser does not support WebGL. Try using the canvas renderer
 *
 * which is both untrue and unactionable as a message — the browser supports
 * WebGL fine, the GPU process just is not there yet. Treating it as fatal would
 * leave the panel dead until the whole app restarts, over a condition that
 * clears itself in a second or two. So: retry a few times, then fall back to
 * the DOM list rather than show a stack trace where a floor should be.
 *
 * Kept as a pure classifier + planner so the policy is testable without a
 * browser, a GPU or Pixi — same as the loss path.
 */

/** Retries before we accept that the scene cannot have a context right now. */
export const DEFAULT_MAX_INIT_RETRIES = 3;

/** Messages meaning "no context for you", across Pixi and Chromium wordings.
 *  Deliberately narrow: anything that is NOT recognised here is reported as the
 *  bug it probably is, rather than hidden behind several seconds of retries. */
const CONTEXT_UNAVAILABLE = [
  /does not support webgl/i, // Pixi 8, verbatim
  /web(gl|gpu)\d?\s*(is\s+)?(not\s+(supported|available)|unsupported|unavailable)/i,
  /(unable|failed) to (create|get|obtain)[^.]*context/i,
  /no (webgl|gpu|rendering) context/i,
];

/** True when `err` says a rendering context could not be obtained — a busy
 *  process, not a browser without WebGL. Follows the `cause` chain so a caller
 *  that wrapped the failure in its own Error still classifies correctly. */
export function isContextUnavailableError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth++) {
    const msg = typeof e === "string" ? e : (e as { message?: unknown })?.message;
    if (typeof msg === "string" && CONTEXT_UNAVAILABLE.some((re) => re.test(msg))) return true;
    e = (e as { cause?: unknown })?.cause;
  }
  return false;
}

export type InitFailurePlan =
  /** Wait `delayMs`, then build the scene again from scratch. */
  | { action: "retry"; delayMs: number; attempt: number }
  /** Out of budget: fall back to the static DOM list. */
  | { action: "give-up" }
  /** Not a context problem — it is a real failure; fall back too, but it is
   *  worth logging distinctly from a busy-GPU retry loop. */
  | { action: "report" };

/** Decide what a rejected pixi init means. `attemptsUsed` is how many retries
 *  this mount has already spent, so the budget survives across rebuilds. */
export function planInitFailure(
  err: unknown,
  attemptsUsed: number,
  opts: { maxRetries?: number; delayMs?: number } = {},
): InitFailurePlan {
  if (!isContextUnavailableError(err)) return { action: "report" };
  const max = opts.maxRetries ?? DEFAULT_MAX_INIT_RETRIES;
  if (attemptsUsed >= max) return { action: "give-up" };
  // Same delay as a rebuild: a GPU process takes a moment to come back, and
  // asking again immediately just gets the same null.
  return { action: "retry", delayMs: opts.delayMs ?? DEFAULT_REBUILD_DELAY_MS, attempt: attemptsUsed + 1 };
}
