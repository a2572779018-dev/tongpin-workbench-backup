import type { AiService } from "../../../server/ai/service";
import { AiError } from "../../../server/ai/security";
import { ApiError, json, type UserRow } from "../platform";

async function parseAiJson<T = unknown>(request: Request): Promise<T> {
  if (!request.body) throw new AiError(400, "INVALID_JSON", "请提交有效 JSON 内容");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  const limit = new URL(request.url).pathname === "/api/ai/chat" ? 1600 * 1024 : 768 * 1024;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new AiError(413, "PAYLOAD_TOO_LARGE", "提交内容过大"); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as T;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(400, "INVALID_JSON", "提交内容不是有效 JSON");
  } finally { reader.releaseLock(); }
}

export async function handleAiRequest(request: Request, service: AiService, user: UserRow, users: () => UserRow[]): Promise<Response> {
  try {
    const url = new URL(request.url);
    const { pathname: path } = url;
    const method = request.method;
    const boundAccount = request.headers.get("X-Tongpin-Account");
    if (boundAccount !== null && boundAccount !== user.id) throw new AiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，请重新打开工作台");
    if (path.startsWith("/api/admin/ai/") && user.role !== "admin") throw new AiError(403, "FORBIDDEN", "你没有访问此功能的权限");
    if (path.startsWith("/api/ai/") && user.role !== "member") throw new AiError(403, "AI_MEMBER_REQUIRED", "请使用成员账号访问 AI 工作台");
    if (path === "/api/admin/ai/provider" && method === "GET") return json({ provider: service.provider() });
    if (path === "/api/admin/ai/provider" && method === "PUT") {
      const body = await parseAiJson<{ baseUrl?: unknown }>(request);
      if (typeof body.baseUrl === "string") {
        let self = false;
        try { self = new URL(body.baseUrl).hostname === url.hostname; } catch { /* Service validates malformed URLs. */ }
        if (self) throw new AiError(400, "AI_URL_UNSAFE", "AI 地址不能指向同频服务自身");
      }
      return json({ provider: await service.saveProvider(body) });
    }
    if (path === "/api/admin/ai/provider/test" && method === "POST") {
      const body = request.headers.get("content-type")?.includes("application/json") ? await parseAiJson(request) : undefined;
      if (body && typeof body === "object" && "baseUrl" in body && typeof body.baseUrl === "string") {
        let self = false;
        try { self = new URL(body.baseUrl).hostname === url.hostname; } catch { /* Service validates malformed URLs. */ }
        if (self) throw new AiError(400, "AI_URL_UNSAFE", "AI 地址不能指向同频服务自身");
      }
      return json(await service.testProvider(body));
    }
    if (path === "/api/admin/ai/members" && method === "GET") return json({ members: service.members(users().filter(item => item.role === "member").map(({ id, name, email, role, status }) => ({ id, name, email, role, status }))) });
    const quotaMatch = path.match(/^\/api\/admin\/ai\/members\/([^/]+)\/quota$/);
    if (quotaMatch && method === "PUT") {
      const member = users().find(item => item.id === decodeURIComponent(quotaMatch[1]));
      if (!member) throw new AiError(404, "USER_NOT_FOUND", "没有找到该成员");
      if (member.role !== "member") throw new AiError(403, "AI_MEMBER_REQUIRED", "AI 额度仅可分配给成员账号");
      const quota = service.setQuota(member.id, user.id, await parseAiJson(request));
      return json({ member: { id: member.id, name: member.name, email: member.email, role: member.role, status: member.status, quota } });
    }
    if (path === "/api/admin/ai/usage" && method === "GET") return json({ entries: service.store.usage(url.searchParams.get("userId") || undefined) });
    if (path === "/api/ai/status" && method === "GET") return json(service.status(user.id));
    if (path === "/api/ai/usage" && method === "GET") { service.quota(user.id); return json({ entries: service.store.usage(user.id) }); }
    if (path === "/api/ai/chat" && method === "POST") return json(await service.chat(user.id, await parseAiJson(request)));
    if (path === "/api/ai/images" && method === "POST") return json(await service.generateImage(user.id, await parseAiJson(request)));
    const assetMatch = path.match(/^\/api\/ai\/assets\/([^/]+)$/);
    if (assetMatch && method === "GET") return json(service.getAsset(user.id, decodeURIComponent(assetMatch[1])));
    if (assetMatch && method === "DELETE") { service.deleteAsset(user.id, decodeURIComponent(assetMatch[1])); return json({ deleted: true }); }
    const requestMatch = path.match(/^\/api\/ai\/requests\/([^/]+)$/);
    if (requestMatch && method === "GET") return json(service.getRequestResult(user.id, decodeURIComponent(requestMatch[1])));
    throw new AiError(404, "NOT_FOUND", "请求的接口不存在");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof AiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "AI_SERVER_ERROR", message: "AI 服务处理失败，请稍后重试" } }, 500);
  }
}
