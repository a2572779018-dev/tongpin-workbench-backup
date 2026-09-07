import { LORA_INTERNAL_COLLECT_PATH, TongpinCore } from "./core";
import type { WorkerEnv } from "./platform";

export { TongpinCore };

const ALLOWED_METHODS = "GET,HEAD,POST,PATCH,PUT,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Authorization,Content-Type,X-Tongpin-Account";
const RELEASE_UPLOAD_PREFIX = "/internal/releases/";
const MAX_RELEASE_PART_BYTES = 8 * 1024 * 1024;
const MAX_RELEASE_OBJECT_BYTES = 2 * 1024 * 1024;

function allowedOrigins(env: WorkerEnv): Set<string> {
  return new Set(
    (env.CLIENT_ORIGINS ?? "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function corsHeaders(request: Request, env: WorkerEnv): Headers {
  const origin = request.headers.get("Origin");
  const headers = new Headers({
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (origin && allowedOrigins(env).has(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function withCors(
  response: Response,
  request: Request,
  env: WorkerEnv,
): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of corsHeaders(request, env)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function bufferedApiRequest(request: Request): Promise<Request> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) {
    return request;
  }
  const path = new URL(request.url).pathname;
  const limit = path === "/api/ai/workspace" ? 2 * 1024 * 1024 + 4096 : ["/api/ai/chat", "/api/ai/preflight"].includes(path) ? 1600 * 1024 : 768 * 1024;
  if (Number(request.headers.get("Content-Length")) > limit) throw new RangeError("API request body is too large");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RangeError("API request body is too large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  });
}

function isReleaseManifest(key: string): boolean {
  return key === "latest.yml" || key === "latest-mac.yml";
}

function releaseCacheControl(key: string): string {
  return isReleaseManifest(key)
    ? "public, max-age=0, must-revalidate"
    : "public, max-age=31536000, immutable";
}

function releaseHttpMetadata(key: string): R2HTTPMetadata {
  let contentType = "application/octet-stream";
  if (key.endsWith(".yml")) contentType = "application/yaml";
  else if (key.endsWith(".dmg")) contentType = "application/x-apple-diskimage";
  else if (key.endsWith(".zip")) contentType = "application/zip";
  else if (key.endsWith(".exe")) {
    contentType = "application/vnd.microsoft.portable-executable";
  }
  return {
    contentType,
    cacheControl: releaseCacheControl(key),
  };
}

function validReleaseKey(key: string): boolean {
  return (
    isReleaseManifest(key) ||
    /^Tongpin-Setup-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\.exe(?:\.blockmap)?$/.test(
      key,
    ) ||
    /^Tongpin-\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?-mac-(?:universal|x64|arm64)\.(?:dmg|zip)(?:\.blockmap)?$/.test(
      key,
    )
  );
}

async function equalSecret(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftHash);
  const rightBytes = new Uint8Array(rightHash);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

async function releaseUploadAuthorized(
  request: Request,
  env: WorkerEnv,
): Promise<boolean> {
  if (!env.RELEASE_UPLOAD_TOKEN) return false;
  return equalSecret(
    request.headers.get("Authorization") ?? "",
    `Bearer ${env.RELEASE_UPLOAD_TOKEN}`,
  );
}

function releaseUploadError(message: string, status = 400): Response {
  return Response.json(
    { error: { code: "RELEASE_UPLOAD_FAILED", message } },
    { status },
  );
}

async function parseReleaseUploadJson<T>(request: Request): Promise<T> {
  const contentLength = Number(request.headers.get("Content-Length") ?? 0);
  if (contentLength > 64 * 1024) {
    throw new RangeError("上传参数过大");
  }
  return request.json<T>();
}

async function handleReleaseUpload(
  request: Request,
  env: WorkerEnv,
  action: string,
): Promise<Response> {
  if (!(await releaseUploadAuthorized(request, env))) {
    return new Response(null, { status: 404 });
  }

  try {
    if (action === "multipart/start" && request.method === "POST") {
      const { key } = await parseReleaseUploadJson<{ key?: unknown }>(request);
      if (
        typeof key !== "string" ||
        !validReleaseKey(key) ||
        isReleaseManifest(key)
      ) {
        return releaseUploadError("无效的安装包文件名");
      }
      const upload = await env.RELEASES.createMultipartUpload(key, {
        httpMetadata: releaseHttpMetadata(key),
      });
      return Response.json({ key, uploadId: upload.uploadId });
    }

    if (action === "multipart/part" && request.method === "PUT") {
      const url = new URL(request.url);
      const key = url.searchParams.get("key") ?? "";
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const partNumber = Number(url.searchParams.get("partNumber"));
      const contentLength = Number(request.headers.get("Content-Length") ?? 0);
      if (
        !validReleaseKey(key) ||
        isReleaseManifest(key) ||
        !uploadId ||
        uploadId.length > 512 ||
        !Number.isInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > 10_000 ||
        !Number.isFinite(contentLength) ||
        contentLength < 1 ||
        contentLength > MAX_RELEASE_PART_BYTES
      ) {
        return releaseUploadError("无效的分片参数");
      }
      const body = await request.arrayBuffer();
      if (body.byteLength !== contentLength) {
        return releaseUploadError("分片长度不一致");
      }
      const upload = env.RELEASES.resumeMultipartUpload(key, uploadId);
      const part = await upload.uploadPart(partNumber, body);
      return Response.json(part);
    }

    if (action === "multipart/complete" && request.method === "POST") {
      const { key, uploadId, parts } = await parseReleaseUploadJson<{
        key?: unknown;
        uploadId?: unknown;
        parts?: unknown;
      }>(request);
      if (
        typeof key !== "string" ||
        !validReleaseKey(key) ||
        isReleaseManifest(key) ||
        typeof uploadId !== "string" ||
        !uploadId ||
        uploadId.length > 512 ||
        !Array.isArray(parts) ||
        parts.length < 1 ||
        parts.length > 10_000
      ) {
        return releaseUploadError("无效的完成参数");
      }
      const normalizedParts = parts.map((part) => {
        if (
          !part ||
          typeof part !== "object" ||
          !Number.isInteger((part as R2UploadedPart).partNumber) ||
          (part as R2UploadedPart).partNumber < 1 ||
          typeof (part as R2UploadedPart).etag !== "string" ||
          !(part as R2UploadedPart).etag
        ) {
          throw new TypeError("无效的分片清单");
        }
        return {
          partNumber: (part as R2UploadedPart).partNumber,
          etag: (part as R2UploadedPart).etag,
        };
      });
      normalizedParts.sort((left, right) => left.partNumber - right.partNumber);
      const upload = env.RELEASES.resumeMultipartUpload(key, uploadId);
      const object = await upload.complete(normalizedParts);
      return Response.json({
        key: object.key,
        size: object.size,
        etag: object.etag,
      });
    }

    if (action === "multipart/abort" && request.method === "POST") {
      const { key, uploadId } = await parseReleaseUploadJson<{
        key?: unknown;
        uploadId?: unknown;
      }>(request);
      if (
        typeof key !== "string" ||
        !validReleaseKey(key) ||
        typeof uploadId !== "string" ||
        !uploadId ||
        uploadId.length > 512
      ) {
        return releaseUploadError("无效的中止参数");
      }
      await env.RELEASES.resumeMultipartUpload(key, uploadId).abort();
      return new Response(null, { status: 204 });
    }

    if (action === "object" && request.method === "PUT") {
      const key = new URL(request.url).searchParams.get("key") ?? "";
      const contentLength = Number(request.headers.get("Content-Length") ?? 0);
      if (
        !validReleaseKey(key) ||
        !Number.isFinite(contentLength) ||
        contentLength < 1 ||
        contentLength > MAX_RELEASE_OBJECT_BYTES
      ) {
        return releaseUploadError("无效的小文件参数");
      }
      const body = await request.arrayBuffer();
      if (body.byteLength !== contentLength) {
        return releaseUploadError("文件长度不一致");
      }
      const object = await env.RELEASES.put(key, body, {
        httpMetadata: releaseHttpMetadata(key),
      });
      if (!object) {
        return releaseUploadError("R2 未返回上传结果", 502);
      }
      return Response.json({
        key: object.key,
        size: object.size,
        etag: object.etag,
      });
    }
  } catch (error) {
    if (error instanceof RangeError || error instanceof TypeError) {
      return releaseUploadError(error.message);
    }
    throw error;
  }

  return new Response(null, { status: 405 });
}

async function serveRelease(
  request: Request,
  env: WorkerEnv,
  key: string,
): Promise<Response> {
  if (!key || key.includes("..") || !validReleaseKey(key)) {
    return Response.json(
      { error: { code: "RELEASE_NOT_FOUND", message: "更新文件不存在" } },
      { status: 404 },
    );
  }

  if (request.method === "HEAD") {
    const object = await env.RELEASES.head(key);
    if (!object) return new Response(null, { status: 404 });
    const headers = new Headers({
      "Accept-Ranges": "bytes",
      "Cache-Control": releaseCacheControl(key),
      "Content-Length": String(object.size),
      ETag: object.httpEtag,
    });
    object.writeHttpMetadata(headers);
    return new Response(null, { headers });
  }

  const object = await env.RELEASES.get(key, {
    onlyIf: request.headers,
    range: request.headers,
  });
  if (!object) return new Response(null, { status: 404 });
  if (!("body" in object)) {
    return new Response(null, {
      status: 412,
      headers: { ETag: object.httpEtag },
    });
  }

  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": releaseCacheControl(key),
    ETag: object.httpEtag,
  });
  object.writeHttpMetadata(headers);

  let status = 200;
  if (object.range) {
    const offset =
      ("offset" in object.range ? object.range.offset : undefined) ?? 0;
    const length =
      ("length" in object.range ? object.range.length : undefined) ??
      object.size;
    headers.set(
      "Content-Range",
      `bytes ${offset}-${offset + length - 1}/${object.size}`,
    );
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }
  return new Response(object.body, { status, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === LORA_INTERNAL_COLLECT_PATH) {
      return new Response(null, { status: 404 });
    }

    if (request.method === "OPTIONS") {
      const origin = request.headers.get("Origin");
      if (origin && !allowedOrigins(env).has(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request, env),
      });
    }

    if (
      url.pathname.startsWith("/releases/") &&
      (request.method === "GET" || request.method === "HEAD")
    ) {
      return serveRelease(
        request,
        env,
        decodeURIComponent(url.pathname.slice("/releases/".length)),
      );
    }

    if (url.pathname.startsWith(RELEASE_UPLOAD_PREFIX)) {
      return handleReleaseUpload(
        request,
        env,
        url.pathname.slice(RELEASE_UPLOAD_PREFIX.length),
      );
    }

    if (url.pathname.startsWith("/api/")) {
      const id = env.TONGPIN_CORE.idFromName("primary");
      const stub = env.TONGPIN_CORE.get(id);
      let forwardedRequest: Request;
      try {
        forwardedRequest = await bufferedApiRequest(request);
      } catch (error) {
        if (error instanceof RangeError) {
          return withCors(
            Response.json(
              {
                error: {
                  code: "PAYLOAD_TOO_LARGE",
                  message: "提交内容过大",
                },
              },
              { status: 413 },
            ),
            request,
            env,
          );
        }
        throw error;
      }
      const response = await stub.fetch(forwardedRequest);
      if (response.status === 101) return response;
      return withCors(response, request, env);
    }

    return Response.json({
      ok: true,
      service: "tongpin-workbench-api",
      api: "/api/health",
      releases: "/releases/",
    });
  },
  scheduled(_controller, env, ctx) {
    const id = env.TONGPIN_CORE.idFromName("primary");
    const stub = env.TONGPIN_CORE.get(id);
    ctx.waitUntil(
      stub
        .fetch(
          new Request(`https://tongpin.internal${LORA_INTERNAL_COLLECT_PATH}`, {
            method: "POST",
          }),
        )
        .then(async (response) => {
          if (!response.ok) {
            const detail = await response.text();
            throw new Error(
              `LORA scheduled aggregate failed (${response.status}): ${detail}`,
            );
          }
        }),
    );
  },
} satisfies ExportedHandler<WorkerEnv>;
