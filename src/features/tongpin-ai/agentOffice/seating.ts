// Pure desk-layout geometry: where the coordinator's head desk and each
// worker's desk sit in world (pre-camera) pixels, plus the fixed anchor
// points for the office's static decor. No Pixi import here so the
// arrangement math is unit-testable on its own.
//
// World units are sprite pixels 1:1 (TILE = one 16px tile, matching every
// LimeZu sprite's native scale — see THIRD_PARTY_NOTICES.md); the only
// scaling applied on top is a small *local* integer multiple (UI_SCALE for
// workers/decor, HEAD_UI_SCALE for the coordinator) composed with the
// camera's own scale (see Camera.ts) — chooseCameraScale below only ever
// picks 0.5/1/1.5, so composed with UI_SCALE(2) the result is always a whole
// 1x/2x/3x, keeping every sprite crisp.
//
// OfficeSceneController scales/centers this world to whatever the host
// element measures (see fitWorld below and Camera.ts), the same way
// munder-difflin's Camera.fitToScreen() does — except the world's own WIDTH
// is now itself derived from that measurement too (computeWorldWidth), so a
// typically-sized panel fills edge to edge instead of fitting a
// fixed-forever 640-wide world into whatever space it happens to get (see
// chooseCameraScale/computeWorldWidth's own doc comments).

export const TILE = 16;
/** Fallback/default world width: used before OfficeSceneController's first
 *  real `setSize()` measurement arrives (its constructor builds the initial
 *  backdrop/layout at this width, then rebuilds at the real one — see
 *  OfficeSceneController.ts), and by fitWorld()/tests that don't care about
 *  panel-width-driven sizing. The live render almost always ends up at
 *  computeWorldWidth()'s result instead, once the host panel is measured. */
export const WORLD_WIDTH = 640;
// Wall + coordinator + two worker rows, tuned to a *much* shorter panel than
// the previous 550: this office's report has the full compression breakdown,
// but in short — growing this without also growing the panel's own default
// height (AgentOfficeView's `height` prop) is exactly what made
// Camera.fitScale() land on a blurry fractional scale before, since the
// panel stayed a fixed ~320-360px tall while this constant grew past it. Kept
// a bit above the office's own "≈420-480" estimate specifically to leave
// enough clearance for a *2-line* activity bubble at the now-legible,
// screen-space-constant 12px text size (see EmployeeFigure.ts/ThoughtBubble.ts/
// ToolBubble.ts) above the row below it — re-check against a rendered
// screenshot before shrinking this further.
export const WORLD_HEIGHT = 510;
/** Smallest/largest world width computeWorldWidth() will ever produce, so an
 *  extreme viewport still gets a room shaped like an office — not a sliver
 *  too narrow for the coordinator's own desk, or a runway so wide it reads as
 *  emptier than the "avoid large empty floor" fix intends. */
const MIN_WORLD_WIDTH = 360;
const MAX_WORLD_WIDTH = 760;

/**
 * The camera's own scale (see Camera.ts), chosen from the host panel's
 * measured CSS width. Composed with this scene's fixed 2x sprite bake
 * (UI_SCALE below), the three values here give a whole-number native-px-to-
 * CSS-px zoom of 1x/2x/3x — the only levels this scene's nearest-filtered
 * pixel art samples crisply; anything in between shimmers/blurs (see
 * Camera.ts's own fitScale(), which snaps to exactly these three and never a
 * fraction outside them). 1 (→ 2x total) is the default, matching this
 * panel's typical content width — AgentOfficePanel's own CSS caps it at
 * 720px, comfortably inside the 560-900 range below; a narrower or wider
 * host falls back to 0.5x/1.5x (→ 1x/3x total) rather than some in-between
 * fraction.
 */
export function chooseCameraScale(viewWidthCss: number): number {
  if (!(viewWidthCss > 0)) return 1;
  if (viewWidthCss < 560) return 0.5;
  if (viewWidthCss > 900) return 1.5;
  return 1;
}

/**
 * World width (world px — i.e. CSS px at camera scale 1, see Camera.ts) that
 * fills a `viewWidthCss`-wide viewport at `cameraScale` with no leftover
 * margin beyond a fraction of one tile — the "derive world width in tiles
 * from the panel's content width" fix for the office rendering too small in
 * the middle of a big, empty margin. Rounds *down* to a whole TILE so the
 * camera's own fitted scale never lands a hair under the intended step
 * (which would otherwise snap all the way down to the next one — see
 * Camera.ts's fitScale()).
 */
