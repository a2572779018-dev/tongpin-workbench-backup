import { EventEmitter } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  createOpenSquillaIpcHandlers,
  createOpenSquillaRouterHost,
  isRouteInput,
  resolveOpenSquillaRouterPaths,
  unpackedPath,
} = require("./opensquilla-router.cjs");

const input = (extra = {}) => ({ conversationId: "conversation-a", message: "你好", historyUserTexts: [], prevAssistantText: null, prevAssistantOutputTokens: null, ...extra });

function fakeWorkers(behaviour) {
  const created = [];
  class FakeWorker extends EventEmitter {
    constructor(file, options) {
      super();
      this.file = file; this.options = options; this.terminated = false; this.posted = [];
      created.push(this);
    }
    postMessage(message) { this.posted.push(message); queueMicrotask(() => behaviour(this, message)); }
    unref() {}
    terminate() { this.terminated = true; return Promise.resolve(0); }
  }
  return { FakeWorker, created };
}

function manualTimers() {
  const timers = new Set();
  return {
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.add(timer); return timer; },
    clearTimer: (timer) => timers.delete(timer),
    fire: (ms) => { for (const timer of [...timers]) if (timer.ms === ms) { timers.delete(timer); timer.fn(); } },
  };
}

describe("OpenSquilla router host (Electron main process)", () => {
  it("maps packaged paths to app.asar.unpacked and validates renderer input cheaply", () => {
    expect(unpackedPath("/Applications/同频.app/Contents/Resources/app.asar/electron")).toBe("/Applications/同频.app/Contents/Resources/app.asar.unpacked/electron");
    expect(unpackedPath("C:\\Program Files\\同频\\resources\\app.asar\\electron")).toBe("C:\\Program Files\\同频\\resources\\app.asar.unpacked\\electron");
    const paths = resolveOpenSquillaRouterPaths("/app/resources/app.asar/electron");
    expect(paths.workerPath).toBe(path.join("/app/resources/app.asar.unpacked/electron/opensquilla-router", "runtime", "router-worker.cjs"));
    expect(isRouteInput(input())).toBe(true);
    for (const bad of [null, input({ extra: 1 }), input({ conversationId: "a b" }), input({ message: "" }), input({ historyUserTexts: ["a", "b", "c", "d", "e"] }), input({ prevAssistantOutputTokens: -2 })]) {
      expect(isRouteInput(bad)).toBe(false);
    }
  });

  it("starts the worker lazily, correlates replies and unloads it after the idle window", async () => {
    const timers = manualTimers();
    const { FakeWorker, created } = fakeWorkers((worker, message) => {
      worker.emit("message", message.type === "route"
        ? { id: message.id, ok: true, decision: { tier: "c1", echo: message.input.message } }
        : { id: message.id, ok: true, bundle: "90afd16eaf9a", loadMs: 800, warmupMs: 90 });
    });
    const host = createOpenSquillaRouterHost({ workerPath: "/w.cjs", bundleDir: "/b", runtimeDir: "/r", numThreads: 2, Worker: FakeWorker, idleUnloadMs: 1_800_000, ...timers });
    expect(created).toHaveLength(0);
    expect(await host.warmup()).toEqual({ ok: true, bundle: "90afd16eaf9a", loadMs: 800, warmupMs: 90 });
    expect(created[0].options.workerData).toEqual({ bundleDir: "/b", runtimeDir: "/r", numThreads: 2 });
    const [a, b] = await Promise.all([host.route(input({ message: "a" })), host.route(input({ message: "b" }))]);
    expect([a.decision.echo, b.decision.echo]).toEqual(["a", "b"]);
    expect(host.status()).toMatchObject({ state: "ready", threads: 2, bundle: "90afd16eaf9a" });
    expect(await host.route({ bad: true })).toEqual({ ok: false, code: "OPENSQUILLA_INPUT_INVALID" });
    timers.fire(1_800_000);
    expect(created[0].terminated).toBe(true);
    expect(host.status().state).toBe("idle");
    await host.route(input());
    expect(created).toHaveLength(2);
  });

  it("retries a failed multi-threaded start single-threaded, then backs off after repeated failures", async () => {
    let clock = 0;
    const { FakeWorker, created } = fakeWorkers((worker, message) => worker.emit("message", { id: message.id, ok: false, code: "OPENSQUILLA_RUNTIME_FAILED", message: "wasm failed" }));
    const host = createOpenSquillaRouterHost({ workerPath: "/w.cjs", bundleDir: "/b", runtimeDir: "/r", numThreads: 4, Worker: FakeWorker, now: () => clock, ...manualTimers() });
    expect(await host.route(input())).toEqual({ ok: false, code: "OPENSQUILLA_RUNTIME_FAILED" });
    expect(created[0].terminated).toBe(true);
    expect(host.status()).toMatchObject({ state: "idle", threads: 1, failures: 0, lastError: "wasm failed" });
    await host.route(input()); await host.route(input());
    expect(host.status()).toMatchObject({ state: "idle", failures: 2 });
    await host.route(input());
    expect(created.map(worker => worker.options.workerData.numThreads)).toEqual([4, 1, 1, 1]);
    expect(host.status().state).toBe("disabled");
    expect(await host.route(input())).toEqual({ ok: false, code: "OPENSQUILLA_UNAVAILABLE" });
    expect(created).toHaveLength(4);
    clock += 5 * 60_000 + 1;
    await host.route(input());
    expect(created).toHaveLength(5);
  });

  it("restarts a worker whose inference exceeded the timeout and a worker that crashed", async () => {
    const timers = manualTimers();
    let respond = true;
    const { FakeWorker, created } = fakeWorkers((worker, message) => {
      if (message.type === "warmup") worker.emit("message", { id: message.id, ok: true, bundle: "90afd16eaf9a" });
      else if (respond) worker.emit("message", { id: message.id, ok: true, decision: {} });
    });
    const host = createOpenSquillaRouterHost({ workerPath: "/w.cjs", bundleDir: "/b", runtimeDir: "/r", numThreads: 1, Worker: FakeWorker, routeTimeoutMs: 20_000, ...timers });
    await host.warmup();
    respond = false;
    const stuck = host.route(input());
    await Promise.resolve(); await Promise.resolve();
    timers.fire(20_000);
    expect(await stuck).toEqual({ ok: false, code: "OPENSQUILLA_TIMEOUT" });
    expect(created[0].terminated).toBe(true);
    respond = true;
    const pending = host.route(input());
    created[1].emit("error", new Error("boom"));
    expect(await pending).toEqual({ ok: false, code: "OPENSQUILLA_RUNTIME_FAILED" });
    expect(created[1].terminated).toBe(true);
    expect(host.status()).toMatchObject({ state: "idle", lastError: "boom" });
    // The next message starts a fresh worker.
    expect(await host.route(input())).toEqual({ ok: true, decision: {} });
    expect(created).toHaveLength(3);
    expect(host.status()).toMatchObject({ state: "ready", failures: 0 });
  });

  it("reports a worker that cannot start as unavailable instead of throwing", async () => {
    class BrokenWorker { constructor() { throw new Error("cannot start"); } }
    const host = createOpenSquillaRouterHost({ workerPath: "relative.cjs", bundleDir: "/b", runtimeDir: "/r", numThreads: 1, Worker: BrokenWorker, ...manualTimers() });
    expect(await host.route(input())).toEqual({ ok: false, code: "OPENSQUILLA_UNAVAILABLE" });
    expect(host.status()).toMatchObject({ state: "idle", failures: 1, lastError: "cannot start" });
  });

  it("serves only the main renderer frame over IPC", async () => {
    const host = { route: async () => ({ ok: true, decision: { tier: "c0" } }), warmup: async () => ({ ok: true }) };
    const handlers = createOpenSquillaIpcHandlers({ isAllowedSender: (event) => event.trusted === true, host });
    expect(await handlers.route({ trusted: false }, input())).toEqual({ ok: false, code: "OPENSQUILLA_FORBIDDEN" });
    expect(await handlers.warmup({ trusted: false })).toEqual({ ok: false, code: "OPENSQUILLA_FORBIDDEN" });
    expect(await handlers.route({ trusted: true }, input())).toEqual({ ok: true, decision: { tier: "c0" } });
  });
});

