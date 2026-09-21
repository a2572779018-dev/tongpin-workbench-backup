const assert = require("node:assert/strict");
const path = require("node:path");
const { app, BrowserWindow, session } = require("electron");
const { createComputerUseController, computerUseSystemVersion } = require("../electron/computer-use.cjs");
const role = process.env.TONGPIN_NATIVE_TEST_ROLE;
const literal = "Tongpin controlled test";
const title = process.env.TONGPIN_NATIVE_TEST_TITLE;
assert.ok(path.isAbsolute(process.env.TONGPIN_NATIVE_TEST_DIR || ""));
app.setPath("userData", path.join(process.env.TONGPIN_NATIVE_TEST_DIR, role));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${process.env.TONGPIN_NATIVE_TEST_URL}/`) }));
  if (role === "editor") {
    const window = new BrowserWindow({ width: 600, height: 400, title, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
    await window.loadURL(process.env.TONGPIN_NATIVE_TEST_URL);
    window.show();
    console.log("EDITOR_READY " + JSON.stringify({ pid: process.pid }));
    return;
  }
  const pid = Number(process.env.TONGPIN_NATIVE_TEST_TARGET_PID);
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  const controller = createComputerUseController({
    osVersion: computerUseSystemVersion(),
    confirmSession: async () => true,
    confirmAction: async ({ action, window }) => window.pid === pid && window.title === title &&
      (action.kind === "click" || (action.kind === "type" && action.text === literal)),
  });
  let nativeActions = 0;
  const effects = [];
  try {
    const probe = await controller.probe();
    if (!probe.available) {
      console.log("NATIVE_TASK_RESULT " + JSON.stringify({ status: "blocked", probeStatus: probe.status, permissions: probe.permissions }));
      app.exit(2);
      return;
    }
    const started = await controller.startSession();
    assert.equal(started.ok, true);
    const listed = await controller.listWindows();
    assert.equal(listed.ok, true);
    const matches = listed.value.windows.filter(window => window.pid === pid && window.title === title);
    assert.equal(matches.length, 1, "Expected exactly one isolated test-editor window");
    const target = { pid, windowId: matches[0].windowId };
    const initial = await controller.getWindowState(target);
    assert.equal(initial.ok, true);
    const { runComputerUseTask } = require(process.env.TONGPIN_NATIVE_TEST_BUNDLE);
    const result = await runComputerUseTask({
      goal: `打开编辑器，输入“${literal}”`, initialState: initial.value,
      bridge: { ...controller, executeApprovedAction: async token => { nativeActions += 1; const output = await controller.executeApprovedAction(token); effects.push(output); return output; } },
      planNext: async (_goal, state) => {
        // Deterministic fixture planner, not a paid model. Raw native API and
        // one-use approval/fresh-state checks are the production controller.
        const open = state.elements.find(element => element.label === "Open test editor" && /button/iu.test(element.role));
        if (open) return { kind: "computer", summary: "Open isolated editor", action: { kind: "click", elementToken: open.elementToken } };
        const field = state.elements.find(element => element.label === "Test document" && /text|edit/iu.test(element.role));
        assert.ok(field, "Expected test-only document field");
        return { kind: "computer", summary: "Type fixed test literal", action: { kind: "type", elementToken: field.elementToken, text: literal } };
      },
    });
    const verifiedLiteral = result.observation?.elements.some(element => element.label === "Test document" && element.value === literal) === true;
    console.log("NATIVE_TASK_RESULT " + JSON.stringify({ status: result.status, steps: result.steps, message: result.message, verifiedLiteral,
      nativeActions, effects, nativeDriver: "@trycua/cua-driver@0.28.1", planner: "deterministic-test-only", approval: "exact-isolated-fixture-only" }));
    await controller.stopSession();
    app.exit(result.status === "completed" && verifiedLiteral ? 0 : 1);
  } catch (error) {
    console.log("NATIVE_TASK_RESULT " + JSON.stringify({ status: "failed", error: error.message, nativeActions }));
    await controller.stopSession();
    app.exit(1);
  }
});
