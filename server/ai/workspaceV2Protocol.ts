import type { AiWorkspaceArtifact, AiWorkspaceConversation, AiWorkspaceMessage } from "../../shared/aiWorkspace";
import { AiError } from "./security";
import { AiStore } from "./storage";
import { aiTenantIdFromPrincipal } from "./tenant";
import { validateAiWorkspaceArtifactEntity, validateAiWorkspaceConversationEntity } from "./workspace";
import { AiWorkspaceV2Store } from "./workspaceV2Store";

/** Body limit shared by the Node route, Worker ingress and the DO decoder.
 * A single V2 conversation can reach 16 MiB without the old account cap. */
export const AI_WORKSPACE_V2_REQUEST_BYTES = 16 * 1024 * 1024 + 16 * 1024;
const PREFIX = "/api/ai/workspace-v2";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Principal = { id: string; role: string; status: string; tenantId?: string; tenant_id?: string; orgId?: string; org_id?: string };

function invalid(message: string): never { throw new AiError(400, "AI_WORKSPACE_INVALID", message); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("工作台请求格式无效");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => !keys.includes(key) || ["__proto__", "constructor", "prototype"].includes(key))) invalid("工作台请求包含不支持的字段");
  return body;
}
function respond(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}
async function readBody(request: Request): Promise<unknown> {
  if (!request.body) invalid("请提交有效 JSON 内容");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0, source = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AI_WORKSPACE_V2_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "单次分实体提交内容过大，原记录未被更改");
      }
      source += decoder.decode(value, { stream: true });
    }
    return JSON.parse(source + decoder.decode()) as unknown;
  } catch (error) {
    if (error instanceof AiError) throw error;
    throw new AiError(400, "INVALID_JSON", "提交内容不是有效 UTF-8 JSON");
  } finally { reader.releaseLock(); }
}
function routeId(raw: string): string {
  let value: string;
  try { value = decodeURIComponent(raw); } catch { return invalid("对话或成果标识无效"); }
  if (!ID.test(value)) invalid("对话或成果标识无效");
  return value;
}

/** A deliberately narrow member protocol. Migration control is never exposed
 * here; all generated answer fields are rebuilt from the server request ledger. */
