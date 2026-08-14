import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  normalizeReleaseNotesText,
  readManifestReleaseNotes,
}: {
  normalizeReleaseNotesText(value: unknown): string;
  readManifestReleaseNotes(source: string): string;
} = require("../../scripts/release-manifest.cjs");

describe("release manifest notes", () => {
  it("reads electron-builder block release notes", () => {
    const manifest = [
      "version: 0.1.18",
      "releaseNotes: |-",
      "  老板通知新增铃声；",
      "  左上角显示版本号。",
      "releaseDate: '2026-08-14T10:00:00.000Z'",
    ].join("\n");

    expect(readManifestReleaseNotes(manifest)).toBe(
      "老板通知新增铃声；\n左上角显示版本号。",
    );
  });

  it("reads inline release notes and rejects a missing field", () => {
    expect(readManifestReleaseNotes("releaseNotes: '新增铃声'\n")).toBe(
      "新增铃声",
    );
    expect(readManifestReleaseNotes("version: 0.1.18\n")).toBe("");
  });

  it("decodes the CRLF scalar emitted by Windows electron-builder", () => {
    const manifest =
      'releaseNotes: "老板通知新增铃声；左上角显示版本号。\\r\\n"\r\n';

    expect(normalizeReleaseNotesText(readManifestReleaseNotes(manifest))).toBe(
      "老板通知新增铃声；左上角显示版本号。",
    );
  });

  it("normalizes line wrapping before exact comparison", () => {
    expect(normalizeReleaseNotesText("新增铃声；\n  显示版本号。 ")).toBe(
      "新增铃声； 显示版本号。",
    );
  });
});