describe("OpenSquilla router worker built for the desktop app", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "tongpin-opensquilla-runtime-"));
  const routerDir = fileURLToPath(new URL("./opensquilla-router", import.meta.url));
  afterAll(() => rmSync(out, { recursive: true, force: true }));

  it("bundles, loads the V4.2 bundle through onnxruntime-web WebAssembly and routes in a worker thread", async () => {
    const { buildOpenSquillaRouterRuntime } = await import("../scripts/opensquilla-router/build-runtime.mjs");
    const built = await buildOpenSquillaRouterRuntime(path.join(out, "runtime"));
    expect(built.onnxruntimeWeb).toBe("1.30.0");
    const runtimeDir = path.join(out, "runtime");
    const host = createOpenSquillaRouterHost({ workerPath: path.join(runtimeDir, "router-worker.cjs"), runtimeDir, bundleDir: path.join(routerDir, "bundle"), numThreads: 1 });
    try {
      const warm = await host.warmup();
      expect(warm).toMatchObject({ ok: true, bundle: expect.stringMatching(/^[0-9a-f]{12}$/) });
      // A second warm-up reuses the first inference.
      expect(await host.warmup()).toEqual(warm);
      const simple = await host.route(input({ message: "谢谢" }));
      expect(simple).toMatchObject({ ok: true, decision: { router: "opensquilla", version: "v4.2-phase3", routeClass: "R0", tier: "c0", promptPolicy: "P0" } });
      const complaint = await host.route(input({ message: "不对，你搞错了", historyUserTexts: ["谢谢"], prevAssistantText: "不客气！", prevAssistantOutputTokens: 4 }));
      expect(complaint.decision.gates).toContain("complaint_upgrade");
    } finally { await host.dispose(); }
  }, 120_000);

  it("verifies the unpacked router in a packaged app layout", () => {
    const { verifyPackagedOpenSquillaRouter } = require("../scripts/opensquilla-router/verify-packaged.cjs");
    const archivePath = path.join(out, "app.asar");
    const unpacked = path.join(`${archivePath}.unpacked`, "electron", "opensquilla-router");
    mkdirSync(unpacked, { recursive: true });
    cpSync(path.join(out, "runtime"), path.join(unpacked, "runtime"), { recursive: true });
    cpSync(path.join(routerDir, "bundle"), path.join(unpacked, "bundle"), { recursive: true });
    const entries = new Set(["/electron/opensquilla-router.cjs", "/electron/opensquilla-router/runtime/router-worker.cjs", "/electron/opensquilla-router/bundle/manifest.json"]);
    expect(() => verifyPackagedOpenSquillaRouter({ archivePath, archiveEntries: entries })).toThrow("third-party notices");
    cpSync(path.join(routerDir, "licenses"), path.join(unpacked, "licenses"), { recursive: true });
    const verified = verifyPackagedOpenSquillaRouter({ archivePath, archiveEntries: entries });
    expect(verified).toMatchObject({ onnxruntimeWeb: "1.30.0" });
    expect(verified.bundleBytes).toBeGreaterThan(40_000_000);
    expect(() => verifyPackagedOpenSquillaRouter({ archivePath, archiveEntries: new Set([...entries].slice(1)) })).toThrow("missing /electron/opensquilla-router.cjs");
    writeFileSync(path.join(unpacked, "runtime", "router-worker.cjs"), "tampered");
    expect(() => verifyPackagedOpenSquillaRouter({ archivePath, archiveEntries: entries })).toThrow("does not match its manifest");
  });
});
