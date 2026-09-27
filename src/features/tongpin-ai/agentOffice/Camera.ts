import type { Container } from "pixi.js";

// Fits the fixed-size office world into whatever the host element measures,
// centered, with a gentle lerp toward the target so a container resize (e.g.
// the chat column widening) settles smoothly instead of snapping. Adapted
// from the MIT-licensed chaitanyagiri/munder-difflin project's
// `src/renderer/src/scene/office/Camera.ts` (see THIRD_PARTY_NOTICES.md),
// trimmed to just fit-to-screen + resize: this scene never pans or zooms to
// a particular desk, so the upstream's focusOn()/nudgeToward() are dropped.

const LERP_SPEED = 0.12;

// Composed with the scene's own fixed 2x sprite bake (UI_SCALE, see
// seating.ts), these give a whole-number native-px-to-CSS-px zoom of
// 1x/2x/3x — the only levels this scene's nearest-filtered pixel art (see
// spriteSheets.ts's `nearest()`) samples crisply; anything else shimmers or
// blurs. Kept here (not imported from seating.ts) so Camera stays the
// generic, seating-agnostic "fit to screen" utility it always was — it only
// needs to agree with seating.ts on *how many* steps there are and that 1 is
// the middle one, which chooseCameraScale()'s own doc comment explains.
const ALLOWED_SCALES = [0.5, 1, 1.5];

/** The largest allowed scale that still fits within `raw` (so the world never
 *  overflows the viewport) — i.e. "round down to the nearest allowed step".
 *  Falls back to `raw` itself, unsnapped, only when even the smallest step
 *  would overflow: a softer, evenly-shrunk frame beats slicing the office in
 *  half, for a viewport too small to fit at any allowed step. */
function nearestAllowedScale(raw: number): number {
  let snapped = raw;
  for (const candidate of ALLOWED_SCALES) {
    if (candidate <= raw) snapped = candidate;
  }
  return snapped;
}

export class Camera {
  private container: Container;
  private currentX = 0;
  private currentY = 0;
  private currentScale = 1;
  private targetScale = 1;
  private viewWidth = 1;
  private viewHeight = 1;
  private worldWidth: number;
  private worldHeight: number;

  constructor(container: Container, worldWidth: number, worldHeight: number) {
    this.container = container;
    this.worldWidth = worldWidth;
    this.worldHeight = worldHeight;
  }

  /** The scale actually being rendered right now (post-lerp) — read by
   *  OfficeSceneController to counter-scale name labels/bubbles so their text
   *  stays a constant, readable CSS size regardless of camera zoom (see
   *  EmployeeFigure.update()). */
  get scale(): number {
    return this.currentScale;
  }

  /** Update the world size this camera fits (see seating.ts's
   *  computeWorldWidth) — takes effect on the next setViewSize()/update(). */
  setWorldSize(width: number, height: number): void {
    this.worldWidth = width;
    this.worldHeight = height;
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.targetScale = this.fitScale();
  }

  private fitScale(): number {
    if (this.viewWidth <= 0 || this.viewHeight <= 0) return 1;
    const raw = Math.min(this.viewWidth / this.worldWidth, this.viewHeight / this.worldHeight);
    return nearestAllowedScale(raw);
  }

  /** Skip the lerp and snap straight to the fitted, centered pose — used on
   *  first mount and under reduced motion, where a drifting-in scene reads as
   *  unwanted motion rather than a nicety. */
  snapToFit(): void {
    this.targetScale = this.fitScale();
    this.currentScale = this.targetScale;
    this.apply();
  }

  update(): void {
    this.currentScale += (this.targetScale - this.currentScale) * LERP_SPEED;
    this.apply();
  }

  private apply(): void {
    this.container.scale.set(this.currentScale);
    this.currentX = (this.viewWidth - this.worldWidth * this.currentScale) / 2;
    this.currentY = (this.viewHeight - this.worldHeight * this.currentScale) / 2;
    this.container.x = this.currentX;
    this.container.y = this.currentY;
  }
}
