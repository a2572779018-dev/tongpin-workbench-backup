import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  normalizeReleaseNotes,
}: {
  normalizeReleaseNotes(value: unknown, maxLength?: number): string;
} = require("../../electron/release-notes.cjs");

describe("updater release notes", () => {
  it("normalizes a plain release note", () => {
    expect(normalizeReleaseNotes("  新增铃声\n提醒  ")).toBe("新增铃声 提醒");
  });

  it("joins electron-updater note arrays without markup", () => {
    expect(
      normalizeReleaseNotes([
        { version: "0.1.18", note: "新增铃声" },
        { version: "0.1.17", note: "连接更稳定" },
      ]),
    ).toBe("新增铃声；连接更稳定");
  });

  it("limits remote text before it reaches the renderer", () => {
    expect(normalizeReleaseNotes("一".repeat(800))).toHaveLength(500);
  });
});
