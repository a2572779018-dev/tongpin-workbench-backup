import { AiStore, type AiSql } from "../../../server/ai/storage";
import { AiService } from "../../../server/ai/service";
import { AiError, createSecretBox, isPublicIp, safeBaseUrl } from "../../../server/ai/security";
import { object, readBoundedJson, type AiTransport } from "../../../server/ai/provider";
import type { AiBackgroundPrincipalCheck } from "../../../server/ai/service";
import { wireRunGuidance } from "../../../server/ai/runGuidanceWiring";

const DEFAULT_AI_HOSTS = ["api.openai.com", "api.deepseek.com", "dashscope.aliyuncs.com", "api.moonshot.cn", "api.siliconflow.cn", "open.bigmodel.cn", "api.typesafe.ai"] as const;
/** Exact deployment-owned domains close the DNS-rebinding gap: Worker fetch cannot pin IPs.
 * This allowlist is never read from an administrator's provider form or a member request.
 * Public DNS checks remain defense in depth and redirects never carry credentials elsewhere. */
export function createWorkerAiTransport(allowedHosts?: string | readonly string[], fetcher: typeof fetch = fetch): AiTransport {
  const configured = typeof allowedHosts === "string" ? allowedHosts.split(/[\s,]+/) : allowedHosts ?? DEFAULT_AI_HOSTS;
  const hosts = new Set(configured.map(host => host.trim().toLowerCase()).filter(host => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/.test(host)));
  return async (target, init) => {
  if (init.body !== undefined && init.binaryBody !== undefined) throw new AiError(400, "AI_TRANSPORT_BODY_INVALID", "请求不能同时包含 JSON 和二进制内容", true);
  const url = new URL(target);
  safeBaseUrl(url.origin);
  if (!hosts.has(url.hostname.toLowerCase())) throw new AiError(400, "AI_HOST_NOT_ALLOWED", "该 API 域名尚未列入服务器允许名单，请先在部署配置中添加准确域名", true);
  let lookups: string[][];
  try { lookups = await Promise.all(["A", "AAAA"].map(async type => {
    const lookupUrl = new URL("https://cloudflare-dns.com/dns-query");
    lookupUrl.searchParams.set("name", url.hostname);
    lookupUrl.searchParams.set("type", type);
    // workerd supports manual/follow, but rejects redirect:"error" at runtime.
    // Manual mode keeps the redirect response local; neither DNS nor provider requests follow it.
    const response = await fetcher(lookupUrl, { headers: { Accept: "application/dns-json" }, redirect: "manual", signal: init.signal });
    if (!response.ok) throw new AiError(502, "AI_DNS_FAILED", "暂时无法验证 AI 服务的公网地址");
    const data = object(await readBoundedJson(response, 32000));
    return Array.isArray(data.Answer) ? data.Answer.map(row => object(row)).filter(row => row.type === 1 || row.type === 28).map(row => String(row.data)) : [];
  })); } catch { throw new AiError(502, "AI_DNS_FAILED", "暂时无法验证 AI 服务的公网地址，请稍后重试", true); }
  const addresses = lookups.flat();
  if (!addresses.length || addresses.some(address => !isPublicIp(address))) throw new AiError(400, "AI_URL_UNSAFE", "API 域名必须解析到公网地址", true);
  const { maxResponseBytes: _limit, binaryBody, ...requestInit } = init;
  return fetcher(target, { ...requestInit, ...(binaryBody ? { body: new Uint8Array(binaryBody) } : {}), redirect: "manual" });
  };
}
export const workerAiTransport: AiTransport = createWorkerAiTransport();

export function createWorkerAi(storage: DurableObjectStorage, secret: () => string, allowedHosts?: string | readonly string[], videoKey?: () => string, isBackgroundPrincipalActive: AiBackgroundPrincipalCheck = () => false) {
  const sql: AiSql = {
    exec(query, ...bindings) { storage.sql.exec(query, ...bindings); },
    all<T>(query: string, ...bindings: Array<string | number | null>): T[] {
      return storage.sql.exec(query, ...bindings).toArray() as T[];
    },
    transaction<T>(action: () => T): T { return storage.transactionSync(action); },
  };
  const store = new AiStore(sql);
  const service = new AiService(store, () => createSecretBox(secret()), createWorkerAiTransport(allowedHosts), videoKey, isBackgroundPrincipalActive);
  // Mid-run guidance (steer) for multi-agent and computer runs; same wiring as Express.
  wireRunGuidance(store);
  return { store, service };
}
