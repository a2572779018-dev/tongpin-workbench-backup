import { Sprite, type Texture } from "pixi.js";
import { advanceToggle, frameForPose, type ToggleState } from "./animationMapping";
import { CharacterFrame } from "./spriteFrameMath";
import type { CharacterTextureSet } from "./spriteSheets";
import type { WorkerPose } from "./visualState";

function frameTexture(textures: CharacterTextureSet, frame: CharacterFrame): Texture {
  switch (frame) {
    case CharacterFrame.TYPE_1: return textures.typing[0];
    case CharacterFrame.TYPE_2: return textures.typing[1];
    case CharacterFrame.READ_1: return textures.reading[0];
    case CharacterFrame.READ_2: return textures.reading[1];
    default: return textures.idle; // IDLE (the resting frame) and any other frame
  }
}

/**
 * One employee's on-desk character sprite: a single Sprite whose texture
 * swaps between a character's pre-sliced down-facing frames (see
 * spriteSheets.ts) as its pose changes — typing/searching alternate between
 * two frames on a timer (see animationMapping.ts), everything else holds the
 * resting frame. This office never turns or walks its employees, so only the
 * down row is ever shown (see spriteFrameMath.ts's doc comment).
 *
 * Anchor is bottom-center (0.5, 1), so callers position it by its "feet"
 * line — see EmployeeFigure.ts, which seats that line below the desk rect
 * entirely (this is now a full head-to-feet frame, not a bust), with the
 * desk drawn *first* (furthest back) so its monitor screen stays fully
 * unobstructed and the character sits in front of and below it instead.
 */
export class CharacterSprite {
  readonly sprite: Sprite;
  private readonly textures: CharacterTextureSet;
  private pose: WorkerPose = "idle";
  private toggle: ToggleState = { toggle: 0, timer: 0 };

  constructor(textures: CharacterTextureSet) {
    this.textures = textures;
    this.sprite = new Sprite(textures.idle);
    this.sprite.anchor.set(0.5, 1);
  }

  setPose(pose: WorkerPose): void {
    if (pose === this.pose) return;
    this.pose = pose;
    this.toggle = { toggle: 0, timer: 0 };
    this.applyFrame();
  }

  /** `instant` (reduced motion / idempotent replays): freeze on the current
   *  frame instead of advancing the toggle timer — the same "settle, don't
   *  animate" convention as Desk/ThoughtBubble/ToolBubble. */
  update(dt: number, instant: boolean): void {
    if (instant) return;
    const next = advanceToggle(this.toggle, dt);
    this.toggle = next;
    if (next.changed) this.applyFrame();
  }

  private applyFrame(): void {
    this.sprite.texture = frameTexture(this.textures, frameForPose(this.pose, this.toggle.toggle));
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
