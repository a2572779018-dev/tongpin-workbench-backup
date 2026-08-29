import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const electronMain = readFileSync(
  new URL("../../electron/main.cjs", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function sourceBetween(start: string, end: string): string {
  const startIndex = electronMain.indexOf(start);
  const endIndex = electronMain.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return electronMain.slice(startIndex, endIndex);
}

describe("Windows tray integration", () => {
  it("creates a Windows-only tray for the normal app and destroys it on quit", () => {
    expect(electronMain).toContain("  Tray,\n} = require(\"electron\");");
    expect(electronMain).toContain(
      'const isWindows = process.platform === "win32";',
    );

    const ensureTray = sourceBetween(
      "function ensureWindowsTray() {",
      "function canShowQuickTasks() {",
    );
    expect(ensureTray).toContain(
      "if (!isWindows || isQuickTaskPreview) return null;",
    );
    expect(ensureTray).toContain("windowsTray = new Tray(APP_ICON_PATH);");
    expect(ensureTray).toContain('windowsTray.setToolTip("同频");');
    expect(ensureTray).toContain('windowsTray.on("click", focusMainWindow);');
    expect(ensureTray).toContain('{ label: "打开同频", click: focusMainWindow }');
    expect(ensureTray).toContain('{ label: "退出同频", click: () => app.quit() }');

    const readyLifecycle = sourceBetween(
      "app.whenReady().then(async () => {",
      'app.on("window-all-closed"',
    );
    expect(readyLifecycle).toMatch(
      /if \(isQuickTaskPreview\)[\s\S]*?} else \{\n    await createWindow\(\);\n    ensureWindowsTray\(\);\n  }/,
    );
    expect(electronMain).toContain('app.on("will-quit", destroyWindowsTray);');
  });

  it("hides Windows directly and restores taskbar presence before showing", () => {
    const hideToTray = sourceBetween(
      "function hideMainWindowToTray() {",
      "function ensureWindowsTray() {",
    );
    expect(hideToTray).toContain(
      "if (!isWindows || !mainWindow || mainWindow.isDestroyed()) return false;",
    );
    expect(hideToTray.indexOf("mainWindow.setSkipTaskbar(true);")).toBeLessThan(
      hideToTray.indexOf("mainWindow.hide();"),
    );

    const focusMain = sourceBetween(
      "function focusMainWindow() {",
      "function hideMainWindowToTray() {",
    );
    expect(focusMain.indexOf("mainWindow.setSkipTaskbar(false);")).toBeLessThan(
      focusMain.indexOf("mainWindow.show();"),
    );
  });

  it("uses the custom tray path on Windows while retaining native macOS minimize", () => {
    expect(electronMain).toContain("    minimizable: !isWindows,");
    expect(electronMain).toContain(
      'mainWindow.on("minimize", () => {\n    if (isWindows) hideMainWindowToTray();\n  });',
    );

    const minimizeHandler = sourceBetween(
      'ipcMain.handle("window:minimize", (event) => {',
      'ipcMain.handle("window:toggle-maximize"',
    );
    expect(minimizeHandler).toContain(
      "if (isWindows) {\n      hideMainWindowToTray();\n      return;\n    }",
    );
    expect(minimizeHandler).toContain("mainWindow.minimize();");
    expect(minimizeHandler.indexOf("hideMainWindowToTray();")).toBeLessThan(
      minimizeHandler.indexOf("mainWindow.minimize();"),
    );

    const closeHandler = sourceBetween(
      'ipcMain.handle("window:close", (event) => {',
      'ipcMain.handle("window:is-maximized"',
    );
    expect(closeHandler).toContain("mainWindow.close();");
    expect(closeHandler).not.toContain("hideMainWindowToTray");
  });
});
