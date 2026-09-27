import { Container, Graphics, Text } from "pixi.js";
import { palette } from "./palette";

// The role-name tag shown above each employee's head: a small rounded pixel-
// style bubble with a downward tail, like the reference office's status tags
// — replacing the office's previous plain Text label floating unbadged below
// the character, on the floor (see the feature's report). Structurally a
// simplified sibling of ThoughtBubble/ToolBubble (same render-then-shrink
// crispness trick, same counter-scale `setPosition`), but always visible —
// a role name has no show/hide state machine to run.

const PADDING_X = 5;
const PADDING_Y = 2;
const CORNER_RADIUS = 4;
const TAIL_H = 4;
const TAIL_W = 8;
const FILL_COLOR = palette.cream;
const OUTLINE_COLOR = palette.ink;
const TEXT_COLOR = "#3d3a2f";
// 22 * RENDER_SCALE(0.5) = 11 CSS-px-equivalent once EmployeeFigure's own
// per-frame counter-scale cancels the camera's own zoom — see ThoughtBubble.
// ts's identical comment for why this two-step (render big, then shrink)
// exists at all (glyph crispness, unrelated to sizing).
const FONT_SIZE = 22;
const RENDER_SCALE = 0.5;

export class NameTag {
  readonly container: Container;
  private readonly inner: Container;
  private readonly bg: Graphics;
  private readonly label: Text;
  private bgW = 0;
  private bgH = 0;

  constructor() {
    this.container = new Container();
    this.container.zIndex = 100_000;
    this.container.eventMode = "none";

    this.inner = new Container();
    this.inner.scale.set(RENDER_SCALE);
    this.container.addChild(this.inner);

    this.bg = new Graphics();
    this.label = new Text({
      text: "",
      style: { fontSize: FONT_SIZE, fontWeight: "700", fill: TEXT_COLOR, fontFamily: "sans-serif", align: "center" },
    });
    this.inner.addChild(this.bg, this.label);
  }

  setText(text: string): void {
    if (this.label.text === text) return;
    this.label.text = text;
    this.redraw();
  }

  /** `px, py` is the tag's anchor point in world space — its tail tip, i.e.
   *  just above the character's head. `scale` (default 1) is EmployeeFigure's
   *  per-frame counter-scale — see ThoughtBubble.setPosition's doc comment
   *  for why it must be folded into this offset math rather than applied as
   *  a plain container scale around the wrong origin. `worldWidth`, when
   *  given, clamps the tag's final horizontal position so it never renders
   *  partly outside the room — see ToolBubble's own copy of this doc
   *  comment. */
  setPosition(px: number, py: number, scale = 1, worldWidth?: number): void {
    this.container.scale.set(scale);
    const tagW = this.bgW * RENDER_SCALE * scale;
    let x = px - tagW / 2;
    if (worldWidth !== undefined) x = Math.min(Math.max(x, 0), Math.max(0, worldWidth - tagW));
    const y = py - this.bgH * RENDER_SCALE * scale;
    this.container.x = Math.round(x);
    this.container.y = Math.round(y);
  }

  private redraw(): void {
    const boxW = this.label.width + PADDING_X * 2;
    const boxH = this.label.height + PADDING_Y * 2;
    this.bgW = boxW;
    this.bgH = boxH + TAIL_H;
    this.label.x = PADDING_X;
    this.label.y = PADDING_Y;

    this.bg.clear();
    this.bg.roundRect(0, 0, boxW, boxH, CORNER_RADIUS).fill({ color: FILL_COLOR }).stroke({ color: OUTLINE_COLOR, width: 1 });
    const cx = boxW / 2;
    this.bg.moveTo(cx - TAIL_W / 2, boxH - 1)
      .lineTo(cx + TAIL_W / 2, boxH - 1)
      .lineTo(cx, boxH - 1 + TAIL_H)
      .closePath()
      .fill({ color: FILL_COLOR })
      .stroke({ color: OUTLINE_COLOR, width: 1 });
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
