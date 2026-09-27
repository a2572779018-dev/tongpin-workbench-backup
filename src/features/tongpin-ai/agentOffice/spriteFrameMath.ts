// Pure pixel-rect math for slicing this office's own compact per-character
// sprite strips — no Pixi, no DOM, unit-testable on its own.
//
// Each strip (see spriteAssets.ts / scripts/agent-office/extract-limezu.py)
// is one row of 16×32 frames (head *and* body — see extract-limezu.py's own
// doc comment for why a 16×16 head-only crop was wrong), already cropped
// down to just the poses this office draws, in a fixed order: idle,
// working ×2, phone ×2. Unlike the scene's previous (Pixel Agents) character
// rig, there is no direction row — this office's employees stay seated
// facing away from the viewer and never turn — so slicing a frame is just an
// index into one row.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;

/** Frame index within a character strip for each named pose (see
 *  roster/animationMapping). Order matches extract-limezu.py's
 *  CHAR_FRAME_SOURCES exactly. */
export const CharacterFrame = {
  IDLE: 0,
  TYPE_1: 1,
  TYPE_2: 2,
  READ_1: 3,
  READ_2: 4,
} as const;
export type CharacterFrame = (typeof CharacterFrame)[keyof typeof CharacterFrame];

export const CHAR_FRAMES_PER_STRIP = 5;
export const CHAR_SHEET_W = CHAR_FRAME_W * CHAR_FRAMES_PER_STRIP;
export const CHAR_SHEET_H = CHAR_FRAME_H;

/** Pixel rect of one 16×32 character frame within its 80×32 strip. */
export function characterFrameRect(frame: CharacterFrame): Rect {
  return { x: frame * CHAR_FRAME_W, y: 0, w: CHAR_FRAME_W, h: CHAR_FRAME_H };
}
