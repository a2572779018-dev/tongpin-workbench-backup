import { AI_MEMORY_LIMITS } from "../../../shared/aiMemory";
import { memoryReviewIds } from "../../../server/ai/memberMemoryService";
import { AiError } from "../../../server/ai/security";
import type { AiService } from "../../../server/ai/service";
import { aiTenantIdFromPrincipal } from "../../../server/ai/tenant";
import { json, type UserRow } from "../platform";

export function isAiMemberMemoryPath(path: string): boolean {
  return path === "/api/ai/memory" || path.startsWith("/api/ai/memory/") || path === "/api/admin/ai/memory";
}

async function parseMemoryJson(request: Request): Promise<unknown> {
  if (!request.body) throw new AiError(400, "INVALID_JSON", "请提交有效 JSON 内容");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_MEMORY_LIMITS.requestBytes) {
        await reader.cancel().catch(() => {});
        throw new AiError(413, "AI_MEMORY_TOO_LARGE", "提交内容过长，记忆未被修改");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(400, "INVALID_JSON", "提交内容不是有效 UTF-8 JSON");
  } finally { reader.releaseLock(); }
}

/**
 * Durable Object handler for member memory. Member paths bind every read and
 * write to the authenticated account; the administrator path returns settings
 * and organization aggregates only — there is no endpoint that reads another
 * account's memory.
 */
export async function handleAiMemberMemoryRequest(request: Request, service: AiService, user: Pick<UserRow, "id" | "role" | "status">): Promise<Response> {
  try {
    if (user.status !== "active") throw new AiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
    const expectedAccount = request.headers.get("X-Tongpin-Account");
    if (expectedAccount !== null && expectedAccount !== user.id) throw new AiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，本次未读取或修改其他账号的记忆");
    const url = new URL(request.url);
    const path = url.pathname, method = request.method;
    const memory = service.forTenant(aiTenantIdFromPrincipal(user)).memberMemory;
    if (path === "/api/admin/ai/memory") {
      if (user.role !== "admin") throw new AiError(403, "FORBIDDEN", "你没有访问此功能的权限");
      if (method === "GET") return json(memory.adminView());
      if (method === "PUT") return json(memory.saveAdminSettings(await parseMemoryJson(request)));
      return json({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持读取或保存记忆设置" } }, 405, { Allow: "GET, PUT" });
    }
    if (user.role !== "member" && user.role !== "boss") throw new AiError(403, "AI_MEMBER_REQUIRED", "请使用成员或老板账号访问自己的记忆");
    if (path === "/api/ai/memory") {
      if (method === "GET") return json(memory.state(user.id));
      if (method === "DELETE") return json(memory.clear(user.id));
      return json({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持读取或清空记忆" } }, 405, { Allow: "GET, DELETE" });
    }
    if (path === "/api/ai/memory/settings" && method === "PUT") return json(memory.setLearning(user.id, await parseMemoryJson(request)));
    if (path === "/api/ai/memory/entries" && method === "POST") return json(memory.updateEntry(user.id, await parseMemoryJson(request)));
    if (path === "/api/ai/memory/reviews" && method === "GET") return json({ reviews: memory.reviewStatuses(user.id, memoryReviewIds(url.searchParams.get("requestIds"))) });
    if (path.startsWith("/api/ai/memory/recalls/") && method === "GET") {
      let requestId: string;
      try { requestId = decodeURIComponent(path.slice("/api/ai/memory/recalls/".length)); } catch { throw new AiError(400, "AI_MEMORY_INVALID", "请求编号格式不正确"); }
      return json({ recall: memory.recallDetail(user.id, requestId) });
    }
    if (path === "/api/ai/memory/skills" && method === "GET") return json(memory.personalSkills(user.id));
    if (path === "/api/ai/memory/skills" && method === "POST") return json(memory.updateSkill(user.id, await parseMemoryJson(request)));
    throw new AiError(404, "NOT_FOUND", "请求的接口不存在");
  } catch (error) {
    if (error instanceof AiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    // Memory is private member data: never echo it on failure.
    return json({ error: { code: "AI_MEMORY_ERROR", message: "记忆暂时不可用，请稍后重试" } }, 500);
  }
}
