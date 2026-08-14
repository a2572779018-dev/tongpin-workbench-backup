function stripYamlScalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function readManifestReleaseNotes(source) {
  const lines = String(source).split(/\r?\n/);
  const index = lines.findIndex((line) => /^releaseNotes:\s*/.test(line));
  if (index < 0) return "";
  const value = lines[index].replace(/^releaseNotes:\s*/, "").trim();
  if (!/^[>|][-+]?$/.test(value)) return stripYamlScalar(value);

  const body = [];
  for (let lineIndex = index + 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line && !/^\s/.test(line)) break;
    if (!line.trim()) {
      if (body.length > 0) body.push("");
      continue;
    }
    body.push(line.replace(/^\s+/, ""));
  }
  return body.join("\n").trim();
}

function normalizeReleaseNotesText(value) {
  return String(value).replace(/\s+/g, " ").trim();
}

module.exports = {
  normalizeReleaseNotesText,
  readManifestReleaseNotes,
};
