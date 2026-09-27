import { Container, Sprite } from "pixi.js";
import { DESK_SCALE, HEAD_DESK_SCALE } from "./seating";
import { getOfficeTextures } from "./spriteSheets";
import type { DeskRect } from "./seating";

// A desk built from Pixel Agents' own furniture art (DESK_FRONT + PC_FRONT,
// see THIRD_PARTY_NOTICES.md) instead of the office's previous
// procedurally-drawn Graphics desk. The desk and its monitor share one native
// pixel scale — DESK_SCALE (1×) for a worker desk, HEAD_DESK_SCALE (2×) for
// the coordinator's — so both stay crisp under the camera's own integer zoom
// (see Camera.ts): two integers composed are still an integer.
//
// Kept as two layers (`back`/`front`) for the same reason the previous
// version was: EmployeeFigure seats its CharacterSprite *between* them, so
// the character's head/shoulders read as in front of the desk while its
// lower body sits behind the desk+monitor art. `back` has nothing of its own
// to draw (this office doesn't use a separate chair sprite — see
// THIRD_PARTY_NOTICES.md), but stays as an empty layer so that seam — and
// EmployeeFigure's z-ordering of it — doesn't need to change either way.

const PC_FRAME_DURATION_SEC = 0.25;

export class Desk {
  /** Empty on purpose — see the class doc comment. Kept only so
   *  EmployeeFigure's three-layer z-order (back < character < front) still
   *  has a slot to insert behind the character. */
  readonly back: Container;
  /** Desk sprite + monitor, drawn in front of the seated character. */
  readonly front: Container;
  private readonly pcSprite: Sprite;
  private on = false;
  private pcFrame = 0;
  private pcTimer = 0;

  constructor(rect: DeskRect, opts: { head?: boolean } = {}) {
    this.back = new Container();
    this.front = new Container();

    const scale = opts.head ? HEAD_DESK_SCALE : DESK_SCALE;
    const textures = getOfficeTextures();

    const deskSprite = new Sprite(textures.deskFront);
    deskSprite.scale.set(scale);
    deskSprite.position.set(rect.x, rect.y);

    // Centered horizontally on the desk, top-aligned with it — PC_FRONT's
    // sheet is the same native height as DESK_FRONT (both 2 tiles), meant to
    // be layered directly over the desk's own bounding box (see PC's
    // manifest.json: canPlaceOnSurfaces=true) rather than offset from it.
    this.pcSprite = new Sprite(textures.pcOff);
    this.pcSprite.scale.set(scale);
    this.pcSprite.x = rect.x + (rect.w - textures.pcOff.width * scale) / 2;
    this.pcSprite.y = rect.y;

    this.front.addChild(deskSprite, this.pcSprite);
  }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.pcFrame = 0;
    this.pcTimer = 0;
    const textures = getOfficeTextures();
    this.pcSprite.texture = on ? textures.pcOn[0] : textures.pcOff;
  }

  /** `instant`: freeze on the current frame instead of cycling — reduced
   *  motion / idempotent replays never need the screen to "animate in". */
  update(dt: number, instant = false): void {
    if (!this.on || instant) return;
    this.pcTimer += dt;
    if (this.pcTimer >= PC_FRAME_DURATION_SEC) {
      this.pcTimer -= PC_FRAME_DURATION_SEC;
      this.pcFrame = (this.pcFrame + 1) % 3;
      this.pcSprite.texture = getOfficeTextures().pcOn[this.pcFrame];
    }
  }

  destroy(): void {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
  }
}
