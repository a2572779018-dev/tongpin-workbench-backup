import { AI_WORKSPACE_LIMITS as LIMITS, type AiWorkspaceSaveRequest, type AiWorkspaceSnapshot, type AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiError } from "./security";
import type { AiSql } from "./storage";

export const AI_WORKSPACE_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_workspaces (
  user_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  schema_version INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_workspace_mutations (
  user_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(user_id, mutation_id)
);
CREATE TABLE IF NOT EXISTS ai_workspace_chunks (
  user_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(user_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS ai_workspace_mutations_revision ON ai_workspace_mutations(user_id, revision DESC);
`;

const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CHUNK_MARKER = "@chunks-v1";
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
type ObjectValue = Record<string, unknown>;

function invalid(message: string): never { throw new AiError(400, "AI_WORKSPACE_INVALID", message); }
function tooLarge(message: string): never { throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", message); }
function record(value: unknown, label: string, keys?: readonly string[]): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label}格式不正确`);
  const result = value as ObjectValue;
  for (const key of Object.keys(result)) {
    if (forbiddenKeys.has(key) || (keys && !keys.includes(key))) invalid(`${label}包含不支持的字段，请更新客户端后重试`);
  }
  return result;
}
function string(value: unknown, label: string, max: number, nonempty = false): asserts value is string {
  if (typeof value !== "string" || (nonempty && !value.trim()) || value.includes("\u0000")) invalid(`${label}格式不正确`);
  if (value.length > max) tooLarge(`${label}过长，原记录未被更改`);
}
function id(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !ID.test(value) || forbiddenKeys.has(value)) invalid(`${label}标识无效`);
}
function optionalId(value: unknown, label: string): void { if (value !== undefined) id(value, label); }
function array(value: unknown, label: string, max: number): unknown[] {
  if (!Array.isArray(value)) invalid(`${label}格式不正确`);
  if (value.length > max) tooLarge(`${label}数量超过上限，原记录未被更改`);
  return value;
}
function unique(value: string, set: Set<string>, label: string): void {
  if (set.has(value)) invalid(`${label}标识重复`);
  set.add(value);
}
function jsonValue(value: unknown, depth = 0): void {
  if (depth > 12) invalid("结构化内容嵌套过深");
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(item => jsonValue(item, depth + 1)); return; }
  if (typeof value === "object" && value) {
    const item = record(value, "结构化内容");
    for (const child of Object.values(item)) jsonValue(child, depth + 1);
    return;
  }
  invalid("工作台只能保存有效 JSON 内容");
}
function documents(value: unknown, label: string): void {
  if (value === undefined) return;
  const ids = new Set<string>();
  for (const raw of array(value, label, LIMITS.documentsPerContainer)) {
    const doc = record(raw, label, ["id", "name", "mimeType", "content", "createdAt"]);
    id(doc.id, label); unique(doc.id, ids, label);
    string(doc.name, "文件名称", 240, true);
    string(doc.mimeType, "文件类型", 160, true);
    string(doc.content, "文件内容", LIMITS.documentCharacters);
    if (doc.createdAt !== undefined) string(doc.createdAt, "文件时间", 80);
  }
}
function usage(value: unknown): void {
  if (value === undefined) return;
  const item = record(value, "消息用量", ["inputTokens", "outputTokens", "totalTokens", "estimated", "convertedTokens", "billingKind"]);
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (!Number.isSafeInteger(item[key]) || Number(item[key]) < 0) invalid("消息用量格式不正确");
  }
  if (item.convertedTokens !== undefined && (!Number.isSafeInteger(item.convertedTokens) || Number(item.convertedTokens) < 0)) invalid("消息折算用量格式不正确");
  if (item.billingKind !== undefined && !["tokens", "image_conversion", "tokens_with_search"].includes(String(item.billingKind))) invalid("消息计量类型格式不正确");
  if (Number(item.inputTokens) + Number(item.outputTokens) + Number(item.convertedTokens ?? 0) !== item.totalTokens || typeof item.estimated !== "boolean") invalid("消息用量格式不正确");
  // Display metadata only: quota accounting must exclusively use the server AI ledger.
}

