import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import {
  CURRENT_RELEASE_VERSION,
  formatReleaseAnnouncementBody,
  getReleaseAnnouncement,
  shouldShowReleaseAnnouncement,
} from "./releaseAnnouncement";

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
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "同频 AI 支持上传和粘贴图片",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "视频采样不包含音频",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "保留任务、客户脉络图、AI 历史及原有额度",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "修复 Fleur 形象超出标题栏边界",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "联网搜索新增兼容协议配置",
    );
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
