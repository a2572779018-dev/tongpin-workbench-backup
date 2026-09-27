// Wall auto-tiling: the 4-bit cardinal-neighbor bitmask that picks which of
// the 16 pieces in a Pixel Agents wall sheet to draw. Ported from the
// MIT-licensed pixel-agents-hq/pixel-agents project's `webview-ui/src/office/
// wallTiles.ts` (`buildWallMask`) — see THIRD_PARTY_NOTICES.md. Kept pure
// (no tile-map type, no Pixi) so it is unit-testable and reusable for any
// neighbor query.

/** N=1, E=2, S=4, W=8 — same convention upstream uses. */
export const WallNeighbor = { NORTH: 1, EAST: 2, SOUTH: 4, WEST: 8 } as const;

export function wallBitmask(hasNorth: boolean, hasEast: boolean, hasSouth: boolean, hasWest: boolean): number {
  let mask = 0;
  if (hasNorth) mask |= WallNeighbor.NORTH;
  if (hasEast) mask |= WallNeighbor.EAST;
  if (hasSouth) mask |= WallNeighbor.SOUTH;
  if (hasWest) mask |= WallNeighbor.WEST;
  return mask;
}

/**
 * This office's wall is always a single row spanning the full width (see
 * sceneDraw.ts) — no tile ever has a wall neighbor to the north or south —
 * so the bitmask for column `col` of `colCount` total wall tiles reduces to
 * whether there is a wall tile immediately to the east/west.
 */
export function wallMaskForRow(col: number, colCount: number): number {
  const hasEast = col < colCount - 1;
  const hasWest = col > 0;
  return wallBitmask(false, hasEast, false, hasWest);
}
