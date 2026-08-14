import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  open,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import releaseManifestHelpers from "./release-manifest.cjs";

const { normalizeReleaseNotesText, readManifestReleaseNotes } =
  releaseManifestHelpers;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(root, process.env.RELEASE_DIR ?? "artifacts");
const packagePath = path.join(root, "package.json");
const releaseNotesPath = path.join(root, "build", "release-notes.md");
const wranglerPath = path.join(
  root,
  "node_modules",
  "wrangler",
  "bin",
  "wrangler.js",
);
const wranglerConfig = path.join(root, "cloudflare", "wrangler.jsonc");
const bucket = "tongpin-workbench-releases";
const publicBaseUrl =
  process.env.TONGPIN_RELEASE_URL?.trim() ||
  "https://notify.samhubs.com/releases";
const verifyOnly = process.argv.includes("--verify-only");
const releaseUploadToken = process.env.TONGPIN_RELEASE_UPLOAD_TOKEN?.trim();
const secureUploadBaseUrl = publicBaseUrl.replace(
  /\/releases\/?$/,
  "/internal/releases",
);
const multipartPartBytes = 8 * 1024 * 1024;
const maxReleaseObjectBytes = 2 * 1024 * 1024;

function argumentValue(name) {
  const inline = process.argv.find((argument) =>
    argument.startsWith(`${name}=`),
  );
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const platform =
  argumentValue("--platform") ??
  (process.platform === "darwin" ? "mac" : "win");
if (platform !== "win" && platform !== "mac") {
  throw new Error("--platform 只支持 win 或 mac");
}
const manifestName = platform === "mac" ? "latest-mac.yml" : "latest.yml";
const manifestPath = path.join(releaseDir, manifestName);

function stripYamlScalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function manifestValue(source, expression, label) {
  const match = source.match(expression);
  if (!match) throw new Error(`${manifestName} 缺少 ${label}`);
  return stripYamlScalar(match[1]);
}

function safeArtifactName(value) {
  const decoded = decodeURIComponent(stripYamlScalar(value));
  if (
    !decoded ||
    decoded !== path.basename(decoded) ||
    decoded.includes("/") ||
    decoded.includes("\\")
  ) {
    throw new Error(`${manifestName} 包含无效产物路径：${value}`);
  }
  return decoded;
}

function parseManifest(source) {
  const version = manifestValue(source, /^version:\s*(.+)$/m, "version");
  const files = [];
  let inFiles = false;
  let current = null;

  const finishCurrent = () => {
    if (!current) return;
    if (!current.sha512 || !Number.isSafeInteger(current.size)) {
      throw new Error(
        `${manifestName} 中 ${current.name} 缺少 sha512 或 size`,
      );
    }
    files.push(current);
    current = null;
  };

  for (const line of source.split(/\r?\n/)) {
    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }
    if (!inFiles) continue;
    if (/^\S/.test(line)) {
      finishCurrent();
      break;
    }
    const urlMatch = line.match(/^\s*-\s+url:\s*(.+)$/);
    if (urlMatch) {
      finishCurrent();
      current = {
        name: safeArtifactName(urlMatch[1]),
        sha512: "",
        size: Number.NaN,
      };
      continue;
    }
    if (!current) continue;
    const shaMatch = line.match(/^\s+sha512:\s*(.+)$/);
    if (shaMatch) {
      current.sha512 = stripYamlScalar(shaMatch[1]);
      continue;
    }
    const sizeMatch = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (sizeMatch) current.size = Number(sizeMatch[1]);
  }
  finishCurrent();
  if (files.length === 0) {
    throw new Error(`${manifestName} 没有可发布的 files 条目`);
  }
  return {
    version,
    files,
    releaseNotes: readManifestReleaseNotes(source),
  };
}

function contentTypeFor(name) {
  if (name.endsWith(".yml")) return "application/yaml";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".exe")) {
    return "application/vnd.microsoft.portable-executable";
  }
  return "application/octet-stream";
}

async function sha512(filePath) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("base64");
}

