import { planInitFailure, type InitFailurePlan } from "./glRecovery";

// Pixi.js is loaded lazily so the main chat bundle doesn't grow for members
// who never open a Pro multi-agent reply. `LoadPixi` is injected (rather than
// this module calling `import("pixi.js")` itself) so the retry/give-up policy
// is unit-testable with a fake loader that resolves or rejects on demand —
// no real dynamic import, no bundler, no browser needed.
export type LoadPixi = () => Promise<unknown>;

export type AttemptResult =
  | { ok: true; module: unknown }
  | { ok: false; plan: InitFailurePlan };

/** Try to load pixi.js once, classifying a failure via glRecovery's shared
 *  "busy GPU vs real bug" policy so a transient failure retries and a real
 *  one (or a spent retry budget) falls back to the static DOM list. */
export async function attemptLoadPixi(loadPixi: LoadPixi, retriesUsed: number): Promise<AttemptResult> {
  try {
    const module = await loadPixi();
    return { ok: true, module };
  } catch (err) {
    return { ok: false, plan: planInitFailure(err, retriesUsed) };
  }
}
