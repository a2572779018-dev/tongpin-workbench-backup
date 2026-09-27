// Pure pixel-rect math for slicing the Pixel Agents sprite sheets — no Pixi,
// no DOM, unit-testable on its own. Mirrors the slicing formulas in the
// MIT-licensed pixel-agents-hq/pixel-agents project's
// `core/src/assets/pngDecoder.ts` / `core/src/assets/constants.ts` (see
// THIRD_PARTY_NOTICES.md), adapted to compute a texture-frame `Rect` instead
// of decoding raw pixels into a 2D color array: this scene loads the PNGs as
// real GPU textures and crops them with Pixi `Texture` frames, so only the
// *geometry* of each sprite sheet needs porting, not upstream's CPU-side
// pixel-array decoder.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ── Characters: 112×96, 3 direction rows × 7 frames of 16×32 ──────────────
// Row order is down/up/right (left is a horizontal flip of right, done at
// render time). Frame order per row: walk1, walk2, walk3, type1, type2,
// read1, read2. This office never turns or walks its employees (they stay
// seated facing their monitor), so only the "down" row is read at runtime;
// the row math is kept general and tested for the other two rows too, since
// it is the same formula upstream uses for all three.
export const CHAR_FRAME_W = 16;
export const CHAR_FRAME_H = 32;
export const CHAR_FRAMES_PER_ROW = 7;
export const CHAR_SHEET_W = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
export const CHAR_SHEET_H = CHAR_FRAME_H * 3;

export const CharacterRow = { DOWN: 0, UP: 1, RIGHT: 2 } as const;
export type CharacterRow = (typeof CharacterRow)[keyof typeof CharacterRow];

/** Frame index within a direction row for each named pose (see roster/animationMapping). */
export const CharacterFrame = {
  WALK_1: 0,
  WALK_2: 1,
  WALK_3: 2,
  TYPE_1: 3,
  TYPE_2: 4,
  READ_1: 5,
  READ_2: 6,
} as const;
export type CharacterFrame = (typeof CharacterFrame)[keyof typeof CharacterFrame];

/** Pixel rect of one 16×32 character frame within the 112×96 sheet. */
export function characterFrameRect(row: CharacterRow, frame: CharacterFrame): Rect {
  return { x: frame * CHAR_FRAME_W, y: row * CHAR_FRAME_H, w: CHAR_FRAME_W, h: CHAR_FRAME_H };
}

// ── Walls: 64×128, 4×4 grid of 16×32 bitmask pieces ────────────────────────
// Bitmask convention: N=1, E=2, S=4, W=8 (see wallAutoTile.ts). Piece at
// bitmask M sits at col = M % 4, row = floor(M / 4) — identical to upstream's
// `parseWallPng`.
export const WALL_PIECE_W = 16;
export const WALL_PIECE_H = 32;
export const WALL_GRID_COLS = 4;
export const WALL_BITMASK_COUNT = 16;

export function wallPieceRect(mask: number): Rect {
  const clamped = ((mask % WALL_BITMASK_COUNT) + WALL_BITMASK_COUNT) % WALL_BITMASK_COUNT;
  const col = clamped % WALL_GRID_COLS;
  const row = Math.floor(clamped / WALL_GRID_COLS);
  return { x: col * WALL_PIECE_W, y: row * WALL_PIECE_H, w: WALL_PIECE_W, h: WALL_PIECE_H };
}
