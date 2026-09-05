export class AiError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly definitelyNotSent = false) { super(message); }
}
export function safeBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new AiError(400, "AI_URL_INVALID", "请输入有效的 HTTPS API 地址");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new AiError(400, "AI_URL_INVALID", "请输入有效的 HTTPS API 地址"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443") ||
      !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|arpa)$/.test(host)) {
    throw new AiError(400, "AI_URL_UNSAFE", "API 地址必须使用公网 HTTPS 域名，不能包含端口、账号、查询参数或内网地址");
  }
  let path = url.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(?:chat\/completions|responses|models|images\/generations)$/, "");
  if (!path) path = "/v1";
  url.pathname = path;
  return url.toString().replace(/\/$/, "");
}
export function isPublicIp(address: string): boolean {
  if (address.includes(":")) {
    // Only global unicast IPv6; excludes mapped IPv4, loopback, link/site local, NAT64 and multicast.
    return /^2[0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:|10:|20:)/i.test(address) && !/^2002:/i.test(address);
  }
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a,b,c] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 0 && c === 2))) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) || (a === 203 && b === 0 && c === 113));
}
function encode(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)); }
function decode(value: string): Uint8Array<ArrayBuffer> { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function createSecretBox(secret: string) {
  if (secret.length < 32 || secret.includes("development-secret")) throw new AiError(503, "AI_ENCRYPTION_UNAVAILABLE", "服务器安全密钥未配置，暂不能保存 API 密钥");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tongpin-ai-key-v1:${secret}`));
  const key = await crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
  return {
    async encrypt(value: string): Promise<string> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
      return `v1.${encode(iv)}.${encode(new Uint8Array(data))}`;
    },
    async decrypt(value: string): Promise<string> {
      try {
        const [version, iv, data] = value.split(".");
        if (version !== "v1") throw new Error("version");
        return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(iv) }, key, decode(data)));
      } catch { throw new AiError(503, "AI_KEY_UNREADABLE", "已保存密钥无法解密，请管理员重新保存 API 密钥"); }
    },
  };
}
export type SecretBox = Awaited<ReturnType<typeof createSecretBox>>;
