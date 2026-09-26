"use strict";

// Desktop host for the OpenSquilla V4.2 router. The model runs in a
// worker_threads worker (electron/opensquilla-router/runtime/router-worker.cjs,
// built from src/features/tongpin-ai/opensquilla/worker.ts), so loading and
// WebAssembly inference never block the main process or the renderer.

const os = require("node:os");
const path = require("node:path");

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_MESSAGE_UNITS = 48_000; // 24k code points; the worker re-validates exactly.
const MAX_CONTEXT_UNITS = 16_000; // 8k code points per context text.
const FAILURE_COOLDOWN_MS = 5 * 60_000;
// OpenSquilla keeps routing history for 30 minutes; an idle router is
// unloaded after the same window to give its ~200 MB back.
const IDLE_UNLOAD_MS = 30 * 60_000;

function unpackedPath(value) {
  // Files under asarUnpack live next to app.asar; worker_threads and the
  // WebAssembly loader need real paths.
  return value.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

function resolveOpenSquillaRouterPaths(electronDir) {
  const root = unpackedPath(path.join(electronDir, "opensquilla-router"));
  return {
    workerPath: path.join(root, "runtime", "router-worker.cjs"),
    runtimeDir: path.join(root, "runtime"),
    bundleDir: path.join(root, "bundle"),
  };
}

function defaultThreads() {
  // Two WebAssembly threads at most: results are identical for any thread
  // count, and a burst on every quick-tier send should not compete with the UI.
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(2, Math.floor(cpus / 2)));
}

/** Cheap structural bounds before structured-cloning into the worker. */
function isRouteInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  const allowed = ["conversationId", "message", "historyUserTexts", "prevAssistantText", "prevAssistantOutputTokens"];
  if (keys.some((key) => !allowed.includes(key))) return false;
  if (typeof value.conversationId !== "string" || !CONVERSATION_ID.test(value.conversationId)) return false;
  if (typeof value.message !== "string" || !value.message.trim() || value.message.length > MAX_MESSAGE_UNITS) return false;
  if (!Array.isArray(value.historyUserTexts) || value.historyUserTexts.length > 4) return false;
  if (value.historyUserTexts.some((text) => typeof text !== "string" || text.length > MAX_CONTEXT_UNITS)) return false;
  if (value.prevAssistantText !== null && (typeof value.prevAssistantText !== "string" || value.prevAssistantText.length > MAX_CONTEXT_UNITS)) return false;
  const tokens = value.prevAssistantOutputTokens;
  return tokens === null || (Number.isSafeInteger(tokens) && tokens >= 0 && tokens <= 10_000_000);
}

