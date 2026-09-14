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
      "视频生成融入同频 AI 对话",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "生成进度与视频播放器直接显示在 AI 回复中",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "保留任务、客户脉络图、AI 历史、密钥和已有成员额度",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "修复模态弹窗和视频控件中的鼠标不可见问题",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "刷新后恢复原视频任务",
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
