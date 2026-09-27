import { describe, expect, it } from "vitest";
import {
  buildDecorLayout,
  chooseCameraScale,
  computeLayout,
  computeWorldWidth,
  fitWorld,
  DESK_W,
  HEAD_DESK_W,
  TILE,
  WORLD_WIDTH,
  WORLD_HEIGHT,
} from "./seating";

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

  it("keeps up to 3 workers on a single row", () => {
    const three = computeLayout(["a", "b", "c"]);
    const rows = new Set([...three.workers.values()].map((r) => r.y));
    expect(rows.size).toBe(1);
  });

  it("wraps onto a second row once past 3 workers, keeping every desk on-screen", () => {
    const four = computeLayout(["a", "b", "c", "d"]);
    const rows = new Set([...four.workers.values()].map((r) => r.y));
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

  it("re-centers every desk when given a different world width", () => {
    const narrow = computeLayout(["a", "b", "c"], 400);
    const wide = computeLayout(["a", "b", "c"], 700);
    for (const rect of narrow.workers.values()) {
      expect(rect.x).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w).toBeLessThanOrEqual(400);
    }
    expect(narrow.coordinator.x).not.toBe(wide.coordinator.x);
    expect(narrow.coordinator.x + narrow.coordinator.w / 2).toBeCloseTo(200); // still centered
    expect(wide.coordinator.x + wide.coordinator.w / 2).toBeCloseTo(350);
  });
});

describe("chooseCameraScale", () => {
  it("defaults to 1 (2x total zoom) across the panel's typical content width", () => {
    for (const width of [560, 640, 696, 760, 900]) expect(chooseCameraScale(width)).toBe(1);
  });

  it("falls back to 0.5 below the typical range and 1.5 above it", () => {
    expect(chooseCameraScale(300)).toBe(0.5);
    expect(chooseCameraScale(1200)).toBe(1.5);
  });

  it("degrades to 1 for a not-yet-measured (zero or negative) width", () => {
    expect(chooseCameraScale(0)).toBe(1);
    expect(chooseCameraScale(-10)).toBe(1);
  });
});

describe("computeWorldWidth", () => {
  it("fills a typical panel width with no leftover beyond a fraction of one tile", () => {
    const width = computeWorldWidth(696, 1);
    expect(width % TILE).toBe(0);
    expect(width).toBeLessThanOrEqual(696);
    expect(width).toBeGreaterThan(696 - TILE);
  });

  it("stays inside a sane min/max so an extreme viewport still reads as a room", () => {
    expect(computeWorldWidth(50, 0.5)).toBeGreaterThanOrEqual(300);
    expect(computeWorldWidth(5000, 1.5)).toBeLessThanOrEqual(800);
  });

  it("falls back to the default WORLD_WIDTH for a not-yet-measured input", () => {
    expect(computeWorldWidth(0, 1)).toBe(WORLD_WIDTH);
    expect(computeWorldWidth(696, 0)).toBe(WORLD_WIDTH);
  });
});

describe("buildDecorLayout", () => {
  it("centers the signboard and keeps the window clear of it at any world width", () => {
    for (const width of [400, WORLD_WIDTH, 760]) {
      const decor = buildDecorLayout(width);
      expect(decor.signboard.x * 2).toBeCloseTo(width - 126 * 2, -1); // roughly centered
      expect(decor.window.x).toBeGreaterThanOrEqual(0);
      expect(decor.window.x).toBeLessThan(decor.signboard.x); // left of the sign, never overlapping
    }
  });

  it("defaults to the fixed fallback width when called with no argument", () => {
    expect(buildDecorLayout()).toEqual(buildDecorLayout(WORLD_WIDTH));
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
