import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(root, process.env.RELEASE_DIR ?? "artifacts");
const manifestPath = path.join(releaseDir, "latest.yml");
const packagePath = path.join(root, "package.json");
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
  "https://notify.samhubs.com/releases";
const verifyOnly = process.argv.includes("--verify-only");
const releaseUploadToken = process.env.TONGPIN_RELEASE_UPLOAD_TOKEN?.trim();
const secureUploadBaseUrl = publicBaseUrl.replace(
  /\/releases$/,
  "/internal/releases",
);
const multipartPartBytes = 8 * 1024 * 1024;
const maxReleaseObjectBytes = 2 * 1024 * 1024;

function manifestValue(source, expression, label) {
  const match = source.match(expression);
  if (!match) throw new Error(`latest.yml 缺少 ${label}`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
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
        "Content-Type": "application/octet-stream",
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

const [manifest, packageJson] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(packagePath, "utf8").then(JSON.parse),
]);
const version = manifestValue(manifest, /^version:\s*(.+)$/m, "version");
const installerName = manifestValue(
  manifest,
  /^\s*-\s+url:\s*(.+)$/m,
  "安装包 URL",
);
const expectedInstallerSize = Number(
  manifestValue(manifest, /^\s+size:\s*(\d+)$/m, "安装包大小"),
);
const expectedInstallerHash = manifestValue(
  manifest,
  /^sha512:\s*(.+)$/m,
  "SHA-512",
);
const installerPath = path.join(releaseDir, installerName);
const blockmapName = `${installerName}.blockmap`;
const blockmapPath = path.join(releaseDir, blockmapName);

if (version !== packageJson.version) {
  throw new Error(
    `版本不一致：package.json=${packageJson.version}，latest.yml=${version}`,
  );
}
await Promise.all([
  access(installerPath),
  access(blockmapPath),
  access(wranglerPath),
  access(wranglerConfig),
]);

const [installerInfo, blockmapInfo, manifestInfo, installerHash] =
  await Promise.all([
    stat(installerPath),
    stat(blockmapPath),
    stat(manifestPath),
    sha512(installerPath),
  ]);
if (installerInfo.size !== expectedInstallerSize) {
  throw new Error(
    `安装包大小校验失败：latest.yml=${expectedInstallerSize}，实际=${installerInfo.size}`,
  );
}
if (installerHash !== expectedInstallerHash) {
  throw new Error("安装包 SHA-512 与 latest.yml 不一致");
}

console.log(
  JSON.stringify(
    {
      version,
      installer: { name: installerName, size: installerInfo.size },
      blockmap: { name: blockmapName, size: blockmapInfo.size },
      manifest: { name: "latest.yml", size: manifestInfo.size },
      verified: true,
    },
    null,
    2,
  ),
);

if (verifyOnly) {
  console.log("本地发布文件校验通过，未执行上传。");
  process.exit(0);
}

const uploads = [
  {
    name: installerName,
    file: installerPath,
    contentType: "application/vnd.microsoft.portable-executable",
    cacheControl: "public, max-age=31536000, immutable",
    size: installerInfo.size,
  },
  {
    name: blockmapName,
    file: blockmapPath,
    contentType: "application/octet-stream",
    cacheControl: "public, max-age=31536000, immutable",
    size: blockmapInfo.size,
  },
  {
    name: "latest.yml",
    file: manifestPath,
    contentType: "application/yaml",
    cacheControl: "public, max-age=0, must-revalidate",
    size: manifestInfo.size,
  },
];

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

const remoteManifest = await fetch(
  `${publicBaseUrl}/latest.yml?verify=${Date.now()}`,
  { cache: "no-store" },
).then(async (response) => {
  if (!response.ok) {
    throw new Error(`latest.yml 读取失败：HTTP ${response.status}`);
  }
  return response.text();
});
if (!remoteManifest.includes(`version: ${version}`)) {
  throw new Error(`线上 latest.yml 未指向版本 ${version}`);
}

console.log(`版本 ${version} 已发布并通过线上校验。`);
