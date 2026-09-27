import { describe, expect, it } from "vitest";
import { wallBitmask, wallMaskForRow, WallNeighbor } from "./wallAutoTile";

describe("wallBitmask", () => {
  it("has no neighbors as 0", () => {
    expect(wallBitmask(false, false, false, false)).toBe(0);
  });

  it("sets the N/E/S/W bits independently", () => {
    expect(wallBitmask(true, false, false, false)).toBe(WallNeighbor.NORTH);
    expect(wallBitmask(false, true, false, false)).toBe(WallNeighbor.EAST);
    expect(wallBitmask(false, false, true, false)).toBe(WallNeighbor.SOUTH);
    expect(wallBitmask(false, false, false, true)).toBe(WallNeighbor.WEST);
  });

  it("combines bits for multiple neighbors", () => {
    expect(wallBitmask(true, true, true, true)).toBe(15);
    expect(wallBitmask(false, true, false, true)).toBe(WallNeighbor.EAST | WallNeighbor.WEST);
  });
});

describe("wallMaskForRow (this office's single-row wall band)", () => {
  it("a lone wall tile has no east or west neighbor", () => {
    expect(wallMaskForRow(0, 1)).toBe(0);
  });

  it("the left end tile has only an east neighbor", () => {
    expect(wallMaskForRow(0, 5)).toBe(WallNeighbor.EAST);
  });

  it("the right end tile has only a west neighbor", () => {
    expect(wallMaskForRow(4, 5)).toBe(WallNeighbor.WEST);
  });

  it("every interior tile has both east and west neighbors", () => {
    for (let col = 1; col < 4; col++) {
      expect(wallMaskForRow(col, 5)).toBe(WallNeighbor.EAST | WallNeighbor.WEST);
    }
  });

  it("never sets the north or south bit — this wall is always one row tall", () => {
    for (let col = 0; col < 6; col++) {
      const mask = wallMaskForRow(col, 6);
      expect(mask & WallNeighbor.NORTH).toBe(0);
      expect(mask & WallNeighbor.SOUTH).toBe(0);
    }
  });
});
