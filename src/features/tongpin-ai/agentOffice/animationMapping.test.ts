import { describe, expect, it } from "vitest";
import {
  advanceToggle,
  animatedFramesForPose,
  FRAME_TOGGLE_DURATION_SEC,
  frameForPose,
  RESTING_FRAME,
  type ToggleState,
} from "./animationMapping";
import { CharacterFrame } from "./spriteFrameMath";
import type { WorkerPose } from "./visualState";

const STATIC_POSES: WorkerPose[] = ["idle", "done", "failed", "cancelled"];

describe("animatedFramesForPose", () => {
  it("typing animates the two typing frames", () => {
    expect(animatedFramesForPose("typing")).toEqual([CharacterFrame.TYPE_1, CharacterFrame.TYPE_2]);
  });

  it("searching animates the two reading frames", () => {
    expect(animatedFramesForPose("searching")).toEqual([CharacterFrame.READ_1, CharacterFrame.READ_2]);
  });

  it("idle/done/failed/cancelled have no animation — the overlay/tint carries the distinction", () => {
    for (const pose of STATIC_POSES) expect(animatedFramesForPose(pose)).toBeNull();
  });
});

describe("frameForPose", () => {
  it("static poses always show the resting frame, regardless of toggle", () => {
    for (const pose of STATIC_POSES) {
      expect(frameForPose(pose, 0)).toBe(RESTING_FRAME);
      expect(frameForPose(pose, 1)).toBe(RESTING_FRAME);
    }
  });

  it("typing/searching alternate between their two frames by toggle", () => {
    expect(frameForPose("typing", 0)).toBe(CharacterFrame.TYPE_1);
    expect(frameForPose("typing", 1)).toBe(CharacterFrame.TYPE_2);
    expect(frameForPose("searching", 0)).toBe(CharacterFrame.READ_1);
    expect(frameForPose("searching", 1)).toBe(CharacterFrame.READ_2);
  });
});

describe("advanceToggle", () => {
  it("holds the frame until the toggle duration elapses", () => {
    const result = advanceToggle({ toggle: 0, timer: 0 }, FRAME_TOGGLE_DURATION_SEC / 2);
    expect(result.changed).toBe(false);
    expect(result.toggle).toBe(0);
    expect(result.timer).toBeCloseTo(FRAME_TOGGLE_DURATION_SEC / 2);
  });

  it("flips the toggle once the duration is reached, carrying the remainder", () => {
    const result = advanceToggle({ toggle: 0, timer: 0 }, FRAME_TOGGLE_DURATION_SEC + 0.05);
    expect(result.changed).toBe(true);
    expect(result.toggle).toBe(1);
    expect(result.timer).toBeCloseTo(0.05);
  });

  it("alternates back and forth across repeated advances", () => {
    let state: ToggleState = { toggle: 0, timer: 0 };
    const toggles: number[] = [];
    for (let i = 0; i < 4; i++) {
      state = advanceToggle(state, FRAME_TOGGLE_DURATION_SEC);
      toggles.push(state.toggle);
    }
    expect(toggles).toEqual([1, 0, 1, 0]);
  });

  it("never fires more than one flip per call, even for a huge dt", () => {
    const result = advanceToggle({ toggle: 0, timer: 0 }, FRAME_TOGGLE_DURATION_SEC * 50);
    expect(result.toggle).toBe(1); // flipped exactly once, not 50 times
  });
});
