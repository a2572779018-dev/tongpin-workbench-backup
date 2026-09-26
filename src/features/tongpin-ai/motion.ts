import autoAnimate, { type AnimationController, type AutoAnimateOptions } from "@formkit/auto-animate";

/** 同频 AI motion budget: short, list-level transitions only (150–220ms). */
export const AI_MOTION_DURATION_MS = 180;
export const AI_MOTION_OPTIONS: Readonly<Partial<AutoAnimateOptions>> = Object.freeze({
  duration: AI_MOTION_DURATION_MS,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  // Deliberately never set disrespectUserMotionPreference: reduced motion wins.
});
/** auto-animate keeps an observer + 2s position poll per child; past this
 * size (long conversation lists) the list stays static on low-end machines. */
export const AI_MOTION_MAX_CHILDREN = 60;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | undefined {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCED_MOTION_QUERY) : undefined;
  } catch {
    return undefined;
  }
}

export function prefersReducedMotion(): boolean {
  return reducedMotionQuery()?.matches === true;
}

interface AttachOptions {
  maxChildren?: number;
  /** Skip parents that already hold content (history rows): only content that
   * arrives live gets an entrance, and settled history carries no observers. */
  onlyIfEmpty?: boolean;
  animate?: (el: HTMLElement, options: Partial<AutoAnimateOptions>) => AnimationController;
}

/** Attaches auto-animate to one parent's direct children. Honors
 * prefers-reduced-motion live (not only at mount) and detaches for large lists. */
export function attachAiMotion(el: HTMLElement, { maxChildren = AI_MOTION_MAX_CHILDREN, onlyIfEmpty = false, animate = autoAnimate }: AttachOptions = {}): () => void {
  if (onlyIfEmpty && el.childElementCount > 0) return () => undefined;
  let controller: AnimationController | undefined;
  const media = reducedMotionQuery();
  const sync = () => {
    const allowed = !media?.matches && el.childElementCount <= maxChildren;
    if (allowed && !controller) controller = animate(el, { ...AI_MOTION_OPTIONS });
    else if (!allowed && controller) {
      controller.destroy?.();
      controller = undefined;
    }
  };
  sync();
  media?.addEventListener?.("change", sync);
  const counter = typeof MutationObserver === "undefined" ? undefined : new MutationObserver(sync);
  counter?.observe(el, { childList: true });
  return () => {
    counter?.disconnect();
    media?.removeEventListener?.("change", sync);
    controller?.destroy?.();
    controller = undefined;
  };
}

/** Stable React 19 callback ref (returns its own cleanup), so re-renders never re-attach. */
export function aiMotionRef(el: HTMLElement | null) {
  return el ? attachAiMotion(el) : undefined;
}

/** For slots whose content should animate in only when it arrives live. */
export function aiLiveMotionRef(el: HTMLElement | null) {
  return el ? attachAiMotion(el, { onlyIfEmpty: true }) : undefined;
}
