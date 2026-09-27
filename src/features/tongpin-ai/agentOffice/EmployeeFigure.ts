import { Container, Graphics, Sprite } from "pixi.js";
import { palette } from "./palette";
import { CharacterSprite } from "./CharacterSprite";
import { Desk } from "./Desk";
import { NameTag } from "./NameTag";
import { ThoughtBubble } from "./ThoughtBubble";
import { ToolBubble, type BubbleKind } from "./ToolBubble";
import { characterIndexForRecipe, type RecipeKey } from "./roster";
import { DESK_SCALE, WORKER_BUBBLE_MAX_W, WORLD_WIDTH, type DeskRect } from "./seating";
import { CHAR_FRAME_H, CHAR_FRAME_W } from "./spriteFrameMath";
import { getOfficeTextures } from "./spriteSheets";
import type { VisualState } from "./visualState";

const BOB_AMPLITUDE = 1.4;
const BOB_SPEED = 5.5;
const FLOURISH_DURATION = 0.7;
/** Gap between the name tag's tail tip and the top of the character's hair. */
const NAME_TAG_GAP = 3;
/** NameTag's own rendered height (world units, at counter-scale 1) — an
 *  estimate (its exact pixel height depends on Pixi's own text-metrics, which
 *  this module has no reason to import), generous enough that the activity
 *  bubble above it never overlaps even for a two-character role label. */
const NAME_TAG_APPROX_H = 18;
/** Extra clearance, on top of the name tag's own height, between it and
 *  whatever activity bubble (ThoughtBubble/ToolBubble) sits above it. */
const BUBBLE_GAP_ABOVE_NAME_TAG = 4;
/** How far (native px) the chair sprite drops below the character's own top
 *  — see the constructor's own comment for why this is needed now that both
 *  sprites share the same native height. */
const CHAIR_DROP_NATIVE = 6;
/** Caps how far update()'s counter-scale (see below) can grow past 1. At the
 *  default camera scale (1) counter is exactly 1 (a no-op) — this only
 *  affects the narrow-panel fallback (camera scale 0.5, counter would
 *  otherwise be 2): full counter-scaling would keep text at a *constant*
 *  CSS size there too, but desk spacing (seating.ts's ROW_GAP) is a fixed
 *  world-unit constant, not itself scale-aware, so an uncapped 2x text
 *  footprint can crowd neighboring labels/bubbles at that one fallback step.
 *  Capping trades a bit of that fallback's text size (still well above the
 *  pre-fix ~6px) for keeping the crowding modest. */
const MAX_LABEL_COUNTER_SCALE = 1.35;

export interface EmployeeFigureOptions {
  id: string;
  kind: "coordinator" | "worker";
  recipe: RecipeKey;
  label: string;
  rect: DeskRect;
  /** Current world width (see seating.ts's computeWorldWidth) — clamps this
   *  figure's name tag/activity bubble so neither renders partly outside the
   *  room (see NameTag/ThoughtBubble/ToolBubble's own setPosition). Defaults
   *  to the fixed fallback WORLD_WIDTH so tests/call sites that don't pass it
   *  still behave (no clamping tighter than the room's own usual width). */
  worldWidth?: number;
  onHover?: (id: string | null) => void;
  onSelect?: (id: string) => void;
}

/** One employee: desk + character + role label + status overlay + activity
 *  bubble. Coordinator and worker share this class — they differ only in
 *  desk scale and which bubble (ThoughtBubble vs. ToolBubble) they carry, per
 *  the product spec. The character/chair themselves render at the same
 *  scale for both: an earlier revision scaled the coordinator's character up
 *  with its desk, but a full 16×32 body at that scale read as oversized next
 *  to the room's other figures and its taller footprint left no vertical
 *  room for the worker row below it — see the feature's report. */
export class EmployeeFigure {
  readonly id: string;
  readonly container: Container;
  private readonly kind: "coordinator" | "worker";
  private readonly desk: Desk;
  private readonly chairSprite: Sprite;
  private readonly character: CharacterSprite;
  private readonly overlay: Graphics;
  private readonly hit: Graphics;
  private readonly nameTag: NameTag;
  private readonly thoughtBubble?: ThoughtBubble;
  private readonly toolBubble?: ToolBubble;
  private readonly anchorX: number;
  private readonly anchorY: number;
  private readonly displayH: number;
  private readonly badgeX: number;
  private readonly badgeY: number;
  private readonly worldWidth: number;

  private greyed = false;
  private busy = false;
  private bobT = 0;
  private flourish: "none" | "success" | "failure" = "none";
  private flourishT = 0;

