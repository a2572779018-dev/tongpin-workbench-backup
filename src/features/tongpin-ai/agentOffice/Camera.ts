import type { Container } from "pixi.js";

// Fits the fixed-size office world into whatever the host element measures,
// centered, with a gentle lerp toward the target so a container resize (e.g.
// the chat column widening) settles smoothly instead of snapping. Adapted
// from the MIT-licensed chaitanyagiri/munder-difflin project's
// `src/renderer/src/scene/office/Camera.ts` (see THIRD_PARTY_NOTICES.md),
// trimmed to just fit-to-screen + resize: this scene never pans or zooms to
// a particular desk, so the upstream's focusOn()/nudgeToward() are dropped.

const LERP_SPEED = 0.12;

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

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    this.targetScale = this.fitScale();
  }

  private fitScale(): number {
    if (this.viewWidth <= 0 || this.viewHeight <= 0) return 1;
    const raw = Math.min(this.viewWidth / this.worldWidth, this.viewHeight / this.worldHeight);
    // Snap to a whole-pixel multiple so every sprite samples crisply at
    // 2×/3× — real pixel art, unlike the office's old procedural Graphics
    // drawing, shows shimmer/blur under a fractional scale. Only snap when
    // there is room to grow into a whole step, though: a panel too small to
    // fit the world even at 1× still shrinks smoothly instead of cropping
    // it — a softer frame beats slicing the office in half.
    return raw >= 1 ? Math.floor(raw) : raw;
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
