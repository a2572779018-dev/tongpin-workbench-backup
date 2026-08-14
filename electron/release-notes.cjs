function normalizeReleaseNotes(value, maxLength = 500) {
  const entries = Array.isArray(value) ? value : [value];
  const normalized = entries
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry && typeof entry.note === "string") return entry.note;
      return "";
    })
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("；");
  return normalized.slice(0, maxLength);
}

module.exports = { normalizeReleaseNotes };
