import { describe, expect, it } from "vitest";
import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CharacterFrame,
  CharacterRow,
  characterFrameRect,
  wallPieceRect,
  WALL_PIECE_H,
  WALL_PIECE_W,
} from "./spriteFrameMath";

describe("characterFrameRect", () => {
  it("slices 16×32 frames left-to-right along the down row (y=0)", () => {
    expect(characterFrameRect(CharacterRow.DOWN, CharacterFrame.WALK_1)).toEqual({ x: 0, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterRow.DOWN, CharacterFrame.WALK_2)).toEqual({ x: 16, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterRow.DOWN, CharacterFrame.TYPE_1)).toEqual({ x: 48, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterRow.DOWN, CharacterFrame.READ_2)).toEqual({ x: 96, y: 0, w: 16, h: 32 });
  });

  it("offsets each direction row by one frame height (32px)", () => {
    expect(characterFrameRect(CharacterRow.UP, CharacterFrame.WALK_1).y).toBe(CHAR_FRAME_H);
    expect(characterFrameRect(CharacterRow.RIGHT, CharacterFrame.WALK_1).y).toBe(CHAR_FRAME_H * 2);
  });

  it("every frame rect is exactly one frame cell", () => {
    for (const row of [CharacterRow.DOWN, CharacterRow.UP, CharacterRow.RIGHT]) {
      for (const frame of Object.values(CharacterFrame)) {
        const rect = characterFrameRect(row, frame);
        expect(rect.w).toBe(CHAR_FRAME_W);
        expect(rect.h).toBe(CHAR_FRAME_H);
      }
    }
  });
});

describe("wallPieceRect", () => {
  it("places bitmask 0 at the sheet's top-left piece", () => {
    expect(wallPieceRect(0)).toEqual({ x: 0, y: 0, w: WALL_PIECE_W, h: WALL_PIECE_H });
  });

  it("wraps to a new row every 4 columns (4×4 grid)", () => {
    expect(wallPieceRect(3)).toEqual({ x: 3 * WALL_PIECE_W, y: 0, w: WALL_PIECE_W, h: WALL_PIECE_H });
    expect(wallPieceRect(4)).toEqual({ x: 0, y: WALL_PIECE_H, w: WALL_PIECE_W, h: WALL_PIECE_H });
    expect(wallPieceRect(15)).toEqual({ x: 3 * WALL_PIECE_W, y: 3 * WALL_PIECE_H, w: WALL_PIECE_W, h: WALL_PIECE_H });
  });

  it("never produces a rect outside the 4×4 grid for any integer mask", () => {
    for (let mask = -3; mask <= 20; mask++) {
      const rect = wallPieceRect(mask);
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x).toBeLessThanOrEqual(3 * WALL_PIECE_W);
      expect(rect.y).toBeGreaterThanOrEqual(0);
      expect(rect.y).toBeLessThanOrEqual(3 * WALL_PIECE_H);
    }
  });
});
