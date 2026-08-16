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
    const announcement = getReleaseAnnouncement("0.1.20");

    expect(
      shouldShowReleaseAnnouncement({
        currentVersion: "0.1.20",
        lastAnnouncedVersion: "0.1.19",
      }),
    ).toBe(true);
    expect(formatReleaseAnnouncementBody(announcement!)).toContain("BOSS 昨日员工工作进度汇报");
    expect(formatReleaseAnnouncementBody(announcement!)).toContain("按员工催办");
  });

  it("does not repeat an announcement for the same installed version", () => {
    expect(
      shouldShowReleaseAnnouncement({
        currentVersion: "0.1.20",
        lastAnnouncedVersion: "0.1.20",
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
