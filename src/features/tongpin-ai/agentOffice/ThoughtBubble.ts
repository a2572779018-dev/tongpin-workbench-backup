import { Container, Graphics, Text } from "pixi.js";
import { palette } from "./palette";

// A comic "thought cloud" pinned above the coordinator's head showing the
// current phase's caption ("正在拆解任务…" / "正在综合结果…"). Adapted from the
// MIT-licensed chaitanyagiri/munder-difflin project's
// `src/renderer/src/scene/office/ThoughtBubble.ts` (see THIRD_PARTY_NOTICES.md):
// same fade/linger state machine and word-wrap approach, restyled to 同频's
// warm palette and simplified to plain text (the upstream version could also
// prefix a "carried tool" glyph, which the coordinator has no use for here).

const PADDING_X = 6;
const PADDING_Y = 3;
const CORNER_RADIUS = 5;
const MAX_WIDTH = 150;
const FILL_COLOR = palette.cream;
const OUTLINE_COLOR = palette.ink;
const TEXT_COLOR = "#3d3a2f";
// 24 * RENDER_SCALE(0.5) = 12 CSS-px-equivalent final size once
// EmployeeFigure's own per-frame counter-scale (see its update()) cancels out
// whatever the camera's own zoom is — matching the "≥12 CSS px, crisp" bar
// for screen-space text. RENDER_SCALE itself stays a separate, smaller
// pre-scale-then-shrink step purely for glyph crispness (unrelated to sizing).
const FONT_SIZE = 24;
const RENDER_SCALE = 0.5;
const OFFSET_Y = -34;
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 1.2;
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
const MAX_CHARS = 120;

type BubbleState = "hidden" | "fading-in" | "visible" | "lingering" | "fading-out";

export class ThoughtBubble {
  readonly container: Container;
  private inner: Container;
  private bg: Graphics;
  private tail: Graphics;
  private label: Text;
  private state: BubbleState = "hidden";
  private fadeElapsed = 0;
  private lingerElapsed = 0;
  private bgW = 0;
  private bgH = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100_000;
    this.container.eventMode = "none";
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.tail = new Graphics();
    this.bg = new Graphics();
    this.label = new Text({
      text: "",
      style: {
        fontSize: FONT_SIZE,
        fontWeight: "bold",
        fill: TEXT_COLOR,
        fontFamily: "monospace",
        align: "left",
        wordWrap: true,
        wordWrapWidth: WRAP_WIDTH,
        breakWords: true,
      },
    });
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    this.inner.addChild(this.tail, this.bg, this.label);
  }

  /** Show `text` (already the final caption — callers derive it, e.g. via
   *  diff.ts's coordinatorCaptionText). Calling this again with unchanged
   *  text while already visible is a cheap no-op re-fade skip. */
  show(text: string): void {
    const trimmed = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1).trimEnd() + "…" : text;
    if (trimmed === this.label.text && this.state !== "hidden" && this.state !== "fading-out") return;
    this.label.text = trimmed;
    this.redraw();
    this.reveal();
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

  /** Begin fading out (after a short linger) — call when there's no caption. */
  startLinger(): void {
    if (this.state === "hidden") return;
    this.state = "lingering";
    this.lingerElapsed = 0;
  }

  /** `scale` (default 1) is EmployeeFigure's per-frame counter-scale, applied
   *  to this whole bubble so its on-screen size stays constant regardless of
   *  the camera's own zoom — see EmployeeFigure.update(). Recomputing the
   *  offset with `scale` folded in keeps the bubble centered/anchored exactly
   *  as before at any scale, rather than drifting off the character's head
   *  (Pixi scales a container's children around its own local origin, not
   *  around whatever point `setPosition`'s un-scaled math had in mind). */
  setPosition(px: number, py: number, scale = 1): void {
    this.container.scale.set(scale);
    const x = px - (this.bgW * RENDER_SCALE * scale) / 2;
    const y = py + OFFSET_Y * scale - this.bgH * RENDER_SCALE * scale;
    this.container.x = Math.round(x);
    this.container.y = Math.round(y);
  }

  hide(): void {
    this.state = "hidden";
    this.container.alpha = 0;
    this.container.visible = false;
  }

  isHidden(): boolean {
    return this.state === "hidden";
  }

  /** Advance fades. `instant` (reduced motion / idempotent replays) skips
   *  straight to the settled state instead of animating toward it. */
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

  private redraw(): void {
    this.bgW = this.label.width + PADDING_X * 2;
    this.bgH = this.label.height + PADDING_Y * 2;

    this.bg.clear();
    this.bg.roundRect(0, 0, this.bgW, this.bgH, CORNER_RADIUS);
    this.bg.fill({ color: FILL_COLOR });
    this.bg.stroke({ color: OUTLINE_COLOR, width: 1 });

    this.tail.clear();
    const baseX = this.bgW * 0.32;
    const puff = (cx: number, cy: number, r: number) => {
      this.tail.circle(cx, cy, r).fill({ color: FILL_COLOR }).stroke({ color: OUTLINE_COLOR, width: 1 });
    };
    puff(baseX, this.bgH + 4, 3);
    puff(baseX - 5, this.bgH + 9, 2);
  }
}
