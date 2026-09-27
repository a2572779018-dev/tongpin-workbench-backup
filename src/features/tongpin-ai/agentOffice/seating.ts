// Pure desk-layout geometry: where the coordinator's head desk and each
// worker's desk sit in world (pre-camera) pixels, plus the fixed anchor
// points for the office's static decor. No Pixi import here so the
// arrangement math is unit-testable on its own.
//
// World units are sprite pixels 1:1 (TILE = one 16px tile, matching every
// Pixel Agents sprite's native scale — see THIRD_PARTY_NOTICES.md); the only
// scaling applied on top is the *camera's* single integer zoom factor (see
// Camera.ts), which is what keeps every sprite crisp at 2×/3×. Desk/decor
// rects below may still use a small *local* integer multiple of a sprite's
// native size (e.g. the head desk at 2×) — composed with an integer camera
// zoom, that stays an integer overall, so it never introduces blur.
//
// OfficeSceneController scales/centers this fixed world to whatever the host
// element measures (see fitWorld below), the same way munder-difflin's
// Camera.fitToScreen() does.

export const TILE = 16;
export const WORLD_WIDTH = 640; // 40 tiles
export const WORLD_HEIGHT = 352; // 22 tiles

// Wall band along the top (see sceneDraw.ts's wall auto-tiling). Pixel Agents'
// wall pieces are 2 tiles tall (16×32 — see spriteFrameMath.ts's WALL_PIECE_H)
// even though the office only ever has a single row *of wall tiles*, so the
// band they occupy on screen is 2 * TILE, not 1.
export const WALL_ROW_HEIGHT = TILE * 2;

// DESK_FRONT.png is 48×32 native; the head desk is the same art at 2× local
// scale so the coordinator visibly anchors the room without needing separate
// art (both factors are integers, so composed with the camera's integer zoom
// the result stays pixel-crisp).
const DESK_NATIVE_W = 48;
const DESK_NATIVE_H = 32;
export const DESK_SCALE = 1;
export const HEAD_DESK_SCALE = 2;
export const DESK_W = DESK_NATIVE_W * DESK_SCALE;
export const DESK_H = DESK_NATIVE_H * DESK_SCALE;
export const HEAD_DESK_W = DESK_NATIVE_W * HEAD_DESK_SCALE;
export const HEAD_DESK_H = DESK_NATIVE_H * HEAD_DESK_SCALE;

const ROW_GAP = 24;
const HEAD_Y = 64;
const WORKER_ROW_Y = 200;
const WORKER_ROW_Y_2 = 288;
/** Workers beyond this many wrap onto a second row so 6 desks stay readable. */
const MAX_PER_ROW = 4;

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
  const workers = new Map<string, DeskRect>();
  for (let i = 0; i < count; i++) {
    const { row, col, cols } = rowOf(count, i);
    const y = row === 0 ? WORKER_ROW_Y : WORKER_ROW_Y_2;
    workers.set(workerIds[i], deskAt(col, cols, y));
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
// Fixed positions for the office's non-interactive dressing (bookshelf,
// whiteboard, clock, plants, coffee mug) — plain data, laid out by hand
// rather than derived, since nothing about them depends on run data. Kept
// here (not in sceneDraw.ts) so every "where things go" number in the scene
// lives in one place. Each is the sprite's top-left in world px; sceneDraw.ts
// draws them at native size (see spriteSheets.ts).

export const DECOR_LAYOUT = {
  /** Wall-mounted clock, left of center. */
  clock: { x: Math.round(WORLD_WIDTH * 0.24), y: WALL_ROW_HEIGHT - 32 },
  /** Wall-mounted whiteboard, right of center. */
  whiteboard: { x: Math.round(WORLD_WIDTH * 0.68), y: WALL_ROW_HEIGHT - 32 },
  /** Low bookshelf against the wall, near the left edge. */
  bookshelf: { x: 24, y: WALL_ROW_HEIGHT },
  /** Floor plants flanking the room. */
  plantLeft: { x: 12, y: WORLD_HEIGHT - 32 },
  plantRight: { x: WORLD_WIDTH - 12 - 16, y: WORLD_HEIGHT - 32 },
  /** Coffee mug on the head desk's corner (desk rect is added at render time). */
  coffeeDeskInsetX: 10,
  coffeeDeskInsetY: 6,
} as const;
