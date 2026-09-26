// Builds the desktop OpenSquilla router runtime into electron/opensquilla-router/runtime/:
//   router-worker.cjs            worker_threads entry (TypeScript engine + onnxruntime-web JS, bundled)
//   ort-wasm-simd-threaded.mjs   onnxruntime-web WebAssembly loader
//   ort-wasm-simd-threaded.wasm  onnxruntime-web WebAssembly binary
//   runtime-manifest.json        versions and sha256 of the three files above
// The converted model bundle (electron/opensquilla-router/bundle/) is versioned in git.
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const ORT_VERSION = "1.30.0"; // must equal the onnxruntime used by OpenSquilla's reference (uv.lock)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_RUNTIME_DIR = path.join(root, "electron/opensquilla-router/runtime");

export async function buildOpenSquillaRouterRuntime(out = DEFAULT_RUNTIME_DIR) {
  const require = createRequire(import.meta.url);
  // package.json is not an exported subpath; the wasm binary is.
  const ortDist = path.dirname(require.resolve("onnxruntime-web/ort-wasm-simd-threaded.wasm", { paths: [root] }));
  const ortVersion = JSON.parse(readFileSync(path.join(path.dirname(ortDist), "package.json"), "utf8")).version;
  if (ortVersion !== ORT_VERSION) throw new Error(`onnxruntime-web ${ortVersion} installed; the OpenSquilla router is validated with ${ORT_VERSION}`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: [path.join(root, "src/features/tongpin-ai/opensquilla/worker.ts")],
    outfile: path.join(out, "router-worker.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    legalComments: "eof",
    logLevel: "warning",
    // onnxruntime-web's Node ESM build calls createRequire(import.meta.url).
    banner: { js: 'const __opensquillaImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    define: { "import.meta.url": "__opensquillaImportMetaUrl" },
  });
  for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]) {
    copyFileSync(path.join(ortDist, name), path.join(out, name));
  }
  const files = Object.fromEntries(["router-worker.cjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"].map(name => {
    const bytes = readFileSync(path.join(out, name));
    return [name, { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }];
  }));
  writeFileSync(path.join(out, "runtime-manifest.json"), `${JSON.stringify({ onnxruntimeWeb: ortVersion, files }, null, 1)}\n`);
  return { out, onnxruntimeWeb: ortVersion, files };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await buildOpenSquillaRouterRuntime(process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_RUNTIME_DIR);
  console.log(`OpenSquilla router runtime: ${Object.entries(result.files).map(([name, file]) => `${name} ${(file.bytes / 1024).toFixed(0)} KiB`).join(", ")}`);
}
