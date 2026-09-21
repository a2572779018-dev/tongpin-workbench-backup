const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");

assert.ok(process.versions.electron, "Must run with real Electron, not Node");
assert.ok(path.isAbsolute(process.env.TONGPIN_PROBE_PROFILE || ""));
app.setPath("userData", process.env.TONGPIN_PROBE_PROFILE);
app.setPath("sessionData", process.env.TONGPIN_PROBE_PROFILE);
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-finish-load", async () => {
    if (contents.getURL() !== `${process.env.VITE_DEV_SERVER_URL}/`) return;
    try {
      if (process.env.TONGPIN_PROBE_MODE === "panel") {
        const result = await contents.executeJavaScript("window.fixtureResult", true);
        assert.ok(result?.retryRecovered, "Real component fixture did not finish");
        console.log("TONGPIN_PROBE_RESULT " + JSON.stringify({ ok: true, ...result, electron: process.versions.electron }));
        app.exit(0);
        return;
      }
      const probe = await contents.executeJavaScript("window.tongpin.computerUse.probe()", true);
      console.log("TONGPIN_PROBE_RESULT " + JSON.stringify({
        ok: true, probe, systemVersion: process.getSystemVersion(),
        electron: process.versions.electron, nativeSessionStarted: false,
      }));
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.exit(0);
    } catch (error) {
      console.log("TONGPIN_PROBE_RESULT " + JSON.stringify({ ok: false, error: error.message }));
      app.exit(1);
    }
  });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith(`${process.env.VITE_DEV_SERVER_URL}/`) });
  });
});
if (process.env.TONGPIN_PROBE_MODE === "panel") {
  app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL(process.env.VITE_DEV_SERVER_URL);
  });
} else {
  require("../electron/main.cjs");
}