  constructor(opts: EmployeeFigureOptions) {
    this.id = opts.id;
    this.kind = opts.kind;
    this.worldWidth = opts.worldWidth ?? WORLD_WIDTH;
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

    // Always the worker scale — see this class's own doc comment for why the
    // coordinator's character/chair no longer scale up with its (still
    // bigger) desk.
    const scale = DESK_SCALE;
    this.displayH = CHAR_FRAME_H * scale;
    const characterIndex = characterIndexForRecipe(opts.recipe);
    this.character = new CharacterSprite(getOfficeTextures().characters[characterIndex]);
    this.character.sprite.scale.set(scale);
    this.anchorX = opts.rect.x + opts.rect.w / 2;
    // The character is now a full head-to-feet frame (see spriteFrameMath.ts
    // / extract-limezu.py — this pack's 16x32 pose, not just its top 16px
    // "bust"), so unlike the office's previous revision, its feet no longer
    // sit at the desk's own bottom edge — that would push a body this tall
    // up into the (opaque, see Desk.ts) monitor screen above. Instead its
    // HEAD starts at the desk's screen/body seam (exactly rect.h/2 down from
    // the desk's top, since desk_on/off's own screen is precisely the top
    // native half of that sprite — see spriteAssets.ts) and extends downward
    // from there by its own full height, past the desk's bottom edge and
    // into the chair — see the report's derivation.
    this.anchorY = opts.rect.y + opts.rect.h / 2 + this.displayH;
    this.character.sprite.x = this.anchorX;
    this.character.sprite.y = this.anchorY;
    this.character.sprite.zIndex = 2;

    // Chair: same width/left edge as the character (both 16px-native wide),
    // dropped a small flat pad below the character's own top so its base
    // peeks out below the seat (both sprites are now the same native
    // height, so without this offset the chair would sit exactly behind the
    // character with nothing showing at all).
    const chairDropWorld = CHAIR_DROP_NATIVE * scale;
    this.chairSprite = new Sprite(getOfficeTextures().chair);
    this.chairSprite.scale.set(scale);
    this.chairSprite.position.set(this.anchorX - (CHAR_FRAME_W * scale) / 2, this.anchorY - this.displayH + chairDropWorld);
    this.chairSprite.zIndex = 1;

    this.overlay = new Graphics();
    this.overlay.eventMode = "none";
    this.overlay.zIndex = 10;
    // Status badge sits at the desk's top-right corner — clear of both the
    // (unobstructed) monitor screen and the character sitting below it, so
    // it never covers a face or the screen glow.
    this.badgeX = opts.rect.x + opts.rect.w - 2;
    this.badgeY = opts.rect.y - 2;

    this.nameTag = new NameTag();
    this.nameTag.setText(opts.label);

    this.hit = new Graphics();
    const headTopY = this.anchorY - this.displayH;
    this.hit.rect(opts.rect.x - 4, headTopY - 40, opts.rect.w + 8, this.anchorY - headTopY + 40 + 16)
      .fill({ color: 0xffffff, alpha: 0.001 });
    this.hit.eventMode = "static";
    this.hit.cursor = "pointer";
    this.hit.zIndex = 20;
    this.hit.on("pointerover", () => opts.onHover?.(this.id));
    this.hit.on("pointerout", () => opts.onHover?.(null));
    this.hit.on("pointertap", (e) => { e.stopPropagation(); opts.onSelect?.(this.id); });

    this.container.addChild(
      this.desk.container,
      this.chairSprite,
      this.character.sprite,
      this.overlay,
      this.nameTag.container,
      this.hit,
    );

    if (opts.kind === "coordinator") {
      this.thoughtBubble = new ThoughtBubble();
      this.container.addChild(this.thoughtBubble.container);
      this.thoughtBubble.setPosition(this.anchorX, this.anchorY - this.displayH, 1, this.worldWidth);
    } else {
      // Capped to this desk's own column width (see seating.ts's
      // WORKER_BUBBLE_MAX_W) so a long activity string shortens with an
      // ellipsis instead of bleeding into a neighboring worker's own bubble.
      this.toolBubble = new ToolBubble({ maxWidth: WORKER_BUBBLE_MAX_W });
      this.container.addChild(this.toolBubble.container);
      this.toolBubble.setPosition(this.anchorX, this.anchorY - this.displayH, 1, this.worldWidth);
    }
  }

  getAnchor(): { x: number; y: number } {
    return { x: this.anchorX, y: this.anchorY };
  }

  setLabel(text: string): void {
    this.nameTag.setText(text);
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

  update(dt: number, reducedMotion: boolean, cameraScale: number): void {
    this.desk.update(dt, reducedMotion);
    this.character.update(dt, reducedMotion);
    this.thoughtBubble?.update(dt, reducedMotion);
    this.toolBubble?.update(dt, reducedMotion);

    // Counter-scale the name label and activity bubble every frame so their
    // text renders at a constant, readable CSS size regardless of the
    // camera's own zoom (see Camera.ts's `scale` getter and seating.ts's
    // chooseCameraScale) — everything else in this figure (desk, chair,
    // character, status badge) stays world-scaled on purpose, since those are
    // art, not text that needs to stay legible at any zoom.
    const counter = cameraScale > 0 ? Math.min(1 / cameraScale, MAX_LABEL_COUNTER_SCALE) : 1;
    const headTopY = this.anchorY - this.displayH;
    const nameTagY = headTopY - NAME_TAG_GAP;
    this.nameTag.setPosition(this.anchorX, nameTagY, counter, this.worldWidth);
    // Fixed world anchor, exactly like nameTagY/headTopY above — the bubble's
    // own OFFSET_Y*scale (see ThoughtBubble/ToolBubble) is what grows this
    // gap proportionally at the narrow-panel counter-scale fallback, the
    // same relationship anchorY/displayH already had to bubbleY before the
    // name tag existed.
    const bubbleY = nameTagY - (NAME_TAG_APPROX_H + BUBBLE_GAP_ABOVE_NAME_TAG);
    this.thoughtBubble?.setPosition(this.anchorX, bubbleY, counter, this.worldWidth);
    this.toolBubble?.setPosition(this.anchorX, bubbleY, counter, this.worldWidth);

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
    this.nameTag.destroy();
    this.thoughtBubble?.destroy();
    this.toolBubble?.destroy();
    this.container.destroy({ children: true });
  }
}