async function runWrangler(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wranglerPath, ...args], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Wrangler 上传失败，退出码 ${code}`));
    });
  });
}

async function secureUploadRequest(pathname, init, attempts = 1) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(`${secureUploadBaseUrl}/${pathname}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${releaseUploadToken}`,
          ...init.headers,
        },
      });
    } catch (error) {
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      continue;
    }
    if (response.ok) return response;

    const message = await response.text();
    const retryable = [408, 425, 429, 500, 502, 503, 504].includes(
      response.status,
    );
    if (!retryable || attempt === attempts) {
      throw new Error(
        `受控上传失败：HTTP ${response.status}${message ? ` ${message}` : ""}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 750));
  }
  throw new Error("受控上传重试次数已耗尽");
}

async function uploadSmallObject(upload) {
  const body = await readFile(upload.file);
  await secureUploadRequest(
    `object?key=${encodeURIComponent(upload.name)}`,
    {
      method: "PUT",
      headers: {
        "Content-Length": String(body.byteLength),
        "Content-Type": upload.contentType,
      },
      body,
    },
  );
}

async function uploadMultipartObject(upload) {
  const started = await secureUploadRequest("multipart/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: upload.name }),
  }).then((response) => response.json());
  const parts = [];
  const handle = await open(upload.file, "r");
  try {
    for (
      let offset = 0, partNumber = 1;
      offset < upload.size;
      offset += multipartPartBytes, partNumber += 1
    ) {
      const length = Math.min(multipartPartBytes, upload.size - offset);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(
          `${upload.name} 分片读取不完整：预期 ${length}，实际 ${bytesRead}`,
        );
      }
      console.log(
        `上传 ${upload.name} 分片 ${partNumber}/${Math.ceil(upload.size / multipartPartBytes)}...`,
      );
      const part = await secureUploadRequest(
        `multipart/part?key=${encodeURIComponent(upload.name)}&uploadId=${encodeURIComponent(started.uploadId)}&partNumber=${partNumber}`,
        {
          method: "PUT",
          headers: {
            "Content-Length": String(buffer.byteLength),
            "Content-Type": "application/octet-stream",
          },
          body: buffer,
        },
        3,
      ).then((response) => response.json());
      parts.push(part);
    }
    await secureUploadRequest("multipart/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: upload.name,
        uploadId: started.uploadId,
        parts,
      }),
    });
  } catch (error) {
    await secureUploadRequest("multipart/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: upload.name,
        uploadId: started.uploadId,
      }),
    }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
}

