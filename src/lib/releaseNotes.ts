/**
 * Renderer-side twin of electron/release-notes.cjs (the preload boundary
 * cannot share CommonJS code with the Vite bundle). Keep both in sync; the
 * tests run the same fixtures through each implementation.
 */
export const MAX_RELEASE_NOTE_ITEMS = 20;
export const MAX_RELEASE_NOTE_ITEM_LENGTH = 300;

const HTML_BREAK_TAG = /<\s*(?:br\s*\/?|\/\s*(?:p|li|div|h[1-6]|ul|ol))\s*>/gi;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;
const LIST_MARKER =
  /^(?:[-*+](?=\s)\s*|[•·●▪]\s*|\d{1,2}\s*(?:[、)）]|\.(?=\s)|．)\s*|[（(]\d{1,2}[)）]\s*|[①-⑳]\s*)/u;
const TRAILING_SEPARATOR = /[\s；;，,、]+$/u;

function cleanItem(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  const item = collapsed.replace(LIST_MARKER, "").replace(TRAILING_SEPARATOR, "").trim();
  return item.length <= MAX_RELEASE_NOTE_ITEM_LENGTH
    ? item
    : `${item.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 1)}…`;
}

/** One item per line; a legacy single-line note is split on "；". */
export function releaseNoteItems(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const text = value
    .replace(HTML_BREAK_TAG, "\n")
    .replace(HTML_TAG, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r\n?/g, "\n");
  let lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 1) lines = lines[0].split(/；+/u);
  return lines.map(cleanItem).filter(Boolean).slice(0, MAX_RELEASE_NOTE_ITEMS);
}

export interface ReleaseNotesNotice {
  body: string;
  items?: string[];
}

/**
 * A single item reads as one sentence after the lead-in; several items become
 * a numbered list so "1 2 3" are never run together in one paragraph.
 */
export function releaseNoteItemsNotice(
  leadIn: string,
  items: readonly string[],
): ReleaseNotesNotice | null {
  if (!items.length) return null;
  if (items.length === 1) return { body: `${leadIn}${items[0]}` };
  return { body: leadIn, items: [...items] };
}

export function releaseNotesNotice(
  leadIn: string,
  notes: unknown,
): ReleaseNotesNotice | null {
  return releaseNoteItemsNotice(leadIn, releaseNoteItems(notes));
}
