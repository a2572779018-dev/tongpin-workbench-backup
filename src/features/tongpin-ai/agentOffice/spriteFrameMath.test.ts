import { describe, expect, it } from "vitest";
import { CHAR_FRAME_H, CHAR_FRAME_W, CharacterFrame, characterFrameRect } from "./spriteFrameMath";

describe("characterFrameRect", () => {
  it("slices 16×32 frames left-to-right along the strip", () => {
    expect(characterFrameRect(CharacterFrame.IDLE)).toEqual({ x: 0, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterFrame.TYPE_1)).toEqual({ x: 16, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterFrame.TYPE_2)).toEqual({ x: 32, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterFrame.READ_1)).toEqual({ x: 48, y: 0, w: 16, h: 32 });
    expect(characterFrameRect(CharacterFrame.READ_2)).toEqual({ x: 64, y: 0, w: 16, h: 32 });
  });

  it("every frame rect is exactly one frame cell, on the strip's single row", () => {
    for (const frame of Object.values(CharacterFrame)) {
      const rect = characterFrameRect(frame);
      expect(rect.w).toBe(CHAR_FRAME_W);
      expect(rect.h).toBe(CHAR_FRAME_H);
      expect(rect.y).toBe(0);
    }
  });
});
