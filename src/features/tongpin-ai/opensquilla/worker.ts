import { readFileSync } from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { loadOpenSquillaRouter } from "./nodeRuntime";
import { OpenSquillaInputError, OpenSquillaRoutingService } from "./routerService";

/*
 * worker_threads entry bundled to electron/opensquilla-router/runtime/router-worker.cjs.
 * The Electron main process only forwards bounded requests here, so model
 * loading and WebAssembly inference never block the main or renderer threads.
 */

interface RouterWorkerData { bundleDir: string; runtimeDir: string; numThreads?: number }
type Request = { id: number; type: "warmup" | "status" } | { id: number; type: "route"; input: unknown };

const config = workerData as RouterWorkerData;
let loading: Promise<{ service: OpenSquillaRoutingService; loadMs: number }> | undefined;
// The renderer warms up on every switch to the quick tier; one inference per worker is enough.
let warming: Promise<number> | undefined;

function service() {
  loading ??= (async () => {
    const wasmBinary = readFileSync(path.join(config.runtimeDir, "ort-wasm-simd-threaded.wasm"));
    const loaded = await loadOpenSquillaRouter(config.bundleDir, {
      wasmBinary,
      wasmModulePath: path.join(config.runtimeDir, "ort-wasm-simd-threaded.mjs"),
      numThreads: config.numThreads ?? 1,
    });
    return { service: new OpenSquillaRoutingService(loaded.engine, loaded.manifestSha256.slice(0, 12)), loadMs: loaded.loadMs };
  })();
  return loading;
}

function reply(message: Record<string, unknown>): void { parentPort!.postMessage(message); }

parentPort!.on("message", (request: Request) => {
  void (async () => {
    try {
      const { service: router, loadMs } = await service();
      if (request.type === "route") reply({ id: request.id, ok: true, decision: await router.route(request.input) });
      else if (request.type === "warmup") {
        warming ??= router.warmup().catch((error: unknown) => { warming = undefined; throw error; });
        reply({ id: request.id, ok: true, loadMs: Math.round(loadMs), warmupMs: Math.round(await warming), bundle: router.bundle });
      }
      else reply({ id: request.id, ok: true, bundle: router.bundle, loadMs: Math.round(loadMs) });
    } catch (error) {
      const code = error instanceof OpenSquillaInputError ? "OPENSQUILLA_INPUT_INVALID" : "OPENSQUILLA_RUNTIME_FAILED";
      reply({ id: request.id, ok: false, code, message: error instanceof Error ? error.message.slice(0, 300) : "router failed" });
    }
  })();
});
