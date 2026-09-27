import { Container, Sprite } from "pixi.js";
import { DESK_SCALE, DESK_SIDE_NATIVE_W, HEAD_DESK_SCALE } from "./seating";
import { getOfficeTextures } from "./spriteSheets";
import type { DeskRect } from "./seating";

// A desk built from LimeZu's own furniture art (see THIRD_PARTY_NOTICES.md)
// instead of the office's previous procedurally-drawn Graphics desk. LimeZu's
// desk+monitor come as one piece per screen state, so this desk is a single
// Sprite that swaps its whole texture: `deskOff` when the monitor is off,
// alternating between `deskOn`'s two frames on a timer while it's on (both
// share the same desk body, so only the monitor reads as "active" — see
// spriteAssets.ts). Flanked by two plain-desk-surface slices (deskSide) so
// the whole desk reads as ~2 tiles wide, like the reference office, without
// the character's own centering math (which stays keyed to the monitor
// module's own width — see seating.ts's DESK_W doc comment) needing to
// change at all.
//
// This sprite's native top half is the monitor screen and is ~fully opaque
// (confirmed by direct pixel inspection — see this feature's report), so
// unlike the office's very first LimeZu pass, nothing is ever layered
// *behind* this sprite expecting to peek through it: EmployeeFigure now
// draws the whole desk first (furthest back) and seats the chair+character
// entirely in front of and below it instead — see its doc comment.

const SCREEN_FRAME_DURATION_SEC = 0.4;

export class Desk {
  /** Desk + monitor sprite (plus its two side fillers). Drawn first
   *  (furthest back) by EmployeeFigure — see its doc comment for the full
   *  front-to-back order. */
  readonly container: Container;
  private readonly deskSprite: Sprite;
  private on = false;
  private onFrame: 0 | 1 = 0;
  private onTimer = 0;

  constructor(rect: DeskRect, opts: { head?: boolean } = {}) {
    this.container = new Container();

    const scale = opts.head ? HEAD_DESK_SCALE : DESK_SCALE;
    const textures = getOfficeTextures();

    const sideLeft = new Sprite(textures.deskSide);
    sideLeft.scale.set(scale);
    sideLeft.position.set(rect.x - DESK_SIDE_NATIVE_W * scale, rect.y);

    const sideRight = new Sprite(textures.deskSide);
    sideRight.scale.set(scale);
    sideRight.position.set(rect.x + rect.w, rect.y);

    this.deskSprite = new Sprite(textures.deskOff);
    this.deskSprite.scale.set(scale);
    this.deskSprite.position.set(rect.x, rect.y);

    this.container.addChild(sideLeft, sideRight, this.deskSprite);
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
    this.container.destroy({ children: true });
  }
}
