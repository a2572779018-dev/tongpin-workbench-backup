"use strict";

const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DARWIN_NATIVE_SPECS,
  MAC_UNIVERSAL_TARGET,
  verifyNativePackage,
  verifySourceComputerUseRuntime,
} = require("./verify-computer-use-runtime.cjs");

function packageRoot(spec) {
  return `${spec.scope}/${spec.packageName}`;
}

function lockEntryFor(root, spec) {
  const lockPath = path.join(root, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const key = `node_modules/${packageRoot(spec)}`;
  const entry = lock.packages?.[key];
  if (
    !entry ||
    entry.version !== spec.version ||
    !Array.isArray(entry.os) ||
    entry.os.length !== 1 ||
    entry.os[0] !== spec.os ||
    !Array.isArray(entry.cpu) ||
    entry.cpu.length !== 1 ||
    entry.cpu[0] !== spec.cpu ||
    typeof entry.resolved !== "string" ||
    !entry.resolved.startsWith("https://") ||
    typeof entry.integrity !== "string" ||
    !entry.integrity.startsWith("sha512-")
  ) {
    throw new Error(`${key} is not fully pinned in package-lock.json`);
  }
  return entry;
}

function assertSafeTarEntries(source) {
  const entries = source.split(/\r?\n/).filter(Boolean);
  if (entries.length === 0) throw new Error("native package tarball is empty");
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/, "");
    const segments = normalized.split("/");
    if (
      entry.includes("\\") ||
      path.posix.isAbsolute(entry) ||
      segments[0] !== "package" ||
      segments.some((segment) => segment === "..")
    ) {
      throw new Error(`native package tarball contains unsafe path: ${entry}`);
    }
  }
}

function rejectSymlinks(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const current = path.join(root, entry.name);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`native package contains a symlink: ${current}`);
    }
    if (stat.isDirectory()) rejectSymlinks(current);
  }
}

async function installLockedPackage(root, spec, fetchImpl = fetch) {
  const entry = lockEntryFor(root, spec);
  const response = await fetchImpl(entry.resolved, {
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(
      `failed to download ${packageRoot(spec)}: HTTP ${response.status}`,
    );
  }
  const archive = Buffer.from(await response.arrayBuffer());
  const actualIntegrity = `sha512-${createHash("sha512")
    .update(archive)
    .digest("base64")}`;
  if (actualIntegrity !== entry.integrity) {
    throw new Error(`${packageRoot(spec)} tarball integrity does not match lockfile`);
  }

  const temporaryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "tongpin-cua-native-"),
  );
  try {
    const archivePath = path.join(temporaryRoot, "package.tgz");
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
    const listing = execFileSync("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    assertSafeTarEntries(listing);

    const target = path.join(root, "node_modules", ...packageRoot(spec).split("/"));
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    execFileSync(
      "tar",
      ["-xzf", archivePath, "--strip-components=1", "-C", target],
      { stdio: "pipe", maxBuffer: 4 * 1024 * 1024 },
    );
    rejectSymlinks(target);
    verifyNativePackage(path.join(root, "node_modules"), spec);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

async function prepareDarwinUniversalRuntime({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  fetchImpl = fetch,
} = {}) {
  if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) {
    throw new Error("darwin-universal runtime preparation must run on macOS");
  }

  const modulesRoot = path.join(root, "node_modules");
  const installed = [];
  for (const spec of DARWIN_NATIVE_SPECS) {
    try {
      lockEntryFor(root, spec);
      verifyNativePackage(modulesRoot, spec);
    } catch {
      process.stdout.write(`Preparing locked ${packageRoot(spec)}...\n`);
      await installLockedPackage(root, spec, fetchImpl);
      installed.push(packageRoot(spec));
    }
  }

  verifySourceComputerUseRuntime({
    root,
    platform,
    arch,
    target: MAC_UNIVERSAL_TARGET,
  });
  return installed;
}

if (require.main === module) {
  const targetIndex = process.argv.indexOf("--target");
  const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
  if (target !== MAC_UNIVERSAL_TARGET) {
    throw new Error(
      "Usage: node scripts/prepare-computer-use-runtime.cjs --target darwin-universal",
    );
  }
  prepareDarwinUniversalRuntime()
    .then((installed) => {
      process.stdout.write(
        installed.length > 0
          ? `Prepared ${installed.length} locked macOS native packages.\n`
          : "Locked macOS universal native packages were already prepared.\n",
      );
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = {
  assertSafeTarEntries,
  lockEntryFor,
  prepareDarwinUniversalRuntime,
};
