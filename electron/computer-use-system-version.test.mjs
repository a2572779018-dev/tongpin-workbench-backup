import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { computerUseSystemVersion, createComputerUseController } = require("./computer-use.cjs");

describe("computer-use operating system product version", () => {
  it("does not pretend ordinary Node knows the macOS product version", () => {
    expect(process.versions.electron).toBeUndefined();
    expect(computerUseSystemVersion()).toBe("");
  });
  it("fails closed rather than using Darwin's kernel version as macOS", async () => {
    const controller = createComputerUseController({ platform: "darwin", arch: "arm64", osVersion: computerUseSystemVersion(),
      loadSdk() { throw new Error("SDK should not load without a known product version"); } });
    expect(await controller.probe()).toMatchObject({ available: false, status: "unsupported_os", osVersion: "" });
  });
});
