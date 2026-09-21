import type { AiService } from "../../../server/ai/service";
import { AiError } from "../../../server/ai/security";
import { ApiError, json, type UserRow } from "../platform";
import type { AiMode } from "../../../shared/ai";
import { aiTenantIdFromPrincipal } from "../../../server/ai/tenant";

const videoTier = (value: string | null): AiMode => ["quick", "standard", "deep", "pro"].includes(String(value)) ? value as AiMode : "quick";

async function parseAiJson<T = unknown>(request: Request): Promise<T> {
  if (!request.body) throw new AiError(400, "INVALID_JSON", "请提交有效 JSON 内容");
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  const limit = ["/api/ai/chat", "/api/ai/preflight"].includes(new URL(request.url).pathname) ? 1600 * 1024 : 768 * 1024;
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
    if (user.status !== "active") throw new AiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
    const boundAccount = request.headers.get("X-Tongpin-Account");
    if (boundAccount !== null && boundAccount !== user.id) throw new AiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，请重新打开工作台");
    const tenantId = aiTenantIdFromPrincipal(user);
    service = service.forTenant(tenantId);
    if (path.startsWith("/api/admin/ai/") && user.role !== "admin") throw new AiError(403, "FORBIDDEN", "你没有访问此功能的权限");
    if (path.startsWith("/api/ai/") && user.role !== "member" && user.role !== "boss") throw new AiError(403, "AI_MEMBER_REQUIRED", "请使用成员或老板账号访问 AI 工作台");
    if (path === "/api/admin/ai/video" && method === "GET") return json({ settings: service.video.settings(), pending: service.video.adminPending() });
    if (path === "/api/admin/ai/video" && method === "PUT") return json({ settings: await service.video.configure(await parseAiJson(request)) });
    if (path === "/api/admin/ai/video/test" && method === "POST") return json(await service.video.test());
    const videoReconcile = path.match(/^\/api\/admin\/ai\/videos\/([^/]+)\/([^/]+)\/reconcile$/);
    if (videoReconcile && method === "POST") return json({ job: service.video.reconcile(videoReconcile[1], videoReconcile[2], user.id, await parseAiJson(request)) });
    if (path === "/api/ai/videos" && method === "GET") return json(service.video.list(user.id, videoTier(url.searchParams.get("tier"))));
    if (path === "/api/ai/video-references" && method === "POST") return json(await service.video.uploadReference(user.id, await parseAiJson(request)));
    if (path === "/api/ai/videos" && method === "POST") return json({ job: await service.video.submit(user.id, await parseAiJson(request)) });
    const videoMatch = path.match(/^\/api\/ai\/videos\/([^/]+)(\/content)?$/);
    if (videoMatch && method === "GET") return videoMatch[2] ? await service.video.content(user.id, videoMatch[1]) : json({ job: await service.video.refresh(user.id, videoMatch[1]) });
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
    if (path === "/api/admin/ai/harness" && method === "GET") return json({ harness: service.harnessSettings() });
    if (path === "/api/admin/ai/harness" && method === "PUT") {
      const body = await parseAiJson<{ providers?: Array<{ baseUrl?: unknown }> }>(request);
      if (Array.isArray(body.providers)) {
        for (const provider of body.providers) {
          if (typeof provider.baseUrl === "string") {
            try { if (new URL(provider.baseUrl).hostname === url.hostname) throw new AiError(400, "AI_URL_UNSAFE", "AI 地址不能指向同频服务自身"); }
            catch (error) { if (error instanceof AiError) throw error; }
          }
        }
      }
      return json({ harness: await service.saveHarness(body) });
    }
    const harnessDiscover = path.match(/^\/api\/admin\/ai\/harness\/providers\/([^/]+)\/discover$/);
    if (harnessDiscover && method === "POST") return json(await service.discoverHarnessProvider(decodeURIComponent(harnessDiscover[1])));
    if (path === "/api/admin/ai/observability" && method === "GET") return json(service.observability(Number(url.searchParams.get("windowMinutes") ?? 60)));
    const observabilityAcknowledge = path.match(/^\/api\/admin\/ai\/observability\/alerts\/([^/]+)\/acknowledge$/);
    if (observabilityAcknowledge && method === "PATCH") return json({ alert: service.acknowledgeObservabilityAlert(decodeURIComponent(observabilityAcknowledge[1]), user.id) });
    if (path === "/api/admin/ai/members" && method === "GET") return json({ members: service.members(users().filter(item => (item.role === "member" || item.role === "boss") && aiTenantIdFromPrincipal(item) === tenantId).map(({ id, name, email, role, status }) => ({ id, name, email, role, status }))) });
    const quotaMatch = path.match(/^\/api\/admin\/ai\/members\/([^/]+)\/quota$/);
    if (quotaMatch && method === "PUT") {
      const member = users().find(item => item.id === decodeURIComponent(quotaMatch[1]));
      if (!member || aiTenantIdFromPrincipal(member) !== tenantId) throw new AiError(404, "USER_NOT_FOUND", "没有找到该成员");
      if (member.role !== "member" && member.role !== "boss") throw new AiError(403, "AI_MEMBER_REQUIRED", "AI 额度仅可分配给成员或老板账号");
      const quota = service.setQuota(member.id, user.id, await parseAiJson(request));
      return json({ member: { id: member.id, name: member.name, email: member.email, role: member.role, status: member.status, quota } });
    }
    if (path === "/api/admin/ai/usage" && method === "GET") return json({ entries: service.store.usage(url.searchParams.get("userId") || undefined) });
    if (path === "/api/ai/status" && method === "GET") return json(service.status(user.id));
    if (path === "/api/ai/availability" && method === "GET") return json(await service.availability(user.id, url.searchParams.get("target") ?? "chat"));
    if (path === "/api/ai/usage" && method === "GET") { service.quota(user.id); return json({ entries: service.memberUsage(user.id) }); }
    if (path === "/api/ai/preflight" && method === "POST") return json(service.preflight(user.id, await parseAiJson(request)));
    if (path === "/api/ai/chat" && method === "POST") return json(await service.chat(user.id, await parseAiJson(request)));
    if (path === "/api/ai/images" && method === "POST") return json(await service.generateImage(user.id, await parseAiJson(request)));
    const assetMatch = path.match(/^\/api\/ai\/assets\/([^/]+)$/);
    if (assetMatch && method === "GET") return json(service.getAsset(user.id, decodeURIComponent(assetMatch[1])));
    if (assetMatch && method === "DELETE") { service.deleteAsset(user.id, decodeURIComponent(assetMatch[1])); return json({ deleted: true }); }
    const requestMatch = path.match(/^\/api\/ai\/requests\/([^/]+)$/);
    if (requestMatch && method === "GET") return json(service.getRequestResult(user.id, decodeURIComponent(requestMatch[1])));
    const runMatch = path.match(/^\/api\/ai\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") return json({ trace: service.harnessTrace(user.id, decodeURIComponent(runMatch[1])) });
    if (runMatch && method === "DELETE") return json({ trace: service.cancelHarnessRun(user.id, decodeURIComponent(runMatch[1])) });
    const resumeRunMatch = path.match(/^\/api\/ai\/runs\/([^/]+)\/resume$/);
    if (resumeRunMatch && method === "POST") return json({ trace: await service.resumeHarnessRun(user.id, decodeURIComponent(resumeRunMatch[1])) });
    throw new AiError(404, "NOT_FOUND", "请求的接口不存在");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof AiError) return json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } }, error.status);
    return json({ error: { code: "AI_SERVER_ERROR", message: "AI 服务处理失败，请稍后重试" } }, 500);
  }
}
