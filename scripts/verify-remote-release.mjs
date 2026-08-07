import { createHash } from "node:crypto";

const baseUrl =
  process.env.TONGPIN_RELEASE_URL?.trim() ||
  "https://notify.samhubs.com/releases";
const apiUrl = new URL(baseUrl).origin;
const cacheBuster = `proof=${Date.now()}`;

function manifestValue(source, expression, label) {
  const match = source.match(expression);
  if (!match) throw new Error(`远端 latest.yml 缺少 ${label}`);
  return match[1].trim().replace(/^['"]|['"]$/g, "");
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

const manifest = await checkedFetch(
  `${baseUrl}/latest.yml?${cacheBuster}`,
).then((response) => response.text());
const version = manifestValue(manifest, /^version:\s*(.+)$/m, "version");
const installerName = manifestValue(
  manifest,
  /^\s*-\s+url:\s*(.+)$/m,
  "安装包 URL",
);
const expectedSize = Number(
  manifestValue(manifest, /^\s+size:\s*(\d+)$/m, "安装包大小"),
);
const expectedSha512 = manifestValue(
  manifest,
  /^sha512:\s*(.+)$/m,
  "SHA-512",
);
const installerUrl = `${baseUrl}/${encodeURIComponent(installerName)}`;
const verificationChunkBytes = 4 * 1024 * 1024;
const rangeAttempts = 3;

const head = await checkedFetch(`${installerUrl}?${cacheBuster}`, {
  method: "HEAD",
});
const remoteSize = Number(head.headers.get("content-length"));
if (remoteSize !== expectedSize) {
  throw new Error(
    `远端安装包大小不一致：latest.yml=${expectedSize}，HEAD=${remoteSize}`,
  );
}

const range = await fetch(`${installerUrl}?${cacheBuster}`, {
  headers: { Range: "bytes=0-1023" },
  cache: "no-store",
});
if (
  range.status !== 206 ||
  Number(range.headers.get("content-length")) !== 1024 ||
  range.headers.get("content-range") !== `bytes 0-1023/${expectedSize}`
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
  start < expectedSize;
  start += verificationChunkBytes, chunkNumber += 1
) {
  const end = Math.min(start + verificationChunkBytes, expectedSize) - 1;
  let chunk;
  let lastError;
  for (let attempt = 1; attempt <= rangeAttempts; attempt += 1) {
    try {
      const response = await fetch(`${installerUrl}?${cacheBuster}`, {
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
          `bytes ${start}-${end}/${expectedSize}`
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
    throw new Error(
      `远端安装包第 ${chunkNumber} 个分片连续失败`,
      { cause: lastError },
    );
  }
  hash.update(chunk);
  downloadedBytes += chunk.byteLength;
  console.log(
    `校验远端安装包分片 ${chunkNumber}/${Math.ceil(expectedSize / verificationChunkBytes)}`,
  );
}
const remoteSha512 = hash.digest("base64");
if (downloadedBytes !== expectedSize || remoteSha512 !== expectedSha512) {
  throw new Error(
    `远端安装包完整性失败：bytes=${downloadedBytes}/${expectedSize}, sha512=${remoteSha512 === expectedSha512}`,
  );
}

const hiddenUploadEndpoint = await fetch(
  `${apiUrl}/internal/releases/multipart/start`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: installerName }),
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
      version,
      installer: installerName,
      bytes: downloadedBytes,
      sha512Matches: true,
      range: "bytes 0-1023",
      uploadEndpointClosed: true,
      verified: true,
    },
    null,
    2,
  ),
);
