import { AI_WORKSPACE_LIMITS } from "../../../shared/aiWorkspace";
import { AiError } from "../../../server/ai/security";
import type { AiWorkspaceRepository } from "../../../server/ai/workspace";
import { json, type UserRow } from "../platform";

async function parseWorkspaceJson(request: Request): Promise<unknown> {
  if (!request.body) throw new AiError(400, "INVALID_JSON", "请提交有效 JSON 内容");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_WORKSPACE_LIMITS.requestBytes) {
        await reader.cancel().catch(() => {});
        throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "工作台提交内容过大，原记录未被更改");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(400, "INVALID_JSON", "提交内容不是有效 UTF-8 JSON");
  } finally { reader.releaseLock(); }
}

/** Caller authenticates first; ownership is always the authenticated member id. */
export async function handleAiWorkspaceRequest(
  request: Request,
  repository: AiWorkspaceRepository,
  user: Pick<UserRow, "id" | "role" | "status">,
): Promise<Response> {
  try {
    if (user.status !== "active") throw new AiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
    if (user.role !== "member" && user.role !== "boss") throw new AiError(403, "AI_MEMBER_REQUIRED", "请使用成员或老板账号访问 AI 工作台");
    if (new URL(request.url).pathname !== "/api/ai/workspace") throw new AiError(404, "NOT_FOUND", "请求的接口不存在");
    const expectedAccount = request.headers.get("X-Tongpin-Account");
    if (expectedAccount !== null && expectedAccount !== user.id) throw new AiError(409, "AI_WORKSPACE_ACCOUNT_CHANGED", "当前登录账号已改变，请重新打开工作台");
    if (request.method === "GET") return json(repository.read(user.id));
    if (request.method === "PUT") {
      return json(await repository.save(user.id, await parseWorkspaceJson(request)));
    }
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持读取或保存工作台" } }, 405, { Allow: "GET, PUT" });
  } catch (error) {
    if (error instanceof AiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "AI_WORKSPACE_ERROR", message: "工作台保存服务暂不可用，请保留当前窗口后重试" } }, 500);
  }
}
