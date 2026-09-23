import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Safe, isolated native-driver integration: two actions against a test-only
// editor child, no live model, no user's windows/data and no OS permission
// changes. Confirmation callbacks authorize only this exact test window/text.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-native-task-"));
const taskBundle = path.join(directory, "computer-task.cjs");
await build({ entryPoints: [path.join(root, "src/features/tongpin-ai/computerUseTask.ts")], bundle: true, platform: "node", format: "cjs", outfile: taskBundle });
const title = `Tongpin isolated editor ${Date.now()}`;
const testNavigation = process.argv.includes("--navigation");
const expectScrollBlocked = process.argv.includes("--expect-scroll-blocked");
const useNativeEditor = process.platform === "darwin" && !process.argv.includes("--chromium-editor");
const editorBinary = path.join(directory, "TongpinComputerSmoke");
if (useNativeEditor) execFileSync("xcrun", ["swiftc", path.join(root, "scripts/computer-use-test-editor.swift"), "-o", editorBinary]);
const server = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>${title}</title><body style="padding:30px"><button aria-label="Open test editor" onclick="this.remove();document.getElementById('document').hidden=false">Open test editor</button><textarea id="document" aria-label="Test document" hidden style="width:400px;height:200px"></textarea><div role="region" tabindex="0" aria-label="Test scroll region" style="width:350px;height:100px;overflow:auto;border:1px solid #888">${Array.from({ length: 40 }, (_, index) => `<p>Line ${index + 1}</p>`).join("")}</div><output aria-label="Scroll position" id="scroll-position">0</output><script>document.querySelector('[role=region]').addEventListener('scroll', event => document.getElementById('scroll-position').textContent = String(Math.round(event.target.scrollTop)))</script></body>`);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const children = [];
function child(role, extra = {}) {
  const process = spawn(role === "editor" && useNativeEditor ? editorBinary : require("electron"), role === "editor" && useNativeEditor ? [] : [path.join(root, "scripts/smoke-computer-use-native-task-main.cjs")], {
    cwd: root, env: { ...globalThis.process.env, ELECTRON_RUN_AS_NODE: "", TONGPIN_NATIVE_TEST_ROLE: role,
      TONGPIN_NATIVE_TEST_DIR: directory, TONGPIN_NATIVE_TEST_URL: origin, TONGPIN_NATIVE_TEST_TITLE: title,
      TONGPIN_NATIVE_TEST_BUNDLE: taskBundle, ...extra }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(process);
  return process;
}
function report(process, prefix) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errors = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${prefix}: ${errors.slice(-1000)}`)), 45_000);
    process.stderr.on("data", chunk => { errors += chunk; });
    process.stdout.on("data", chunk => {
      output += chunk;
      const line = output.split("\n").find(value => value.startsWith(prefix));
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(prefix.length))); }
    });
    process.on("error", error => { clearTimeout(timer); reject(error); });
    process.on("exit", code => { clearTimeout(timer); if (!output.includes(prefix)) reject(new Error(`Child exited ${code}: ${errors.slice(-1000)}`)); });
  });
}
try {
  const editor = child("editor");
  const ready = await report(editor, "EDITOR_READY ");
  const controller = child("controller", { TONGPIN_NATIVE_TEST_TARGET_PID: String(ready.pid), TONGPIN_NATIVE_TEST_NAVIGATION: testNavigation ? "1" : "0" });
  const result = await report(controller, "NATIVE_TASK_RESULT ");
  console.log(JSON.stringify({ ...result, isolatedDirectory: directory }, null, 2));
  assert.equal(result.status, "completed", "Native task did not complete; do not claim acceptance");
  assert.equal(result.steps, 2);
  assert.equal(result.verifiedLiteral, true);
  assert.equal(result.nativeActions, testNavigation ? 4 : 2);
  if (testNavigation) {
    assert.equal(result.navigation?.scroll?.ok, !expectScrollBlocked,
      "Isolated scroll outcome did not match the declared platform boundary");
    assert.equal(result.navigation?.key?.ok, true, "Isolated safe key did not reach the native driver");
    assert.equal(result.navigation?.scrollMoved, !expectScrollBlocked,
      "Isolated scroll state change did not match the declared platform boundary");
    if (expectScrollBlocked) {
      assert.equal(result.navigation.scroll.error?.code, "background_unavailable");
      assert.match(JSON.stringify(result.navDiagnostics), /background_unavailable/);
    }
  }
} finally {
  for (const process of children) process.kill("SIGTERM");
  server.close();
}