function createOpenSquillaRouterHost({
  workerPath,
  bundleDir,
  runtimeDir,
  numThreads = defaultThreads(),
  Worker = require("node:worker_threads").Worker,
  now = Date.now,
  routeTimeoutMs = 20_000,
  loadTimeoutMs = 90_000,
  idleUnloadMs = IDLE_UNLOAD_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let worker = null;
  let threads = numThreads;
  let ready = false;
  let nextId = 1;
  let failures = 0;
  let disabledUntil = 0;
  let lastError = "";
  let info = {};
  let idleTimer = null;
  const pending = new Map();

  function scheduleIdleUnload() {
    if (idleTimer) clearTimer(idleTimer);
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (pending.size || !worker) return;
      const current = worker;
      worker = null;
      ready = false;
      current.terminate().catch(() => {});
    }, idleUnloadMs);
    idleTimer?.unref?.();
  }

  function failAll(code) {
    for (const [id, entry] of pending) {
      clearTimer(entry.timer);
      entry.resolve({ ok: false, code });
      pending.delete(id);
    }
  }

  function drop(reason) {
    const current = worker;
    worker = null;
    ready = false;
    failAll("OPENSQUILLA_RUNTIME_FAILED");
    if (current) current.terminate().catch(() => {});
    lastError = reason;
    // A multi-threaded WebAssembly worker that fails is retried single-threaded
    // first; three single-threaded failures in a row pause the router.
    if (threads > 1) { threads = 1; return; }
    failures += 1;
    if (failures >= 3) disabledUntil = now() + FAILURE_COOLDOWN_MS;
  }

  function spawn() {
    if (worker) return worker;
    if (disabledUntil > now()) return null;
    let created;
    try {
      created = new Worker(workerPath, {
        workerData: { bundleDir, runtimeDir, numThreads: threads },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
    } catch (error) {
      drop(error && error.message ? error.message : "worker failed to start");
      return null;
    }
    created.on("message", (message) => {
      const entry = message && pending.get(message.id);
      if (!entry) return;
      clearTimer(entry.timer);
      pending.delete(message.id);
      if (message.ok) {
        ready = true;
        failures = 0;
        if (message.bundle) info = { ...info, bundle: message.bundle, ...(message.loadMs !== undefined ? { loadMs: message.loadMs } : {}), ...(message.warmupMs !== undefined ? { warmupMs: message.warmupMs } : {}) };
      } else if (message.code === "OPENSQUILLA_RUNTIME_FAILED" && !ready) {
        drop(String(message.message || "load failed"));
      }
      entry.resolve(message);
    });
    created.on("error", (error) => { if (worker === created) drop(error && error.message ? error.message : "worker error"); });
    created.on("exit", (code) => { if (worker === created) drop(`worker exited (${code})`); });
    created.unref();
    worker = created;
    return created;
  }

  function call(type, input) {
    const target = spawn();
    if (!target) return Promise.resolve({ ok: false, code: "OPENSQUILLA_UNAVAILABLE" });
    return new Promise((resolve) => {
      const id = nextId++;
      const timeout = ready ? routeTimeoutMs : loadTimeoutMs;
      const timer = setTimer(() => {
        // A stuck inference cannot be cancelled inside WebAssembly; restart the worker.
        pending.delete(id);
        resolve({ ok: false, code: "OPENSQUILLA_TIMEOUT" });
        if (worker === target) drop("timeout");
      }, timeout);
      timer?.unref?.();
      pending.set(id, { resolve: (message) => { scheduleIdleUnload(); resolve(message); }, timer });
      target.postMessage(type === "route" ? { id, type, input } : { id, type });
    });
  }

  return {
    async route(input) {
      if (!isRouteInput(input)) return { ok: false, code: "OPENSQUILLA_INPUT_INVALID" };
      const result = await call("route", input);
      return result.ok ? { ok: true, decision: result.decision } : { ok: false, code: result.code || "OPENSQUILLA_RUNTIME_FAILED" };
    },
    async warmup() {
      const result = await call("warmup");
      return result.ok ? { ok: true, ...info } : { ok: false, code: result.code || "OPENSQUILLA_RUNTIME_FAILED" };
    },
    status() {
      return { state: ready ? "ready" : worker ? "starting" : disabledUntil > now() ? "disabled" : "idle", threads, failures, lastError, ...info };
    },
    async dispose() {
      if (idleTimer) clearTimer(idleTimer);
      idleTimer = null;
      const current = worker;
      worker = null;
      ready = false;
      failAll("OPENSQUILLA_RUNTIME_FAILED");
      if (current) await current.terminate().catch(() => {});
    },
  };
}

function createOpenSquillaIpcHandlers({ isAllowedSender, host }) {
  return {
    route: async (event, input) => {
      if (!isAllowedSender(event)) return { ok: false, code: "OPENSQUILLA_FORBIDDEN" };
      return host.route(input);
    },
    warmup: async (event) => {
      if (!isAllowedSender(event)) return { ok: false, code: "OPENSQUILLA_FORBIDDEN" };
      return host.warmup();
    },
  };
}

module.exports = {
  createOpenSquillaIpcHandlers,
  createOpenSquillaRouterHost,
  isRouteInput,
  resolveOpenSquillaRouterPaths,
  unpackedPath,
};