/** Validate the entire snapshot before any write. Unknown fields fail explicitly, never disappear. */
export function validateAiWorkspaceState(value: unknown): AiWorkspaceState {
  const state = record(value, "工作台", ["view", "mode", "conversations", "projects", "artifacts", "drafts", "draftAttachments", "composerTool", "webSearch", "activeConversationId", "activeProjectId", "enabledSkillIds", "sidebarCollapsed"]);
  if (!["chat", "project", "skills"].includes(String(state.view)) || !["quick", "deep"].includes(String(state.mode))) invalid("工作台页面或模式无效");
  if (state.sidebarCollapsed !== undefined && typeof state.sidebarCollapsed !== "boolean") invalid("侧栏状态无效");
  if (state.composerTool !== undefined && !["text", "presentation", "image"].includes(String(state.composerTool))) invalid("生成模式无效");
  if (state.webSearch !== undefined && typeof state.webSearch !== "boolean") invalid("联网搜索状态无效");
  const projectIds = new Set<string>();
  for (const raw of array(state.projects, "项目", LIMITS.projects)) {
    const project = record(raw, "项目", ["id", "title", "timeLabel", "instructions", "contextDocuments"]);
    id(project.id, "项目"); unique(project.id, projectIds, "项目");
    string(project.title, "项目名称", LIMITS.titleCharacters, true);
    string(project.timeLabel, "项目时间", 80);
    if (project.instructions !== undefined) string(project.instructions, "项目说明", LIMITS.instructionsCharacters);
    documents(project.contextDocuments, "项目资料");
  }
  const conversationIds = new Set<string>();
  const messageIds = new Set<string>();
  const conversationProjects = new Map<string, string | undefined>();
  const messageArtifactRefs: Array<{ conversationId: string; artifactId: string }> = [];
  let totalMessages = 0;
  for (const raw of array(state.conversations, "对话", LIMITS.conversations)) {
    const conversation = record(raw, "对话", ["id", "title", "timeLabel", "projectId", "messages"]);
    id(conversation.id, "对话"); unique(conversation.id, conversationIds, "对话");
    string(conversation.title, "对话名称", LIMITS.titleCharacters, true);
    string(conversation.timeLabel, "对话时间", 80);
    optionalId(conversation.projectId, "所属项目");
    if (conversation.projectId !== undefined && !projectIds.has(conversation.projectId as string)) invalid("对话所属项目不存在，请同步最新记录");
    conversationProjects.set(conversation.id, conversation.projectId as string | undefined);
    const messages = array(conversation.messages, "对话消息", LIMITS.messagesPerConversation);
    totalMessages += messages.length;
    if (totalMessages > LIMITS.totalMessages) tooLarge("消息总数超过上限，原记录未被更改");
    for (const entry of messages) {
      const message = record(entry, "消息", ["id", "role", "content", "time", "status", "artifactId", "requestId", "model", "usage", "attachments", "sources"]);
      id(message.id, "消息"); unique(message.id, messageIds, "消息");
      if (message.role !== "user" && message.role !== "assistant") invalid("消息角色无效");
      string(message.content, "消息内容", LIMITS.messageCharacters);
      string(message.time, "消息时间", 80);
      if (message.status !== undefined && !["thinking", "typing", "ready", "error", "stopped"].includes(String(message.status))) invalid("消息状态无效");
      optionalId(message.artifactId, "成果"); optionalId(message.requestId, "请求");
      if (message.model !== undefined) string(message.model, "模型名称", 160);
      usage(message.usage); documents(message.attachments, "消息附件");
      if (message.sources !== undefined) {
        for (const rawSource of array(message.sources, "引用来源", 100)) {
          const source = record(rawSource, "引用来源", ["title", "url"]);
          string(source.title, "来源标题", 1000);
          string(source.url, "来源链接", 4096, true);
          let url: URL;
          try { url = new URL(source.url); } catch { invalid("来源链接格式不正确"); }
          if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) invalid("来源链接必须为不带账号密码的 HTTP(S) 地址");
        }
      }
      if (typeof message.artifactId === "string") messageArtifactRefs.push({ conversationId: conversation.id, artifactId: message.artifactId });
    }
  }
  const artifactIds = new Set<string>();
  const artifactConversations = new Map<string, string>();
  for (const raw of array(state.artifacts, "成果", LIMITS.artifacts)) {
    const artifact = record(raw, "成果", ["id", "conversationId", "projectId", "title", "kind", "updatedLabel", "summary", "sections", "data"]);
    id(artifact.id, "成果"); unique(artifact.id, artifactIds, "成果");
    id(artifact.conversationId, "成果所属对话"); optionalId(artifact.projectId, "成果所属项目");
    if (!conversationIds.has(artifact.conversationId)) invalid("成果所属对话不存在，请一并处理关联成果");
    if (artifact.projectId !== undefined && artifact.projectId !== conversationProjects.get(artifact.conversationId)) invalid("成果与对话的所属项目不一致");
    artifactConversations.set(artifact.id, artifact.conversationId);
    string(artifact.title, "成果名称", LIMITS.titleCharacters, true);
    string(artifact.kind, "成果类型", 80, true);
    string(artifact.updatedLabel, "成果时间", 80);
    string(artifact.summary, "成果摘要", 24000);
    for (const rawSection of array(artifact.sections, "成果章节", 100)) {
      const section = record(rawSection, "成果章节", ["heading", "lines"]);
      string(section.heading, "章节标题", 500);
      for (const line of array(section.lines, "章节内容", 500)) string(line, "章节内容", 24000);
    }
    if (artifact.data !== undefined) jsonValue(record(artifact.data, "成果数据"));
  }
  for (const reference of messageArtifactRefs) {
    if (artifactConversations.get(reference.artifactId) !== reference.conversationId) invalid("消息关联成果不存在或不属于该对话");
  }
  if (state.activeConversationId !== null) {
    id(state.activeConversationId, "当前对话");
    if (!conversationIds.has(state.activeConversationId)) invalid("当前对话不存在");
  }
  if (state.activeProjectId !== null) {
    id(state.activeProjectId, "当前项目");
    if (!projectIds.has(state.activeProjectId)) invalid("当前项目不存在");
  }
  if (state.view === "project" && state.activeProjectId === null) invalid("请先选择项目");
  const drafts = record(state.drafts, "草稿");
  if (Object.keys(drafts).length > LIMITS.conversations + LIMITS.projects + 1) tooLarge("草稿数量超过上限");
  for (const [key, draft] of Object.entries(drafts)) {
    if (key !== "new-conversation" && !conversationIds.has(key) && !(key.startsWith("new-project-conversation:") && projectIds.has(key.slice("new-project-conversation:".length)))) invalid("草稿所属对话或项目不存在");
    string(draft, "草稿", LIMITS.draftCharacters);
  }
  if (state.draftAttachments !== undefined) {
    const attachments = record(state.draftAttachments, "草稿附件");
    if (Object.keys(attachments).length > LIMITS.conversations + LIMITS.projects + 1) tooLarge("草稿附件数量超过上限");
    for (const [key, value] of Object.entries(attachments)) {
      if (key !== "new-conversation" && !conversationIds.has(key) && !(key.startsWith("new-project-conversation:") && projectIds.has(key.slice("new-project-conversation:".length)))) invalid("草稿附件所属对话或项目不存在");
      documents(value, "草稿附件");
    }
  }
  const skillIds = new Set<string>();
  for (const skillId of array(state.enabledSkillIds, "已启用技能", 100)) {
    id(skillId, "技能"); unique(skillId, skillIds, "技能");
  }
  jsonValue(state);
  const serialized = JSON.stringify(state);
  if (new TextEncoder().encode(serialized).byteLength > LIMITS.stateBytes) tooLarge("工作台已超过 2 MiB 保存上限，请导出并整理历史记录后重试；原记录未被更改");
  // Isolate the validated request from caller mutations during the asynchronous hash.
  return JSON.parse(serialized) as AiWorkspaceState;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

