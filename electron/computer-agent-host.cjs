"use strict";

/**
 * Electron wiring for the unified computer executor (computer-agent.cjs):
 * native dialogs, the exact macOS privacy panes, the Esc stop shortcut and
 * the four narrow IPC channels. main.cjs only calls registerComputerAgentIpc.
 */

const { app, desktopCapturer, dialog, globalShortcut, shell, systemPreferences } = require("electron");
const { createComputerAgentController } = require("./computer-agent.cjs");
const { computerUseSystemVersion } = require("./computer-use.cjs");

const PRIVACY_PANES = Object.freeze({
  accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenRecording: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
});

function registerComputerAgentIpc({ ipcMain, getMainWindow, assertMainRendererEvent }) {
  let controller = null;

  function mainWindow() {
    const window = getMainWindow();
    return window && !window.isDestroyed() ? window : null;
  }

  /** Brings 同频 forward (a confirmation or the end of a run in another app). */
  function bringForward(parent) {
    if (process.platform === "darwin") app.focus({ steal: true });
    if (parent.isMinimized()) parent.restore();
    parent.show();
    parent.focus();
  }

  /** A confirmation is never hidden behind the target app. */
  async function confirm(spec, type) {
    const parent = mainWindow();
    if (!parent) return false;
    try {
      bringForward(parent);
    } catch {
      // The dialog still opens attached to the window.
    }
    const choice = await dialog.showMessageBox(parent, {
      type,
      title: spec.title,
      message: spec.message,
      detail: spec.detail,
      buttons: spec.buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return choice.response === 1;
  }

  function controllerFor() {
    if (controller) return controller;
    controller = createComputerAgentController({
      platform: process.platform,
      arch: process.arch,
      osVersion: computerUseSystemVersion(),
      hostPid: process.pid,
      showConsent: (spec) => confirm(spec, "question"),
      showExtraConsent: (spec) => confirm(spec, "warning"),
      openPrivacyPane: async (pane) => {
        if (process.platform !== "darwin") return;
        const key = pane === "screenRecording" ? "screenRecording" : "accessibility";
        try {
          // Registers 同频 in the privacy list so the member can switch it on.
          if (key === "screenRecording") await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
          else systemPreferences.isTrustedAccessibilityClient(true);
        } catch {
          // The pane still opens; the member can add 同频 with the + button.
        }
        await shell.openExternal(PRIVACY_PANES[key]);
      },
      emit: (event) => {
        const window = mainWindow();
        if (window) window.webContents.send("computer-agent:event", event);
      },
      restoreHost: () => {
        const window = mainWindow();
        if (window) bringForward(window);
      },
      registerStopShortcut: (onStop) => {
        if (!globalShortcut.register("Escape", onStop)) return null;
        return () => globalShortcut.unregister("Escape");
      },
    });
    return controller;
  }

  ipcMain.handle("computer-agent:consent", async (event, input) => {
    assertMainRendererEvent(event);
    return controllerFor().consent(input);
  });
  ipcMain.handle("computer-agent:observe", async (event) => {
    assertMainRendererEvent(event);
    return controllerFor().observe();
  });
  ipcMain.handle("computer-agent:execute", async (event, input) => {
    assertMainRendererEvent(event);
    return controllerFor().execute(input);
  });
  ipcMain.handle("computer-agent:stop", async (event) => {
    assertMainRendererEvent(event);
    return controllerFor().stop("user");
  });

  return Object.freeze({
    /** Emergency stop (logout, window closed, lock screen, quit). */
    stop: (reason) => (controller ? controller.stop(reason) : Promise.resolve({ ok: true, value: { stopped: true } })),
  });
}

module.exports = { registerComputerAgentIpc };
