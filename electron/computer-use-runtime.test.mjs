import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  DARWIN_NATIVE_SPECS,
  MAC_UNIVERSAL_TARGET,
  readMachOArchitectures,
  verifyPackagedComputerUseRuntime,
  verifySourceComputerUseRuntime,
  WINDOWS_TARGET,
} = require("../scripts/verify-computer-use-runtime.cjs");
const {
  assertSafeTarEntries,
  prepareDarwinUniversalRuntime,
} = require("../scripts/prepare-computer-use-runtime.cjs");

const temporaryRoots = [];

function write(root, relativePath, data) {
  const filePath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, data);
}

function packageJson(name, version, platform) {
  return JSON.stringify({
    name,
    version,
    ...(platform ? { os: [platform.os], cpu: [platform.cpu] } : {}),
  });
}

function thinMachO(cpu) {
  const result = Buffer.alloc(32);
  result.writeUInt32LE(0xfeedfacf, 0);
  result.writeUInt32LE(cpu === "arm64" ? 0x0100000c : 0x01000007, 4);
  return result;
}

function universalMachO() {
  const x64 = thinMachO("x64");
  const arm64 = thinMachO("arm64");
  const result = Buffer.alloc(48 + x64.length + arm64.length);
  result.writeUInt32BE(0xcafebabe, 0);
  result.writeUInt32BE(2, 4);
  result.writeUInt32BE(0x01000007, 8);
  result.writeUInt32BE(48, 16);
  result.writeUInt32BE(x64.length, 20);
  result.writeUInt32BE(0x0100000c, 28);
  result.writeUInt32BE(48 + x64.length, 36);
  result.writeUInt32BE(arm64.length, 40);
  x64.copy(result, 48);
  arm64.copy(result, 48 + x64.length);
  return result;
}

function createBaseFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tongpin-cua-runtime-"));
  temporaryRoots.push(root);
  const modules = path.join(root, "node_modules");
  write(
    modules,
    "@trycua/cua-driver/package.json",
    packageJson("@trycua/cua-driver", "0.28.1"),
  );
  write(
    modules,
    "@ubjs/node/package.json",
    packageJson("@ubjs/node", "0.31.0-3"),
  );
  return root;
}

function createWindowsFixture() {
  const root = createBaseFixture();
  const modules = path.join(root, "node_modules");
  write(
    modules,
    "@trycua/cua-driver-win32-x64-msvc/package.json",
    packageJson("@trycua/cua-driver-win32-x64-msvc", "0.28.1", {
      os: "win32",
      cpu: "x64",
    }),
  );
  write(
    modules,
    "@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
    Buffer.from("MZdriver"),
  );
  write(
    modules,
    "@trycua/cua-driver-win32-x64-msvc/cua_driver_node_runtime.node",
    Buffer.from("MZruntime"),
  );
  write(
    modules,
    "@ubjs/node-win32-x64-msvc/package.json",
    packageJson("@ubjs/node-win32-x64-msvc", "0.31.0-3", {
      os: "win32",
      cpu: "x64",
    }),
  );
  write(
    modules,
    "@ubjs/node-win32-x64-msvc/uniffi-runtime-napi.win32-x64-msvc.node",
    Buffer.from("MZubjs"),
  );
  return root;
}

