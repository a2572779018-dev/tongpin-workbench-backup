// Pure desk-layout geometry: where the coordinator's head desk and each
// worker's desk sit in world (pre-camera) pixels, plus the fixed anchor
// points for the office's static decor. No Pixi import here so the
// arrangement math is unit-testable on its own.
//
// World units are sprite pixels 1:1 (TILE = one 16px tile, matching every
// LimeZu sprite's native scale — see THIRD_PARTY_NOTICES.md); the only
// scaling applied on top is a small *local* integer multiple (UI_SCALE for
// workers/decor, HEAD_UI_SCALE for the coordinator) composed with the
// camera's own single integer zoom (see Camera.ts) — two integers composed
// are still an integer, so every sprite stays crisp at 1×/2×/3×.
//
// OfficeSceneController scales/centers this fixed world to whatever the host
// element measures (see fitWorld below), the same way munder-difflin's
// Camera.fitToScreen() does.

export const TILE = 16;
export const WORLD_WIDTH = 640; // 40 tiles
// Taller than the first LimeZu pass (352): each employee's visible footprint
// grew once the character moved to sit fully in front of (not hidden behind)
// its desk — see EmployeeFigure.ts — and MAX_PER_ROW dropping from 4 to 3
// means 6 workers now always wraps to two rows. Chosen so two worker rows
// plus the coordinator's row all clear each other's bubble/label space with
// room to spare — see this feature's report for a note to re-check this
// against a rendered screenshot if the row constants below ever change.
export const WORLD_HEIGHT = 550;

/** Shared local scale for every worker-side sprite (desk, character, decor)
 *  — LimeZu's furniture and characters are native 16px-tile art, small enough
 *  that drawing them at 1:1 would read as sparse in this office's existing
 *  640×352 world, so everything here is drawn at a uniform 2× local scale
 *  instead (still an integer, so it stays crisp composed with the camera's
 *  own zoom). The coordinator gets one size class up, HEAD_UI_SCALE, so their
 *  desk/figure visibly anchors the room the way the previous (Pixel Agents)
 *  2×-vs-1× head desk did. */
export const UI_SCALE = 2;
export const HEAD_UI_SCALE = 3;
/** @deprecated kept as aliases — EmployeeFigure/Desk still spell these the
 *  way the previous revision did; same values as UI_SCALE/HEAD_UI_SCALE. */
export const DESK_SCALE = UI_SCALE;
export const HEAD_DESK_SCALE = HEAD_UI_SCALE;

// Wall band along the top. LimeZu's own wall crop (see spriteAssets.ts) is a
// single 32px-tall "cap + face" unit — the office draws just one row of it,
// tiled horizontally at UI_SCALE, so the band it occupies on screen is
// 32 * UI_SCALE.
const WALL_NATIVE_H = 32;
export const WALL_ROW_HEIGHT = WALL_NATIVE_H * UI_SCALE;

// desk_off/desk_on_{a,b}.png are all 16×32 native (see spriteAssets.ts); the
// head desk is the same art at HEAD_UI_SCALE so the coordinator visibly
// anchors the room without needing separate art.
const DESK_NATIVE_W = 16;
const DESK_NATIVE_H = 32;
export const DESK_W = DESK_NATIVE_W * UI_SCALE;
export const DESK_H = DESK_NATIVE_H * UI_SCALE;
export const HEAD_DESK_W = DESK_NATIVE_W * HEAD_UI_SCALE;
export const HEAD_DESK_H = DESK_NATIVE_H * HEAD_UI_SCALE;

const ROW_GAP = 48;
// Row Y's give each row's *desk top*; the character/chair/label group that
// now hangs off each desk (see EmployeeFigure.ts) extends well past the old
// desk-only footprint, so these are spaced by a full row "pitch" (~130-140px)
// rather than the old desk-height-sized gap — tuned against a rendered
// screenshot (see this feature's report) so a row's activity bubble never
// overlaps the row above it, and the coordinator's bubble clears the
// signboard.
const HEAD_Y = 104;
const WORKER_ROW_Y = 270;
const WORKER_ROW_Y_2 = 410;
/** Workers beyond this many wrap onto a second row. Dropped from 4 to 3 (two
 *  rows of up to 3) so a full 6-worker room reads as a "neat grid" instead of
 *  a single cramped row of 4 plus a lonely row of 2. */
const MAX_PER_ROW = 3;

export interface DeskRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SeatLayout {
  coordinator: DeskRect;
  /** Keyed by worker id, in the same order `computeLayout` received them. */
  workers: Map<string, DeskRect>;
}

function rowOf(count: number, index: number): { row: number; col: number; cols: number } {
  if (count <= MAX_PER_ROW) return { row: 0, col: index, cols: count };
  const firstRow = Math.ceil(count / 2);
  if (index < firstRow) return { row: 0, col: index, cols: firstRow };
  return { row: 1, col: index - firstRow, cols: count - firstRow };
}

/** Row Y for a given (row, totalRows) pair. 1-3 workers only ever use "row
 *  0", but pinning that lone row to the same Y the *first* of two rows would
 *  use leaves the whole lower half of the floor empty — the exact "floats in
 *  the middle, empty floor below" complaint this office's report calls out.
 *  So a single row instead sits at the vertical midpoint between the two
 *  configured row slots, splitting the difference between "close to the
 *  coordinator" and "using the floor space a second row would have". */
function rowY(row: number, totalRows: number): number {
  if (totalRows <= 1) return (WORKER_ROW_Y + WORKER_ROW_Y_2) / 2;
  return row === 0 ? WORKER_ROW_Y : WORKER_ROW_Y_2;
}

