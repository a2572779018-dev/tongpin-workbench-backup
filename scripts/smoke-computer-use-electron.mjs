import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the real main.cjs, sandboxed preload and renderer IPC. Nothing is
// stubbed on Electron's app/process objects. No session is started and no OS
// permissions are requested. Each run gets a separate, disposable profile.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const profile = await mkdtemp(path.join(os.tmpdir(), "tongpin-electron-probe-"));
const panelMode = process.argv.includes("--panel");
const fixture = panelMode ? await build({ entryPoints: [path.join(root, "scripts/computer-use-panel-fixture.tsx")], bundle: true,
  write: false, outfile: "fixture.js", format: "esm", jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' } }) : null;
const server = http.createServer((_request, response) => {
  if (panelMode && _request.url === "/fixture.js") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(fixture.outputFiles.find(file => file.path.endsWith("fixture.js")).contents);
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(panelMode
    ? '<!doctype html><title>Tongpin panel fixture</title><div id="root"></div><script type="module" src="/fixture.js"></script>'
    : "<!doctype html><title>Tongpin isolated IPC probe</title><p>只读能力检查</p>");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(require("electron"), [path.join(root, "scripts/smoke-computer-use-electron-main.cjs")], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "", TONGPIN_PROBE_PROFILE: profile,
    VITE_DEV_SERVER_URL: origin, TONGPIN_API_URL: origin, TONGPIN_PROBE_MODE: panelMode ? "panel" : "native" },
  stdio: ["ignore", "pipe", "pipe"],
});
let output = "";
let errors = "";
child.stdout.on("data", chunk => { output += chunk; });
child.stderr.on("data", chunk => { errors += chunk; });
const timer = setTimeout(() => child.kill("SIGTERM"), 40_000);
try {
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  const line = output.split("\n").find(value => value.startsWith("TONGPIN_PROBE_RESULT "));
  assert.ok(line, `Electron did not report IPC probe: ${errors.slice(-2000)}`);
  const result = JSON.parse(line.slice("TONGPIN_PROBE_RESULT ".length));
  assert.equal(code, 0, JSON.stringify(result));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!panelMode) {
  assert.equal(result.probe.osVersion, result.systemVersion);
  assert.equal(result.nativeSessionStarted, false);
  assert.equal(result.probe.sdkVersion, "0.28.1");
  assert.ok(["ready", "permission_required", "unsupported_os", "unsupported_arch"].includes(result.probe.status),
    `Native runtime did not load cleanly: ${result.probe.status}`);
  }
  console.log(JSON.stringify({ ...result, isolatedProfile: profile }, null, 2));
} finally {
  clearTimeout(timer);
  server.close();
}