function createDarwinFixture() {
  const root = createBaseFixture();
  const modules = path.join(root, "node_modules");
  for (const spec of DARWIN_NATIVE_SPECS) {
    const name = `${spec.scope}/${spec.packageName}`;
    write(
      modules,
      `${name}/package.json`,
      packageJson(name, spec.version, { os: spec.os, cpu: spec.cpu }),
    );
    for (const binary of spec.binaries) {
      write(
        modules,
        `${name}/${binary.path}`,
        spec.scope === "@trycua" ? universalMachO() : thinMachO(spec.cpu),
      );
    }
  }
  const packages = Object.fromEntries(
    DARWIN_NATIVE_SPECS.map((spec) => [
      `node_modules/${spec.scope}/${spec.packageName}`,
      {
        version: spec.version,
        resolved: `https://registry.example.test/${spec.packageName}.tgz`,
        integrity: `sha512-${Buffer.alloc(64, spec.cpu === "arm64" ? 1 : 2).toString("base64")}`,
        os: [spec.os],
        cpu: [spec.cpu],
      },
    ]),
  );
  write(
    root,
    "package-lock.json",
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return root;
}

function archiveFixture(root, target) {
  const archivePath = path.join(root, "resources/app.asar");
  const unpackedModules = path.join(`${archivePath}.unpacked`, "node_modules");
  fs.mkdirSync(path.dirname(unpackedModules), { recursive: true });
  fs.cpSync(path.join(root, "node_modules"), unpackedModules, {
    recursive: true,
  });
  const packages = new Map([
    [
      "node_modules/@trycua/cua-driver/package.json",
      packageJson("@trycua/cua-driver", "0.28.1"),
    ],
    [
      "node_modules/@ubjs/node/package.json",
      packageJson("@ubjs/node", "0.31.0-3"),
    ],
  ]);
  const nativeSpecs =
    target === MAC_UNIVERSAL_TARGET
      ? DARWIN_NATIVE_SPECS
      : [
          {
            scope: "@trycua",
            packageName: "cua-driver-win32-x64-msvc",
          },
          { scope: "@ubjs", packageName: "node-win32-x64-msvc" },
        ];
  const archiveEntries = new Set([
    "/electron/computer-use.cjs",
    "/node_modules/@trycua/cua-driver/dist/index.js",
    "/node_modules/@trycua/cua-driver/dist/native/node-runtime.js",
    "/node_modules/@trycua/cua-driver/package.json",
    "/node_modules/@ubjs/node/package.json",
    "/node_modules/@ubjs/node/typescript/dist/resolve-lib.js",
    ...nativeSpecs.map(
      (spec) => `/node_modules/${spec.scope}/${spec.packageName}/package.json`,
    ),
  ]);
  return { archivePath, archiveEntries, packages };
}

afterEach(() => {
  while (temporaryRoots.length) {
    fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe("computer-use Windows native packaging gate", () => {
  it("accepts only the locked clean Windows x64 source inventory", () => {
    const root = createWindowsFixture();
    expect(
      verifySourceComputerUseRuntime({
        root,
        platform: "win32",
        arch: "x64",
        target: WINDOWS_TARGET,
      }),
    ).toBe(true);
    expect(() =>
      verifySourceComputerUseRuntime({
        root,
        platform: "darwin",
        arch: "arm64",
        target: WINDOWS_TARGET,
      }),
    ).toThrow(/cross-building/);
  });

  it("rejects missing, non-PE, mismatched and foreign native files", () => {
    const missing = createWindowsFixture();
    fs.rmSync(
      path.join(
        missing,
        "node_modules/@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
      ),
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: missing,
        platform: "win32",
        arch: "x64",
      }),
    ).toThrow(/missing/);

    const wrongBinary = createWindowsFixture();
    write(
      path.join(wrongBinary, "node_modules"),
      "@trycua/cua-driver-win32-x64-msvc/cua_driver_sdk.dll",
      "Mach-O",
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: wrongBinary,
        platform: "win32",
        arch: "x64",
      }),
    ).toThrow(/not a Windows PE/);

    const wrongVersion = createWindowsFixture();
    write(
      path.join(wrongVersion, "node_modules"),
      "@trycua/cua-driver-win32-x64-msvc/package.json",
      packageJson("@trycua/cua-driver-win32-x64-msvc", "0.28.0", {
        os: "win32",
        cpu: "x64",
      }),
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: wrongVersion,
        platform: "win32",
        arch: "x64",
      }),
    ).toThrow(/locked win32-x64/);

    const mixed = createWindowsFixture();
    write(
      path.join(mixed, "node_modules"),
      "@trycua/cua-driver-darwin-arm64/package.json",
      "{}",
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: mixed,
        platform: "win32",
        arch: "x64",
      }),
    ).toThrow(/foreign native package/);
  });

  it("checks both app.asar wrappers and unpacked Windows binaries", () => {
    const root = createWindowsFixture();
    const { archivePath, archiveEntries, packages } = archiveFixture(
      root,
      WINDOWS_TARGET,
    );
    expect(
      verifyPackagedComputerUseRuntime({
        archivePath,
        archiveEntries,
        readArchiveFile: (entry) => Buffer.from(packages.get(entry) ?? ""),
        target: WINDOWS_TARGET,
      }),
    ).toBe(true);
    archiveEntries.delete("/electron/computer-use.cjs");
    expect(() =>
      verifyPackagedComputerUseRuntime({
        archivePath,
        archiveEntries,
        readArchiveFile: () => Buffer.from("{}"),
        target: WINDOWS_TARGET,
      }),
    ).toThrow(/computer-use\.cjs/);
  });
});

