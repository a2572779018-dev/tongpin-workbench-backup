"use strict";

// Packaging check for the desktop OpenSquilla router: the worker, the
// onnxruntime-web WebAssembly files and every converted model file must be
// unpacked next to app.asar (worker_threads and WebAssembly need real files)
// and byte-identical to what the build recorded.

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROUTER = "electron/opensquilla-router";

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function verifyFiles(root, files, label) {
  for (const [name, expected] of Object.entries(files)) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) throw new Error(`Packaged OpenSquilla ${label} is missing ${name}`);
    const size = fs.statSync(file).size;
    if (size !== expected.bytes || sha256(file) !== expected.sha256) throw new Error(`Packaged OpenSquilla ${label} file ${name} does not match its manifest`);
  }
  return Object.values(files).reduce((sum, item) => sum + item.bytes, 0);
}

function verifyPackagedOpenSquillaRouter({ archivePath, archiveEntries }) {
  for (const entry of [`/electron/opensquilla-router.cjs`, `/${ROUTER}/runtime/router-worker.cjs`, `/${ROUTER}/bundle/manifest.json`]) {
    if (!archiveEntries.has(entry)) throw new Error(`Packaged app.asar is missing ${entry}`);
  }
  const unpacked = path.join(`${archivePath}.unpacked`, ROUTER);
  const runtimeManifest = JSON.parse(fs.readFileSync(path.join(unpacked, "runtime", "runtime-manifest.json"), "utf8"));
  const bundleManifest = JSON.parse(fs.readFileSync(path.join(unpacked, "bundle", "manifest.json"), "utf8"));
  if (bundleManifest.format !== "tongpin-opensquilla-router-bundle" || bundleManifest.router?.version !== "v4.2") {
    throw new Error("Packaged OpenSquilla bundle manifest is not the V4.2 router bundle");
  }
  const runtimeBytes = verifyFiles(path.join(unpacked, "runtime"), runtimeManifest.files, "runtime");
  const bundleBytes = verifyFiles(path.join(unpacked, "bundle"), bundleManifest.files, "bundle");
  // Notices for the libraries compiled into the ONNX Runtime WebAssembly binary.
  const notices = path.join(unpacked, "licenses", "onnxruntime-ThirdPartyNotices.txt");
  if (!fs.existsSync(notices) || fs.statSync(notices).size === 0) throw new Error("Packaged OpenSquilla router is missing the ONNX Runtime third-party notices");
  return { runtimeBytes, bundleBytes, onnxruntimeWeb: runtimeManifest.onnxruntimeWeb };
}

module.exports = { verifyPackagedOpenSquillaRouter };
