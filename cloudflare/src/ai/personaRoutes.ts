import { AI_PERSONA_LIMITS } from "../../../shared/aiPersona";
import { AiError } from "../../../server/ai/security";
import type { AiPersonaRepository } from "../../../server/ai/persona";
import { json, type UserRow } from "../platform";

async function parsePersonaJson(request: Request): Promise<unknown> {
  if (!request.body) throw new AiError(400, "INVALID_JSON", "请提交有效 JSON 内容");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_PERSONA_LIMITS.requestBytes) {
        await reader.cancel().catch(() => {});
        throw new AiError(413, "AI_PERSONA_TOO_LARGE", "专属 AI 设置过长，原设置未被更改");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(400, "INVALID_JSON", "提交内容不是有效 UTF-8 JSON");
  } finally { reader.releaseLock(); }
}

export async function handleAiPersonaRequest(
  request: Request,
  repository: AiPersonaRepository,
  user: Pick<UserRow, "id" | "role" | "status">,
): Promise<Response> {
  try {
    if (user.status !== "active") throw new AiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
    if (user.role !== "member") throw new AiError(403, "AI_MEMBER_REQUIRED", "请使用成员账号访问专属 AI 设置");
    const expectedAccount = request.headers.get("X-Tongpin-Account");
    if (expectedAccount !== null && expectedAccount !== user.id) throw new AiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，本次未读取或修改其他账号的专属 AI 设置");
    if (new URL(request.url).pathname !== "/api/ai/persona") throw new AiError(404, "NOT_FOUND", "请求的接口不存在");
    if (request.method === "GET") return json(repository.read(user.id));
    if (request.method === "PUT") return json(repository.save(user.id, await parsePersonaJson(request)));
    return json({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持读取或保存专属 AI 设置" } }, 405, { Allow: "GET, PUT" });
  } catch (error) {
    if (error instanceof AiError) return json({ error: { code: error.code, message: error.message } }, error.status);
    return json({ error: { code: "AI_PERSONA_ERROR", message: "专属 AI 设置暂时不可用，请稍后重试" } }, 500);
  }
}