describe("computer-use macOS universal native packaging gate", () => {
  it("accepts both locked Darwin packages from either Mac build host", () => {
    const root = createDarwinFixture();
    for (const arch of ["arm64", "x64"]) {
      expect(
        verifySourceComputerUseRuntime({
          root,
          platform: "darwin",
          arch,
          target: MAC_UNIVERSAL_TARGET,
        }),
      ).toBe(true);
    }
    expect([...readMachOArchitectures(universalMachO(), "fixture")]).toEqual([
      "x64",
      "arm64",
    ]);
    const truncated = universalMachO().subarray(0, 80);
    expect(() => readMachOArchitectures(truncated, "truncated")).toThrow(
      /out-of-bounds Mach-O slice/,
    );
  });

  it("rejects absent x64 packages, metadata lies, bad Mach-O and foreign native packages", () => {
    const missing = createDarwinFixture();
    fs.rmSync(
      path.join(missing, "node_modules/@ubjs/node-darwin-x64"),
      { recursive: true },
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: missing,
        platform: "darwin",
        arch: "arm64",
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toThrow(/missing/);

    const wrongMetadata = createDarwinFixture();
    write(
      path.join(wrongMetadata, "node_modules"),
      "@ubjs/node-darwin-x64/package.json",
      packageJson("@ubjs/node-darwin-x64", "0.31.0-3", {
        os: "darwin",
        cpu: "arm64",
      }),
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: wrongMetadata,
        platform: "darwin",
        arch: "x64",
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toThrow(/locked darwin-x64/);

    const wrongMach = createDarwinFixture();
    write(
      path.join(wrongMach, "node_modules"),
      "@ubjs/node-darwin-x64/uniffi-runtime-napi.darwin-x64.node",
      thinMachO("arm64"),
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: wrongMach,
        platform: "darwin",
        arch: "arm64",
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toThrow(/declared x64 Mach-O slice/);

    const nonMach = createDarwinFixture();
    write(
      path.join(nonMach, "node_modules"),
      "@trycua/cua-driver-darwin-arm64/libcua_driver_sdk.dylib",
      Buffer.from("not-macho"),
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: nonMach,
        platform: "darwin",
        arch: "arm64",
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toThrow(/Mach-O binary/);

    const mixed = createDarwinFixture();
    write(
      path.join(mixed, "node_modules"),
      "@trycua/cua-driver-win32-x64-msvc/package.json",
      "{}",
    );
    expect(() =>
      verifySourceComputerUseRuntime({
        root: mixed,
        platform: "darwin",
        arch: "arm64",
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toThrow(/foreign native package/);
  });

  it("checks both Darwin variants inside the packaged universal app", () => {
    const root = createDarwinFixture();
    const { archivePath, archiveEntries, packages } = archiveFixture(
      root,
      MAC_UNIVERSAL_TARGET,
    );
    expect(
      verifyPackagedComputerUseRuntime({
        archivePath,
        archiveEntries,
        readArchiveFile: (entry) => Buffer.from(packages.get(entry) ?? ""),
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toBe(true);

    archiveEntries.delete(
      "/node_modules/@trycua/cua-driver-darwin-x64/package.json",
    );
    expect(() =>
      verifyPackagedComputerUseRuntime({
        archivePath,
        archiveEntries,
        readArchiveFile: (entry) => Buffer.from(packages.get(entry) ?? ""),
        target: MAC_UNIVERSAL_TARGET,
      }),
    ).toThrow(/cua-driver-darwin-x64/);
  });

  it("does not redownload a fully prepared locked inventory", async () => {
    const root = createDarwinFixture();
    const fetchImpl = vi.fn(() => {
      throw new Error("network should not be used");
    });
    await expect(
      prepareDarwinUniversalRuntime({
        root,
        platform: "darwin",
        arch: "arm64",
        fetchImpl,
      }),
    ).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects traversal paths before extracting a locked tarball", () => {
    expect(() => assertSafeTarEntries("package/package.json\npackage/lib/a.node\n"))
      .not.toThrow();
    expect(() => assertSafeTarEntries("package/../outside\n")).toThrow(
      /unsafe path/,
    );
    expect(() => assertSafeTarEntries("/absolute\n")).toThrow(/unsafe path/);
  });
});
