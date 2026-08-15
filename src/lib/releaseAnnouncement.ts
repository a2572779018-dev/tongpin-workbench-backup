import releaseNotes from "../../build/release-notes.md?raw";

export const RELEASE_ANNOUNCEMENT_STORAGE_KEY =
  "tongpin:last-announced-release";
export const CURRENT_RELEASE_VERSION = "0.1.19";

export interface ReleaseAnnouncement {
  version: string;
  highlights: string[];
}

const currentHighlights = releaseNotes
  .split(/[；\n]+/)
  .map((highlight) => highlight.trim().replace(/[。；]+$/, ""))
  .filter(Boolean);

const CURRENT_RELEASE: ReleaseAnnouncement = {
  version: CURRENT_RELEASE_VERSION,
  highlights: currentHighlights,
};

export function getReleaseAnnouncement(
  version: string,
): ReleaseAnnouncement | null {
  return version === CURRENT_RELEASE.version ? CURRENT_RELEASE : null;
}

export function formatReleaseAnnouncementBody(
  announcement: ReleaseAnnouncement,
): string {
  return `本次更新：${announcement.highlights.join("；")}。`;
}

export function shouldShowReleaseAnnouncement({
  currentVersion,
  lastAnnouncedVersion,
}: {
  currentVersion: string;
  lastAnnouncedVersion: string | null;
}): boolean {
  return (
    Boolean(getReleaseAnnouncement(currentVersion)) &&
    currentVersion !== lastAnnouncedVersion
  );
}
