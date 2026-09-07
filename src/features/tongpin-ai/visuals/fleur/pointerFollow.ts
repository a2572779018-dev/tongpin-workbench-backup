export const FOLLOW_MAX_YAW = 7;
export const FOLLOW_MAX_PITCH = 5;
const FOLLOW_IDLE_MS = 1200;
export interface FollowRect { left: number; top: number; width: number; height: number; }
export interface PointerFollowState { clientX: number; clientY: number; hasPoint: boolean; lastMoveMs: number; pitch: number; yaw: number; }
export const createPointerFollowState = (): PointerFollowState => ({ clientX: 0, clientY: 0, hasPoint: false, lastMoveMs: 0, pitch: 0, yaw: 0 });
export function resetPointerFollow(state: PointerFollowState) {
  state.hasPoint = false; state.pitch = 0; state.yaw = 0;
}
export function notePointerPosition(state: PointerFollowState, clientX: number, clientY: number, visibleMs: number) {
  if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
  state.clientX = clientX; state.clientY = clientY; state.lastMoveMs = visibleMs; state.hasPoint = true;
}
export function stepPointerFollow(state: PointerFollowState, rect: FollowRect, deltaMs: number, visibleMs: number) {
  if (visibleMs - state.lastMoveMs >= FOLLOW_IDLE_MS) state.hasPoint = false;
  const tracking = state.hasPoint && visibleMs - state.lastMoveMs < FOLLOW_IDLE_MS && rect.width > 0 && rect.height > 0;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  const targetYaw = tracking ? clamp((state.clientX - rect.left - rect.width / 2) / Math.max(220, rect.width * 3)) * FOLLOW_MAX_YAW : 0;
  const targetPitch = tracking ? -clamp((state.clientY - rect.top - rect.height / 2) / Math.max(180, rect.height * 3)) * FOLLOW_MAX_PITCH : 0;
  const blend = 1 - Math.exp(-Math.min(100, Math.max(0, deltaMs)) / 170);
  state.yaw += (targetYaw - state.yaw) * blend;
  state.pitch += (targetPitch - state.pitch) * blend;
  if (Math.abs(state.yaw) < 0.001) state.yaw = 0;
  if (Math.abs(state.pitch) < 0.001) state.pitch = 0;
}
