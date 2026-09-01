import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  getCornerWindowBounds,
  getQuickCornerDisplayArea,
  getHotCornerTriggerBounds,
  getQuickPanelBounds,
  normalizeQuickTaskCommand,
  pointInBounds,
  shouldSuppressMainActivation,
} = require("../../electron/quick-task-policy.cjs");
const quickTaskCss = readFileSync(
  new URL("../quick-task.css", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const electronMain = readFileSync(
  new URL("../../electron/main.cjs", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const quickCornerComponent = readFileSync(
  new URL("../components/QuickCorner.tsx", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function sourceBetween(start: string, end: string): string {
  const startIndex = electronMain.indexOf(start);
  const endIndex = electronMain.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return electronMain.slice(startIndex, endIndex);
}

describe("Electron quick task hot corner policy", () => {
  const workArea = { x: -1440, y: 25, width: 1440, height: 875 };

  it("keeps the default and quick panel anchored to the top-right", () => {
    expect(getHotCornerTriggerBounds(workArea)).toEqual({
      x: -12,
      y: 25,
      width: 12,
      height: 12,
    });
    expect(getCornerWindowBounds(workArea)).toEqual({
      x: -54,
      y: 25,
      width: 54,
      height: 54,
    });
    expect(getQuickPanelBounds(workArea)).toEqual({
      x: -396,
      y: 41,
      width: 380,
      height: 500,
    });
  });

  it("uses the Windows work area with a bottom-docked taskbar", () => {
    const bottomTaskbarDisplay = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    };
    const windowsArea = getQuickCornerDisplayArea(bottomTaskbarDisplay);
    expect(windowsArea).toEqual(bottomTaskbarDisplay.workArea);
    expect(getHotCornerTriggerBounds(windowsArea, 12, "left")).toEqual({
      x: 0,
      y: 0,
      width: 12,
      height: 12,
    });
    expect(getCornerWindowBounds(windowsArea, 54, "left")).toEqual({
      x: 0,
      y: 0,
      width: 54,
      height: 54,
    });
    expect(
      getQuickPanelBounds(windowsArea, { width: 380, height: 500 }, 16, "left"),
    ).toEqual({
      x: 16,
      y: 16,
      width: 380,
      height: 500,
    });
  });

  it("avoids Windows taskbars docked to the top, right, or left", () => {
    const topTaskbarDisplay = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 40, width: 1920, height: 1040 },
    };
    const topArea = getQuickCornerDisplayArea(topTaskbarDisplay);
    expect(getHotCornerTriggerBounds(topArea, 12, "left")).toMatchObject({
      x: 0,
      y: 40,
    });
    expect(
      getQuickPanelBounds(topArea, { width: 380, height: 500 }, 16, "left"),
    ).toMatchObject({
      x: 16,
      y: 56,
    });

    const rightTaskbarDisplay = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1880, height: 1080 },
    };
    const rightArea = getQuickCornerDisplayArea(rightTaskbarDisplay);
    expect(getHotCornerTriggerBounds(rightArea, 12, "left")).toMatchObject({
      x: 0,
      y: 0,
    });
    expect(getCornerWindowBounds(rightArea, 54, "left")).toMatchObject({
      x: 0,
      y: 0,
    });

    const leftTaskbarDisplay = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 48, y: 0, width: 1872, height: 1080 },
    };
    const leftArea = getQuickCornerDisplayArea(leftTaskbarDisplay);
    expect(getHotCornerTriggerBounds(leftArea, 12, "left")).toMatchObject({
      x: 48,
      y: 0,
    });
    expect(getCornerWindowBounds(leftArea, 54, "left")).toMatchObject({
      x: 48,
      y: 0,
    });
    expect(
      getQuickPanelBounds(leftArea, { width: 380, height: 500 }, 16, "left"),
    ).toMatchObject({
      x: 64,
      y: 16,
    });
  });

  it("keeps a Windows panel on the same top-left display as its corner", () => {
    const secondaryArea = { x: -1920, y: 30, width: 1920, height: 1040 };
    const panelBounds = getQuickPanelBounds(
      secondaryArea,
      { width: 380, height: 500 },
      16,
      "left",
    );

    expect(panelBounds).toEqual({
      x: -1904,
      y: 46,
      width: 380,
      height: 500,
    });
    expect(panelBounds.x).toBeGreaterThanOrEqual(secondaryArea.x);
    expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(
      secondaryArea.x + secondaryArea.width,
    );
  });

  it("keeps macOS quick-task surfaces below the menu bar", () => {
    const display = {
      bounds: { x: 0, y: 0, width: 1512, height: 982 },
      workArea: { x: 0, y: 25, width: 1512, height: 932 },
    };
    const macArea = getQuickCornerDisplayArea(display);
    expect(macArea).toEqual(display.workArea);
    expect(getHotCornerTriggerBounds(macArea)).toMatchObject({
      x: 1500,
      y: 25,
    });
    expect(getCornerWindowBounds(macArea)).toMatchObject({
      x: 1458,
      y: 25,
    });
    expect(getQuickPanelBounds(macArea)).toMatchObject({
      x: 1116,
      y: 41,
    });
  });

  it("falls back to display bounds when no work area is available", () => {
    const bounds = { x: 10, y: 20, width: 1280, height: 720 };
    expect(getQuickCornerDisplayArea({ bounds })).toEqual(bounds);
  });

  it("treats the Windows top-left edge as inside without crossing displays", () => {
    const bounds = getHotCornerTriggerBounds(workArea, 12, "left");
    expect(pointInBounds({ x: -1440, y: 25 }, bounds)).toBe(true);
    expect(pointInBounds({ x: -1439, y: 25 }, bounds)).toBe(true);
    expect(pointInBounds({ x: -1441, y: 25 }, bounds)).toBe(false);
    expect(pointInBounds({ x: -1440, y: 24 }, bounds)).toBe(false);
  });

  it("mirrors the Windows affordance inward from the top-left", () => {
    expect(quickTaskCss).toContain("align-items: flex-start;");
    expect(quickTaskCss).toContain(
      "transform: translate(10px, -10px) scale(0.72);",
    );
    expect(quickTaskCss).toContain("transform-origin: right top;");
    expect(quickTaskCss).toContain("border-radius: 0 0 0 14px;");
    expect(quickTaskCss).toContain("box-shadow: -3px 3px 0 #171717;");
    expect(quickTaskCss).toContain("transform: translate(-2px, 2px);");
    expect(quickTaskCss).toContain(
      'html[data-corner-side="left"] .quick-corner-stage',
    );
    expect(quickTaskCss).toContain("justify-content: flex-start;");
    expect(quickTaskCss).toContain(
      "transform: translate(-10px, -10px) scale(0.72);",
    );
    expect(quickTaskCss).toContain("transform-origin: left top;");
    expect(quickTaskCss).toContain("border-radius: 0 0 14px 0;");
    expect(quickTaskCss).toContain("box-shadow: 3px 3px 0 #171717;");
    expect(quickTaskCss).toContain("transform: translate(2px, 2px);");
    expect(electronMain).toContain(
      'const QUICK_CORNER_SIDE = isWindows ? "left" : "right";',
    );
    expect(electronMain).toContain(
      'query.cornerSide = QUICK_CORNER_SIDE;',
    );
    const showPanel = sourceBetween(
      "async function showQuickPanel() {",
      "function pollQuickCorner() {",
    );
    expect(showPanel).toContain("QUICK_CORNER_SIDE");

    const reposition = sourceBetween(
      "function repositionQuickTaskWindows() {",
      "function configureQuickTaskLifecycle() {",
    );
    expect(reposition).toContain("QUICK_CORNER_SIDE");
  });

  it("keeps quick-surface activation from restoring the main window", () => {
    const cornerBounds = getCornerWindowBounds(workArea);
    const panelBounds = getQuickPanelBounds(workArea);
    expect(
      shouldSuppressMainActivation({ now: 100, suppressUntil: 800 }),
    ).toBe(true);
    expect(
      shouldSuppressMainActivation({
        now: 900,
        suppressUntil: 800,
        cursorPoint: { x: -100, y: 500 },
        panelBounds,
      }),
    ).toBe(true);
    expect(
      shouldSuppressMainActivation({
        now: 900,
        suppressUntil: 800,
        cursorPoint: { x: -1, y: 25 },
        cornerBounds,
      }),
    ).toBe(true);
    expect(
      shouldSuppressMainActivation({
        now: 900,
        suppressUntil: 800,
        cursorPoint: { x: -500, y: 500 },
        cornerBounds,
        panelBounds,
      }),
    ).toBe(false);
  });

  it("opens only the quick panel from the corner and reserves main-window restore for the explicit footer action", () => {
    expect(quickCornerComponent).toContain("getBridge()?.openPanel()");
    expect(quickCornerComponent).not.toContain("openMain");

    const openPanelHandler = sourceBetween(
      'ipcMain.handle("quick-task:open-panel", async (event) => {',
      'ipcMain.handle("quick-task:close-panel"',
    );
    expect(openPanelHandler).toContain("return showQuickPanel();");
    expect(openPanelHandler).not.toContain("focusMainWindow");
    expect(openPanelHandler).not.toContain("mainWindow.show");

    const showPanel = sourceBetween(
      "async function showQuickPanel() {",
      "function pollQuickCorner() {",
    );
    expect(showPanel).toContain("target.show();");
    expect(showPanel).toContain("target.focus();");
    expect(showPanel).not.toContain("focusMainWindow");
    expect(showPanel).not.toContain("mainWindow.show");

    const openMainHandler = sourceBetween(
      'ipcMain.handle("quick-task:open-main", (event) => {',
      'ipcMain.handle("quick-task:request"',
    );
    expect(openMainHandler).toContain("focusMainWindow();");
  });

  it("does not let a focused quick panel block a later Dock activation", () => {
    expect(
      shouldSuppressMainActivation({
        now: 900,
        suppressUntil: 800,
        cursorPoint: { x: 720, y: 890 },
        panelBounds: getQuickPanelBounds(workArea),
      }),
    ).toBe(false);
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
