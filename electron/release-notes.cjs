const DEFAULT_RELEASE_NOTES_MAX_LENGTH = 2_000;
const MAX_RELEASE_NOTE_ITEMS = 20;
const MAX_RELEASE_NOTE_ITEM_LENGTH = 300;

const HTML_BREAK_TAG = /<\s*(?:br\s*\/?|\/\s*(?:p|li|div|h[1-6]|ul|ol))\s*>/gi;
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/gi;
// Authors may already number or bullet their items; the notice renders its
// own ordered list, so a leading marker would otherwise appear twice.
const LIST_MARKER =
  /^(?:[-*+](?=\s)\s*|[•·●▪]\s*|\d{1,2}\s*(?:[、)）]|\.(?=\s)|．)\s*|[（(]\d{1,2}[)）]\s*|[①-⑳]\s*)/u;
const TRAILING_SEPARATOR = /[\s；;，,、]+$/u;

function releaseNoteText(entry) {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.note === "string") return entry.note;
  return "";
}

function cleanItem(value) {
  const collapsed = value.replace(/\s+/g, " ").trim();
  const item = collapsed.replace(LIST_MARKER, "").replace(TRAILING_SEPARATOR, "").trim();
  if (item.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return item;
  return `${item.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 1)}…`;
}

/**
 * One release note item per line. Authors write one item per line in
 * build/release-notes.md; older single-line notes separate items with "；".
 * Markup and list markers are removed because the renderer numbers items.
 */
function splitReleaseNoteItems(value) {
  const text = releaseNoteText(value)
    .replace(HTML_BREAK_TAG, "\n")
    .replace(HTML_TAG, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r\n?/g, "\n");
  let lines = text.split("\n").filter((line) => line.trim());
  if (lines.length === 1) lines = lines[0].split(/；+/u);
  return lines.map(cleanItem).filter(Boolean);
}

/**
 * Updater release notes cross IPC as plain text with exactly one item per
 * line. Whitespace inside an item is collapsed, but line boundaries are kept
 * so every surface can show each item on its own line.
 */
function normalizeReleaseNotes(value, maxLength = DEFAULT_RELEASE_NOTES_MAX_LENGTH) {
  const entries = Array.isArray(value) ? value : [value];
  const items = entries
    .flatMap((entry) => splitReleaseNoteItems(entry))
    .slice(0, MAX_RELEASE_NOTE_ITEMS);
  const limit = Number.isFinite(maxLength) && maxLength > 0 ? Math.floor(maxLength) : DEFAULT_RELEASE_NOTES_MAX_LENGTH;
  const kept = [];
  let length = 0;
  for (const item of items) {
    const next = length + (kept.length ? 1 : 0) + item.length;
    if (next > limit) {
      // Never cut an item in half unless even the first one does not fit.
      if (!kept.length) kept.push(`${item.slice(0, Math.max(0, limit - 1))}…`);
      break;
    }
    kept.push(item);
    length = next;
  }
  return kept.join("\n");
}

module.exports = {
  DEFAULT_RELEASE_NOTES_MAX_LENGTH,
  MAX_RELEASE_NOTE_ITEMS,
  MAX_RELEASE_NOTE_ITEM_LENGTH,
  normalizeReleaseNotes,
  splitReleaseNoteItems,
};
