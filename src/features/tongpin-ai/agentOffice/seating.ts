// Pure desk-layout geometry: where the coordinator's head desk and each
// worker's desk sit in world (pre-camera) pixels. No Pixi import here so the
// arrangement math is unit-testable on its own.
//
// The world is a fixed logical size; OfficeSceneController scales/centers it
// to whatever the host element measures (see fitWorld below), the same way
// munder-difflin's Camera.fitToScreen() does.

export const WORLD_WIDTH = 640;
export const WORLD_HEIGHT = 360;

export const DESK_W = 72;
export const DESK_H = 44;
export const HEAD_DESK_W = 108;
export const HEAD_DESK_H = 50;

const ROW_GAP = 20;
const HEAD_Y = 40;
const WORKER_ROW_Y = 165;
const WORKER_ROW_Y_2 = 250;
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
 *  has no use for (nothing here ever needs to focus on one desk). */
export function fitWorld(viewW: number, viewH: number): { scale: number; x: number; y: number } {
  if (viewW <= 0 || viewH <= 0) return { scale: 1, x: 0, y: 0 };
  const scale = Math.min(viewW / WORLD_WIDTH, viewH / WORLD_HEIGHT);
  const x = (viewW - WORLD_WIDTH * scale) / 2;
  const y = (viewH - WORLD_HEIGHT * scale) / 2;
  return { scale, x, y };
}
