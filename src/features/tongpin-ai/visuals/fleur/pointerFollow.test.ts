import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createPointerFollowState, FOLLOW_MAX_PITCH, FOLLOW_MAX_YAW, notePointerPosition, resetPointerFollow, stepPointerFollow } from "./pointerFollow";

const rect = { left: 100, top: 100, width: 48, height: 48 };
describe("subtle fine-pointer Fleur following", () => {
  it("turns towards the mouse without instantly snapping to or exceeding the angle cap", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 100000, -100000, 0);
    expect(state.yaw).toBe(0);
    stepPointerFollow(state, rect, 1000 / 30, 1000 / 30);
    expect(state.yaw).toBeGreaterThan(0); expect(state.yaw).toBeLessThan(FOLLOW_MAX_YAW);
    expect(state.pitch).toBeGreaterThan(0); expect(state.pitch).toBeLessThan(FOLLOW_MAX_PITCH);
    for (let t = 66; t < 1100; t += 33) stepPointerFollow(state, rect, 33, t);
    expect(state.yaw).toBeLessThanOrEqual(7); expect(state.pitch).toBeLessThanOrEqual(5);
  });
  it("smoothly returns to the center after movement stops", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, -1000, 1000, 0);
    for (let t = 0; t < 1000; t += 33) stepPointerFollow(state, rect, 33, t);
    const yaw = state.yaw;
    stepPointerFollow(state, rect, 33, 1300);
    expect(Math.abs(state.yaw)).toBeLessThan(Math.abs(yaw));
    expect(state.yaw).not.toBe(0);
    for (let t = 1333; t < 6000; t += 33) stepPointerFollow(state, rect, 33, t);
    expect(state.yaw).toBe(0); expect(state.pitch).toBe(0); expect(state.hasPoint).toBe(false);
  });
  it("resets without carrying stale pointer coordinates into the next visible session", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 500, 0, 0); stepPointerFollow(state, rect, 33, 33);
    resetPointerFollow(state); stepPointerFollow(state, rect, 33, 66);
    expect(state).toMatchObject({ hasPoint: false, yaw: 0, pitch: 0 });
    notePointerPosition(state, NaN, Infinity, 80);
    expect(state.hasPoint).toBe(false);
  });
  it("takes a neutral target at the center of even a tiny avatar", () => {
    const state = createPointerFollowState();
    notePointerPosition(state, 124, 124, 0); stepPointerFollow(state, rect, 33, 33);
    expect(state.yaw).toBe(0); expect(state.pitch).toBe(0);
  });
  it("subscribes only for active fine-mouse following and caches layout outside pointer events", () => {
    const source = readFileSync(new URL("./FleurCharacter.tsx", import.meta.url), "utf8");
    const pointer = source.slice(source.indexOf("const onFollowPointer"), source.indexOf("const resetFollow"));
    expect(pointer).toContain('event.pointerType === "mouse"');
    expect(pointer).not.toMatch(/getBoundingClientRect|setState|setPointerCapture|preventDefault/);
    expect(source).toContain("setFollowing(active && visualRef.current.followPointer && finePointer.matches)");
    expect(source).toContain('window.addEventListener("pointermove", onFollowPointer, { passive: true })');
    expect(source).toContain('window.removeEventListener("pointermove", onFollowPointer)');
    expect(source).toContain('window.addEventListener("blur", resetFollow)');
    expect(source).toContain('event.relatedTarget === null');
    expect(source).toContain('now - rectReadAt >= 250');
    expect(source).toContain('turn: input.config.turn + followRef.current.yaw');
    expect(source).toContain('tilt: input.config.tilt + followRef.current.pitch');
    expect(source).toContain('export const FleurCharacter = memo(');
  });
});
