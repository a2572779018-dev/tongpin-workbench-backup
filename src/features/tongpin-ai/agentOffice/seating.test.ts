import { describe, expect, it } from "vitest";
import { computeLayout, fitWorld, DESK_W, HEAD_DESK_W, WORLD_WIDTH, WORLD_HEIGHT } from "./seating";

describe("computeLayout", () => {
  it("always seats the coordinator at a fixed head desk, independent of worker count", () => {
    const zero = computeLayout([]);
    const six = computeLayout(["a", "b", "c", "d", "e", "f"]);
    expect(zero.coordinator).toEqual(six.coordinator);
    expect(zero.coordinator.w).toBe(HEAD_DESK_W);
  });

  it("seats every worker from 1 through 6 with a distinct, in-bounds desk", () => {
    for (let count = 1; count <= 6; count++) {
      const ids = Array.from({ length: count }, (_, i) => `w${i}`);
      const layout = computeLayout(ids);
      expect(layout.workers.size).toBe(count);
      const rects = ids.map((id) => layout.workers.get(id)!);
      for (const rect of rects) {
        expect(rect.w).toBe(DESK_W);
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.w).toBeLessThanOrEqual(WORLD_WIDTH);
        expect(rect.y + rect.h).toBeLessThanOrEqual(WORLD_HEIGHT);
      }
      // No two desks overlap horizontally on the same row.
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const sameRow = a.y === b.y;
          if (sameRow) {
            const overlap = a.x < b.x + b.w && b.x < a.x + a.w;
            expect(overlap).toBe(false);
          }
        }
      }
    }
  });

  it("wraps onto a second row once past 4 workers, keeping every desk on-screen", () => {
    const five = computeLayout(["a", "b", "c", "d", "e"]);
    const rows = new Set([...five.workers.values()].map((r) => r.y));
    expect(rows.size).toBe(2);
  });

  it("is a pure function of the id list: same ids, same order → identical rects", () => {
    const ids = ["w1", "w2", "w3"];
    const first = computeLayout(ids);
    const second = computeLayout([...ids]);
    for (const id of ids) expect(first.workers.get(id)).toEqual(second.workers.get(id));
  });

  it("keeps a survivor's desk stable when the id set is unchanged (idempotent updates)", () => {
    const before = computeLayout(["w1", "w2"]);
    const after = computeLayout(["w1", "w2"]);
    expect(before.workers.get("w1")).toEqual(after.workers.get("w1"));
    expect(before.workers.get("w2")).toEqual(after.workers.get("w2"));
  });

  it("ignores workers beyond the 6-seat budget rather than overflowing the layout", () => {
    const ids = Array.from({ length: 9 }, (_, i) => `w${i}`);
    const layout = computeLayout(ids);
    expect(layout.workers.size).toBe(6);
  });
});

describe("fitWorld", () => {
  it("centers and scales the fixed world to fit an arbitrary viewport", () => {
    const fit = fitWorld(WORLD_WIDTH * 2, WORLD_HEIGHT * 2);
    expect(fit.scale).toBe(2);
    expect(fit.x).toBeCloseTo(0);
    expect(fit.y).toBeCloseTo(0);
  });

  it("letterboxes rather than cropping when the aspect ratio differs", () => {
    const fit = fitWorld(WORLD_WIDTH, WORLD_HEIGHT * 4);
    expect(fit.scale).toBe(1); // width is the binding constraint
    expect(fit.y).toBeGreaterThan(0); // vertical letterbox, not cropped
  });

  it("degrades gracefully for a not-yet-measured (zero-size) host", () => {
    expect(fitWorld(0, 0)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});
