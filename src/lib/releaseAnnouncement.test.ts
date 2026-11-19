import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import {
  CURRENT_RELEASE_VERSION,
  formatReleaseAnnouncementBody,
  getReleaseAnnouncement,
  releaseAnnouncementNotice,
  shouldShowReleaseAnnouncement,
} from "./releaseAnnouncement";

const releaseNotesSource = readFileSync(
  new URL("../../build/release-notes.md", import.meta.url),
  "utf8",
);

describe("release announcement", () => {
  it("keeps release notes in sync with the packaged application version", () => {
    const announcement = getReleaseAnnouncement(packageJson.version);

    expect(announcement).not.toBeNull();
    expect(announcement?.version).toBe(packageJson.version);
    expect(CURRENT_RELEASE_VERSION).toBe(packageJson.version);
    expect(announcement?.highlights.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a release once and includes the version changes", () => {
    const announcement = getReleaseAnnouncement(packageJson.version);

    expect(
      shouldShowReleaseAnnouncement({
        currentVersion: packageJson.version,
        lastAnnouncedVersion: "0.1.23",
      }),
    ).toBe(true);
    const body = formatReleaseAnnouncementBody(announcement!);
    for (const change of ["消息阅读空间", "长草稿", "已完成", "主动恢复"]) {
      expect(body).toContain(change);
    }
  });

  it("shows every release-notes line as its own numbered item", () => {
    const announcement = getReleaseAnnouncement(packageJson.version)!;
    const sourceLines = releaseNotesSource
      .split(/\r?\n/)
      .filter((line) => line.trim());
    const notice = releaseAnnouncementNotice(announcement);

    expect(announcement.highlights).toHaveLength(sourceLines.length);
    expect(notice.body).toBe("本次更新：");
    expect(notice.items).toEqual(announcement.highlights);
    expect(notice.items?.every((item) => !/[；\n]/.test(item))).toBe(true);
    expect(formatReleaseAnnouncementBody(announcement).split("\n")).toEqual([
      "本次更新：",
      ...announcement.highlights.map((item, index) => `${index + 1}. ${item}`),
    ]);
  });

  it("does not repeat an announcement for the same installed version", () => {
    expect(
      shouldShowReleaseAnnouncement({
        currentVersion: packageJson.version,
        lastAnnouncedVersion: packageJson.version,
      }),
    ).toBe(false);
  });

  it("does not invent release notes for an unknown version", () => {
    expect(
      shouldShowReleaseAnnouncement({
        currentVersion: "9.9.9",
        lastAnnouncedVersion: null,
      }),
    ).toBe(false);
  });
});