export function computeWorldWidth(viewWidthCss: number, cameraScale: number): number {
  if (!(viewWidthCss > 0) || !(cameraScale > 0)) return WORLD_WIDTH;
  const raw = Math.floor(viewWidthCss / cameraScale / TILE) * TILE;
  return Math.max(MIN_WORLD_WIDTH, Math.min(MAX_WORLD_WIDTH, raw));
}

/** Shared local scale for every worker-side sprite (desk, character, decor)
 *  — LimeZu's furniture and characters are native 16px-tile art, small enough
 *  that drawing them at 1:1 would read as sparse, so everything here is drawn
 *  at a uniform 2× local scale instead (still an integer, so it stays crisp
 *  composed with the camera's own scale — see chooseCameraScale above). The
 *  coordinator gets one size class up, HEAD_UI_SCALE, so their desk/figure
 *  visibly anchors the room the way the previous (Pixel Agents) 2×-vs-1× head
 *  desk did. */
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
// hangs off each desk (see EmployeeFigure.ts) extends well past the old
// desk-only footprint, so these are spaced by a full row "pitch" rather than
// the desk-height-sized gap alone — tuned so a row's activity bubble (now up
// to 2 lines of legible, screen-space-constant 12px text — see
// ThoughtBubble.ts/ToolBubble.ts) never overlaps the row above it, and the
// coordinator's own bubble clears the signboard. Trimmed slightly from the
// previous pass (104/270/410) to fit WORLD_HEIGHT's own reduction — re-check
// against a rendered screenshot if either changes again.
const HEAD_Y = 108;
const WORKER_ROW_Y = 262;
const WORKER_ROW_Y_2 = 402;
/** Workers beyond this many wrap onto a second row. Two rows of up to 3 reads
 *  as a "neat grid" for a full 6-worker room instead of a single cramped row
 *  of 4 plus a lonely row of 2. */
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

/** Desk position for `index` of `cols` desks centered in `worldWidth`. */
function deskAt(index: number, cols: number, y: number, worldWidth: number): DeskRect {
  const totalW = cols * DESK_W + (cols - 1) * ROW_GAP;
  const startX = (worldWidth - totalW) / 2;
  return { x: startX + index * (DESK_W + ROW_GAP), y, w: DESK_W, h: DESK_H };
}

/**
 * Pure function of the current worker id list (order preserved from the
 * snapshot) and the world's current width (see computeWorldWidth). Same
 * inputs always produce the same rects, so a status-only update never
 * reshuffles desks — only the *set* of ids (or a real width change) drives
 * layout, which keeps repeated/idempotent snapshots visually stable.
 * `worldWidth` defaults to the fixed fallback so existing call sites/tests
 * that don't care about panel-width-driven sizing are unaffected.
 */
export function computeLayout(workerIds: readonly string[], worldWidth: number = WORLD_WIDTH): SeatLayout {
  const count = Math.max(0, Math.min(6, workerIds.length));
  const coordinator: DeskRect = {
    x: (worldWidth - HEAD_DESK_W) / 2,
    y: HEAD_Y,
    w: HEAD_DESK_W,
    h: HEAD_DESK_H,
  };
  const totalRows = count <= MAX_PER_ROW ? 1 : 2;
  const workers = new Map<string, DeskRect>();
  for (let i = 0; i < count; i++) {
    const { row, col, cols } = rowOf(count, i);
    workers.set(workerIds[i], deskAt(col, cols, rowY(row, totalRows), worldWidth));
  }
  return { coordinator, workers };
}

/** Scale + offset that fits the fixed world into an arbitrary viewport,
 *  centered, without cropping — the same "fit to screen" idea as
 *  munder-difflin's Camera, minus the pan/zoom-to-agent features this scene
 *  has no use for (nothing here ever needs to focus on one desk). Camera.ts
 *  additionally snaps this to 0.5/1/1.5 for on-screen rendering; this pure
 *  version keeps the exact continuous ratio (used by its own tests / anyone
 *  needing the unrounded fit). Always against the fixed fallback WORLD_WIDTH
 *  — unlike the live scene, this helper has no host panel to measure. */
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
// run data (only on the world's current width, now that it can vary — see
// buildDecorLayout below). Each is the sprite's top-left in world px, sized
// at its own native px × UI_SCALE (sceneDraw.ts draws them at that scale —
// see spriteSheets.ts for native sizes).

