export const FOLLOW_MAX_YAW = 14;
export const FOLLOW_MAX_PITCH = 10;
export interface FollowRect { left: number; top: number; width: number; height: number; }
export interface FollowAnchor { centerX: number; centerY: number; rangeX: number; rangeY: number; }
export interface PointerFollowState { clientX: number; clientY: number; hasPoint: boolean; pitch: number; yaw: number; weight: number; }
export const createPointerFollowState = (): PointerFollowState => ({ clientX: 0, clientY: 0, hasPoint: false, pitch: 0, yaw: 0, weight: 0 });
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** One short-lived viewport point for an unmount/mount handoff, never a trail. */
export function createPointerSnapshotCache() {
  let point: { clientX: number; clientY: number; recordedAt: number } | null = null;
  return {
    remember(clientX: number, clientY: number, now: number) {
      if ([clientX, clientY, now].every(Number.isFinite)) point = { clientX, clientY, recordedAt: now };
    },
    read(now: number) {
      if (point && (!Number.isFinite(now) || now < point.recordedAt || now - point.recordedAt > 1500)) point = null;
      return point;
    },
    clear() { point = null; },
  };
}

/** Map the flower's SVG origin, not the center of the impression's top padding. */
export function followAnchorFromViewBox(rect: FollowRect, box: readonly number[]): FollowAnchor | null {
  if (box.length !== 4 || !box.every(Number.isFinite) || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0 || box[2] <= 0 || box[3] <= 0) return null;
  const scale = Math.min(rect.width / box[2], rect.height / box[3]);
  const bodySize = Math.min(rect.width, rect.height);
  return {
    centerX: rect.left + (rect.width - box[2] * scale) / 2 - box[0] * scale,
    centerY: rect.top + (rect.height - box[3] * scale) / 2 - box[1] * scale,
    rangeX: Math.max(120, bodySize * 1.25),
    rangeY: Math.max(100, bodySize * 1.1),
  };
}

export function resetPointerFollow(state: PointerFollowState) {
  state.hasPoint = false; state.pitch = 0; state.yaw = 0; state.weight = 0;
}
/** Leaving returns smoothly; disabling/hidden sessions use the hard reset above. */
export function releasePointerFollow(state: PointerFollowState) { state.hasPoint = false; }
export function notePointerPosition(state: PointerFollowState, clientX: number, clientY: number) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  state.clientX = clientX; state.clientY = clientY; state.hasPoint = true;
}
function pointerTarget(state: PointerFollowState, anchor: FollowAnchor | null) {
  return state.hasPoint && anchor ? {
    yaw: clamp((state.clientX - anchor.centerX) / anchor.rangeX, 1) * FOLLOW_MAX_YAW,
    pitch: -clamp((state.clientY - anchor.centerY) / anchor.rangeY, 1) * FOLLOW_MAX_PITCH,
    weight: 1,
  } : { yaw: 0, pitch: 0, weight: 0 };
}
/** A newly visible avatar starts from its own fresh anchor, never an old pose. */
export function seedPointerFollow(state: PointerFollowState, anchor: FollowAnchor | null) {
  Object.assign(state, pointerTarget(state, anchor));
}
export function stepPointerFollow(state: PointerFollowState, anchor: FollowAnchor | null, deltaMs: number) {
  // Recover harmlessly from stale development state or an interrupted mount.
  if (!Number.isFinite(state.yaw)) state.yaw = 0;
  if (!Number.isFinite(state.pitch)) state.pitch = 0;
  if (!Number.isFinite(state.weight)) state.weight = 0;
  const target = pointerTarget(state, anchor);
  const blend = 1 - Math.exp(-Math.min(50, Math.max(0, Number.isFinite(deltaMs) ? deltaMs : 0)) / 160);
  // Hold a stationary pointer, including after a click. A 1.2s timeout used to
  // turn the face away even though the user's mouse had never left it.
  state.yaw += (target.yaw - state.yaw) * blend;
  state.pitch += (target.pitch - state.pitch) * blend;
  state.weight += (target.weight - state.weight) * blend;
  if (Math.abs(state.yaw) < 0.001) state.yaw = 0;
  if (Math.abs(state.pitch) < 0.001) state.pitch = 0;
  if (state.weight < 0.001) state.weight = 0;
}
