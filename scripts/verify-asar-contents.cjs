"use strict";

const fs = require("node:fs");
const path = require("node:path");
const asar = require("@electron/asar");

const archivePath = process.argv[2];
if (!archivePath || !path.isAbsolute(path.resolve(archivePath))) {
  throw new Error("Usage: node scripts/verify-asar-contents.cjs <app.asar>");
}
const resolvedArchive = path.resolve(archivePath);
if (!fs.statSync(resolvedArchive).isFile()) {
  throw new Error("Packaged app.asar was not found");
}

const entries = new Set(asar.listPackage(resolvedArchive));
const required = [
  "/electron/main.cjs",
  "/electron/preload.cjs",
  "/electron/relationship-graph-vault.cjs",
  "/THIRD_PARTY_NOTICES.md",
];
for (const entry of required) {
  if (!entries.has(entry)) {
    throw new Error(`Packaged app.asar is missing ${entry}`);
  }
}

process.stdout.write(`Verified ${required.length} required app.asar entries.\n`);
