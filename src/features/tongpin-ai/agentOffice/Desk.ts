import { Container, Sprite } from "pixi.js";
import { DESK_SCALE, HEAD_DESK_SCALE } from "./seating";
import { getOfficeTextures } from "./spriteSheets";
import type { DeskRect } from "./seating";

// A desk built from LimeZu's own furniture art (see THIRD_PARTY_NOTICES.md)
// instead of the office's previous procedurally-drawn Graphics desk. Unlike
// the scene's earlier (Pixel Agents) rig — a desk sprite plus a separately
// swapped monitor sprite layered on top — LimeZu's desk+monitor come as one
// piece per screen state, so this desk is a single Sprite that swaps its
// whole texture: `deskOff` when the monitor is off, alternating between
// `deskOn`'s two frames on a timer while it's on (both share the same desk
// body, so only the monitor reads as "active" — see spriteAssets.ts).
//
// Kept as two layers (`back`/`front`) for the same reason the previous
// version was: EmployeeFigure seats its CharacterSprite *between* them, so
// the character's head/shoulders read as in front of the desk while its
// lower body sits behind the desk+monitor art. `back` has nothing of its own
// to draw (this office doesn't use a separate chair sprite — see
// THIRD_PARTY_NOTICES.md), but stays as an empty layer so that seam — and
// EmployeeFigure's z-ordering of it — doesn't need to change either way.

const SCREEN_FRAME_DURATION_SEC = 0.4;

export class Desk {
  /** Empty on purpose — see the class doc comment. Kept only so
   *  EmployeeFigure's three-layer z-order (back < character < front) still
   *  has a slot to insert behind the character. */
  readonly back: Container;
  /** Desk + monitor sprite, drawn in front of the seated character. */
  readonly front: Container;
  private readonly deskSprite: Sprite;
  private on = false;
  private onFrame: 0 | 1 = 0;
  private onTimer = 0;

  constructor(rect: DeskRect, opts: { head?: boolean } = {}) {
    this.back = new Container();
    this.front = new Container();

    const scale = opts.head ? HEAD_DESK_SCALE : DESK_SCALE;
    const textures = getOfficeTextures();

    this.deskSprite = new Sprite(textures.deskOff);
    this.deskSprite.scale.set(scale);
    this.deskSprite.position.set(rect.x, rect.y);

    this.front.addChild(this.deskSprite);
  }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.onFrame = 0;
    this.onTimer = 0;
    const textures = getOfficeTextures();
    this.deskSprite.texture = on ? textures.deskOn[0] : textures.deskOff;
  }

  /** `instant`: freeze on the current frame instead of cycling — reduced
   *  motion / idempotent replays never need the screen to "animate in". */
  update(dt: number, instant = false): void {
    if (!this.on || instant) return;
    this.onTimer += dt;
    if (this.onTimer >= SCREEN_FRAME_DURATION_SEC) {
      this.onTimer -= SCREEN_FRAME_DURATION_SEC;
      this.onFrame = this.onFrame === 0 ? 1 : 0;
      this.deskSprite.texture = getOfficeTextures().deskOn[this.onFrame];
    }
  }

  destroy(): void {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
  }
}
