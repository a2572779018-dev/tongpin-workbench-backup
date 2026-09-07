import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPointerFollowState, createPointerSnapshotCache, followAnchorFromViewBox, FOLLOW_MAX_PITCH, FOLLOW_MAX_YAW, notePointerPosition, releasePointerFollow, resetPointerFollow, seedPointerFollow, stepPointerFollow } from "./pointerFollow";

const rect = { left: 100, top: 100, width: 48, height: 48 };
const anchor = followAnchorFromViewBox(rect, [-100, -100, 200, 200])!;
describe("stable visible-head Fleur following", () => {
  it("turns towards the mouse without instantly snapping to or exceeding the angle cap", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 100000, -100000);
    expect(state.yaw).toBe(0);
    stepPointerFollow(state, anchor, 1000 / 30);
    expect(state.yaw).toBeGreaterThan(0); expect(state.yaw).toBeLessThan(FOLLOW_MAX_YAW);
    expect(state.pitch).toBeGreaterThan(0); expect(state.pitch).toBeLessThan(FOLLOW_MAX_PITCH);
    for (let t = 66; t < 1100; t += 33) stepPointerFollow(state, anchor, 33);
    expect(state.yaw).toBeGreaterThan(13.9); expect(state.yaw).toBeLessThanOrEqual(14);
    expect(state.pitch).toBeGreaterThan(9.9); expect(state.pitch).toBeLessThanOrEqual(10);
  });
  it("keeps looking at a stationary mouse after a click instead of a 1.2-second auto-reset", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, -1000, 1000);
    for (let t = 0; t < 10_000; t += 33) stepPointerFollow(state, anchor, 33);
    expect(state.yaw).toBeCloseTo(-14); expect(state.pitch).toBeCloseTo(-10);
    expect(state.hasPoint).toBe(true);
    const beforeClick = { ...state };
    notePointerPosition(state, -1000, 1000);
    expect(state).toEqual(beforeClick);
    releasePointerFollow(state);
    stepPointerFollow(state, anchor, 33);
    expect(state.yaw).toBeGreaterThan(-14); expect(state.yaw).toBeLessThan(0);
    for (let t = 0; t < 6000; t += 33) stepPointerFollow(state, anchor, 33);
    expect(state).toMatchObject({ yaw: 0, pitch: 0, weight: 0, hasPoint: false });
  });
  it("resets without carrying stale pointer coordinates into the next visible session", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 500, 0); stepPointerFollow(state, anchor, 33);
    resetPointerFollow(state); stepPointerFollow(state, anchor, 33);
    expect(state).toMatchObject({ hasPoint: false, yaw: 0, pitch: 0 });
    notePointerPosition(state, NaN, Infinity);
    expect(state.hasPoint).toBe(false);
  });
  it("takes a neutral target at the center of even a tiny avatar", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 124, 124); stepPointerFollow(state, anchor, 33);
    expect(state.yaw).toBe(0); expect(state.pitch).toBe(0);
  });
  it("uses the flower origin below top impression padding, including letterboxing", () => {
    const tall = followAnchorFromViewBox({ left: 10, top: 20, width: 100, height: 134 }, [-100, -240, 200, 340])!;
    expect(tall.centerX).toBeCloseTo(60);
    expect(tall.centerY).toBeCloseTo(20 + 240 * 134 / 340);
    expect(tall.centerY).toBeGreaterThan(20 + 134 / 2 + 20);
    const state = createPointerFollowState();
    notePointerPosition(state, tall.centerX, tall.centerY); seedPointerFollow(state, tall);
    expect(state).toMatchObject({ yaw: 0, pitch: -0, weight: 1 });
    const wide = followAnchorFromViewBox({ left: 10, top: 20, width: 300, height: 100 }, [-100, -100, 200, 200])!;
    expect(wide.centerX).toBe(160); expect(wide.centerY).toBe(70);
  });
  it("recomputes the target after a layout move while interpolating rather than jumping", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 300, 124); seedPointerFollow(state, anchor);
    expect(state.yaw).toBe(14);
    const moved = followAnchorFromViewBox({ ...rect, left: 500 }, [-100, -100, 200, 200])!;
    stepPointerFollow(state, moved, 33);
    expect(state.yaw).toBeLessThan(14); expect(state.yaw).toBeGreaterThan(5);
    for (let i = 0; i < 60; i++) stepPointerFollow(state, moved, 33);
    expect(state.yaw).toBeCloseTo(-14);
    expect(state.pitch).toBe(0);
  });
  it("hands off one recent viewport point but recalculates a new avatar's pose", () => {
    const cache = createPointerSnapshotCache();
    cache.remember(300, 124, 100);
    const point = cache.read(500)!;
    const oldState = createPointerFollowState();
    notePointerPosition(oldState, point.clientX, point.clientY); seedPointerFollow(oldState, anchor);
    const newState = createPointerFollowState();
    notePointerPosition(newState, point.clientX, point.clientY);
    seedPointerFollow(newState, followAnchorFromViewBox({ ...rect, left: 500 }, [-100, -100, 200, 200]));
    expect(oldState.yaw).toBe(14); expect(newState.yaw).toBe(-14);
    expect(cache.read(1700)).toBeNull();
    cache.remember(1, 2, 2000); cache.clear(); expect(cache.read(2001)).toBeNull();
  });
  it("rejects zero/invalid layout and large frame gaps without poisoning or snapping the state", () => {
    expect(followAnchorFromViewBox({ ...rect, width: 0 }, [-100, -100, 200, 200])).toBeNull();
    expect(followAnchorFromViewBox(rect, [NaN, 0, 100, 100])).toBeNull();
    const state = createPointerFollowState(); notePointerPosition(state, 1000, 1000);
    stepPointerFollow(state, anchor, 5000);
    expect(state.yaw).toBeLessThan(4); expect(state.pitch).toBeGreaterThan(-3);
    stepPointerFollow(state, null, NaN);
    expect(Object.values(state).filter(value => typeof value === "number").every(Number.isFinite)).toBe(true);
    state.yaw = NaN; state.pitch = Infinity; state.weight = NaN;
    stepPointerFollow(state, anchor, 33);
    expect([state.yaw, state.pitch, state.weight].every(Number.isFinite)).toBe(true);
  });
  it("subscribes only for active fine-mouse following and measures fresh layout outside pointer events", () => {
    const source = readFileSync(new URL("./FleurCharacter.tsx", import.meta.url), "utf8");
    const pointer = source.slice(source.indexOf("const onFollowPointer"), source.indexOf("const resetFollow"));
    expect(pointer).toContain('event.pointerType === "mouse"');
    expect(pointer).not.toMatch(/getBoundingClientRect|setState|setPointerCapture|preventDefault/);
    expect(source).toContain("setFollowing(active && visualRef.current.followPointer && finePointer.matches && !flipping)");
    expect(source).toContain('window.addEventListener("pointermove", onFollowPointer, { passive: true })');
    expect(source).toContain('window.removeEventListener("pointermove", onFollowPointer)');
    expect(source).toContain('window.addEventListener("pointerdown", onFollowPointer, { passive: true })');
    expect(source).toContain('window.removeEventListener("pointerdown", onFollowPointer)');
    expect(source).toContain('window.addEventListener("blur", resetFollow)');
    expect(source).toContain('event.relatedTarget === null');
    expect(source).toContain('followAnchorFromViewBox(svg.getBoundingClientRect(), latest.box)');
    expect(source).not.toContain('rectReadAt');
    expect(source).toContain('headTracking: { yaw: followRef.current.yaw, pitch: followRef.current.pitch, weight: followRef.current.weight }');
    expect(source).toContain('if (!interactive || paused) return;');
    expect(source).toContain('export const FleurCharacter = memo(');
  });
});
