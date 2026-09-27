import { Container, Graphics, Sprite, Text } from "pixi.js";
import { palette } from "./palette";
import { CharacterSprite } from "./CharacterSprite";
import { Desk } from "./Desk";
import { ThoughtBubble } from "./ThoughtBubble";
import { ToolBubble, type BubbleKind } from "./ToolBubble";
import { characterIndexForRecipe, type RecipeKey } from "./roster";
import { DESK_SCALE, HEAD_DESK_SCALE, type DeskRect } from "./seating";
import { CHAR_FRAME_H, CHAR_FRAME_W } from "./spriteFrameMath";
import { getOfficeTextures } from "./spriteSheets";
import type { VisualState } from "./visualState";

const CHARACTER_SCALE = { worker: DESK_SCALE, coordinator: HEAD_DESK_SCALE } as const;
const BOB_AMPLITUDE = 1.4;
const BOB_SPEED = 5.5;
const FLOURISH_DURATION = 0.7;
/** Gap below the desk/chair group before the role label starts. Chair.png's
 *  own art (see extract-limezu.py) extends a few native px of legs/base below
 *  the character's own frame height, so this is a flat pad generous enough to
 *  clear that overhang at the *coordinator's* larger HEAD_UI_SCALE, not just
 *  the worker one. */
const LABEL_GAP = 16;

export interface EmployeeFigureOptions {
  id: string;
  kind: "coordinator" | "worker";
  recipe: RecipeKey;
  label: string;
  rect: DeskRect;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string) => void;
}

/** One employee: desk + character + role label + status overlay + activity
 *  bubble. Coordinator and worker share this class — they differ only in
 *  desk/character scale and which bubble (ThoughtBubble vs. ToolBubble) they
 *  carry, per the product spec. */
export class EmployeeFigure {
  readonly id: string;
  readonly container: Container;
  private readonly kind: "coordinator" | "worker";
  private readonly desk: Desk;
  private readonly chairSprite: Sprite;
  private readonly character: CharacterSprite;
  private readonly overlay: Graphics;
  private readonly hit: Graphics;
  private readonly label: Text;
  private readonly thoughtBubble?: ThoughtBubble;
  private readonly toolBubble?: ToolBubble;
  private readonly anchorX: number;
  private readonly anchorY: number;
  private readonly displayH: number;
  private readonly badgeX: number;
  private readonly badgeY: number;

  private greyed = false;
  private busy = false;
  private bobT = 0;
  private flourish: "none" | "success" | "failure" = "none";
  private flourishT = 0;

  constructor(opts: EmployeeFigureOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.container = new Container();
    this.container.sortableChildren = true;

    // Front-to-back order (all z-indices are small, fixed integers — cross
    // figure draw order is handled by OfficeSceneController's own insertion
    // order into `world`, not by these): desk (furthest back, monitor screen
    // fully unobstructed) → chair (mostly hidden behind the seated
    // character, its base peeking out below) → character (back-facing,
    // "sitting in front of" the desk — see CharacterSprite/extract-limezu.py
    // for why this pack's desk art needs a back-facing pose) → overlay/label
    // (always on top, but positioned to clear both the screen and the
    // character — see badgeX/badgeY below).
    this.desk = new Desk(opts.rect, { head: opts.kind === "coordinator" });
    this.desk.container.zIndex = 0;

    const scale = CHARACTER_SCALE[opts.kind];
    this.displayH = CHAR_FRAME_H * scale;
    const characterIndex = characterIndexForRecipe(opts.recipe);
    this.character = new CharacterSprite(getOfficeTextures().characters[characterIndex]);
    this.character.sprite.scale.set(scale);
    this.anchorX = opts.rect.x + opts.rect.w / 2;
    // The character's feet-line sits exactly on the desk's own bottom edge —
    // since the character's native frame height equals the desk sprite's
    // native *body* half (16px each), this puts the character's head right
    // at the screen/body seam, covering the desk's front panel and legs
    // without ever touching the (fully opaque, see Desk.ts) screen above it.
    this.anchorY = opts.rect.y + opts.rect.h;
    this.character.sprite.x = this.anchorX;
    this.character.sprite.y = this.anchorY;
    this.character.sprite.zIndex = 2;

    // Chair: same top-left as the character (both are 16px-native wide), so
    // it reads as "under" the character — its own art is a few native px
    // taller than a character frame, so its base peeks out below the seat.
    this.chairSprite = new Sprite(getOfficeTextures().chair);
    this.chairSprite.scale.set(scale);
    this.chairSprite.position.set(this.anchorX - (CHAR_FRAME_W * scale) / 2, this.anchorY - this.displayH);
    this.chairSprite.zIndex = 1;

    this.overlay = new Graphics();
    this.overlay.eventMode = "none";
    this.overlay.zIndex = 10;
    // Status badge sits at the desk's top-right corner — clear of both the
    // (unobstructed) monitor screen and the character sitting below it, so
    // it never covers a face or the screen glow.
    this.badgeX = opts.rect.x + opts.rect.w - 2;
    this.badgeY = opts.rect.y - 2;

    this.label = new Text({
      text: opts.label,
      style: { fontSize: 11, fontWeight: "600", fill: "#3f4038", fontFamily: "sans-serif", align: "center" },
    });
    this.label.anchor.set(0.5, 0);
    this.label.x = this.anchorX;
    this.label.y = this.anchorY + LABEL_GAP;
    this.label.zIndex = 10;

    this.hit = new Graphics();
    this.hit.rect(opts.rect.x - 4, opts.rect.y - 44, opts.rect.w + 8, opts.rect.h + 44 + LABEL_GAP + 16)
      .fill({ color: 0xffffff, alpha: 0.001 });
    this.hit.eventMode = "static";
    this.hit.cursor = "pointer";
    this.hit.zIndex = 20;
    this.hit.on("pointerover", () => opts.onHover?.(this.id));
    this.hit.on("pointerout", () => opts.onHover?.(null));
    this.hit.on("pointertap", (e) => { e.stopPropagation(); opts.onSelect?.(this.id); });

    this.container.addChild(this.desk.container, this.chairSprite, this.character.sprite, this.overlay, this.label, this.hit);

    if (opts.kind === "coordinator") {
      this.thoughtBubble = new ThoughtBubble();
      this.container.addChild(this.thoughtBubble.container);
      this.thoughtBubble.setPosition(this.anchorX, this.anchorY - this.displayH);
    } else {
      this.toolBubble = new ToolBubble();
      this.container.addChild(this.toolBubble.container);
      this.toolBubble.setPosition(this.anchorX, this.anchorY - this.displayH);
    }
  }