/** Keep every SQLite row comfortably below the Durable Objects 2 MB row limit. */
function chunks(serialized: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + 64000, serialized.length);
    const code = serialized.charCodeAt(end - 1);
    if (end < serialized.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    result.push(serialized.slice(start, end));
    start = end;
  }
  return result;
}

export class AiWorkspaceRepository {
  constructor(readonly sql: AiSql) {}

  /** Invoke from the existing Node/DO schema initialization, not during request handling. */
  initialize(): void { this.sql.exec(AI_WORKSPACE_SCHEMA); }

  read(userId: string): AiWorkspaceSnapshot {
    id(userId, "账号");
    const row = this.sql.all<{ revision: number; schema_version: number; updated_at: string; data: string }>("SELECT revision,schema_version,updated_at,data FROM ai_workspaces WHERE user_id=?", userId)[0];
    if (!row) return { revision: 0, schemaVersion: 1, updatedAt: null, state: null };
    if (row.schema_version !== 1) throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "工作台记录版本已更新，请升级客户端");
    let serialized = row.data;
    if (serialized === CHUNK_MARKER) {
      const rows = this.sql.all<{ chunk_index: number; data: string }>("SELECT chunk_index,data FROM ai_workspace_chunks WHERE user_id=? ORDER BY chunk_index", userId);
      if (!rows.length || rows.some((chunk, index) => chunk.chunk_index !== index)) throw new AiError(500, "AI_WORKSPACE_CORRUPT", "工作台记录不完整，请保留当前窗口并联系管理员");
      serialized = rows.map(chunk => chunk.data).join("");
    }
    return { revision: row.revision, schemaVersion: 1, updatedAt: row.updated_at, state: JSON.parse(serialized) as AiWorkspaceState };
  }

  async save(userId: string, value: unknown): Promise<AiWorkspaceSnapshot> {
    id(userId, "账号");
    const body = record(value, "保存请求", ["expectedRevision", "mutationId", "state"]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 0 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid("工作台版本无效，请重新同步");
    if (typeof body.mutationId !== "string" || !UUID.test(body.mutationId)) invalid("保存请求标识无效");
    const request: AiWorkspaceSaveRequest = { expectedRevision: Number(body.expectedRevision), mutationId: body.mutationId, state: validateAiWorkspaceState(body.state) };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(request)));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    // Both adapters execute a synchronous transaction, with no external I/O or await inside.
    return this.sql.transaction(() => {
      const prior = this.sql.all<{ request_hash: string }>("SELECT request_hash FROM ai_workspace_mutations WHERE user_id=? AND mutation_id=?", userId, request.mutationId)[0];
      const current = this.read(userId);
      if (prior) {
        if (prior.request_hash !== hash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
        // A delayed retry must not overwrite newer changes from this or another client.
        return current;
      }
      if (current.revision !== request.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台已在其他窗口更新，本次未覆盖任何记录，请同步后重试");
      const revision = current.revision + 1;
      const updatedAt = new Date().toISOString();
      this.sql.exec("INSERT INTO ai_workspaces(user_id,revision,schema_version,updated_at,data) VALUES(?,?,1,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,schema_version=excluded.schema_version,updated_at=excluded.updated_at,data=excluded.data", userId, revision, updatedAt, CHUNK_MARKER);
      this.sql.exec("DELETE FROM ai_workspace_chunks WHERE user_id=?", userId);
      for (const [index, data] of chunks(JSON.stringify(request.state)).entries()) {
        this.sql.exec("INSERT INTO ai_workspace_chunks(user_id,chunk_index,data) VALUES(?,?,?)", userId, index, data);
      }
      this.sql.exec("INSERT INTO ai_workspace_mutations(user_id,mutation_id,request_hash,revision) VALUES(?,?,?,?)", userId, request.mutationId, hash, revision);
      // Compact receipts, not user records. Older requests still fail CAS and cannot replay writes.
      this.sql.exec("DELETE FROM ai_workspace_mutations WHERE user_id=? AND revision<=?", userId, Math.max(0, revision - 2048));
      return { revision, schemaVersion: 1, updatedAt, state: request.state };
    });
  }
}
