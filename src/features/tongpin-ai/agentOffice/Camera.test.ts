import { Container } from "pixi.js";
import { describe, expect, it } from "vitest";
import { Camera } from "./Camera";

// Container construction needs no canvas/WebGL/DOM (see
// OfficeSceneController.test.ts's own fakeFigure() for the same reasoning).

describe("Camera", () => {
  it("snaps to the middle allowed scale (1) when the world fits almost exactly", () => {
    const camera = new Camera(new Container(), 640, 510);
    camera.setViewSize(640, 510);
    expect(camera.scale).toBe(1); // still the constructor default before the first update()/snapToFit()
    camera.snapToFit();
    expect(camera.scale).toBe(1);
  });

  it("never lands on a fraction outside {0.5, 1, 1.5}, rounding down to the nearest step", () => {
    const camera = new Camera(new Container(), 640, 510);
    camera.setViewSize(640, 510 * 1.4); // width is the binding constraint, raw ~1.0
    camera.snapToFit();
    expect(camera.scale).toBe(1);

    camera.setViewSize(640 * 1.49, 510 * 1.49); // raw ~1.49, just under the next step
    camera.snapToFit();
    expect(camera.scale).toBe(1);

    camera.setViewSize(640 * 1.5, 510 * 1.5); // raw exactly 1.5
    camera.snapToFit();
    expect(camera.scale).toBe(1.5);

    camera.setViewSize(640 * 0.99, 510 * 0.99); // raw just under 1
    camera.snapToFit();
    expect(camera.scale).toBe(0.5);
  });

  it("shrinks smoothly (unsnapped) rather than cropping when even the smallest step overflows", () => {
    const camera = new Camera(new Container(), 640, 510);
    camera.setViewSize(640 * 0.2, 510 * 0.2); // raw 0.2, below the smallest allowed step
    camera.snapToFit();
    expect(camera.scale).toBeCloseTo(0.2);
  });

  it("degrades to scale 1 for a not-yet-measured (zero-size) view", () => {
    const camera = new Camera(new Container(), 640, 510);
    camera.setViewSize(0, 0);
    camera.snapToFit();
    expect(camera.scale).toBe(1);
  });

  it("setWorldSize changes what the next fit is computed against", () => {
    const camera = new Camera(new Container(), 640, 510);
    camera.setViewSize(320, 510);
    camera.snapToFit();
    expect(camera.scale).toBe(0.5); // 320/640 = 0.5 exactly

    camera.setWorldSize(320, 510);
    camera.setViewSize(320, 510);
    camera.snapToFit();
    expect(camera.scale).toBe(1); // now an exact 1:1 fit
  });

  it("lerps toward the target on update() rather than snapping immediately", () => {
    const camera = new Camera(new Container(), 640, 510);
    camera.setViewSize(640 * 0.2, 510 * 0.2); // unsnapped target ~0.2, far from the default 1
    camera.update();
    expect(camera.scale).toBeGreaterThan(0.2);
    expect(camera.scale).toBeLessThan(1);
  });
});
