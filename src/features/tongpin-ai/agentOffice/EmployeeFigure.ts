import { Container, Graphics, Text } from "pixi.js";
import { palette } from "./palette";
import { CharacterSprite } from "./CharacterSprite";
import { Desk } from "./Desk";
import { ThoughtBubble } from "./ThoughtBubble";
import { ToolBubble, type BubbleKind } from "./ToolBubble";
import { characterIndexForRecipe, type RecipeKey } from "./roster";
import { DESK_SCALE, HEAD_DESK_SCALE, type DeskRect } from "./seating";
import { CHAR_FRAME_H } from "./spriteFrameMath";
import { getOfficeTextures } from "./spriteSheets";
import type { VisualState } from "./visualState";

const CHARACTER_SCALE = { worker: DESK_SCALE, coordinator: HEAD_DESK_SCALE } as const;
const BOB_AMPLITUDE = 1.4;
const BOB_SPEED = 5.5;
const FLOURISH_DURATION = 0.7;
/** How far down the desk's height the character's feet-line sits: enough
 *  overlap that the desk + monitor (drawn in front, see Desk.ts) reads as
 *  covering the seated lower body, while the head and shoulders stay above
 *  it. Untunable-by-formula without a rendered screenshot to check against —
 *  see this feature's README/report for a note to eyeball it in the running
 *  app and adjust here if it needs it. */
const SEAT_ANCHOR_FRACTION = 0.58;

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
  private readonly character: CharacterSprite;
  private readonly overlay: Graphics;
  private readonly hit: Graphics;
  private readonly label: Text;
  private readonly thoughtBubble?: ThoughtBubble;
  private readonly toolBubble?: ToolBubble;
  private readonly anchorX: number;
  private readonly anchorY: number;
  private readonly displayH: number;

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

    this.desk = new Desk(opts.rect, { head: opts.kind === "coordinator" });
    // Character behind the desk's own layer, desk surface + monitor in front
    // of it — see Desk.ts's doc comment for why this needs two z-layers.
    this.desk.back.zIndex = opts.rect.y - 2;
    this.desk.front.zIndex = opts.rect.y;

    const scale = CHARACTER_SCALE[opts.kind];
    this.displayH = CHAR_FRAME_H * scale;
    const characterIndex = characterIndexForRecipe(opts.recipe);
    this.character = new CharacterSprite(getOfficeTextures().characters[characterIndex]);
    this.character.sprite.scale.set(scale);
    this.anchorX = opts.rect.x + opts.rect.w / 2;
    this.anchorY = opts.rect.y + opts.rect.h * SEAT_ANCHOR_FRACTION;
    this.character.sprite.x = this.anchorX;
    this.character.sprite.y = this.anchorY;
    this.character.sprite.zIndex = opts.rect.y - 1;

    this.overlay = new Graphics();
    this.overlay.eventMode = "none";
    this.overlay.zIndex = opts.rect.y + 1000;

    this.label = new Text({
      text: opts.label,
      style: { fontSize: 11, fontWeight: "600", fill: "#3f4038", fontFamily: "sans-serif", align: "center" },
    });
    this.label.anchor.set(0.5, 0);
    this.label.x = this.anchorX;
    this.label.y = opts.rect.y + opts.rect.h + 4;
    this.label.zIndex = opts.rect.y + 1000;

    this.hit = new Graphics();
    this.hit.rect(opts.rect.x - 4, opts.rect.y - this.displayH, opts.rect.w + 8, opts.rect.h + this.displayH + 16)
      .fill({ color: 0xffffff, alpha: 0.001 });
    this.hit.eventMode = "static";
    this.hit.cursor = "pointer";
    this.hit.zIndex = opts.rect.y + 2000;
    this.hit.on("pointerover", () => opts.onHover?.(this.id));
    this.hit.on("pointerout", () => opts.onHover?.(null));
    this.hit.on("pointertap", (e) => { e.stopPropagation(); opts.onSelect?.(this.id); });

    this.container.addChild(this.desk.back, this.character.sprite, this.desk.front, this.overlay, this.label, this.hit);

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
    const badgeX = this.anchorX + 12;
    const badgeY = this.anchorY - this.displayH - 4;
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
    this.character.destroy();
    this.overlay.destroy();
    this.hit.destroy();
    this.thoughtBubble?.destroy();
    this.toolBubble?.destroy();
    this.container.destroy({ children: true });
  }
}