/** Desk position for `index` of `cols` desks centered in the world, on `y`. */
function deskAt(index: number, cols: number, y: number): DeskRect {
  const totalW = cols * DESK_W + (cols - 1) * ROW_GAP;
  const startX = (WORLD_WIDTH - totalW) / 2;
  return { x: startX + index * (DESK_W + ROW_GAP), y, w: DESK_W, h: DESK_H };
}

/**
 * Pure function of the current worker id list (order preserved from the
 * snapshot). Same ids in the same order always produce the same rects, so a
 * status-only update never reshuffles desks — only the *set* of ids drives
 * layout, which keeps repeated/idempotent snapshots visually stable.
 */
export function computeLayout(workerIds: readonly string[]): SeatLayout {
  const count = Math.max(0, Math.min(6, workerIds.length));
  const coordinator: DeskRect = {
    x: (WORLD_WIDTH - HEAD_DESK_W) / 2,
    y: HEAD_Y,
    w: HEAD_DESK_W,
    h: HEAD_DESK_H,
  };
  const totalRows = count <= MAX_PER_ROW ? 1 : 2;
  const workers = new Map<string, DeskRect>();
  for (let i = 0; i < count; i++) {
    const { row, col, cols } = rowOf(count, i);
    workers.set(workerIds[i], deskAt(col, cols, rowY(row, totalRows)));
  }
  return { coordinator, workers };
}

/** Scale + offset that fits the fixed world into an arbitrary viewport,
 *  centered, without cropping — the same "fit to screen" idea as
 *  munder-difflin's Camera, minus the pan/zoom-to-agent features this scene
 *  has no use for (nothing here ever needs to focus on one desk). Camera.ts
 *  additionally snaps this to an integer for on-screen rendering; this pure
 *  version keeps the exact continuous ratio (used by its own tests / anyone
 *  needing the unrounded fit). */
export function fitWorld(viewW: number, viewH: number): { scale: number; x: number; y: number } {
  if (viewW <= 0 || viewH <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(viewW / WORLD_WIDTH, viewH / WORLD_HEIGHT);
  const x = (viewW - WORLD_WIDTH * scale) / 2;
  const y = (viewH - WORLD_HEIGHT * scale) / 2;
  return { scale, x, y };
}

// ── Static decor anchors ────────────────────────────────────────────────
// Fixed positions for the office's non-interactive dressing — plain data,
// laid out by hand rather than derived, since nothing about them depends on
// run data. Kept here (not in sceneDraw.ts) so every "where things go" number
// in the scene lives in one place. Each is the sprite's top-left in world px,
// sized at its own native px × UI_SCALE (sceneDraw.ts draws them at that
// scale — see spriteSheets.ts for native sizes). Composition constants below
// (signboard/clock/door placement especially) were re-checked against the
// `.preview/` harness's rendered screenshots at 1/3/6 workers across every
// phase (see the feature's report for those paths) — clock/door/bookshelf/
// plant/water-cooler positions read fine there and were left as originally
// hand-chosen from the cropped art; only the row Y's, MAX_PER_ROW and the
// signboard's native size changed for this pass (see below).

// Matches render-signboard.py's current output exactly (regenerate both
// together if the font/text ever changes — see that script's own comments).
const SIGNBOARD_NATIVE_W = 126;
const SIGNBOARD_NATIVE_H = 39;
const BOOKSHELF_NATIVE_W = 32;
const PLANT_BIG_NATIVE_W = 32;
const PLANT_BIG_NATIVE_H = 48;

export const DECOR_LAYOUT = {
  /** Wall sign above the coordinator's head desk — see AgentOffice's report
   *  for the font/rasterization pipeline (`render-signboard.py`). */
  signboard: {
    x: Math.round((WORLD_WIDTH - SIGNBOARD_NATIVE_W * UI_SCALE) / 2),
    y: 6,
  },
  /** Wall clock, left of the signboard. */
  clock: { x: Math.round(WORLD_WIDTH * 0.16), y: 0 },
  /** Wall-mounted door, right of the signboard. */
  door: { x: Math.round(WORLD_WIDTH * 0.84), y: 16 },
  /** Standing whiteboard/presentation board, floor-level near the left wall. */
  whiteboard: { x: 110, y: WALL_ROW_HEIGHT },
  /** Low bookshelf against the wall, near the left edge. */
  bookshelf: { x: 16, y: WALL_ROW_HEIGHT },
  /** Second low bookshelf, right of the coordinator's head desk (which spans
   *  roughly x=296-344, independent of worker count) and left of the water
   *  cooler (x>=500) — kept clear of both so it reads as its own spot along
   *  the back wall rather than overlapping either. */
  bookshelf2: { x: 420, y: WALL_ROW_HEIGHT },
  /** Floor plants flanking the room. */
  plantLeft: { x: 16, y: WORLD_HEIGHT - PLANT_BIG_NATIVE_H * UI_SCALE },
  plantRight: {
    x: WORLD_WIDTH - 16 - PLANT_BIG_NATIVE_W * UI_SCALE,
    y: WORLD_HEIGHT - PLANT_BIG_NATIVE_H * UI_SCALE,
  },
  /** Break-area water cooler + coffee maker, floor-level near the right wall. */
  waterCooler: { x: WORLD_WIDTH - 140, y: WALL_ROW_HEIGHT },
  coffee: { x: WORLD_WIDTH - 140 + BOOKSHELF_NATIVE_W * UI_SCALE + 8, y: WALL_ROW_HEIGHT + 12 },
} as const;
