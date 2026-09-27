"use strict";

/**
 * Electron wiring for the unified computer executor (computer-agent.cjs):
 * native dialogs, the exact macOS privacy panes, the Esc stop shortcut and
 * the four narrow IPC channels. main.cjs only calls registerComputerAgentIpc.
 */

const { execFile } = require("node:child_process");
const { app, desktopCapturer, dialog, globalShortcut, shell, systemPreferences } = require("electron");
const { createComputerAgentController, parseLayeredWindows, parseRecognizedText } = require("./computer-agent.cjs");
const { computerUseSystemVersion } = require("./computer-use.cjs");

/**
 * One app's on-screen windows on CGWindow layers other than 0, read with the
 * system's own JavaScript for Automation (CoreGraphics window list; no Apple
 * Events, no other app is driven). Cua Driver lists layer-0 windows only, and
 * WeChat draws its search list on another layer. The script is fixed: only
 * the validated pid is written into it.
 */
function listLayeredWindows(pid) {
  if (process.platform !== "darwin" || !Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  // Same calls as the check run on the member's Mac (WeChat's search list
  // came back as layer 3); 17 = kCGWindowListOptionOnScreenOnly |
  // kCGWindowListExcludeDesktopElements.
  const script = [
    "function run() {",
    "  ObjC.import(\"CoreGraphics\");",
    "  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(17, 0))) || [];",
    `  return JSON.stringify(list.filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer !== 0 && w.kCGWindowBounds)`,
    "    .slice(0, 20).map((w) => [w.kCGWindowNumber, w.kCGWindowLayer, w.kCGWindowBounds.X, w.kCGWindowBounds.Y, w.kCGWindowBounds.Width, w.kCGWindowBounds.Height]));",
    "}",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script], { timeout: 3_000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
      // null: the windows could not be listed (never "there are none").
      resolve(error ? null : parseLayeredWindows(stdout, pid));
    });
  });
}

/**
 * The system's text recognition (Vision's VNRecognizeTextRequest, through
 * JavaScript for Automation) over one window picture, handed over on the
 * script's standard input — never written to disk. The script is fixed and
 * takes no arguments. Nothing leaves this machine. Rows as
 * parseRecognizedText reads them; null when recognition is unavailable.
 */
const RECOGNIZE_TEXT_SCRIPT = [
  "function run() {",
  "  ObjC.import(\"Foundation\");",
  "  ObjC.import(\"Vision\");",
  "  const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;",
  "  if (!data || !data.length) return \"null\";",
  "  const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(data, $.NSDictionary.dictionary);",
  "  const request = $.VNRecognizeTextRequest.alloc.init;",
  "  request.recognitionLevel = 0;",
  "  request.usesLanguageCorrection = false;",
  "  request.recognitionLanguages = $([\"zh-Hans\", \"en-US\"]);",
  "  if (!handler.performRequestsError($([request]), null)) return \"null\";",
  "  const results = request.results;",
  "  const rows = [];",
  "  for (let i = 0; results && i < results.count && rows.length < 400; i += 1) {",
  "    const item = results.objectAtIndex(i);",
  "    const top = item.topCandidates(1);",
  "    if (!top.count) continue;",
  "    const box = item.boundingBox;",
  "    rows.push([top.objectAtIndex(0).string.js, Number(top.objectAtIndex(0).confidence), box.origin.x, box.origin.y, box.size.width, box.size.height]);",
  "  }",
  "  return JSON.stringify(rows);",
  "}",
].join("\n");
const MAX_PICTURE_BASE64 = 32 * 1024 * 1024;

function recognizeWindowText(imageBase64) {
  if (process.platform !== "darwin" || typeof imageBase64 !== "string" || !imageBase64 || imageBase64.length > MAX_PICTURE_BASE64) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", RECOGNIZE_TEXT_SCRIPT], { timeout: 8_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve(error ? null : parseRecognizedText(stdout));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(Buffer.from(imageBase64, "base64"));
    } catch {
      resolve(null);
    }
  });
}

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
      listPopupWindows: listLayeredWindows,
      recognizeText: recognizeWindowText,
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
