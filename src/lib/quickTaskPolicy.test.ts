import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  getCornerWindowBounds,
  getHotCornerTriggerBounds,
  getQuickPanelBounds,
  normalizeQuickTaskCommand,
  pointInBounds,
} = require("../../electron/quick-task-policy.cjs");

describe("Electron quick task hot corner policy", () => {
  const workArea = { x: -1440, y: 25, width: 1440, height: 875 };

  it("anchors to a negative-coordinate secondary display work area", () => {
    expect(getHotCornerTriggerBounds(workArea)).toEqual({
      x: -12,
      y: 888,
      width: 12,
      height: 12,
    });
    expect(getCornerWindowBounds(workArea)).toEqual({
      x: -54,
      y: 846,
      width: 54,
      height: 54,
    });
    expect(getQuickPanelBounds(workArea)).toEqual({
      x: -396,
      y: 384,
      width: 380,
      height: 500,
    });
  });

  it("treats the bottom-right edge as inside without crossing displays", () => {
    const bounds = getHotCornerTriggerBounds(workArea);
    expect(pointInBounds({ x: -1, y: 899 }, bounds)).toBe(true);
    expect(pointInBounds({ x: 0, y: 899 }, bounds)).toBe(false);
  });

  it("accepts only narrow task commands", () => {
    expect(normalizeQuickTaskCommand({ type: "list-today" })).toEqual({
      type: "list-today",
    });
    expect(
      normalizeQuickTaskCommand({
        type: "create",
        title: "  快速待办  ",
        priority: "p1",
        date: "2030-01-01",
      }),
    ).toEqual({ type: "create", title: "快速待办", priority: "p1" });
    expect(
      normalizeQuickTaskCommand({
        type: "update-status",
        taskId: "11111111-1111-4111-8111-111111111111",
        status: "done",
      }),
    ).toEqual({
      type: "update-status",
      taskId: "11111111-1111-4111-8111-111111111111",
      status: "done",
    });
    expect(
      normalizeQuickTaskCommand({ type: "create", title: "", priority: "p0" }),
    ).toBeNull();
    expect(
      normalizeQuickTaskCommand({
        type: "create",
        title: "x",
        priority: "root",
      }),
    ).toBeNull();
  });
});
