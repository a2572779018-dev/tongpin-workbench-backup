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
      "重新编辑并生成",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "参考图随对话保留",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "保留任务、客户脉络图、AI 历史、密钥和已有成员额度",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "避免被参考图片遮住",
    );
    expect(formatReleaseAnnouncementBody(announcement!)).toContain(
      "结果待核对或费用未结算时不重复生成",
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
