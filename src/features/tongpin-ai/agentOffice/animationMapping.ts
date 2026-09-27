// Pure mapping from a worker's pose (visualState.ts) to which frame(s) of its
// assigned character sheet to show, and the timing for the two-frame
// typing/reading toggle. Kept free of Pixi so "does this pose animate, and
// with which frames" and "how long is a frame held" are unit-testable
// without a Sprite, a Texture or a DOM. The toggle-duration constant matches
// the MIT-licensed pixel-agents-hq/pixel-agents project's
// `webview-ui/src/constants.ts` (`TYPE_FRAME_DURATION_SEC`) — see
// THIRD_PARTY_NOTICES.md.

import { CharacterFrame } from "./spriteFrameMath";
import type { WorkerPose } from "./visualState";

export type FrameToggle = 0 | 1;

/** idle / done / failed / cancelled all rest on the same standing frame —
 *  LimeZu's premade character sheets have no distinct "happy/done" pose worth
 *  using (see spriteFrameMath.ts / the feature's report), so what tells these
 *  four states apart is the overlay badge and grey tint applied on top (see
 *  visualState.ts + EmployeeFigure.ts), not the character's own pose. */
export const RESTING_FRAME: CharacterFrame = CharacterFrame.IDLE;

/** The two-frame loop for an animated pose, or null for a static one. */
export function animatedFramesForPose(pose: WorkerPose): [CharacterFrame, CharacterFrame] | null {
  switch (pose) {
    case "typing":
      return [CharacterFrame.TYPE_1, CharacterFrame.TYPE_2];
    case "searching":
      return [CharacterFrame.READ_1, CharacterFrame.READ_2];
    case "idle":
    case "done":
    case "failed":
    case "cancelled":
      return null;
    default: {
      const exhaustive: never = pose;
      return exhaustive;
    }
  }
}

/** The single frame to display right now for `pose` at toggle phase `toggle`
 *  (`toggle` is ignored for static poses). */
export function frameForPose(pose: WorkerPose, toggle: FrameToggle): CharacterFrame {
  const animated = animatedFramesForPose(pose);
  return animated ? animated[toggle] : RESTING_FRAME;
}

/** Seconds a typing/reading frame holds before flipping to the other one. */
export const FRAME_TOGGLE_DURATION_SEC = 0.3;

export interface ToggleState {
  toggle: FrameToggle;
  timer: number;
}

/** Advance a (toggle, timer) pair by `dt` seconds — pure state transition,
 *  the caller owns the mutable fields and re-applies the frame when
 *  `changed` comes back true. Never advances past one flip per call so a
 *  single very large `dt` (e.g. a tab regaining focus) can't desync the
 *  reported toggle from how many frames actually elapsed. */
export function advanceToggle(state: ToggleState, dt: number): ToggleState & { changed: boolean } {
  const timer = state.timer + dt;
  if (timer >= FRAME_TOGGLE_DURATION_SEC) {
    return { toggle: state.toggle === 0 ? 1 : 0, timer: timer - FRAME_TOGGLE_DURATION_SEC, changed: true };
  }
  return { toggle: state.toggle, timer, changed: false };
}
