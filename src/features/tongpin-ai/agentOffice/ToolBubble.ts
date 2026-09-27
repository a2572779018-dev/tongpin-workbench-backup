import { Container, Graphics, Text } from "pixi.js";
import { palette } from "./palette";

// Speech bubble shown above a worker's desk: an icon + short text, for the
// "searching" activity and the "done" result summary. Adapted from the
// MIT-licensed chaitanyagiri/munder-difflin project's
// `src/renderer/src/scene/office/ToolBubble.ts` (see THIRD_PARTY_NOTICES.md):
// same fade/linger state machine and word-wrap approach, restyled to 同频's
// warm palette. The upstream icon map covered coding-tool names (Read/Edit/
// Bash/…); this office's icon set instead covers this feature's own two
// bubble kinds (search vs. a finished result).

export type BubbleKind = "search" | "result";

const ICONS: Record<BubbleKind, string> = {
  search: "🔍",
  result: "✓",
};

const PADDING_X = 6;
const PADDING_Y = 3;
const CORNER_RADIUS = 4;
/** Default cap when a caller doesn't pass its own — see the constructor's
 *  `maxWidth` option and seating.ts's WORKER_BUBBLE_MAX_W, which every real
 *  worker bubble is constructed with instead (this default only matters for
 *  a caller with no desk-column budget to hand in). */
const MAX_WIDTH = 150;
const BG_COLOR = palette.ink;
const BG_ALPHA = 0.95;
const TEXT_COLOR = "#fffdf5";
// See ThoughtBubble.ts's own comment on this pairing: 24 * RENDER_SCALE(0.5)
// = 12 CSS-px-equivalent once EmployeeFigure's per-frame counter-scale
// cancels the camera's own zoom — the "≥12 CSS px, crisp" bar for
// screen-space text.
const FONT_SIZE = 24;
const RENDER_SCALE = 0.5;
const OFFSET_Y = -32;
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 2.0;
const MAX_CHARS = 140;

type BubbleState = "hidden" | "fading-in" | "visible" | "lingering" | "fading-out";

export interface ToolBubbleOptions {
  /** World-unit width cap for this instance (see seating.ts's
   *  WORKER_BUBBLE_MAX_W) — defaults to MAX_WIDTH when omitted. */
  maxWidth?: number;
}

export class ToolBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private label: Text;
  private state: BubbleState = "hidden";
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;
  /** This instance's own width budget, in "big" (pre-RENDER_SCALE) text
   *  units — see fitToWidth(). */
  private readonly widthBudget: number;

  constructor(opts: ToolBubbleOptions = {}) {
    const maxWidth = opts.maxWidth ?? MAX_WIDTH;
    this.widthBudget = maxWidth / RENDER_SCALE - PADDING_X * 2;

    this.container = new Container();
    this.container.zIndex = 100_000;
    this.container.eventMode = "none";
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.bg = new Graphics();
    // Single line, ellipsis-truncated to this.widthBudget (see fitToWidth)
    // instead of wordWrap: this office's desks sit close enough together
    // (see WORKER_BUBBLE_MAX_W's own comment) that a bubble wrapping to a
    // second line would need more vertical room than a worker row budgets
    // for — better to shorten than to grow taller into the row above.
    this.label = new Text({
      text: "",
      style: { fontSize: FONT_SIZE, fontWeight: "bold", fill: TEXT_COLOR, fontFamily: "monospace", align: "left" },
    });
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    this.inner.addChild(this.bg, this.label);
  }

  show(kind: BubbleKind, text: string): void {
    const display = `${ICONS[kind]} ${text}`;
    const capped = display.length > MAX_CHARS ? display.slice(0, MAX_CHARS - 1).trimEnd() + "…" : display;
    const previous = this.label.text;
    const fitted = this.fitToWidth(capped);
    if (fitted === previous && this.state !== "hidden" && this.state !== "fading-out") return;
    this.label.text = fitted;
    this.redrawBg();
    this.reveal();
  }

  /** Shortens `text` with a trailing "…" until it renders within
   *  this.widthBudget, measuring via this.label itself (Pixi has no
   *  measure-only API; the mutation is harmless since show() always
   *  re-assigns this.label.text to the final result right after calling
   *  this). Leaves `text` untouched when it already fits. */
  private fitToWidth(text: string): string {
    this.label.text = text;
    if (this.label.width <= this.widthBudget) return text;
    let candidate = text;
    while (candidate.length > 1) {
      candidate = candidate.slice(0, -1);
      this.label.text = `${candidate}…`;
      if (this.label.width <= this.widthBudget) return this.label.text;
    }
    return this.label.text; // down to one character + ellipsis — as short as this gets
  }

  private reveal(): void {
    if (this.state === "hidden" || this.state === "fading-out") {
      this.state = "fading-in";
      this.fadeElapsed = 0;
      this.container.visible = true;
    } else {
      this.state = "visible";
      this.container.alpha = 1;
    }
    this.lingerElapsed = 0;
  }

  startLinger(): void {
    if (this.state === "hidden") return;
    this.state = "lingering";
    this.lingerElapsed = 0;
  }

  /** See ThoughtBubble.setPosition's doc comment: `scale` is EmployeeFigure's
   *  per-frame counter-scale, folded into this offset so the bubble stays
   *  centered/anchored at any scale instead of drifting off the character's
   *  head. `worldWidth`, when given, clamps the bubble's final horizontal
   *  position so it never renders partly off either edge of the room — a
   *  worker seated near the wall would otherwise have its own bubble spill
   *  outside the world despite being correctly centered on its own desk. */
  setPosition(px: number, py: number, scale = 1, worldWidth?: number): void {
    this.container.scale.set(scale);
    const bubbleW = this.bgW * RENDER_SCALE * scale;
    let x = px - bubbleW / 2;
    if (worldWidth !== undefined) x = Math.min(Math.max(x, 0), Math.max(0, worldWidth - bubbleW));
    this.container.x = Math.round(x);
    this.container.y = Math.round(py + OFFSET_Y * scale - this.bgH * RENDER_SCALE * scale);
  }

  hide(): void {
    this.state = "hidden";
    this.container.alpha = 0;
    this.container.visible = false;
  }

  isHidden(): boolean {
    return this.state === "hidden";
  }

  update(dt: number, instant = false): void {
    switch (this.state) {
      case "fading-in": {
        this.fadeElapsed += dt;
        const t = instant ? 1 : Math.min(this.fadeElapsed / FADE_IN_DURATION, 1);
        this.container.alpha = t;
        if (t >= 1) this.state = "visible";
        break;
      }
      case "lingering": {
        this.lingerElapsed += dt;
        if (instant || this.lingerElapsed >= LINGER_DURATION) {
          this.state = "fading-out";
          this.fadeElapsed = 0;
        }
        break;
      }
      case "fading-out": {
        this.fadeElapsed += dt;
        const t = instant ? 1 : Math.min(this.fadeElapsed / FADE_OUT_DURATION, 1);
        this.container.alpha = 1 - t;
        if (t >= 1) this.hide();
        break;
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private redrawBg(): void {
    this.bgW = this.label.width + PADDING_X * 2;
    this.bgH = this.label.height + PADDING_Y * 2;
    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: BG_COLOR, alpha: BG_ALPHA });
  }
}
