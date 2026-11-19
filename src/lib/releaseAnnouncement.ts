import releaseNotes from "../../build/release-notes.md?raw";
import { releaseNoteItems, releaseNoteItemsNotice, type ReleaseNotesNotice } from "./releaseNotes";

export const RELEASE_ANNOUNCEMENT_STORAGE_KEY =
  "tongpin:last-announced-release";
export const CURRENT_RELEASE_VERSION = "0.1.53";

export interface ReleaseAnnouncement {
  version: string;
  highlights: string[];
}

const currentHighlights = releaseNoteItems(releaseNotes);

const CURRENT_RELEASE: ReleaseAnnouncement = {
  version: CURRENT_RELEASE_VERSION,
  highlights: currentHighlights,
};

export function getReleaseAnnouncement(
  version: string,
): ReleaseAnnouncement | null {
  return version === CURRENT_RELEASE.version ? CURRENT_RELEASE : null;
}

const RELEASE_ANNOUNCEMENT_LEAD_IN = "本次更新：";

/** Structured copy for the in-app notice: each highlight is its own list item. */
export function releaseAnnouncementNotice(
  announcement: ReleaseAnnouncement,
): ReleaseNotesNotice {
  return releaseNoteItemsNotice(
    RELEASE_ANNOUNCEMENT_LEAD_IN,
    announcement.highlights,
  ) ?? { body: RELEASE_ANNOUNCEMENT_LEAD_IN };
}

/** Plain-text form (screen readers, logs): one numbered highlight per line. */
export function formatReleaseAnnouncementBody(
  announcement: ReleaseAnnouncement,
): string {
  const { body, items } = releaseAnnouncementNotice(announcement);
  if (!items) return body;
  return [body, ...items.map((item, index) => `${index + 1}. ${item}`)].join("\n");
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