// Matches render-signboard.py's current output exactly (regenerate both
// together if the font/text ever changes — see that script's own comments).
const SIGNBOARD_NATIVE_W = 126;
const SIGNBOARD_NATIVE_H = 39;
const BOOKSHELF_NATIVE_W = 32;
const PLANT_BIG_NATIVE_W = 32;
const PLANT_BIG_NATIVE_H = 48;
const RUG_MARGIN = 64;
const RUG_TOP = WALL_ROW_HEIGHT + 28;
const RUG_BOTTOM = WORLD_HEIGHT - 26;
/** No window sprite exists in the owner's purchased LimeZu categories
 *  (Conference_Hall / Living_Room / Classroom_and_Library / Television_and_
 *  Film_Studio — see extract-limezu.py's PACK_ROOT comment); sceneDraw.ts
 *  paints this one procedurally instead, in the same palette as everything
 *  else, rather than pull in an unrelated theme's art. */
const WINDOW_W = 44;
const WINDOW_H = 34;

export interface DecorLayout {
  signboard: { x: number; y: number };
  clock: { x: number; y: number };
  door: { x: number; y: number };
  whiteboard: { x: number; y: number };
  bookshelf: { x: number; y: number };
  bookshelf2: { x: number; y: number };
  plantLeft: { x: number; y: number };
  plantRight: { x: number; y: number };
  waterCooler: { x: number; y: number };
  coffee: { x: number; y: number };
  window: { x: number; y: number; w: number; h: number };
  rug: { x: number; y: number; w: number; h: number };
}

/** Decor anchors for the given world width — a function (not a static
 *  object) now that the world's width itself varies with the host panel's
 *  measured size (see computeWorldWidth). `worldWidth` defaults to the fixed
 *  fallback so tests/call sites that don't care about dynamic sizing can
 *  still just call this with no argument. Composition here (clock/door/
 *  bookshelf/plant/water-cooler positions, the signboard's own size) was
 *  hand-checked against the `.preview/` harness's rendered screenshots at
 *  1/3/6 workers across every phase — see the feature's report for those
 *  paths and for the rug/window additions' own sourcing. */
export function buildDecorLayout(worldWidth: number = WORLD_WIDTH): DecorLayout {
  return {
    /** Wall sign above the coordinator's head desk — see AgentOffice's report
     *  for the font/rasterization pipeline (`render-signboard.py`). */
    signboard: {
      x: Math.round((worldWidth - SIGNBOARD_NATIVE_W * UI_SCALE) / 2),
      y: 6,
    },
    /** Wall clock, left of the signboard. */
    clock: { x: Math.round(worldWidth * 0.16), y: 0 },
    /** Wall-mounted door, right of the signboard. */
    door: { x: Math.round(worldWidth * 0.84), y: 16 },
    /** Standing whiteboard/presentation board, floor-level near the left wall. */
    whiteboard: { x: Math.round(worldWidth * 0.17), y: WALL_ROW_HEIGHT },
    /** Low bookshelf against the wall, near the left edge. */
    bookshelf: { x: 16, y: WALL_ROW_HEIGHT },
    /** Second low bookshelf, right of the coordinator's head desk and left of
     *  the water cooler — kept clear of both so it reads as its own spot
     *  along the back wall rather than overlapping either. */
    bookshelf2: { x: Math.round(worldWidth * 0.66), y: WALL_ROW_HEIGHT },
    /** Floor plants flanking the room. */
    plantLeft: { x: 16, y: WORLD_HEIGHT - PLANT_BIG_NATIVE_H * UI_SCALE },
    plantRight: {
      x: worldWidth - 16 - PLANT_BIG_NATIVE_W * UI_SCALE,
      y: WORLD_HEIGHT - PLANT_BIG_NATIVE_H * UI_SCALE,
    },
    /** Break-area water cooler + coffee maker, floor-level near the right wall. */
    waterCooler: { x: worldWidth - 140, y: WALL_ROW_HEIGHT },
    coffee: { x: worldWidth - 140 + BOOKSHELF_NATIVE_W * UI_SCALE + 8, y: WALL_ROW_HEIGHT + 12 },
    /** Procedural "window light" on the back wall near the left edge, clear
     *  of the clock (see WINDOW_W above) — see this interface's own doc
     *  comment for why it's painted rather than a LimeZu sprite. */
    window: { x: Math.round(worldWidth * 0.045), y: 8, w: WINDOW_W, h: WINDOW_H },
    /** Rug under the worker desk clusters — see this interface's own doc
     *  comment for its LimeZu source (a small diamond-motif floor accent,
     *  tiled). Margins keep it inset from both side walls at any world width. */
    rug: {
      x: RUG_MARGIN,
      y: RUG_TOP,
      w: Math.max(0, worldWidth - RUG_MARGIN * 2),
      h: Math.max(0, RUG_BOTTOM - RUG_TOP),
    },
  };
}
