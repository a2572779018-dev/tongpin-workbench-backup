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
const MAX_WIDTH = 150;
const BG_COLOR = palette.ink;
const BG_ALPHA = 0.95;
const TEXT_COLOR = "#fffdf5";
const FONT_SIZE = 12;
const RENDER_SCALE = 0.5;
const OFFSET_Y = -32;
const FADE_IN_DURATION = 0.15;
const FADE_OUT_DURATION = 0.3;
const LINGER_DURATION = 2.0;
const WRAP_WIDTH = MAX_WIDTH / RENDER_SCALE - PADDING_X * 2;
const MAX_CHARS = 140;

type BubbleState = "hidden" | "fading-in" | "visible" | "lingering" | "fading-out";

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

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100_000;
    this.container.eventMode = "none";
    this.container.alpha = 0;
    this.container.visible = false;

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

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

    this.inner.addChild(this.bg, this.label);
  }

  show(kind: BubbleKind, text: string): void {
    const display = `${ICONS[kind]} ${text}`;
    const trimmed = display.length > MAX_CHARS ? display.slice(0, MAX_CHARS - 1).trimEnd() + "…" : display;
    if (trimmed === this.label.text && this.state !== "hidden" && this.state !== "fading-out") return;
    this.label.text = trimmed;
    this.redrawBg();
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

  startLinger(): void {
    if (this.state === "hidden") return;
    this.state = "lingering";
    this.lingerElapsed = 0;
  }

  setPosition(px: number, py: number): void {
    const halfBubble = (this.bgW * RENDER_SCALE) / 2;
    this.container.x = Math.round(px - halfBubble);
    this.container.y = Math.round(py + OFFSET_Y - this.bgH * RENDER_SCALE);
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