export async function handleAiWorkspaceV2Request(request: Request, store: AiWorkspaceV2Store, user: Principal): Promise<Response> {
  try {
    if (user.status !== "active") throw new AiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
    if (user.role !== "member" && user.role !== "boss") throw new AiError(403, "AI_MEMBER_REQUIRED", "请使用成员或老板账号访问 AI 工作台");
    const account = request.headers.get("X-Tongpin-Account");
    if (account !== null && account !== user.id) throw new AiError(409, "AI_WORKSPACE_ACCOUNT_CHANGED", "当前登录账号已改变，请重新打开工作台");
    const tenant = aiTenantIdFromPrincipal(user);
    const url = new URL(request.url);
    const path = url.pathname;
    if (!path.startsWith(`${PREFIX}/`)) throw new AiError(404, "NOT_FOUND", "请求的接口不存在");

    if (path === `${PREFIX}/bootstrap` && request.method === "GET") {
      if (store.workspaceVersion(user.id, tenant) === 1) return respond({ schemaVersion: 1 });
      const [directory, projects, manifest] = await Promise.all([
        store.listActiveConversations(user.id, tenant), store.listActiveProjects(user.id, tenant), store.readActiveEntity(user.id, "manifest", "root", tenant),
      ]);
      if (!manifest || manifest.deleted || directory.epoch !== projects.epoch) throw new AiError(500, "AI_WORKSPACE_CORRUPT", "工作台索引不完整");
      return respond({ schemaVersion: 2, epoch: directory.epoch, manifestRevision: manifest.revision, manifest: manifest.value, conversations: directory.conversations, projects: projects.projects });
    }

    // All non-bootstrap paths are active-only. A stale V1 client must not use
    // these operations before explicit, reviewed migration.
    if (store.workspaceVersion(user.id, tenant) !== 2) throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "分实体工作台尚未启用");
    const messages = new RegExp(`^${PREFIX}/conversations/([^/]+)/messages$`).exec(path);
    if (messages && request.method === "GET") {
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 30;
      const before = url.searchParams.get("before");
      if ([...url.searchParams.keys()].some(key => key !== "limit" && key !== "before")) invalid("消息分页参数无效");
      return respond(await store.pageActiveMessages(user.id, routeId(messages[1]), { limit, before }, tenant));
    }
    const context = new RegExp(`^${PREFIX}/conversations/([^/]+)/context$`).exec(path);
    if (context && request.method === "GET") {
      const conversationId = routeId(context[1]);
      const directory = store.listActiveConversations(user.id, tenant).conversations.find(item => item.entityId === conversationId);
      if (!directory) throw new AiError(404, "AI_CONVERSATION_NOT_FOUND", "没有找到这段对话");
      const refs = [{ kind: "draft" as const, entityId: conversationId }, { kind: "draftAttachment" as const, entityId: conversationId },
        ...(directory.projectId ? [{ kind: "project" as const, entityId: directory.projectId }] : [])];
      const batch = await store.readActiveEntities(user.id, refs, tenant);
      if (directory.projectId && (!batch.entities[2] || batch.entities[2].deleted)) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话所属项目已变化，请刷新");
      return respond({ epoch: batch.epoch, conversation: directory, draft: batch.entities[0], draftAttachment: batch.entities[1], project: batch.entities[2] ?? null });
    }
    const artifactMatch = new RegExp(`^${PREFIX}/artifacts/([^/]+)$`).exec(path);
    if (artifactMatch && request.method === "GET") {
      const artifactId = routeId(artifactMatch[1]);
      const conversationId = routeId(url.searchParams.get("conversationId") ?? "");
      const batch = await store.readActiveEntities(user.id, [{ kind: "conversation", entityId: conversationId }, { kind: "artifact", entityId: artifactId }], tenant);
      const [conversationEntity, artifactEntity] = batch.entities;
      if (!conversationEntity || conversationEntity.deleted || !artifactEntity || artifactEntity.deleted) throw new AiError(404, "AI_ARTIFACT_NOT_FOUND", "没有找到这项成果");
      const conversation = validateAiWorkspaceConversationEntity(conversationEntity.value) as AiWorkspaceConversation;
      const artifact = validateAiWorkspaceArtifactEntity(artifactEntity.value) as AiWorkspaceArtifact;
      if (artifact.conversationId !== conversationId || artifact.projectId !== conversation.projectId ||
        !conversation.messages.some(message => message.role === "assistant" && message.artifactId === artifactId)) {
        throw new AiError(404, "AI_ARTIFACT_NOT_FOUND", "没有找到这项成果");
      }
      return respond({ epoch: batch.epoch, artifact });
    }

    if (path === `${PREFIX}/mutate` && request.method === "POST") {
      const body = object(await readBody(request), ["epoch", "mutationId", "ops"]);
      if (!Array.isArray(body.ops) || body.ops.some(op => !op || typeof op !== "object" || Array.isArray(op) ||
        !["conversation", "draft", "draftAttachment", "manifest"].includes((op as { kind?: string }).kind ?? ""))) invalid("此类工作台实体尚未开放成员写入");
      return respond(await store.mutateActive(user.id, body, tenant));
    }
    if (path === `${PREFIX}/rename-conversation` && request.method === "POST") {
      const body = object(await readBody(request), ["epoch", "mutationId", "conversationId", "expectedRevision", "title"]);
      return respond(await store.renameActiveConversation(user.id, body as unknown as {
        epoch: number; mutationId: string; conversationId: string; expectedRevision: number; title: string;
      }, tenant));
    }
    if (path === `${PREFIX}/append-user` && request.method === "POST") {
      const body = object(await readBody(request), ["epoch", "mutationId", "conversationId", "expectedRevision", "message"]);
      const message = object(body.message, ["id", "role", "content", "time", "requestId", "attachments"]);
      if (message.role !== "user" || typeof message.id !== "string" || !ID.test(message.id) ||
        typeof message.content !== "string" || typeof message.time !== "string" ||
        (message.requestId !== undefined && (typeof message.requestId !== "string" || !UUID.test(message.requestId)))) invalid("用户消息格式无效");
      return respond(await store.appendActiveMessages(user.id, { epoch: body.epoch, mutationId: body.mutationId,
        conversationId: body.conversationId, expectedRevision: body.expectedRevision, messages: [message as unknown as AiWorkspaceMessage] }, tenant));
    }
    if (path === `${PREFIX}/commit-assistant` && request.method === "POST") {
      const body = object(await readBody(request), ["epoch", "mutationId", "conversationId", "expectedRevision", "requestId", "messageId"]);
      if (typeof body.requestId !== "string" || !UUID.test(body.requestId) ||
        typeof body.messageId !== "string" || !ID.test(body.messageId) ||
        typeof body.conversationId !== "string" || !ID.test(body.conversationId)) invalid("回复保存参数无效");
      const recorded = new AiStore(store.sql, tenant).request(user.id, body.requestId);
      if (!recorded || recorded.kind !== "chat" || recorded.conversationId !== body.conversationId) throw new AiError(404, "AI_REQUEST_NOT_FOUND", "没有找到这段对话的 AI 请求");
      if (recorded.status !== "completed" || !recorded.result || recorded.result.requestId !== body.requestId) throw new AiError(409, "AI_REQUEST_NOT_COMPLETE", "AI 回复尚未完成，暂不能保存");
      const parent = await store.readActiveEntity(user.id, "conversation", body.conversationId, tenant);
      if (!parent || parent.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话已变化，请重新读取后保存回复");
      const prior = validateAiWorkspaceConversationEntity(parent.value) as AiWorkspaceConversation;
      if (!prior.messages.some(message => message.role === "user" && message.requestId === body.requestId)) {
        throw new AiError(409, "AI_WORKSPACE_CONFLICT", "AI 回复缺少当前对话中已保存的提问");
      }
      if (parent.revision !== body.expectedRevision && !prior.messages.some(message => message.role === "assistant" && message.requestId === body.requestId)) {
        throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话已变化，请重新读取后保存回复");
      }
      const reply = recorded.result;
      const message: AiWorkspaceMessage = { id: body.messageId, role: "assistant", content: reply.content,
        time: recorded.createdAt.slice(11, 16), requestId: body.requestId, status: "ready",
        taskPhase: reply.completion ? "partial" : "completed", model: reply.model, usage: reply.usage,
        ...(reply.analysisSummary ? { analysisSummary: reply.analysisSummary } : {}),
        ...(reply.completion ? { completion: reply.completion } : {}),
        ...(reply.sources ? { sources: reply.sources } : {}),
        ...(reply.trace ? { trace: reply.trace } : {}) };
      return respond(await store.appendActiveMessages(user.id, { epoch: body.epoch, mutationId: body.mutationId,
        conversationId: body.conversationId, expectedRevision: body.expectedRevision, messages: [message] }, tenant));
    }
    return respond({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口或方法不可用" } }, 405);
  } catch (error) {
    if (error instanceof AiError) return respond({ error: { code: error.code, message: error.message } }, error.status);
    return respond({ error: { code: "AI_WORKSPACE_ERROR", message: "工作台服务暂不可用，请稍后重试" } }, 500);
  }
}
