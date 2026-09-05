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

const entries = new Set(
  asar.listPackage(resolvedArchive).map((entry) => entry.replaceAll("\\", "/")),
);
const required = [
  "/electron/main.cjs",
  "/electron/preload.cjs",
  "/electron/app-config.json",
  "/electron/credential-vault.cjs",
  "/electron/safe-storage-adapter.cjs",
  "/electron/secure-session-binding-store.cjs",
  "/electron/relationship-member-verifier.cjs",
  "/electron/relationship-graph-vault.cjs",
  "/electron/ai-source-policy.cjs",
  "/THIRD_PARTY_NOTICES.md",
  "/package.json",
];
for (const entry of required) {
  if (!entries.has(entry)) {
    throw new Error(`Packaged app.asar is missing ${entry}`);
  }
}

const packagedConfig = JSON.parse(
  asar
    .extractFile(resolvedArchive, "electron/app-config.json")
    .toString("utf8"),
);
if (
  packagedConfig.apiUrl !== "https://notify.samhubs.com" ||
  packagedConfig.updateUrl !== "https://notify.samhubs.com/releases"
) {
  throw new Error(
    "Packaged app API or update URL is not the production endpoint",
  );
}

const appUpdatePath = path.join(
  path.dirname(resolvedArchive),
  "app-update.yml",
);
const appUpdateConfig = fs.readFileSync(appUpdatePath, "utf8");
if (
  !/^url:\s*https:\/\/notify\.samhubs\.com\/releases\s*$/m.test(
    appUpdateConfig,
  )
) {
  throw new Error(
    "Packaged updater feed is not the production release endpoint",
  );
}

const packagedPackage = JSON.parse(
  asar.extractFile(resolvedArchive, "package.json").toString("utf8"),
);
const expectedVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
).version;
if (packagedPackage.version !== expectedVersion) {
  throw new Error(
    `Packaged app version ${packagedPackage.version} does not match ${expectedVersion}`,
  );
}

process.stdout.write(`Verified ${required.length} required app.asar entries.\n`);
