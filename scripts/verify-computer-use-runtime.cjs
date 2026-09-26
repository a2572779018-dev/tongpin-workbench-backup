"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CUA_VERSION = "0.28.1";
const UBJS_VERSION = "0.31.0-3";
const WINDOWS_TARGET = "win32-x64";
const MAC_UNIVERSAL_TARGET = "darwin-universal";
const SUPPORTED_TARGETS = new Set([WINDOWS_TARGET, MAC_UNIVERSAL_TARGET]);

const WINDOWS_NATIVE_SPECS = Object.freeze([
  Object.freeze({
    scope: "@trycua",
    packageName: "cua-driver-win32-x64-msvc",
    version: CUA_VERSION,
    os: "win32",
    cpu: "x64",
    binaries: Object.freeze([
      Object.freeze({ path: "cua_driver_sdk.dll", format: "pe" }),
      Object.freeze({ path: "cua_driver_node_runtime.node", format: "pe" }),
    ]),
  }),
  Object.freeze({
    scope: "@ubjs",
    packageName: "node-win32-x64-msvc",
    version: UBJS_VERSION,
    os: "win32",
    cpu: "x64",
    binaries: Object.freeze([
      Object.freeze({
        path: "uniffi-runtime-napi.win32-x64-msvc.node",
        format: "pe",
      }),
    ]),
  }),
]);

const DARWIN_NATIVE_SPECS = Object.freeze([
  ...["arm64", "x64"].map((cpu) =>
    Object.freeze({
      scope: "@trycua",
      packageName: `cua-driver-darwin-${cpu}`,
      version: CUA_VERSION,
      os: "darwin",
      cpu,
      binaries: Object.freeze([
        Object.freeze({
          path: "libcua_driver_sdk.dylib",
          format: "macho",
          architecture: cpu,
        }),
        Object.freeze({
          path: "cua_driver_node_runtime.node",
          format: "macho",
          architecture: cpu,
        }),
      ]),
    }),
  ),
  ...["arm64", "x64"].map((cpu) =>
    Object.freeze({
      scope: "@ubjs",
      packageName: `node-darwin-${cpu}`,
      version: UBJS_VERSION,
      os: "darwin",
      cpu,
      binaries: Object.freeze([
        Object.freeze({
          path: `uniffi-runtime-napi.darwin-${cpu}.node`,
          format: "macho",
          architecture: cpu,
        }),
      ]),
    }),
  ),
]);

const MACH_CPU_NAMES = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);

function fail(message) {
  throw new Error(`Computer-use native runtime verification failed: ${message}`);
}

function packageRoot(spec) {
  return `${spec.scope}/${spec.packageName}`;
}

