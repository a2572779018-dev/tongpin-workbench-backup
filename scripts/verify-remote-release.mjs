import { createHash } from "node:crypto";

const baseUrl =
  process.env.TONGPIN_RELEASE_URL?.trim() ||
  "https://notify.samhubs.com/releases";
const apiUrl = new URL(baseUrl).origin;
const cacheBuster = `proof=${Date.now()}`;

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

function stripYamlScalar(value) {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function safeArtifactName(value) {
  const decoded = decodeURIComponent(stripYamlScalar(value));
  if (!decoded || decoded.includes("/") || decoded.includes("\\")) {
    throw new Error(`远端 ${manifestName} 包含无效文件名`);
  }
  return decoded;
}

function parseManifest(source) {
  const versionMatch = source.match(/^version:\s*(.+)$/m);
  if (!versionMatch) throw new Error(`远端 ${manifestName} 缺少 version`);
  const files = [];
  let inFiles = false;
  let current = null;
  const finishCurrent = () => {
    if (!current) return;
    if (!current.sha512 || !Number.isSafeInteger(current.size)) {
      throw new Error(
        `远端 ${manifestName} 中 ${current.name} 缺少 sha512 或 size`,
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
    if (shaMatch) current.sha512 = stripYamlScalar(shaMatch[1]);
    const sizeMatch = line.match(/^\s+size:\s*(\d+)\s*$/);
    if (sizeMatch) current.size = Number(sizeMatch[1]);
  }
  finishCurrent();
  if (files.length === 0) {
    throw new Error(`远端 ${manifestName} 没有 files 条目`);
  }
  return {
    version: stripYamlScalar(versionMatch[1]),
    files,
  };
}

async function checkedFetch(url, init = {}) {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
  });
  if (!response.ok) {
    throw new Error(`${url} 返回 HTTP ${response.status}`);
  }
  return response;
}

const manifestSource = await checkedFetch(
  `${baseUrl}/${manifestName}?${cacheBuster}`,
).then((response) => response.text());
const manifest = parseManifest(manifestSource);
const updateArtifact =
  manifest.files.find((file) =>
    platform === "mac"
      ? file.name.endsWith(".zip")
      : file.name.endsWith(".exe"),
  ) ?? manifest.files[0];
const artifactUrl =
  `${baseUrl}/${encodeURIComponent(updateArtifact.name)}`;
const verificationChunkBytes = 4 * 1024 * 1024;
const rangeAttempts = 3;

for (const file of manifest.files) {
  const head = await checkedFetch(
    `${baseUrl}/${encodeURIComponent(file.name)}?${cacheBuster}`,
    { method: "HEAD" },
  );
  const remoteSize = Number(head.headers.get("content-length"));
  if (remoteSize !== file.size) {
    throw new Error(
      `远端 ${file.name} 大小不一致：清单=${file.size}，HEAD=${remoteSize}`,
    );
  }
}

if (platform === "mac") {
  const dmgName = updateArtifact.name.replace(/\.zip$/, ".dmg");
  await checkedFetch(
    `${baseUrl}/${encodeURIComponent(dmgName)}?${cacheBuster}`,
    { method: "HEAD" },
  );
}

const rangeEnd = Math.min(1023, updateArtifact.size - 1);
const range = await fetch(`${artifactUrl}?${cacheBuster}`, {
  headers: { Range: `bytes=0-${rangeEnd}` },
  cache: "no-store",
});
const expectedRangeLength = rangeEnd + 1;
if (
  range.status !== 206 ||
  Number(range.headers.get("content-length")) !== expectedRangeLength ||
  range.headers.get("content-range") !==
    `bytes 0-${rangeEnd}/${updateArtifact.size}`
) {
  throw new Error(
    `Range 下载异常：status=${range.status}, length=${range.headers.get("content-length")}, range=${range.headers.get("content-range")}`,
  );
}
await range.arrayBuffer();

const hash = createHash("sha512");
let downloadedBytes = 0;
for (
  let start = 0, chunkNumber = 1;
  start < updateArtifact.size;
  start += verificationChunkBytes, chunkNumber += 1
) {
  const end =
    Math.min(start + verificationChunkBytes, updateArtifact.size) - 1;
  let chunk;
  let lastError;
  for (let attempt = 1; attempt <= rangeAttempts; attempt += 1) {
    try {
      const response = await fetch(`${artifactUrl}?${cacheBuster}`, {
        headers: {
          "Accept-Encoding": "identity",
          Range: `bytes=${start}-${end}`,
        },
        cache: "no-store",
      });
      const expectedLength = end - start + 1;
      if (
        response.status !== 206 ||
        Number(response.headers.get("content-length")) !== expectedLength ||
        response.headers.get("content-range") !==
          `bytes ${start}-${end}/${updateArtifact.size}`
      ) {
        throw new Error(
          `分片响应异常：status=${response.status}, range=${response.headers.get("content-range")}`,
        );
      }
      chunk = Buffer.from(await response.arrayBuffer());
      if (chunk.byteLength !== expectedLength) {
        throw new Error(
          `分片长度异常：${chunk.byteLength}/${expectedLength}`,
        );
      }
      break;
    } catch (error) {
      lastError = error;
      if (attempt < rangeAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  if (!chunk) {
    throw new Error(`远端安装包第 ${chunkNumber} 个分片连续失败`, {
      cause: lastError,
    });
  }
  hash.update(chunk);
  downloadedBytes += chunk.byteLength;
  console.log(
    `校验远端安装包分片 ${chunkNumber}/${Math.ceil(updateArtifact.size / verificationChunkBytes)}`,
  );
}
const remoteSha512 = hash.digest("base64");
if (
  downloadedBytes !== updateArtifact.size ||
  remoteSha512 !== updateArtifact.sha512
) {
  throw new Error(
    `远端安装包完整性失败：bytes=${downloadedBytes}/${updateArtifact.size}, sha512=${remoteSha512 === updateArtifact.sha512}`,
  );
}

const hiddenUploadEndpoint = await fetch(
  `${apiUrl}/internal/releases/multipart/start`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: updateArtifact.name }),
  },
);
if (hiddenUploadEndpoint.status !== 404) {
  throw new Error(
    `发布后上传入口未关闭：HTTP ${hiddenUploadEndpoint.status}`,
  );
}

console.log(
  JSON.stringify(
    {
      platform,
      version: manifest.version,
      manifest: manifestName,
      installer: updateArtifact.name,
      bytes: downloadedBytes,
      sha512Matches: true,
      range: `bytes 0-${rangeEnd}`,
      uploadEndpointClosed: true,
      verified: true,
    },
    null,
    2,
  ),
);
