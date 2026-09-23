import type { AiService } from "./service";
import { AiError } from "./security";
import { DifyToolGatewayError, type DifyToolExecutionContext } from "./difyToolGateway";
import { DifyToolRuntime, type DifyRuntimeConfig } from "./difyRuntime";

export interface DifyRouteOptions {
  config?: DifyRuntimeConfig;
  principalActive?: (tenantId: string, userId: string) => boolean | Promise<boolean>;
}
function response(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
function failure(error: unknown): Response {
  if (error instanceof AiError || error instanceof DifyToolGatewayError) return response({ error: { code: error.code, message: error.message } }, error.status);
  return response({ error: { code: "DIFY_TOOL_SERVER_ERROR", message: "Dify 工具处理失败，请查询原任务" } }, 500);
}
async function body(request: Request): Promise<Record<string, unknown>> {
  // The callback schema carries IDs only; prompts and media stay in the saved grant.
  const reader = request.body?.getReader();
  if (!reader) throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "请求内容为空", 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > 16_384) { await reader.cancel(); throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "Dify 请求内容过大", 413); }
    chunks.push(item.value);
  }
  const all = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(all)); }
  catch { throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "Dify 请求不是有效 JSON", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "Dify 请求格式无效", 400);
  return value as Record<string, unknown>;
}

/** Mount behind the existing member authentication and account-change guard.
 * Calling this approval action authorizes only the saved plan and bounded points.
 */
export async function createDifyGrantResponse(service: AiService, context: DifyToolExecutionContext, value: unknown, options: DifyRouteOptions = {}): Promise<Response> {
  try { return response(await new DifyToolRuntime(service.forTenant(context.tenantId), options.config, options.principalActive).issueGrant(context, value)); }
  catch (error) { return failure(error); }
}

/** Mount separately from browser-session auth. The opaque capability in the
 * Authorization header authenticates this callback; tenant JSON only selects
 * a store partition, and the grant and active member must match that partition.
 */
export async function createDifyToolResponse(service: AiService, request: Request, options: DifyRouteOptions = {}): Promise<Response> {
  try {
    if (request.method !== "POST") return response({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持 POST" } }, 405);
    const token = request.headers.get("Authorization")?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return response({ error: { code: "DIFY_TOOL_AUTH_INVALID", message: "Dify 工具授权无效" } }, 401);
    const input = await body(request);
    if (typeof input.tenantId !== "string") throw new DifyToolGatewayError("DIFY_TOOL_INPUT_INVALID", "缺少组织范围", 400);
    const runtime = new DifyToolRuntime(service.forTenant(input.tenantId), options.config, options.principalActive);
    return response(await runtime.invoke({ ...input, authorization: token }));
  } catch (error) { return failure(error); }
}
