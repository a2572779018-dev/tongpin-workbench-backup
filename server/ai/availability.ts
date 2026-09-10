import type { AiAvailabilityCheck } from "../../shared/ai";
import { AiError, type SecretBox } from "./security";
import { object, readBoundedJson, readProviderHttpError, type AiTransport } from "./provider";

/** Short-lived, single-flight, server-only connection checks. No prompts or usage writes. */
export class AvailabilityProbe {
  private slots = new Map<string, { identity: string; expires: number; promise: Promise<AiAvailabilityCheck> }>();
  constructor(private readonly transport: AiTransport, private readonly box: () => Promise<SecretBox>) {}
  invalidate(target: "chat" | "image") { this.slots.delete(target); }
  check(target: string, baseUrl: string, encryptedKey: string): Promise<AiAvailabilityCheck> {
    const identity = JSON.stringify([baseUrl, encryptedKey]);
    const cached = this.slots.get(target);
    if (cached?.identity === identity && cached.expires > Date.now()) return cached.promise;
    const entry = { identity, expires: Infinity, promise: this.probe(baseUrl, encryptedKey) };
    this.slots.set(target, entry);
    void entry.promise.finally(() => { entry.expires = Date.now() + 15_000; });
    return entry.promise;
  }
  private async probe(baseUrl: string, encryptedKey: string): Promise<AiAvailabilityCheck> {
    const result = (state: AiAvailabilityCheck["state"], code: string, message: string): AiAvailabilityCheck => ({ state, code, message, checkedAt: new Date().toISOString() });
    try {
      const key = await (await this.box()).decrypt(encryptedKey);
      const response = await this.transport(`${baseUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
      if ([404, 405, 501].includes(response.status)) {
        await response.body?.cancel();
        return result("unverified", "AI_PROBE_UNSUPPORTED", "服务商不支持连接检测，生成能力尚未验证；可尝试发送，失败时会显示具体原因。");
      }
      if (!response.ok) throw await readProviderHttpError(response, "models");
      const body = object(await readBoundedJson(response, 512_000));
      if (!Array.isArray(body.data)) return result("unverified", "AI_PROBE_UNVERIFIED", "服务商未返回有效模型列表，生成能力尚未验证；可尝试发送。");
      return result("reachable", "AI_CONNECTION_REACHABLE", "服务商连接检查通过；生成、联网搜索等能力以实际请求结果为准。");
    } catch (error) {
      // Provider messages are normalized by readProviderHttpError; never forward raw transport/decryption errors.
      if (error instanceof AiError) {
        if (["AI_PROVIDER_RESPONSE", "AI_PROVIDER_REJECTED"].includes(error.code)) return result("unverified", error.code, "服务商的检测接口未能完成验证；这不代表生成接口一定不可用，可尝试发送。");
        return result("unavailable", error.code, error.message);
      }
      return result("unavailable", "AI_CONNECTION_FAILED", "暂时无法连接 AI 服务商，请稍后重新检测；若持续失败，请联系管理员检查服务连接。");
    }
  }
}
