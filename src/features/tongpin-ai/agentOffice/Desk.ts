import { Container, Graphics } from "pixi.js";
import { palette } from "./palette";
import type { DeskRect } from "./seating";

// A procedurally-drawn desk: chair back, desk surface + apron, and a monitor
// whose screen lights up and shows a small scrolling-lines-and-cursor "the
// screen is doing something" animation while its worker is active. Original
// drawing code (no tileset/tile-gid art involved) — see EmployeeFigure.ts for
// why: 同频's office has no Tiled map to draw from, per this feature's IP
// constraints (see THIRD_PARTY_NOTICES.md).
//
// Split into two layers rather than one: the chair sits BEHIND the bust
// (`back`), the desk surface + monitor sit IN FRONT of it (`front`), so the
// bust reads as seated behind the desk rather than floating in front of it.

const SCREEN_INSET = 3;

export class Desk {
  /** Chair back — give this a lower zIndex than the bust. */
  readonly back: Container;
  /** Desk surface + monitor — give this a higher zIndex than the bust. */
  readonly front: Container;
  private screenGlow: Graphics;
  private screenRect: { x: number; y: number; w: number; h: number };
  private on = false;
  private t = 0;

  constructor(rect: DeskRect, opts: { head?: boolean } = {}) {
    this.back = new Container();
    this.front = new Container();

    const chairW = rect.w * 0.45;
    const chairH = rect.h * 0.6;
    const cx = rect.x + rect.w / 2;
    const chair = new Graphics();
    chair.roundRect(cx - chairW / 2, rect.y, chairW, chairH, 4).fill(palette.deskShade);
    this.back.addChild(chair);

    const body = new Graphics();
    const surfaceY = rect.y + rect.h * 0.52;
    const surfaceH = rect.h - rect.h * 0.52;
    body.roundRect(rect.x, surfaceY, rect.w, surfaceH, 5).fill(palette.desk);
    body.rect(rect.x, surfaceY + surfaceH - 6, rect.w, 6).fill(palette.deskShade);
    if (opts.head) {
      // A thin accent stripe along the front edge marks this as the head
      // desk / meeting table, not just another worker desk.
      body.rect(rect.x, surfaceY + surfaceH - 2, rect.w, 2).fill(palette.yellow);
    }

    // Monitor: bezel + inset screen, centered on the desk surface.
    const monW = rect.w * 0.34;
    const monH = surfaceH * 0.62;
    const monX = cx - monW / 2;
    const monY = surfaceY - monH * 0.55;
    body.roundRect(monX, monY, monW, monH, 2).fill(palette.ink);
    this.screenRect = {
      x: monX + SCREEN_INSET,
      y: monY + SCREEN_INSET,
      w: monW - SCREEN_INSET * 2,
      h: monH - SCREEN_INSET * 2 - 3,
    };
    body.rect(this.screenRect.x, this.screenRect.y, this.screenRect.w, this.screenRect.h).fill(0x1c2430);
    body.rect(cx - 2, monY + monH, 4, 4).fill(palette.deskShade); // stand

    this.screenGlow = new Graphics();
    this.screenGlow.eventMode = "none";
    this.front.addChild(body, this.screenGlow);
  }

  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    if (!on) { this.screenGlow.clear(); this.t = 0; }
  }

  /** `instant`: paint the settled look without depending on elapsed time
   *  (reduced motion / idempotent replays never need this to "animate in"). */
  update(dt: number, instant = false): void {
    if (!this.on) return;
    this.t += dt;
    const g = this.screenGlow;
    const r = this.screenRect;
    g.clear();
    g.rect(r.x, r.y, r.w, r.h).fill({ color: 0x8fb3ff, alpha: 0.16 });
    const lineCount = 2;
    for (let i = 0; i < lineCount; i++) {
      const phase = instant ? (i * r.h) / lineCount : (this.t * 5 + i * (r.h / lineCount)) % r.h;
      const y = r.y + r.h - 1 - phase;
      const w = Math.max(2, Math.round(r.w * 0.5));
      g.rect(r.x + 1, Math.round(y), w, 1).fill({ color: 0xcfe6ff, alpha: 0.6 });
    }
    const cursorOn = instant ? true : Math.floor(this.t / 0.5) % 2 === 0;
    if (cursorOn) g.rect(r.x + 1, r.y + r.h - 2, 2, 2).fill({ color: 0xffffff, alpha: 0.9 });
  }

  destroy(): void {
    this.back.destroy({ children: true });
    this.front.destroy({ children: true });
  }
}
