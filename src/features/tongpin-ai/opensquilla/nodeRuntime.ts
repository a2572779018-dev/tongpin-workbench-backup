// Derived from OpenSquilla (https://github.com/TokenRhythm/opensquilla @ d27ba0e, Apache-2.0),
// ported to TypeScript and modified for Tongpin. See THIRD_PARTY_NOTICES.md.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ort from "onnxruntime-web";
import { OpenSquillaRouterEngine, type OpenSquillaBundleData, type OpenSquillaManifest, type OpenSquillaOnnxRunner } from "./engine";

/*
 * Node (Electron main-process worker) host for the OpenSquilla router: reads
 * the converted bundle, verifies every file against the bundle manifest, and
 * runs the two ONNX graphs with onnxruntime-web's WebAssembly backend —
 * the same ORT 1.30.0 graph optimizer OpenSquilla's Python runtime uses, with
 * no native addon to package per platform.
 */

export interface OrtWasmOptions {
  /** Contents of ort-wasm-simd-threaded.wasm; skips ORT's own file lookup. */
  wasmBinary?: Uint8Array;
  /** Absolute path of ort-wasm-simd-threaded.mjs (outside app.asar). */
  wasmModulePath?: string;
  /** WebAssembly threads (1–4). Work is split by output rows, so results do not depend on it. */
  numThreads?: number;
}

export interface LoadedOpenSquillaRouter {
  engine: OpenSquillaRouterEngine;
  manifestSha256: string;
  loadMs: number;
}

const REQUIRED_FILES = ["tokenizer.json", "tfidf-vocab.json", "tfidf-idf.f64", "svd-components.f64", "bge-pca.f32", "mlp-scaler.f64", "lgbm-main.bin", "bge.onnx", "mlp.onnx"] as const;

let ortConfigured = false;
function configureOrt(options: OrtWasmOptions): void {
  if (ortConfigured) return;
  ortConfigured = true;
  const threads = Number.isInteger(options.numThreads) ? Math.max(1, Math.min(4, options.numThreads!)) : 1;
  ort.env.wasm.numThreads = threads;
  ort.env.wasm.proxy = false;
  if (options.wasmBinary) ort.env.wasm.wasmBinary = options.wasmBinary;
  if (options.wasmModulePath) ort.env.wasm.wasmPaths = { mjs: pathToFileURL(options.wasmModulePath).href };
  ort.env.logLevel = "error";
}

async function readVerified(dir: string, name: string, manifest: OpenSquillaManifest): Promise<Buffer> {
  const expected = manifest.files[name];
  if (!expected) throw new Error(`OpenSquilla bundle manifest has no entry for ${name}`);
  const bytes = await readFile(path.join(dir, name));
  if (bytes.byteLength !== expected.bytes) throw new Error(`OpenSquilla bundle file ${name} has unexpected size`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== expected.sha256) throw new Error(`OpenSquilla bundle file ${name} failed its sha256 check`);
  return bytes;
}

export async function createOrtRunner(bgeModel: Uint8Array, mlpModel: Uint8Array, options: OrtWasmOptions = {}): Promise<OpenSquillaOnnxRunner & { release(): Promise<void> }> {
  configureOrt(options);
  const sessionOptions: ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all" };
  const bge = await ort.InferenceSession.create(bgeModel, sessionOptions);
  const mlp = await ort.InferenceSession.create(mlpModel, sessionOptions);
  if (bge.inputNames.join() !== "input_ids,attention_mask,token_type_ids" || bge.outputNames[0] !== "last_hidden_state") throw new Error("unexpected BGE ONNX signature");
  if (mlp.inputNames.length !== 1 || mlp.outputNames.length !== 1) throw new Error("unexpected MLP ONNX signature");
  return {
    async embed({ ids, mask, typeIds, batch, length }) {
      const shape = [batch, length];
      const result = await bge.run({
        input_ids: new ort.Tensor("int64", ids, shape),
        attention_mask: new ort.Tensor("int64", mask, shape),
        token_type_ids: new ort.Tensor("int64", typeIds, shape),
      });
      const hidden = result.last_hidden_state;
      const data = hidden.data as Float32Array;
      const copy = Float32Array.from(data);
      hidden.dispose();
      return copy;
    },
    async mlp(input) {
      const result = await mlp.run({ [mlp.inputNames[0]]: new ort.Tensor("float32", input, [1, input.length]) });
      const logits = result[mlp.outputNames[0]];
      const copy = Float32Array.from(logits.data as Float32Array);
      logits.dispose();
      return copy;
    },
    async release() { await bge.release(); await mlp.release(); },
  };
}

export async function loadOpenSquillaRouter(bundleDir: string, options: OrtWasmOptions & { auxHead?: boolean } = {}): Promise<LoadedOpenSquillaRouter> {
  const started = performance.now();
  const manifestBytes = await readFile(path.join(bundleDir, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as OpenSquillaManifest;
  for (const name of REQUIRED_FILES) if (!manifest.files[name]) throw new Error(`OpenSquilla bundle is missing ${name}`);
  const read = (name: string) => readVerified(bundleDir, name, manifest);
  const [tokenizer, vocab, idf, svd, pca, scaler, main, aux, bge, mlp] = await Promise.all([
    read("tokenizer.json"), read("tfidf-vocab.json"), read("tfidf-idf.f64"), read("svd-components.f64"), read("bge-pca.f32"),
    read("mlp-scaler.f64"), read("lgbm-main.bin"), options.auxHead === false ? Promise.resolve(undefined) : read("lgbm-aux.bin"), read("bge.onnx"), read("mlp.onnx"),
  ]);
  const data: OpenSquillaBundleData = {
    manifest,
    tokenizerJson: JSON.parse(tokenizer.toString("utf8")),
    tfidfVocabulary: JSON.parse(vocab.toString("utf8")) as string[],
    tfidfIdf: idf, svdComponents: svd, bgePca: pca, mlpScaler: scaler, lgbmMain: main,
    ...(aux ? { lgbmAux: aux } : {}),
  };
  const runner = await createOrtRunner(bge, mlp, options);
  const engine = new OpenSquillaRouterEngine(data, runner);
  return {
    engine,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    loadMs: performance.now() - started,
  };
}