  getAnchor(): { x: number; y: number } {
    return { x: this.anchorX, y: this.anchorY };
  }

  setLabel(text: string): void {
    if (this.label.text !== text) this.label.text = text;
  }

  /** Coordinator only: the phase caption ("正在拆解任务…" / null to hide). */
  setCaption(text: string | null, instant: boolean): void {
    if (!this.thoughtBubble) return;
    if (text) this.thoughtBubble.show(text);
    else if (!this.thoughtBubble.isHidden()) this.thoughtBubble.startLinger();
    if (instant) this.thoughtBubble.update(0, true);
  }

  /** Worker only: the search/result bubble, or null to hide it. */
  setBubble(bubble: { kind: BubbleKind; text: string } | null, instant: boolean): void {
    if (!this.toolBubble) return;
    if (bubble) this.toolBubble.show(bubble.kind, bubble.text);
    else if (!this.toolBubble.isHidden()) this.toolBubble.startLinger();
    if (instant) this.toolBubble.update(0, true);
  }

  applyVisualState(state: VisualState): void {
    this.busy = state.pose === "typing" || state.pose === "searching";
    this.greyed = state.greyed;
    this.desk.setOn(state.monitorOn);
    this.character.setPose(state.pose);
    this.container.alpha = this.greyed ? 0.55 : 1;
    this.character.sprite.tint = this.greyed ? palette.muted : 0xffffff;

    this.overlay.clear();
    const badgeX = this.badgeX;
    const badgeY = this.badgeY;
    if (state.overlay === "check") {
      this.overlay.circle(badgeX, badgeY, 7).fill(palette.green).stroke({ color: palette.ink, width: 1 });
      this.overlay.moveTo(badgeX - 3, badgeY).lineTo(badgeX - 1, badgeY + 3).lineTo(badgeX + 3.5, badgeY - 3.5)
        .stroke({ color: palette.ink, width: 1.5 });
    } else if (state.overlay === "cross") {
      this.overlay.circle(badgeX, badgeY, 7).fill(palette.red).stroke({ color: palette.ink, width: 1 });
      this.overlay.moveTo(badgeX - 3, badgeY - 3).lineTo(badgeX + 3, badgeY + 3)
        .stroke({ color: "#fffdf5", width: 1.5 });
      this.overlay.moveTo(badgeX + 3, badgeY - 3).lineTo(badgeX - 3, badgeY + 3)
        .stroke({ color: "#fffdf5", width: 1.5 });
    }
  }

  /** One-shot celebratory sparkle (done) or a brief shake (failed). */
  playFlourish(kind: "success" | "failure", reducedMotion: boolean): void {
    this.flourish = kind;
    this.flourishT = reducedMotion ? FLOURISH_DURATION : 0;
  }

  update(dt: number, reducedMotion: boolean): void {
    this.desk.update(dt, reducedMotion);
    this.character.update(dt, reducedMotion);
    this.thoughtBubble?.update(dt, reducedMotion);
    this.toolBubble?.update(dt, reducedMotion);

    if (this.busy && !reducedMotion) {
      this.bobT += dt;
      this.character.sprite.y = this.anchorY + Math.sin(this.bobT * BOB_SPEED) * BOB_AMPLITUDE;
    } else {
      this.bobT = 0;
      this.character.sprite.y = this.anchorY;
    }

    if (this.flourish !== "none") {
      this.flourishT += dt;
      const t = Math.min(this.flourishT / FLOURISH_DURATION, 1);
      if (this.flourish === "failure" && !reducedMotion) {
        this.container.x = Math.sin(this.flourishT * 40) * (1 - t) * 2;
      } else {
        this.container.x = 0;
      }
      if (t >= 1) { this.flourish = "none"; this.container.x = 0; }
    }
  }

  destroy(): void {
    this.desk.destroy();
    this.chairSprite.destroy();
    this.character.destroy();
    this.overlay.destroy();
    this.hit.destroy();
    this.thoughtBubble?.destroy();
    this.toolBubble?.destroy();
    this.container.destroy({ children: true });
  }
}
