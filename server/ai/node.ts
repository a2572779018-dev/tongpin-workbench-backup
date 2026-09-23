import { randomBytes } from "node:crypto";
import { lookup } from "node:dns";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import { Readable } from "node:stream";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AiError, createSecretBox, isPublicIp, safeBaseUrl } from "./security";
import { AiStore, type AiSql } from "./storage";
import { AiService, type AiBackgroundPrincipalCheck } from "./service";
import { AiPersonaRepository } from "./persona";
import type { AiTransport } from "./provider";

/** Resolve and pin a public address within the TLS connection itself; never follow redirects. */
export const nodeAiTransport: AiTransport = async (target, init) => {
  if (init.body !== undefined && init.binaryBody !== undefined) throw new AiError(400, "AI_TRANSPORT_BODY_INVALID", "请求不能同时包含 JSON 和二进制内容", true);
  const url = new URL(target);
  safeBaseUrl(url.origin);
  return new Promise<Response>((resolve, reject) => {
    let connected = false;
    const request = https.request(url, {
      method: init.method, headers: init.headers, signal: init.signal,
      lookup(hostname, options, callback) {
        lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
          if (error || !addresses.length || addresses.some(item => !isPublicIp(item.address))) {
            callback(new Error("AI destination is not a public address"), "", 4); return;
          }
          const address = addresses.find(item => !options.family || item.family === options.family) ?? addresses[0];
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        });
      },
    }, response => {
      try {
        const status = response.statusCode ?? 502;
        // Expose bytes as they arrive so bounded readers and search-budget guards can cancel promptly.
        // Readable.toWeb propagates cancellation to IncomingMessage; it never retries the request.
        let size = 0;
        const videoDownload = url.origin === "https://www.75api.com" && /^\/v1\/videos\/task_[a-zA-Z0-9_-]{8,128}\/content$/.test(url.pathname) && init.method === "GET";
        const limit = Math.min(init.maxResponseBytes ?? 2_000_000, videoDownload ? 64 * 1024 * 1024 : 6_000_000);
        const body = [204, 205, 304].includes(status) ? null : (Readable.toWeb(response) as ReadableStream<Uint8Array>).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            size += chunk.byteLength;
            if (size > limit) throw new AiError(502, "AI_PROVIDER_RESPONSE", "AI 返回内容过大");
            controller.enqueue(chunk);
          },
        }));
        if (!body) response.resume();
        const headers = new Headers({ "Content-Type": String(response.headers["content-type"] ?? "application/json") });
        for (const name of ["x-request-id", "cf-ray", "cf-mitigated", "server"]) {
          const value = response.headers[name];
          if (typeof value === "string" && value.length <= 200) headers.set(name, value);
        }
        resolve(new Response(body, { status, headers }));
      } catch { response.destroy(); reject(new AiError(502, "AI_PROVIDER_RESPONSE", "AI 服务返回了无效响应")); }
    });
    request.on("socket", socket => { socket.once("secureConnect", () => { connected = true; }); });
    // Keep-alive sockets do not emit secureConnect again. A reset on a reused
    // connection may happen after the paid body was sent, so never refund it as unsent.
    request.on("error", () => reject(new AiError(502, "AI_CONNECTION_FAILED", "无法安全连接 AI 服务，请检查公网 API 地址和网络", !connected && !request.reusedSocket)));
    const body = init.binaryBody ?? init.body;
    if (body !== undefined) request.write(body);
    request.end();
  });
};
async function localSecret(file: string): Promise<string> {
  try { await chmod(file, 0o600); return (await readFile(file, "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const secret = randomBytes(32).toString("hex");
  try { await writeFile(file, secret, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return (await readFile(file, "utf8")).trim();
}
export async function createNodeAi(dataFile: string, transport: AiTransport = nodeAiTransport, isBackgroundPrincipalActive: AiBackgroundPrincipalCheck = () => false) {
  await mkdir(path.dirname(dataFile), { recursive: true });
  const file = `${dataFile}.ai.sqlite`;
  const database = new DatabaseSync(file);
  await chmod(file, 0o600);
  database.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;");
  const sql: AiSql = {
    exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
    transaction<T>(action: () => T): T {
      database.exec("BEGIN IMMEDIATE");
      try { const result = action(); database.exec("COMMIT"); return result; }
      catch (error) { database.exec("ROLLBACK"); throw error; }
    },
  };
  const store = new AiStore(sql); store.initialize();
  new AiPersonaRepository(sql).initialize();
  let secret: ReturnType<typeof createSecretBox> | undefined;
  const box = async () => {
    secret ??= localSecret(`${dataFile}.ai-key`).then(value => createSecretBox(value));
    return await secret;
  };
  const service = new AiService(store, box, transport, () => process.env.TONGPIN_H3_API_KEY ?? "", isBackgroundPrincipalActive);
  let closed = false;
  return { service, store, close: () => { if (!closed) { closed = true; database.close(); } } };
}