async function verifyRemote(fileName, expectedSize) {
  const response = await fetch(
    `${publicBaseUrl}/${encodeURIComponent(fileName)}?verify=${Date.now()}`,
    { method: "HEAD", cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(`${fileName} 线上校验失败：HTTP ${response.status}`);
  }
  const remoteSize = Number(response.headers.get("content-length"));
  if (remoteSize !== expectedSize) {
    throw new Error(
      `${fileName} 线上大小不一致：本地 ${expectedSize}，线上 ${remoteSize}`,
    );
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

const [manifestSource, packageJson, expectedReleaseNotesSource] =
  await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(packagePath, "utf8").then(JSON.parse),
    readFile(releaseNotesPath, "utf8"),
  ]);
const manifest = parseManifest(manifestSource);
if (manifest.version !== packageJson.version) {
  throw new Error(
    `版本不一致：package.json=${packageJson.version}，${manifestName}=${manifest.version}`,
  );
}
const expectedReleaseNotes = normalizeReleaseNotesText(
  expectedReleaseNotesSource,
);
const manifestReleaseNotes = normalizeReleaseNotesText(
  manifest.releaseNotes,
);
if (!expectedReleaseNotes) {
  throw new Error("build/release-notes.md 不能为空");
}
if (!manifestReleaseNotes) {
  throw new Error(`${manifestName} 缺少 releaseNotes`);
}
if (manifestReleaseNotes !== expectedReleaseNotes) {
  throw new Error(
    `${manifestName} 的 releaseNotes 与 build/release-notes.md 不一致`,
  );
}

const artifacts = new Map();
for (const entry of manifest.files) {
  const file = path.join(releaseDir, entry.name);
  await access(file);
  const [info, hash] = await Promise.all([stat(file), sha512(file)]);
  if (info.size !== entry.size) {
    throw new Error(
      `${entry.name} 大小校验失败：清单=${entry.size}，实际=${info.size}`,
    );
  }
  if (hash !== entry.sha512) {
    throw new Error(`${entry.name} SHA-512 与 ${manifestName} 不一致`);
  }
  artifacts.set(entry.name, { name: entry.name, file, size: info.size });
}

if (platform === "mac") {
  if (![...artifacts.keys()].some((name) => name.endsWith(".zip"))) {
    throw new Error("latest-mac.yml 必须包含用于自动更新的 ZIP");
  }
  const macPrefix = `Tongpin-${manifest.version}-mac-`;
  const dmgNames = (await readdir(releaseDir)).filter(
    (name) => name.startsWith(macPrefix) && name.endsWith(".dmg"),
  );
  if (dmgNames.length === 0) {
    throw new Error("Mac 发布必须同时包含首次安装使用的 DMG");
  }
  for (const name of dmgNames) {
    const file = path.join(releaseDir, name);
    const info = await stat(file);
    artifacts.set(name, { name, file, size: info.size });
  }
}

const uploads = [];
for (const artifact of artifacts.values()) {
  if (artifact.size <= 0) throw new Error(`${artifact.name} 是空文件`);
  uploads.push({
    ...artifact,
    contentType: contentTypeFor(artifact.name),
    cacheControl: "public, max-age=31536000, immutable",
  });

  const blockmapName = `${artifact.name}.blockmap`;
  const blockmapFile = path.join(releaseDir, blockmapName);
  const blockmapRequired =
    artifact.name.endsWith(".exe") || artifact.name.endsWith(".zip");
  if (await fileExists(blockmapFile)) {
    const info = await stat(blockmapFile);
    uploads.push({
      name: blockmapName,
      file: blockmapFile,
      size: info.size,
      contentType: "application/octet-stream",
      cacheControl: "public, max-age=31536000, immutable",
    });
  } else if (blockmapRequired) {
    throw new Error(`${artifact.name} 缺少自动更新所需的 blockmap`);
  }
}

const manifestInfo = await stat(manifestPath);
uploads.push({
  name: manifestName,
  file: manifestPath,
  size: manifestInfo.size,
  contentType: "application/yaml",
  cacheControl: "public, max-age=0, must-revalidate",
});

console.log(
  JSON.stringify(
    {
      platform,
      version: manifest.version,
      files: uploads.map(({ name, size }) => ({ name, size })),
      manifest: manifestName,
      verified: true,
    },
    null,
    2,
  ),
);

if (verifyOnly) {
  console.log("本地发布文件校验通过，未执行上传。");
} else {
  if (!releaseUploadToken) {
    await Promise.all([access(wranglerPath), access(wranglerConfig)]);
  }
  for (const upload of uploads) {
    console.log(`上传 ${upload.name}...`);
    if (releaseUploadToken) {
      if (upload.size > maxReleaseObjectBytes) {
        await uploadMultipartObject(upload);
      } else {
        await uploadSmallObject(upload);
      }
    } else {
      await runWrangler([
        "r2",
        "object",
        "put",
        `${bucket}/${upload.name}`,
        "--file",
        upload.file,
        "--content-type",
        upload.contentType,
        "--cache-control",
        upload.cacheControl,
        "--remote",
        "--force",
        "--config",
        wranglerConfig,
      ]);
    }
    await verifyRemote(upload.name, upload.size);
  }

  const remoteManifestSource = await fetch(
    `${publicBaseUrl}/${manifestName}?verify=${Date.now()}`,
    { cache: "no-store" },
  ).then(async (response) => {
    if (!response.ok) {
      throw new Error(
        `${manifestName} 读取失败：HTTP ${response.status}`,
      );
    }
    return response.text();
  });
  const remoteManifest = parseManifest(remoteManifestSource);
  if (remoteManifest.version !== manifest.version) {
    throw new Error(
      `线上 ${manifestName} 未指向版本 ${manifest.version}`,
    );
  }
  console.log(
    `版本 ${manifest.version} 的 ${platform} 产物已发布并通过线上校验。`,
  );
}