function readRequiredFile(root, relativePath, { format, architecture } = {}) {
  const filePath = path.join(root, ...relativePath.split("/"));
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch {
    fail(`missing ${relativePath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    fail(`${relativePath} must be a non-empty regular file`);
  }
  const data = fs.readFileSync(filePath);
  if (
    format === "pe" &&
    (data.length < 2 || data[0] !== 0x4d || data[1] !== 0x5a)
  ) {
    fail(`${relativePath} is not a Windows PE binary`);
  }
  if (format === "macho") {
    const architectures = readMachOArchitectures(data, relativePath);
    if (!architectures.has(architecture)) {
      fail(
        `${relativePath} does not contain the declared ${architecture} Mach-O slice`,
      );
    }
  }
  return data;
}

function readPackageJson(root, relativePath) {
  try {
    return JSON.parse(readRequiredFile(root, relativePath).toString("utf8"));
  } catch (error) {
    if (String(error?.message).startsWith("Computer-use native runtime")) {
      throw error;
    }
    fail(`${relativePath} is not valid JSON`);
  }
}

function exactPlatformList(value, expected) {
  return Array.isArray(value) && value.length === 1 && value[0] === expected;
}

function cpuName(cpuType, relativePath) {
  const normalized = cpuType >>> 0;
  const name = MACH_CPU_NAMES.get(normalized);
  if (!name) {
    fail(
      `${relativePath} contains unsupported Mach-O CPU type 0x${normalized.toString(16)}`,
    );
  }
  return name;
}

function readThinMachOCpu(data, offset, size, relativePath) {
  if (size < 32 || offset < 0 || offset + size > data.length) {
    fail(`${relativePath} contains an out-of-bounds Mach-O slice`);
  }
  const magicBe = data.readUInt32BE(offset);
  const magicLe = data.readUInt32LE(offset);
  if (magicLe === 0xfeedfacf) {
    return cpuName(data.readUInt32LE(offset + 4), relativePath);
  }
  if (magicBe === 0xfeedfacf) {
    return cpuName(data.readUInt32BE(offset + 4), relativePath);
  }
  fail(`${relativePath} contains a slice that is not a 64-bit Mach-O binary`);
}

function readMachOArchitectures(data, relativePath) {
  if (!Buffer.isBuffer(data) || data.length < 32) {
    fail(`${relativePath} is not a complete Mach-O binary`);
  }

  const magicBe = data.readUInt32BE(0);
  const magicLe = data.readUInt32LE(0);
  const architectures = new Set();

  if (magicBe === 0xcafebabe || magicBe === 0xcafebabf) {
    const entrySize = magicBe === 0xcafebabf ? 32 : 20;
    const count = data.readUInt32BE(4);
    const headerSize = 8 + count * entrySize;
    if (count < 1 || count > 16 || data.length < headerSize) {
      fail(`${relativePath} has an invalid universal Mach-O header`);
    }
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 8 + index * entrySize;
      const declaredCpu = cpuName(data.readUInt32BE(entryOffset), relativePath);
      const sliceOffset =
        entrySize === 32
          ? Number(data.readBigUInt64BE(entryOffset + 8))
          : data.readUInt32BE(entryOffset + 8);
      const sliceSize =
        entrySize === 32
          ? Number(data.readBigUInt64BE(entryOffset + 16))
          : data.readUInt32BE(entryOffset + 12);
      if (
        !Number.isSafeInteger(sliceOffset) ||
        !Number.isSafeInteger(sliceSize) ||
        sliceOffset < headerSize ||
        readThinMachOCpu(data, sliceOffset, sliceSize, relativePath) !==
          declaredCpu ||
        architectures.has(declaredCpu)
      ) {
        fail(`${relativePath} has an invalid ${declaredCpu} Mach-O slice`);
      }
      architectures.add(declaredCpu);
    }
  } else if (magicBe === 0xbebafeca || magicBe === 0xbfbafeca) {
    const entrySize = magicBe === 0xbfbafeca ? 32 : 20;
    const count = data.readUInt32LE(4);
    const headerSize = 8 + count * entrySize;
    if (count < 1 || count > 16 || data.length < headerSize) {
      fail(`${relativePath} has an invalid byte-swapped universal Mach-O header`);
    }
    for (let index = 0; index < count; index += 1) {
      const entryOffset = 8 + index * entrySize;
      const declaredCpu = cpuName(data.readUInt32LE(entryOffset), relativePath);
      const sliceOffset =
        entrySize === 32
          ? Number(data.readBigUInt64LE(entryOffset + 8))
          : data.readUInt32LE(entryOffset + 8);
      const sliceSize =
        entrySize === 32
          ? Number(data.readBigUInt64LE(entryOffset + 16))
          : data.readUInt32LE(entryOffset + 12);
      if (
        !Number.isSafeInteger(sliceOffset) ||
        !Number.isSafeInteger(sliceSize) ||
        sliceOffset < headerSize ||
        readThinMachOCpu(data, sliceOffset, sliceSize, relativePath) !==
          declaredCpu ||
        architectures.has(declaredCpu)
      ) {
        fail(`${relativePath} has an invalid ${declaredCpu} Mach-O slice`);
      }
      architectures.add(declaredCpu);
    }
  } else if (magicLe === 0xfeedfacf || magicBe === 0xfeedfacf) {
    architectures.add(readThinMachOCpu(data, 0, data.length, relativePath));
  } else {
    fail(`${relativePath} is not a 64-bit Mach-O binary`);
  }

  if (architectures.size === 0) {
    fail(`${relativePath} does not contain a supported Mach-O architecture`);
  }
  return architectures;
}

function verifyNativePackage(modulesRoot, spec) {
  const root = packageRoot(spec);
  const metadata = readPackageJson(modulesRoot, `${root}/package.json`);
  if (
    metadata.name !== root ||
    metadata.version !== spec.version ||
    !exactPlatformList(metadata.os, spec.os) ||
    !exactPlatformList(metadata.cpu, spec.cpu)
  ) {
    fail(
      `${root}/package.json does not describe the locked ${spec.os}-${spec.cpu} package`,
    );
  }
  for (const binary of spec.binaries) {
    readRequiredFile(modulesRoot, `${root}/${binary.path}`, binary);
  }
}

function allowedNativePackages(target) {
  const specs =
    target === MAC_UNIVERSAL_TARGET
      ? DARWIN_NATIVE_SPECS
      : WINDOWS_NATIVE_SPECS;
  return new Map([
    [
      "@trycua",
      new Set([
        "cua-driver",
        ...specs
          .filter((spec) => spec.scope === "@trycua")
          .map((spec) => spec.packageName),
      ]),
    ],
    [
      "@ubjs",
      new Set([
        "core",
        "node",
        ...specs
          .filter((spec) => spec.scope === "@ubjs")
          .map((spec) => spec.packageName),
      ]),
    ],
  ]);
}

function rejectForeignNativePackages(modulesRoot, target) {
  const allowed = allowedNativePackages(target);
  const groups = [
    { scope: "@trycua", native: /^cua-driver-(?:darwin|linux|win32)-/ },
    { scope: "@ubjs", native: /^node-(?:darwin|linux|win32)-/ },
  ];
  for (const group of groups) {
    const scopeRoot = path.join(modulesRoot, group.scope);
    if (!fs.existsSync(scopeRoot)) continue;
    for (const entry of fs.readdirSync(scopeRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        fail(`${group.scope}/${entry.name} must not be a symlink`);
      }
      if (
        group.native.test(entry.name) &&
        !allowed.get(group.scope)?.has(entry.name)
      ) {
        fail(`foreign native package ${group.scope}/${entry.name} is present`);
      }
    }
  }
}

function verifyModuleVersions(
  modulesRoot,
  readPackage = (relativePath) => readPackageJson(modulesRoot, relativePath),
) {
  const driver = readPackage("@trycua/cua-driver/package.json");
  const ubjs = readPackage("@ubjs/node/package.json");
  if (driver.name !== "@trycua/cua-driver" || driver.version !== CUA_VERSION) {
    fail(`@trycua/cua-driver must be exactly ${CUA_VERSION}`);
  }
  if (ubjs.name !== "@ubjs/node" || ubjs.version !== UBJS_VERSION) {
    fail(`@ubjs/node must be exactly ${UBJS_VERSION}`);
  }
}

function specsForTarget(target) {
  if (target === WINDOWS_TARGET) return WINDOWS_NATIVE_SPECS;
  if (target === MAC_UNIVERSAL_TARGET) return DARWIN_NATIVE_SPECS;
  fail(`unsupported target ${target}`);
}

function verifyNativeInventory(modulesRoot, target) {
  verifyModuleVersions(modulesRoot);
  for (const spec of specsForTarget(target)) {
    verifyNativePackage(modulesRoot, spec);
  }
  rejectForeignNativePackages(modulesRoot, target);
}

function verifySourceComputerUseRuntime({
  root = process.cwd(),
  platform = process.platform,
  arch = process.arch,
  target = WINDOWS_TARGET,
} = {}) {
  if (!SUPPORTED_TARGETS.has(target)) fail(`unsupported target ${target}`);
  if (target === WINDOWS_TARGET && (platform !== "win32" || arch !== "x64")) {
    fail(
      "Windows installers must be built from a clean Windows x64 npm ci --include=optional environment; cross-building from another host is blocked",
    );
  }
  if (
    target === MAC_UNIVERSAL_TARGET &&
    (platform !== "darwin" || (arch !== "arm64" && arch !== "x64"))
  ) {
    fail(
      "macOS universal installers must be built on macOS with both locked arm64 and x64 native packages prepared",
    );
  }
  verifyNativeInventory(path.join(root, "node_modules"), target);
  return true;
}

function verifyPackagedComputerUseRuntime({
  archivePath,
  archiveEntries,
  target = WINDOWS_TARGET,
}) {
  if (!SUPPORTED_TARGETS.has(target)) fail(`unsupported target ${target}`);
  if (!archivePath || !(archiveEntries instanceof Set)) {
    fail("packaged runtime verifier received invalid inputs");
  }
  const requiredArchiveEntries = [
    "/electron/computer-use.cjs",
    "/electron/computer-agent.cjs",
    "/electron/computer-agent-host.cjs",
    "/electron/computer-agent-policy.cjs",
    "/node_modules/@trycua/cua-driver/dist/index.js",
    "/node_modules/@trycua/cua-driver/dist/electron.js",
    "/node_modules/@trycua/cua-driver/dist/native/node-runtime.js",
    "/node_modules/@trycua/cua-driver/package.json",
    "/node_modules/@ubjs/node/package.json",
    "/node_modules/@ubjs/node/typescript/dist/resolve-lib.js",
    ...specsForTarget(target).map(
      (spec) => `/node_modules/${packageRoot(spec)}/package.json`,
    ),
  ];
  for (const entry of requiredArchiveEntries) {
    if (!archiveEntries.has(entry)) {
      fail(`packaged app.asar is missing ${entry}`);
    }
  }
  const unpackedModules = path.join(`${archivePath}.unpacked`, "node_modules");
  // These packages are deliberately matched by build.asarUnpack. Validate the
  // physical files that Electron will load instead of asking @electron/asar to
  // extract them. The asar library resolves nested entry names with the host
  // path separator, so slash-separated names fail on Windows even though the
  // corresponding unpacked file is valid and present.
  verifyModuleVersions(unpackedModules);
  for (const spec of specsForTarget(target)) {
    verifyNativePackage(unpackedModules, spec);
  }
  rejectForeignNativePackages(unpackedModules, target);
  return true;
}

function argumentValue(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (require.main === module) {
  if (!process.argv.includes("--source")) {
    throw new Error(
      "Usage: node scripts/verify-computer-use-runtime.cjs --source [--target win32-x64|darwin-universal]",
    );
  }
  const target = argumentValue("--target") ?? WINDOWS_TARGET;
  verifySourceComputerUseRuntime({ target });
  process.stdout.write(`Verified locked ${target} computer-use source runtime.\n`);
}

module.exports = {
  CUA_VERSION,
  DARWIN_NATIVE_SPECS,
  MAC_UNIVERSAL_TARGET,
  UBJS_VERSION,
  WINDOWS_NATIVE_SPECS,
  WINDOWS_TARGET,
  readMachOArchitectures,
  verifyNativePackage,
  verifyPackagedComputerUseRuntime,
  verifySourceComputerUseRuntime,
};
