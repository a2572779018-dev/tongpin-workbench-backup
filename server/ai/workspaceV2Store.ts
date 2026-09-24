import { AiError } from "./security";
import { AI_WORKSPACE_LIMITS, type AiWorkspaceArtifact, type AiWorkspaceConversation, type AiWorkspaceMessage, type AiWorkspaceProject, type AiWorkspaceSnapshot, type AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiStore } from "./storage";
import type { AiSql } from "./storage";
import { normalizeAiTenantId, tenantStorageKey } from "./tenant";
import { AI_WORKSPACE_V2_ENTITY_BYTES, AiWorkspaceRepository, validateAiWorkspaceArtifactEntity, validateAiWorkspaceConversationEntity, validateAiWorkspaceDraft, validateAiWorkspaceDraftAttachments, validateAiWorkspaceProjectEntity, validateAiWorkspaceVideoDraftSetting } from "./workspace";
import { AiWorkspaceV2ShadowRepository, assembleV2Segments, canonical, split, type Segment } from "./workspaceV2Shadow";

/**
 * Internal V2 preparation plus deliberately narrow leaf, project,
 * conversation append/metadata and owner-stable artifact CAS proofs.
 * No HTTP route or automatic migration calls this repository. A future client
 * still needs the other entity writers, media references, legacy exclusion and
 * all background readers before an account can be activated. V1 remains
 * authoritative throughout preparation.
 */
export const AI_WORKSPACE_V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_workspace_v2_meta (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  epoch INTEGER NOT NULL,
  prepared_at TEXT NOT NULL,
  activated_at TEXT,
  image_index_version INTEGER NOT NULL DEFAULT 0,
  message_index_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,user_id)
);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_entities (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(tenant_id,user_id,kind,entity_id)
);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_entity_chunks (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,kind,entity_id,chunk_index)
);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_mutations (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,mutation_id)
);
-- Message append receipts stay for the lifetime of this V2 epoch. Pruning a
-- receipt would turn a delayed retry into a second write or a false conflict.
CREATE TABLE IF NOT EXISTS ai_workspace_v2_message_appends (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,mutation_id)
);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_image_artifacts (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,conversation_id,asset_id,artifact_id)
);
CREATE INDEX IF NOT EXISTS ai_workspace_v2_image_artifacts_by_artifact ON ai_workspace_v2_image_artifacts(tenant_id,user_id,artifact_id);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_message_owners (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,message_id)
);
CREATE INDEX IF NOT EXISTS ai_workspace_v2_message_owners_by_conversation ON ai_workspace_v2_message_owners(tenant_id,user_id,conversation_id);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_conversation_directory (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  time_label TEXT NOT NULL,
  project_id TEXT,
  ordinal INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,user_id,conversation_id)
);
CREATE INDEX IF NOT EXISTS ai_workspace_v2_conversation_directory_order ON ai_workspace_v2_conversation_directory(tenant_id,user_id,ordinal);
CREATE TABLE IF NOT EXISTS ai_workspace_v2_project_directory (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  time_label TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(tenant_id,user_id,project_id)
);
`;

const ENTITY_KINDS = new Set<Segment["kind"]>(["manifest", "project", "conversation", "artifact", "draft", "draftAttachment", "videoDraftSettings"]);
const BINARY_CHUNK_BYTES = 48 * 1024; // Base64 data is at most 64 KiB per SQLite row.
interface MetaRow { source_revision: number; source_hash: string; epoch: number; prepared_at: string; activated_at: string | null; image_index_version: number; message_index_version: number }
interface EntityRow { revision: number; ordinal: number; byte_length: number; sha256: string; chunk_count: number; deleted: number }
interface ChunkRow { chunk_index: number; data: string }
interface ActiveSnapshotEntry extends AiWorkspaceV2EntityRef { entity: EntityRow | undefined; rows: ChunkRow[] }
interface ActiveSnapshot { epoch: number; entries: ActiveSnapshotEntry[] }
interface MigrationSnapshot {
  meta: MetaRow;
  active: ActiveSnapshot;
  entityRows: Array<{ kind: Segment["kind"]; entity_id: string; revision: number; ordinal: number; deleted: number; chunk_count: number }>;
  chunkCount: number;
  messageOwners: Array<{ message_id: string; conversation_id: string }>;
  imageArtifacts: Array<{ conversation_id: string; asset_id: string; artifact_id: string }>;
  conversationDirectory: Array<{ conversation_id: string; title: string; time_label: string; project_id: string | null; ordinal: number; revision: number }>;
  projectDirectory: Array<{ project_id: string; title: string; time_label: string; ordinal: number; revision: number }>;
}
interface PreparedEntity { segment: Segment; bytes: Uint8Array; sha256: string; chunks: string[] }
export interface AiWorkspaceV2PreparedSnapshot { sourceRevision: number; sourceHash: string; epoch: number; preparedAt: string; entityCount: number }
export interface AiWorkspaceV2PreparedEntity { kind: Segment["kind"]; entityId: string; revision: number; ordinal: number; value: unknown }
export interface AiWorkspaceV2ActiveEntity extends AiWorkspaceV2PreparedEntity { deleted: boolean }
export interface AiWorkspaceV2EntityRef { kind: Segment["kind"]; entityId: string }
export interface AiWorkspaceV2ActiveBatch { epoch: number; entities: Array<AiWorkspaceV2ActiveEntity | null> }
export interface AiWorkspaceV2MutationAck { epoch: number; entities: Array<{ kind: "draft" | "draftAttachment" | "videoDraftSettings" | "artifact" | "project" | "conversation" | "manifest"; entityId: string; revision: number; deleted: boolean }> }
export interface AiWorkspaceV2AppendAck { epoch: number; entityId: string; revision: number; messageIds: string[] }
export interface AiWorkspaceV2ConversationDirectory { epoch: number; conversations: Array<{ entityId: string; title: string; timeLabel: string; projectId?: string; ordinal: number; revision: number }> }
export interface AiWorkspaceV2ProjectDirectory { epoch: number; projects: Array<{ entityId: string; title: string; timeLabel: string; ordinal: number; revision: number }> }
export interface AiWorkspaceV2MessagePage { epoch: number; revision: number; messages: AiWorkspaceMessage[]; hasMore: boolean; nextBefore: string | null }
type WritableKind = "draft" | "draftAttachment" | "videoDraftSettings" | "artifact" | "project" | "conversation" | "manifest";
interface ManifestValue { base: Record<string, unknown>; hasDraftAttachments: boolean; hasVideoDraftSettings: boolean }
interface PreparedMutationOp { kind: WritableKind; entityId: string; expectedRevision: number; action: "put" | "delete"; bytes?: Uint8Array; sha256?: string; chunks?: string[]; artifact?: AiWorkspaceArtifact; project?: AiWorkspaceProject; conversation?: AiWorkspaceConversation; manifest?: ManifestValue; manifestRevision?: number; imageAssets?: string[]; dependencies?: Array<{ kind: "conversation" | "project"; entityId: string; revision: number }> }
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DRAFT_BYTES = 96 * 1024;
const MAX_VIDEO_DRAFT_BYTES = 2 * 1024;
const MAX_MANIFEST_BYTES = 128 * 1024;
const MAX_MUTATION_BYTES = 16 * 1024 * 1024;
const MAX_MUTATION_RECEIPTS = 256;
const MAX_ACTIVE_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_ARTIFACT_INDEX_ROWS = 4096;
const MAX_IMAGE_ARTIFACT_SCAN_ROWS = 8192;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const lexical = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

function* indexedImageAssets(artifact: AiWorkspaceArtifact): Generator<string> {
  if ((artifact.kind !== "图片" && artifact.kind !== "image") || !Array.isArray(artifact.data?.images)) return;
  if (artifact.data.images.length > MAX_IMAGE_ARTIFACT_SCAN_ROWS) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "图片成果索引超出安全准备上限，原记录未被更改");
  const ids = new Set<string>();
  for (const image of artifact.data.images) {
    if (!image || typeof image !== "object" || Array.isArray(image)) continue;
    const value = image as Record<string, unknown>;
    if (typeof value.assetId === "string" && ASSET_ID.test(value.assetId) && !value.deleted && !ids.has(value.assetId)) {
      ids.add(value.assetId);
      yield value.assetId;
    }
  }
}

function corrupt(): never { throw new AiError(500, "AI_WORKSPACE_CORRUPT", "工作台分实体准备数据不完整，原记录未被更改"); }
function stale(): never { throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台已更新，请重新准备分实体数据"); }
function invalid(message: string): never { throw new AiError(400, "AI_WORKSPACE_INVALID", message); }
function unsupported(): never { throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "分实体工作台尚未启用，不能写入准备数据"); }
function manifestValue(value: unknown): ManifestValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("工作台索引内容无效");
  const manifest = value as Record<string, unknown>;
  if (Object.keys(manifest).length !== 3 || Object.keys(manifest).some(key => !["base", "hasDraftAttachments", "hasVideoDraftSettings"].includes(key)) ||
    !manifest.base || typeof manifest.base !== "object" || Array.isArray(manifest.base) ||
    typeof manifest.hasDraftAttachments !== "boolean" || typeof manifest.hasVideoDraftSettings !== "boolean") invalid("工作台索引内容无效");
  return manifest as unknown as ManifestValue;
}
function boundedManifestBase(value: Record<string, unknown>): string {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (pending.length) {
    const entry = pending.pop()!;
    if (entry.depth > 12) invalid("工作台索引内容嵌套过深");
    if (entry.value && typeof entry.value === "object") {
      for (const child of Object.values(entry.value)) pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return canonical(value);
}
async function hash(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  input.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input.buffer));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}
function encodeChunks(bytes: Uint8Array): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < bytes.length; start += BINARY_CHUNK_BYTES) {
    chunks.push(btoa(String.fromCharCode(...bytes.subarray(start, start + BINARY_CHUNK_BYTES))));
  }
  return chunks;
}
function decodeChunks(rows: ChunkRow[], expected: EntityRow): Uint8Array {
  if (!Number.isSafeInteger(expected.chunk_count) || expected.chunk_count < 1 || expected.chunk_count > 2048 ||
    !Number.isSafeInteger(expected.byte_length) || expected.byte_length < 1 || expected.byte_length > 64 * 1024 * 1024 ||
    rows.length !== expected.chunk_count) corrupt();
  const bytes = new Uint8Array(expected.byte_length);
  let offset = 0;
  for (const [index, row] of rows.entries()) {
    if (row.chunk_index !== index || !row.data || row.data.length > 65_536 || row.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(row.data)) corrupt();
    let decoded: string;
    try { decoded = atob(row.data); } catch { return corrupt(); }
    if (decoded.length < 1 || decoded.length > BINARY_CHUNK_BYTES || offset + decoded.length > bytes.length) corrupt();
    for (let byte = 0; byte < decoded.length; byte++) bytes[offset + byte] = decoded.charCodeAt(byte);
    offset += decoded.length;
  }
  if (offset !== bytes.length) corrupt();
  return bytes;
}

export class AiWorkspaceV2Store {
  private readonly shadow: AiWorkspaceV2ShadowRepository;
  constructor(readonly sql: AiSql, readonly workspace: AiWorkspaceRepository,
    private readonly migrationOptions: { allowLocalTestMigration?: boolean } = {}) {
    this.shadow = new AiWorkspaceV2ShadowRepository(sql, workspace);
  }
  initialize(): void {
    this.sql.exec(AI_WORKSPACE_V2_SCHEMA);
    // Existing prepared-only test tables predate tombstones; no account is
    // activated by this additive migration.
    if (!this.sql.all<{ name: string }>("PRAGMA table_info(ai_workspace_v2_entities)").some(column => column.name === "deleted")) {
      this.sql.exec("ALTER TABLE ai_workspace_v2_entities ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    }
    if (!this.sql.all<{ name: string }>("PRAGMA table_info(ai_workspace_v2_meta)").some(column => column.name === "image_index_version")) {
      this.sql.exec("ALTER TABLE ai_workspace_v2_meta ADD COLUMN image_index_version INTEGER NOT NULL DEFAULT 0");
    }
    if (!this.sql.all<{ name: string }>("PRAGMA table_info(ai_workspace_v2_meta)").some(column => column.name === "message_index_version")) {
      this.sql.exec("ALTER TABLE ai_workspace_v2_meta ADD COLUMN message_index_version INTEGER NOT NULL DEFAULT 0");
    }
  }

  private activeScope(userId: string, tenantId?: string): { tenant: string; storedUser: string; meta: MetaRow } {
    if (typeof userId !== "string" || !ID.test(userId)) invalid("工作台账号标识无效");
    const tenant = normalizeAiTenantId(tenantId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const storedUser = tenantStorageKey(tenant, userId);
    const meta = this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version,message_index_version FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    const current = this.sql.all<{ schema_version: number; revision: number }>("SELECT schema_version,revision FROM ai_workspaces WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    if (!meta?.activated_at || current?.schema_version !== 2) unsupported();
    if (current.revision !== meta.source_revision) stale();
    return { tenant, storedUser, meta };
  }

  /** Schema probe only. A V1 caller receives no workspace contents. */
  workspaceVersion(userId: string, tenantId?: string): 1 | 2 {
    if (!ID.test(userId)) invalid("工作台账号标识无效");
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const row = this.sql.all<{ schema_version: number }>("SELECT schema_version FROM ai_workspaces WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    if (!row || row.schema_version === 1) return 1;
    if (row.schema_version !== 2) unsupported();
    this.activeScope(userId, tenant);
    return 2;
  }

  /** Explicit internal preparation only. No route, background job or live-account activation invokes it. */
  async prepareFromShadow(userId: string, tenantId?: string): Promise<AiWorkspaceV2PreparedSnapshot | null> {
    const tenant = normalizeAiTenantId(tenantId);
    const storedUser = tenantStorageKey(tenant, userId);
    const source = await this.shadow.read(userId, tenant);
    if (!source) return null;
    if (source.stale || source.currentRevision !== source.sourceRevision) stale();
    const prepared: PreparedEntity[] = [];
    for (const segment of split(source.state)) {
      const bytes = new TextEncoder().encode(JSON.stringify(segment.value));
      prepared.push({ segment, bytes, sha256: await hash(bytes), chunks: encodeChunks(bytes) });
    }
    const imageIndex: Array<{ conversationId: string; artifactId: string; assetId: string }> = [];
    const imageOwners = new Map<string, string>();
    for (const artifact of source.state.artifacts) for (const assetId of indexedImageAssets(artifact)) {
      if (imageIndex.length >= MAX_IMAGE_ARTIFACT_INDEX_ROWS) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "图片成果索引超出安全准备上限，原记录未被更改");
      const identity = JSON.stringify([artifact.conversationId, assetId]);
      const priorOwner = imageOwners.get(identity);
      if (priorOwner && priorOwner !== artifact.id) throw new AiError(409, "AI_WORKSPACE_AMBIGUOUS_REFERENCE", "同一图片关联多个成果，暂不能准备分实体迁移");
      imageOwners.set(identity, artifact.id);
      imageIndex.push({ conversationId: artifact.conversationId, artifactId: artifact.id, assetId });
    }
    const messageOwners: Array<{ conversationId: string; messageId: string }> = [];
    const messageIds = new Set<string>();
    for (const conversation of source.state.conversations) for (const message of conversation.messages) {
      if (messageOwners.length >= AI_WORKSPACE_LIMITS.totalMessages) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "消息索引超出安全准备上限，原记录未被更改");
      if (messageIds.has(message.id)) throw new AiError(409, "AI_WORKSPACE_AMBIGUOUS_REFERENCE", "消息标识重复，暂不能准备分实体迁移");
      messageIds.add(message.id);
      messageOwners.push({ conversationId: conversation.id, messageId: message.id });
    }
    const original = canonical(source.state);
    const preparedAt = new Date().toISOString();
    return this.sql.transaction(() => {
      const current = this.workspace.read(userId, tenant);
      const shadowMeta = this.sql.all<{ source_revision: number; source_hash: string; staged_at: string }>(
        "SELECT source_revision,source_hash,staged_at FROM ai_workspace_v2_shadow_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser,
      )[0];
      if (!current.state || current.revision !== source.sourceRevision || canonical(current.state) !== original ||
        shadowMeta?.source_revision !== source.sourceRevision || shadowMeta.source_hash !== source.sourceHash || shadowMeta.staged_at !== source.stagedAt) stale();
      const prior = this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version,message_index_version FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
      if (prior && prior.activated_at !== null) throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "已启用分实体工作台，不能再覆盖准备记录");
      const epoch = (prior?.epoch ?? 0) + 1;
      this.sql.exec("DELETE FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_message_appends WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_conversation_directory WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_project_directory WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      for (const item of prepared) {
        const { kind, entityId, ordinal } = item.segment;
        this.sql.exec("INSERT INTO ai_workspace_v2_entities(tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count) VALUES(?,?,?,?,1,?,?,?,?)",
          tenant, storedUser, kind, entityId, ordinal, item.bytes.length, item.sha256, item.chunks.length);
        for (const [index, data] of item.chunks.entries()) {
          this.sql.exec("INSERT INTO ai_workspace_v2_entity_chunks(tenant_id,user_id,kind,entity_id,chunk_index,data) VALUES(?,?,?,?,?,?)",
            tenant, storedUser, kind, entityId, index, data);
        }
      }
      for (const entry of imageIndex) this.sql.exec(
        "INSERT INTO ai_workspace_v2_image_artifacts(tenant_id,user_id,conversation_id,asset_id,artifact_id) VALUES(?,?,?,?,?)",
        tenant, storedUser, entry.conversationId, entry.assetId, entry.artifactId,
      );
      for (const entry of messageOwners) this.sql.exec(
        "INSERT INTO ai_workspace_v2_message_owners(tenant_id,user_id,message_id,conversation_id) VALUES(?,?,?,?)",
        tenant, storedUser, entry.messageId, entry.conversationId,
      );
      for (const [ordinal, conversation] of source.state.conversations.entries()) this.sql.exec(
        "INSERT INTO ai_workspace_v2_conversation_directory(tenant_id,user_id,conversation_id,title,time_label,project_id,ordinal,revision) VALUES(?,?,?,?,?,?,?,1)",
        tenant, storedUser, conversation.id, conversation.title, conversation.timeLabel, conversation.projectId ?? null, ordinal,
      );
      for (const [ordinal, project] of source.state.projects.entries()) this.sql.exec(
        "INSERT INTO ai_workspace_v2_project_directory(tenant_id,user_id,project_id,title,time_label,ordinal,revision) VALUES(?,?,?,?,?,?,1)",
        tenant, storedUser, project.id, project.title, project.timeLabel, ordinal,
      );
      this.sql.exec("INSERT INTO ai_workspace_v2_meta(tenant_id,user_id,source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version,message_index_version) VALUES(?,?,?,?,?,?,NULL,1,1) ON CONFLICT(tenant_id,user_id) DO UPDATE SET source_revision=excluded.source_revision,source_hash=excluded.source_hash,epoch=excluded.epoch,prepared_at=excluded.prepared_at,activated_at=NULL,image_index_version=1,message_index_version=1",
        tenant, storedUser, source.sourceRevision, source.sourceHash, epoch, preparedAt);
      return { sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, epoch, preparedAt, entityCount: prepared.length };
    });
  }

  private assertLocalTestMigration(userId: string, tenantId?: string): string {
    const tenant = normalizeAiTenantId(tenantId);
    if (!this.migrationOptions.allowLocalTestMigration || tenant !== "local-test" || !/^local-v2-test-[a-zA-Z0-9_-]+$/.test(userId)) unsupported();
    new AiStore(this.sql, tenant).assertAccess(userId);
    return tenant;
  }

  private captureMigrationSnapshot(tenant: string, storedUser: string): MigrationSnapshot {
    const meta = this.sql.all<MetaRow>(
      "SELECT source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version,message_index_version FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?",
      tenant, storedUser,
    )[0];
    if (!meta) stale();
    const entityRows = this.sql.all<MigrationSnapshot["entityRows"][number]>(
      "SELECT kind,entity_id,revision,ordinal,deleted,chunk_count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? ORDER BY kind,entity_id",
      tenant, storedUser,
    );
    if (!entityRows.length || entityRows.length > 4096 || entityRows.some(row => !ENTITY_KINDS.has(row.kind) || !row.entity_id)) corrupt();
    const chunkCount = this.sql.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=?", tenant, storedUser,
    )[0]?.count ?? 0;
    return {
      meta, entityRows, chunkCount,
      active: { epoch: meta.epoch, entries: this.captureActiveEntries(tenant, storedUser, entityRows.map(row => ({ kind: row.kind, entityId: row.entity_id }))) },
      messageOwners: this.sql.all("SELECT message_id,conversation_id FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=? ORDER BY message_id", tenant, storedUser),
      imageArtifacts: this.sql.all("SELECT conversation_id,asset_id,artifact_id FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=? ORDER BY conversation_id,asset_id,artifact_id", tenant, storedUser),
      conversationDirectory: this.sql.all("SELECT conversation_id,title,time_label,project_id,ordinal,revision FROM ai_workspace_v2_conversation_directory WHERE tenant_id=? AND user_id=? ORDER BY ordinal,conversation_id", tenant, storedUser),
      projectDirectory: this.sql.all("SELECT project_id,title,time_label,ordinal,revision FROM ai_workspace_v2_project_directory WHERE tenant_id=? AND user_id=? ORDER BY ordinal,project_id", tenant, storedUser),
    };
  }

  private async verifyMigrationSnapshot(snapshot: MigrationSnapshot): Promise<AiWorkspaceState> {
    if (snapshot.meta.image_index_version !== 1 || snapshot.meta.message_index_version !== 1 ||
      snapshot.chunkCount !== snapshot.entityRows.reduce((sum, row) => sum + row.chunk_count, 0)) corrupt();
    const batch = await this.verifyActiveSnapshot(snapshot.active);
    const entities = batch.entities;
    if (entities.some(entity => !entity)) corrupt();
    const live = entities.filter((entity): entity is AiWorkspaceV2ActiveEntity => Boolean(entity && !entity.deleted));
    const state = assembleV2Segments(live.map(entity => ({ kind: entity.kind, entityId: entity.entityId, ordinal: entity.ordinal, value: entity.value })));
    const expectedMessages = state.conversations.flatMap(conversation => conversation.messages.map(message => ({ message_id: message.id, conversation_id: conversation.id })))
      .sort((a, b) => lexical(a.message_id, b.message_id));
    if (canonical(expectedMessages) !== canonical(snapshot.messageOwners)) corrupt();
    const expectedImages = state.artifacts.flatMap(artifact => [...indexedImageAssets(artifact)].map(assetId => ({ conversation_id: artifact.conversationId, asset_id: assetId, artifact_id: artifact.id })))
      .sort((a, b) => lexical(canonical(a), canonical(b)));
    if (canonical(expectedImages) !== canonical([...snapshot.imageArtifacts].sort((a, b) => lexical(canonical(a), canonical(b))))) corrupt();
    const expectedConversations = live.filter(entity => entity.kind === "conversation").map(entity => {
      const value = entity.value as AiWorkspaceConversation;
      return { conversation_id: entity.entityId, title: value.title, time_label: value.timeLabel,
        project_id: value.projectId ?? null, ordinal: entity.ordinal, revision: entity.revision };
    }).sort((a, b) => a.ordinal - b.ordinal || lexical(a.conversation_id, b.conversation_id));
    if (canonical(expectedConversations) !== canonical(snapshot.conversationDirectory)) corrupt();
    const expectedProjects = live.filter(entity => entity.kind === "project").map(entity => {
      const value = entity.value as AiWorkspaceProject;
      return { project_id: entity.entityId, title: value.title, time_label: value.timeLabel, ordinal: entity.ordinal, revision: entity.revision };
    }).sort((a, b) => a.ordinal - b.ordinal || lexical(a.project_id, b.project_id));
    if (canonical(expectedProjects) !== canonical(snapshot.projectDirectory)) corrupt();
    return state;
  }

  /** Local fixture only: no HTTP route, production constructor flag, or real
   * member ID can activate this cutover. The V1 version flip is atomic. */
  async activatePreparedForLocalTest(userId: string, expected: AiWorkspaceV2PreparedSnapshot, tenantId?: string): Promise<{ epoch: number; sourceRevision: number; activatedAt: string }> {
    const tenant = this.assertLocalTestMigration(userId, tenantId), storedUser = tenantStorageKey(tenant, userId);
    const captured = this.sql.transaction(() => ({ current: this.workspace.read(userId, tenant), migration: this.captureMigrationSnapshot(tenant, storedUser) }));
    const { current, migration } = captured;
    if (!current.state || current.revision !== expected.sourceRevision || migration.meta.activated_at !== null ||
      migration.meta.source_revision !== expected.sourceRevision || migration.meta.source_hash !== expected.sourceHash ||
      migration.meta.epoch !== expected.epoch || migration.meta.prepared_at !== expected.preparedAt ||
      migration.entityRows.length !== expected.entityCount) stale();
    const state = await this.verifyMigrationSnapshot(migration);
    if (await hash(new TextEncoder().encode(canonical(current.state))) !== expected.sourceHash || canonical(state) !== canonical(current.state)) stale();
    const fingerprint = canonical(migration);
    const source = canonical(current.state);
    const activatedAt = new Date().toISOString();
    return this.sql.transaction(() => {
      const latest = this.workspace.read(userId, tenant);
      if (!latest.state || latest.revision !== expected.sourceRevision || canonical(latest.state) !== source ||
        canonical(this.captureMigrationSnapshot(tenant, storedUser)) !== fingerprint) stale();
      this.sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=? WHERE tenant_id=? AND user_id=? AND activated_at IS NULL", activatedAt, tenant, storedUser);
      this.sql.exec("UPDATE ai_workspaces SET schema_version=2 WHERE tenant_id=? AND user_id=? AND schema_version=1 AND revision=?", tenant, storedUser, expected.sourceRevision);
      return { epoch: expected.epoch, sourceRevision: expected.sourceRevision, activatedAt };
    });
  }

  /** Rebuild the latest V2 state, then write a *new* V1 revision in one SQL
   * transaction. If the state exceeds V1 limits, V2 stays active and intact. */
  async rollbackActiveForLocalTest(userId: string, tenantId?: string): Promise<AiWorkspaceSnapshot> {
    const tenant = this.assertLocalTestMigration(userId, tenantId), storedUser = tenantStorageKey(tenant, userId);
    const captured = this.sql.transaction(() => {
      this.activeScope(userId, tenant);
      return this.captureMigrationSnapshot(tenant, storedUser);
    });
    const state = await this.verifyMigrationSnapshot(captured);
    const serialized = JSON.stringify(state); // assembleV2Segments enforces the V1 aggregate 8 MiB cap.
    const chunks: string[] = [];
    for (let start = 0; start < serialized.length;) {
      let end = Math.min(start + 64000, serialized.length);
      if (end < serialized.length && serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff) end--;
      chunks.push(serialized.slice(start, end));
      start = end;
    }
    const fingerprint = canonical(captured);
    const updatedAt = new Date().toISOString();
    return this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      if (meta.epoch !== captured.meta.epoch || canonical(this.captureMigrationSnapshot(tenant, storedUser)) !== fingerprint) stale();
      const revision = meta.source_revision + 1;
      this.sql.exec("UPDATE ai_workspaces SET revision=?,schema_version=1,updated_at=?,data='@chunks-v1' WHERE tenant_id=? AND user_id=? AND schema_version=2 AND revision=?",
        revision, updatedAt, tenant, storedUser, meta.source_revision);
      this.sql.exec("DELETE FROM ai_workspace_chunks WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      for (const [index, data] of chunks.entries()) this.sql.exec("INSERT INTO ai_workspace_chunks(user_id,tenant_id,chunk_index,data) VALUES(?,?,?,?)", storedUser, tenant, index, data);
      for (const table of ["ai_workspace_v2_entity_chunks", "ai_workspace_v2_entities", "ai_workspace_v2_mutations", "ai_workspace_v2_message_appends",
        "ai_workspace_v2_image_artifacts", "ai_workspace_v2_message_owners", "ai_workspace_v2_conversation_directory", "ai_workspace_v2_project_directory"] as const) {
        this.sql.exec(`DELETE FROM ${table} WHERE tenant_id=? AND user_id=?`, tenant, storedUser);
      }
      // Preserve the epoch counter. A later local re-prepare must not reuse an
      // epoch still cached by a pre-rollback V2 client.
      this.sql.exec("UPDATE ai_workspace_v2_meta SET activated_at=NULL WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      return { revision, schemaVersion: 1 as const, updatedAt, state };
    });
  }

  /** Read prepared data only while the matching V1 record remains authoritative. */
  async readPreparedEntity(userId: string, kind: Segment["kind"], entityId: string, tenantId?: string): Promise<AiWorkspaceV2PreparedEntity | null> {
    if (!ENTITY_KINDS.has(kind) || typeof entityId !== "string" || !entityId || entityId.length > 160) {
      throw new AiError(400, "AI_WORKSPACE_INVALID", "工作台实体标识无效");
    }
    const tenant = normalizeAiTenantId(tenantId);
    const storedUser = tenantStorageKey(tenant, userId);
    // Capture the source and prepared bytes at one SQLite linearization point.
    // Hashing below is async, but cannot combine V1 from one revision with V2
    // chunks from a later preparation.
    const snapshot = this.sql.transaction(() => ({
      current: this.workspace.read(userId, tenant),
      meta: this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at,image_index_version,message_index_version FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0],
      entity: this.sql.all<EntityRow>("SELECT revision,ordinal,byte_length,sha256,chunk_count,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?", tenant, storedUser, kind, entityId)[0],
      rows: this.sql.all<ChunkRow>("SELECT chunk_index,data FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=? ORDER BY chunk_index", tenant, storedUser, kind, entityId),
    }));
    const { current, meta, entity, rows } = snapshot;
    if (!meta) return null;
    if (meta.activated_at || !current.state || current.revision !== meta.source_revision ||
      await hash(new TextEncoder().encode(canonical(current.state))) !== meta.source_hash) stale();
    if (!entity) return null;
    if (entity.deleted !== 0) corrupt();
    const bytes = decodeChunks(rows, entity);
    if (await hash(bytes) !== entity.sha256) corrupt();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return corrupt(); }
    if (["project", "conversation", "artifact"].includes(kind) &&
      (!value || typeof value !== "object" || Array.isArray(value) || (value as { id?: unknown }).id !== entityId)) corrupt();
    return { kind, entityId, revision: entity.revision, ordinal: entity.ordinal, value };
  }

  private captureActiveEntries(tenant: string, storedUser: string, refs: AiWorkspaceV2EntityRef[]): ActiveSnapshotEntry[] {
    return refs.map(({ kind, entityId }) => ({
      kind, entityId,
      entity: this.sql.all<EntityRow>("SELECT revision,ordinal,byte_length,sha256,chunk_count,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?", tenant, storedUser, kind, entityId)[0],
      rows: this.sql.all<ChunkRow>("SELECT chunk_index,data FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=? ORDER BY chunk_index", tenant, storedUser, kind, entityId),
    }));
  }

  private async verifyActiveSnapshot(snapshot: ActiveSnapshot): Promise<AiWorkspaceV2ActiveBatch> {
    const entities: AiWorkspaceV2ActiveBatch["entities"] = [];
    let totalBytes = 0;
    for (const { kind, entityId, entity, rows } of snapshot.entries) {
      if (!entity) {
        if (rows.length) corrupt();
        entities.push(null);
        continue;
      }
      if (entity.deleted === 1) {
        if (entity.byte_length !== 0 || entity.chunk_count !== 0 || rows.length || entity.sha256 !== "") corrupt();
        entities.push({ kind, entityId, revision: entity.revision, ordinal: entity.ordinal, deleted: true, value: null });
        continue;
      }
      if (entity.deleted !== 0) corrupt();
      if (!Number.isSafeInteger(entity.byte_length) || entity.byte_length < 1 || totalBytes + entity.byte_length > MAX_ACTIVE_BATCH_BYTES) {
        throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "单次分实体读取超出安全上限，请缩小读取范围");
      }
      totalBytes += entity.byte_length;
      const bytes = decodeChunks(rows, entity);
      if (await hash(bytes) !== entity.sha256) corrupt();
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return corrupt(); }
      if (["project", "conversation", "artifact"].includes(kind) &&
        (!value || typeof value !== "object" || Array.isArray(value) || (value as { id?: unknown }).id !== entityId)) corrupt();
      entities.push({ kind, entityId, revision: entity.revision, ordinal: entity.ordinal, deleted: false, value });
    }
    return { epoch: snapshot.epoch, entities };
  }

  /** Read a bounded set from one SQL snapshot, then verify every entity. No
   * caller receives a partial batch when one referenced record is corrupt. */
  async readActiveEntities(userId: string, refs: AiWorkspaceV2EntityRef[], tenantId?: string): Promise<AiWorkspaceV2ActiveBatch> {
    if (!Array.isArray(refs) || !refs.length || refs.length > 32) invalid("工作台读取实体数量无效");
    const identities = new Set<string>();
    for (const ref of refs) {
      if (!ref || !ENTITY_KINDS.has(ref.kind) || typeof ref.entityId !== "string" || !ref.entityId || ref.entityId.length > 160) invalid("工作台实体标识无效");
      const identity = JSON.stringify([ref.kind, ref.entityId]);
      if (identities.has(identity)) invalid("同一实体不能在单次请求中重复读取");
      identities.add(identity);
    }
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    const snapshot = this.sql.transaction((): ActiveSnapshot => {
      const { meta } = this.activeScope(userId, tenant);
      return { epoch: meta.epoch, entries: this.captureActiveEntries(tenant, storedUser, refs) };
    });
    return this.verifyActiveSnapshot(snapshot);
  }

  /** Internal V2 read only. It intentionally cannot be reached through the V1
   * HTTP route, whose old clients must be rejected after any future cutover. */
  async readActiveEntity(userId: string, kind: Segment["kind"], entityId: string, tenantId?: string): Promise<AiWorkspaceV2ActiveEntity | null> {
    return (await this.readActiveEntities(userId, [{ kind, entityId }], tenantId)).entities[0];
  }

  /** Lightweight account-scoped conversation directory. It never reads or
   * returns message bodies; directory rows and entity revisions move together. */
  listActiveConversations(userId: string, tenantId?: string): AiWorkspaceV2ConversationDirectory {
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    return this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      const rows = this.sql.all<{ conversation_id: string; title: string; time_label: string; project_id: string | null; ordinal: number; revision: number; entity_revision: number | null; deleted: number | null }>(
        "SELECT d.conversation_id,d.title,d.time_label,d.project_id,d.ordinal,d.revision,e.revision AS entity_revision,e.deleted FROM ai_workspace_v2_conversation_directory d LEFT JOIN ai_workspace_v2_entities e ON e.tenant_id=d.tenant_id AND e.user_id=d.user_id AND e.kind='conversation' AND e.entity_id=d.conversation_id WHERE d.tenant_id=? AND d.user_id=? ORDER BY d.ordinal ASC",
        tenant, storedUser,
      );
      const entities = this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='conversation' AND deleted=0", tenant, storedUser)[0]?.count ?? 0;
      if (rows.length !== entities || rows.some(row => row.deleted !== 0 || row.entity_revision !== row.revision || !ID.test(row.conversation_id))) corrupt();
      return { epoch: meta.epoch, conversations: rows.map(row => ({ entityId: row.conversation_id, title: row.title, timeLabel: row.time_label,
        ...(row.project_id ? { projectId: row.project_id } : {}), ordinal: row.ordinal, revision: row.revision })) };
    });
  }

  listActiveProjects(userId: string, tenantId?: string): AiWorkspaceV2ProjectDirectory {
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    return this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      const rows = this.sql.all<{ project_id: string; title: string; time_label: string; ordinal: number; revision: number; entity_revision: number | null; deleted: number | null }>(
        "SELECT d.project_id,d.title,d.time_label,d.ordinal,d.revision,e.revision AS entity_revision,e.deleted FROM ai_workspace_v2_project_directory d LEFT JOIN ai_workspace_v2_entities e ON e.tenant_id=d.tenant_id AND e.user_id=d.user_id AND e.kind='project' AND e.entity_id=d.project_id WHERE d.tenant_id=? AND d.user_id=? ORDER BY d.ordinal ASC",
        tenant, storedUser,
      );
      const entities = this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='project' AND deleted=0", tenant, storedUser)[0]?.count ?? 0;
      if (rows.length !== entities || rows.some(row => row.deleted !== 0 || row.entity_revision !== row.revision || !ID.test(row.project_id))) corrupt();
      return { epoch: meta.epoch, projects: rows.map(row => ({ entityId: row.project_id, title: row.title, timeLabel: row.time_label,
        ordinal: row.ordinal, revision: row.revision })) };
    });
  }

  /** Stable backwards page of one validated conversation. A newly appended
   * tail does not shift the `before` message ID used for earlier pages. */
  async pageActiveMessages(userId: string, conversationId: string, options: { before?: string | null; limit?: number } = {}, tenantId?: string): Promise<AiWorkspaceV2MessagePage> {
    if (!ID.test(conversationId) || (options.before != null && !ID.test(options.before)) ||
      !Number.isSafeInteger(options.limit ?? 30) || (options.limit ?? 30) < 1 || (options.limit ?? 30) > 50) invalid("消息分页参数无效");
    const entity = await this.readActiveEntity(userId, "conversation", conversationId, tenantId);
    if (!entity || entity.deleted) throw new AiError(404, "AI_CONVERSATION_NOT_FOUND", "没有找到这段对话");
    const conversation = validateAiWorkspaceConversationEntity(entity.value);
    if (conversation.id !== conversationId) corrupt();
    const end = options.before == null ? conversation.messages.length : conversation.messages.findIndex(message => message.id === options.before);
    if (end < 0) invalid("消息分页游标不存在");
    const start = Math.max(0, end - (options.limit ?? 30));
    const messages = conversation.messages.slice(start, end);
    return { epoch: (await this.readActiveEntities(userId, [{ kind: "manifest", entityId: "root" }], tenantId)).epoch,
      revision: entity.revision, messages, hasMore: start > 0, nextBefore: start > 0 ? messages[0]?.id ?? null : null };
  }

  /** Rename without requiring a browser to download and resubmit every message.
   * The existing entity CAS and message-index checks remain authoritative. */
  async renameActiveConversation(userId: string, input: { epoch: number; mutationId: string; conversationId: string; expectedRevision: number; title: string }, tenantId?: string): Promise<AiWorkspaceV2MutationAck> {
    if (!ID.test(input.conversationId) || typeof input.title !== "string") invalid("对话标题无效");
    const current = await this.readActiveEntity(userId, "conversation", input.conversationId, tenantId);
    if (!current || current.deleted) throw new AiError(404, "AI_CONVERSATION_NOT_FOUND", "没有找到这段对话");
    if (current.revision !== input.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话已更新，请刷新后再重命名");
    const conversation = validateAiWorkspaceConversationEntity(current.value);
    return this.mutateActive(userId, { epoch: input.epoch, mutationId: input.mutationId, ops: [{
      kind: "conversation", entityId: input.conversationId, expectedRevision: input.expectedRevision,
      action: "put", value: { ...conversation, title: input.title },
    }] }, tenantId);
  }

  /** Index is only a candidate locator. Capture it with the conversation and
   * artifact in one SQL snapshot; caller must still validate their linkage and
   * current asset ownership before granting a reference. */
  async readActiveImageSourceEntities(userId: string, conversationId: string, assetId: string, tenantId?: string): Promise<{ artifactId: string; batch: AiWorkspaceV2ActiveBatch } | null> {
    if (!ID.test(conversationId) || !ASSET_ID.test(assetId)) invalid("图片成果标识无效");
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    const snapshot = this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      if (meta.image_index_version !== 1) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "图片成果索引尚未准备，请重新同步");
      const artifactIds = this.sql.all<{ artifact_id: string }>(
        "SELECT artifact_id FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=? AND conversation_id=? AND asset_id=? ORDER BY artifact_id LIMIT 2",
        tenant, storedUser, conversationId, assetId,
      ).map(row => row.artifact_id);
      if (artifactIds.length !== 1 || !ID.test(artifactIds[0])) return null;
      return {
        artifactId: artifactIds[0],
        batch: { epoch: meta.epoch, entries: this.captureActiveEntries(tenant, storedUser, [
          { kind: "conversation", entityId: conversationId }, { kind: "artifact", entityId: artifactIds[0] },
        ]) },
      };
    });
    return snapshot ? { artifactId: snapshot.artifactId, batch: await this.verifyActiveSnapshot(snapshot.batch) } : null;
  }

  /** Append only: a client cannot replace older messages or manufacture an
   * account-wide snapshot. Hashing and entity validation happen outside the
   * synchronous SQL transaction; the transaction rechecks every dependency. */
  async appendActiveMessages(userId: string, input: unknown, tenantId?: string): Promise<AiWorkspaceV2AppendAck> {
    this.activeScope(userId, tenantId);
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid("消息追加请求无效");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["epoch", "mutationId", "conversationId", "expectedRevision", "messages"].includes(key)) ||
      !Number.isSafeInteger(body.epoch) || Number(body.epoch) < 1 || typeof body.mutationId !== "string" || !UUID.test(body.mutationId) ||
      typeof body.conversationId !== "string" || !ID.test(body.conversationId) ||
      !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1 ||
      !Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 8) invalid("消息追加请求无效");
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    const conversationId = body.conversationId as string;
    let incoming: AiWorkspaceMessage[];
    try {
      const source = JSON.stringify(body.messages);
      if (!source || source.length > AI_WORKSPACE_V2_ENTITY_BYTES.conversation) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "追加消息超过单对话安全上限");
      incoming = validateAiWorkspaceConversationEntity({ id: conversationId, title: "追加消息", timeLabel: "", messages: JSON.parse(source) }).messages;
    } catch (error) {
      if (error instanceof AiError) throw error;
      return invalid("消息内容必须是有界的有效 JSON");
    }
    const requestHash = await hash(new TextEncoder().encode(canonical({ operation: "append-messages", epoch: body.epoch,
      conversationId, expectedRevision: body.expectedRevision, messages: incoming })));
    const readReplay = (): AiWorkspaceV2AppendAck | null => this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      if (meta.epoch !== body.epoch) stale();
      const prior = this.sql.all<{ request_hash: string; ack_json: string }>(
        "SELECT request_hash,ack_json FROM ai_workspace_v2_message_appends WHERE tenant_id=? AND user_id=? AND mutation_id=?",
        tenant, storedUser, body.mutationId as string,
      )[0];
      if (!prior) {
        if (this.sql.all<{ mutation_id: string }>("SELECT mutation_id FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? AND mutation_id=?",
          tenant, storedUser, body.mutationId as string)[0]) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于其他操作");
        return null;
      }
      if (prior.request_hash !== requestHash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
      try { return JSON.parse(prior.ack_json) as AiWorkspaceV2AppendAck; } catch { return corrupt(); }
    });
    const replay = readReplay();
    if (replay) return replay;
    try {
      const base = await this.readActiveEntity(userId, "conversation", conversationId, tenant);
      if (!base || base.deleted || base.revision !== body.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话版本已变化，请重新同步");
      const old = validateAiWorkspaceConversationEntity(base.value);
      if (old.id !== conversationId) corrupt();
      for (const message of incoming) {
        if (message.role === "assistant" && message.requestId && old.messages.some(prior => prior.role === "assistant" && prior.requestId === message.requestId)) {
          throw new AiError(409, "AI_WORKSPACE_CONFLICT", "这次 AI 回复已保存，请刷新对话");
        }
      }
      const conversation = validateAiWorkspaceConversationEntity({ ...old, messages: [...old.messages, ...incoming] });
      const appended = conversation.messages.slice(old.messages.length);
      const messageIds = appended.map(message => message.id);
      if (new Set(messageIds).size !== messageIds.length || old.messages.some(message => messageIds.includes(message.id))) invalid("追加消息标识重复");
      const refs: AiWorkspaceV2EntityRef[] = [];
      if (conversation.projectId) refs.push({ kind: "project", entityId: conversation.projectId });
      const artifactIds = [...new Set(appended.flatMap(message => message.artifactId ? [message.artifactId] : []))];
      for (const artifactId of artifactIds) refs.push({ kind: "artifact", entityId: artifactId });
      const related = refs.length ? (await this.readActiveEntities(userId, refs, tenant)).entities : [];
      const dependencies: Array<{ kind: "project" | "artifact"; entityId: string; revision: number; sha256: string; value?: AiWorkspaceArtifact }> = [];
      for (const [index, ref] of refs.entries()) {
        const entity = related[index];
        if (!entity || entity.deleted) invalid("消息关联项目或成果不存在");
        if (ref.kind === "project") {
          if (validateAiWorkspaceProjectEntity(entity.value).id !== ref.entityId) invalid("对话所属项目不存在");
          dependencies.push({ kind: "project", entityId: ref.entityId, revision: entity.revision,
            sha256: await hash(new TextEncoder().encode(JSON.stringify(entity.value))) });
        } else {
          const artifact = validateAiWorkspaceArtifactEntity(entity.value);
          if (artifact.id !== ref.entityId || artifact.conversationId !== conversationId || artifact.projectId !== conversation.projectId) invalid("消息关联成果不属于该对话");
          dependencies.push({ kind: "artifact", entityId: ref.entityId, revision: entity.revision,
            sha256: await hash(new TextEncoder().encode(JSON.stringify(entity.value))), value: artifact });
        }
      }
      const bytes = new TextEncoder().encode(JSON.stringify(conversation));
      const sha256 = await hash(bytes), chunks = encodeChunks(bytes);
      const priorSha = await hash(new TextEncoder().encode(JSON.stringify(base.value)));
      return this.sql.transaction(() => {
        const { meta } = this.activeScope(userId, tenant);
        if (meta.epoch !== body.epoch || meta.message_index_version !== 1) stale();
        const prior = this.sql.all<{ request_hash: string; ack_json: string }>(
          "SELECT request_hash,ack_json FROM ai_workspace_v2_message_appends WHERE tenant_id=? AND user_id=? AND mutation_id=?",
          tenant, storedUser, body.mutationId as string,
        )[0];
        if (prior) {
          if (prior.request_hash !== requestHash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
          try { return JSON.parse(prior.ack_json) as AiWorkspaceV2AppendAck; } catch { return corrupt(); }
        }
        if (this.sql.all<{ mutation_id: string }>("SELECT mutation_id FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? AND mutation_id=?",
          tenant, storedUser, body.mutationId as string)[0]) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于其他操作");
        const current = this.sql.all<EntityRow>("SELECT revision,ordinal,byte_length,sha256,chunk_count,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='conversation' AND entity_id=?",
          tenant, storedUser, conversationId)[0];
        if (!current || current.deleted || current.revision !== body.expectedRevision || current.sha256 !== priorSha) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话已更新，本次未覆盖任何消息");
        const indexedIds = this.sql.all<{ message_id: string }>(
          "SELECT message_id FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=? AND conversation_id=? ORDER BY message_id",
          tenant, storedUser, conversationId).map(row => row.message_id);
        if (canonical(indexedIds) !== canonical(old.messages.map(message => message.id).sort())) stale();
        const total = this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0].count;
        if (total + appended.length > AI_WORKSPACE_LIMITS.totalMessages) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "账号消息数量超过安全上限");
        for (const dependency of dependencies) {
          const row = this.sql.all<{ revision: number; sha256: string; deleted: number }>(
            "SELECT revision,sha256,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?",
            tenant, storedUser, dependency.kind, dependency.entityId)[0];
          if (!row || row.deleted || row.revision !== dependency.revision || row.sha256 !== dependency.sha256) stale();
          if (dependency.kind !== "artifact") continue;
          const artifact = dependency.value!;
          if (artifact.kind === "图片" || artifact.kind === "image") {
            const images = Array.isArray(artifact.data?.images) ? artifact.data.images : [];
            const assetIds: string[] = [];
            for (const image of images) {
              if (!image || typeof image !== "object" || Array.isArray(image) || image.deleted) continue;
              if (typeof image.assetId !== "string" || !ASSET_ID.test(image.assetId) ||
                !this.sql.all<{ asset_id: string }>("SELECT asset_id FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=? AND conversation_id=? AND asset_id=? AND artifact_id=?",
                  tenant, storedUser, conversationId, image.assetId, artifact.id)[0] ||
                !new AiStore(this.sql, tenant).assetMetadata(userId, image.assetId)) invalid("图片成果引用没有当前账号的真实资产");
              assetIds.push(image.assetId);
            }
            if (assetIds.length) {
              // The artifact JSON and assistant link are client-writable. A
              // matching server-owned completed request is the provenance.
              const directRequestId = artifact.id.startsWith("artifact-") ? artifact.id.slice("artifact-".length) : "";
              const request = directRequestId && UUID.test(directRequestId) ? this.sql.all<{ data: string }>(
                "SELECT data FROM ai_requests WHERE tenant_id=? AND user_id=? AND request_id=?",
                tenant, storedUser, directRequestId)[0] : undefined;
              const taskId = artifact.data?.mediaTaskRequestId;
              const hasTaskTable = this.sql.all<{ name: string }>(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_media_task_runs'",
              ).length === 1;
              const task = hasTaskTable && typeof taskId === "string" && ID.test(taskId) ? this.sql.all<{ data: string }>(
                "SELECT data FROM ai_media_task_runs WHERE tenant_id=? AND user_id=? AND request_id=? AND conversation_id=?",
                tenant, storedUser, taskId, conversationId)[0] : undefined;
              let directIds: string[] = [], taskIds: string[] = [];
              try {
                if (request) {
                  const value = JSON.parse(request.data) as { kind?: string; status?: string; conversationId?: string; imageResult?: { images?: Array<{ assetId?: string }> } };
                  if (value.kind === "image" && value.status === "completed" && value.conversationId === conversationId) directIds = value.imageResult?.images?.flatMap(image => typeof image.assetId === "string" ? [image.assetId] : []) ?? [];
                }
                if (task) {
                  const value = JSON.parse(task.data) as { status?: string; conversationId?: string; tool?: { capability?: string; artifactIds?: string[]; partialArtifactIds?: string[] } };
                  if (value.conversationId === conversationId && value.tool?.capability === "image") taskIds = value.status === "completed" ? value.tool?.artifactIds ?? [] : value.status === "partial" ? value.tool?.partialArtifactIds ?? [] : [];
                }
              } catch { corrupt(); }
              if (!assetIds.every(id => directIds.includes(id)) && !assetIds.every(id => taskIds.includes(id))) invalid("图片成果没有当前对话的已完成生成记录");
            }
          }
          const videoJobId = artifact.data?.videoJobId;
          if (typeof videoJobId === "string") {
            const job = this.sql.all<{ data: string }>("SELECT data FROM ai_video_jobs WHERE tenant_id=? AND user_id=? AND id=?", tenant, storedUser, videoJobId)[0];
            let video: { conversationId?: string; status?: string } | undefined;
            try { video = job ? JSON.parse(job.data) as { conversationId?: string; status?: string } : undefined; } catch { corrupt(); }
            if (!video || video.conversationId !== conversationId || (artifact.data?.videoStatus === "completed" || artifact.data?.mediaTaskStatus === "completed") && video.status !== "completed") invalid("视频成果引用没有当前对话的真实任务");
          }
          if (artifact.kind === "视频" && artifact.data?.mediaTaskStatus === "completed") {
            const taskId = artifact.data?.mediaTaskRequestId;
            const hasTaskTable = this.sql.all<{ name: string }>(
              "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_media_task_runs'",
            ).length === 1;
            const task = hasTaskTable && typeof taskId === "string" && ID.test(taskId) ? this.sql.all<{ data: string }>(
              "SELECT data FROM ai_media_task_runs WHERE tenant_id=? AND user_id=? AND request_id=? AND conversation_id=?",
              tenant, storedUser, taskId, conversationId)[0] : undefined;
            let value: { status?: string; conversationId?: string; tool?: { capability?: string; artifactIds?: string[] } } | undefined;
            try { value = task ? JSON.parse(task.data) as typeof value : undefined; } catch { corrupt(); }
            if (!value || value.status !== "completed" || value.conversationId !== conversationId || value.tool?.capability !== "video" ||
              typeof videoJobId !== "string" || !value.tool.artifactIds?.includes(videoJobId)) invalid("视频成果没有当前对话的已完成生成记录");
          }
        }
        for (const messageId of messageIds) {
          if (this.sql.all<{ message_id: string }>("SELECT message_id FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=? AND message_id=?", tenant, storedUser, messageId)[0]) {
            throw new AiError(409, "AI_WORKSPACE_CONFLICT", "消息标识已被当前账号使用");
          }
          this.sql.exec("INSERT INTO ai_workspace_v2_message_owners(tenant_id,user_id,message_id,conversation_id) VALUES(?,?,?,?)", tenant, storedUser, messageId, conversationId);
        }
        const revision = current.revision + 1;
        this.sql.exec("UPDATE ai_workspace_v2_entities SET revision=?,byte_length=?,sha256=?,chunk_count=? WHERE tenant_id=? AND user_id=? AND kind='conversation' AND entity_id=?",
          revision, bytes.length, sha256, chunks.length, tenant, storedUser, conversationId);
        this.sql.exec("UPDATE ai_workspace_v2_conversation_directory SET revision=? WHERE tenant_id=? AND user_id=? AND conversation_id=? AND revision=?",
          revision, tenant, storedUser, conversationId, current.revision);
        this.sql.exec("DELETE FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind='conversation' AND entity_id=?", tenant, storedUser, conversationId);
        for (const [index, data] of chunks.entries()) this.sql.exec("INSERT INTO ai_workspace_v2_entity_chunks(tenant_id,user_id,kind,entity_id,chunk_index,data) VALUES(?,?,'conversation',?,?,?)",
          tenant, storedUser, conversationId, index, data);
        const ack = { epoch: meta.epoch, entityId: conversationId, revision, messageIds };
        this.sql.exec("INSERT INTO ai_workspace_v2_message_appends(tenant_id,user_id,mutation_id,request_hash,ack_json) VALUES(?,?,?,?,?)",
          tenant, storedUser, body.mutationId as string, requestHash, JSON.stringify(ack));
        return ack;
      });
    } catch (error) {
      const replay = readReplay();
      if (replay) return replay;
      throw error;
    }
  }

  /** CAS is implemented for draft/settings/attachments, restricted project/artifact/conversation puts and
   * the manifest's attachment-presence flag. No HTTP
   * route, activation entry point or real-account migration yet. */
  async mutateActive(userId: string, input: unknown, tenantId?: string): Promise<AiWorkspaceV2MutationAck> {
    this.activeScope(userId, tenantId);
    if (!input || typeof input !== "object" || Array.isArray(input)) invalid("分实体保存请求无效");
    const body = input as Record<string, unknown>;
    if (Object.keys(body).some(key => !["epoch", "mutationId", "ops"].includes(key))) invalid("分实体保存请求包含不支持的字段");
    if (!Number.isSafeInteger(body.epoch) || Number(body.epoch) < 1 || typeof body.mutationId !== "string" || !UUID.test(body.mutationId)
      || !Array.isArray(body.ops) || !body.ops.length || body.ops.length > 8) invalid("分实体保存请求无效");
    const prepared: PreparedMutationOp[] = [];
    const identities = new Set<string>();
    const canonicalOps: Array<Record<string, unknown>> = [];
    let totalWriteBytes = 0;
    for (const raw of body.ops) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("分实体操作无效");
      const op = raw as Record<string, unknown>;
      if (Object.keys(op).some(key => !["kind", "entityId", "expectedRevision", "action", "value"].includes(key))) invalid("分实体操作包含不支持的字段");
      if (!ENTITY_KINDS.has(op.kind as Segment["kind"])) invalid("分实体类型无效");
      if (op.kind !== "draft" && op.kind !== "draftAttachment" && op.kind !== "videoDraftSettings" && op.kind !== "artifact" && op.kind !== "project" && op.kind !== "conversation" && op.kind !== "manifest") throw new AiError(409, "V2_OPERATION_NOT_READY", "此类工作台实体尚未开放逐条写入");
      if (typeof op.entityId !== "string" || op.entityId.length > 160 ||
        !(ID.test(op.entityId) || op.kind !== "artifact" && op.kind !== "project" && op.kind !== "conversation" && op.kind !== "manifest" && op.entityId.startsWith("new-project-conversation:") && ID.test(op.entityId.slice("new-project-conversation:".length)))) invalid("分实体标识无效");
      if (op.kind === "manifest" && op.entityId !== "root") invalid("工作台索引标识无效");
      if (!Number.isSafeInteger(op.expectedRevision) || Number(op.expectedRevision) < 0 || Number(op.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid("分实体版本无效");
      if (op.action !== "put" && op.action !== "delete") invalid("分实体操作类型无效");
      const identity = JSON.stringify([op.kind, op.entityId]);
      if (identities.has(identity)) invalid("同一实体不能在单次请求中重复写入");
      identities.add(identity);
      const normalized: PreparedMutationOp = { kind: op.kind, entityId: op.entityId, expectedRevision: Number(op.expectedRevision), action: op.action };
      const forHash: Record<string, unknown> = { kind: op.kind, entityId: op.entityId, expectedRevision: op.expectedRevision, action: op.action };
      if (op.action === "put") {
        const validated = op.kind === "draft" ? validateAiWorkspaceDraft(op.value) : op.kind === "draftAttachment" ? validateAiWorkspaceDraftAttachments(op.value) : op.kind === "videoDraftSettings" ? validateAiWorkspaceVideoDraftSetting(op.value) : op.kind === "artifact" ? validateAiWorkspaceArtifactEntity(op.value) : op.kind === "project" ? validateAiWorkspaceProjectEntity(op.value) : op.kind === "conversation" ? validateAiWorkspaceConversationEntity(op.value) : manifestValue(op.value);
        let value: unknown;
        try { value = JSON.parse(JSON.stringify(validated)) as unknown; } catch { invalid("分实体内容必须是有效 JSON"); }
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        if (bytes.length > (op.kind === "draft" ? MAX_DRAFT_BYTES : op.kind === "draftAttachment" ? AI_WORKSPACE_V2_ENTITY_BYTES.draftAttachment : op.kind === "videoDraftSettings" ? MAX_VIDEO_DRAFT_BYTES : op.kind === "artifact" ? AI_WORKSPACE_V2_ENTITY_BYTES.artifact : op.kind === "project" ? AI_WORKSPACE_V2_ENTITY_BYTES.project : op.kind === "conversation" ? AI_WORKSPACE_V2_ENTITY_BYTES.conversation : MAX_MANIFEST_BYTES)) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "分实体内容超出安全保存上限");
        totalWriteBytes += bytes.length;
        if (totalWriteBytes > MAX_MUTATION_BYTES) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "单次分实体保存内容超出安全上限");
        normalized.bytes = bytes;
        normalized.sha256 = await hash(bytes);
        normalized.chunks = encodeChunks(bytes);
        forHash.value = value;
        if (op.kind === "artifact") {
          const artifact = value as AiWorkspaceArtifact;
          if (artifact.id !== op.entityId) invalid("成果标识与保存目标不一致");
          normalized.artifact = artifact;
          normalized.imageAssets = Array.from(indexedImageAssets(artifact));
        } else if (op.kind === "project") {
          if ((value as AiWorkspaceProject).id !== op.entityId) invalid("项目标识与保存目标不一致");
          normalized.project = value as AiWorkspaceProject;
        } else if (op.kind === "conversation") {
          const conversation = value as AiWorkspaceConversation;
          if (conversation.id !== op.entityId) invalid("对话标识与保存目标不一致");
          normalized.conversation = conversation;
        } else if (op.kind === "manifest") {
          normalized.manifest = manifestValue(value);
          boundedManifestBase(normalized.manifest.base);
        }
      } else {
        if (op.kind === "artifact" || op.kind === "project" || op.kind === "conversation" || op.kind === "manifest") throw new AiError(409, "V2_OPERATION_NOT_READY", "工作台索引、项目、对话或成果删除尚未开放");
        if (op.value !== undefined) invalid("删除操作不能携带内容");
      }
      prepared.push(normalized);
      canonicalOps.push(forHash);
    }
    if (prepared.some(op => op.kind === "project") && prepared.some(op => op.kind !== "project")) {
      throw new AiError(409, "V2_OPERATION_NOT_READY", "项目与其他实体的组合保存尚未开放");
    }
    if (prepared.some(op => op.kind === "conversation") && prepared.length !== 1) {
      throw new AiError(409, "V2_OPERATION_NOT_READY", "对话与其他实体的组合保存尚未开放");
    }
    if (prepared.some(op => op.kind === "manifest") && prepared.length !== 1) {
      throw new AiError(409, "V2_OPERATION_NOT_READY", "工作台索引与其他实体的组合保存尚未开放");
    }
    const requestHash = await hash(new TextEncoder().encode(canonical({ epoch: body.epoch, ops: canonicalOps })));
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    const needsPreflight = prepared.some(op => op.kind === "artifact" || op.kind === "conversation" || op.kind === "manifest" || op.kind === "draftAttachment" || op.kind === "videoDraftSettings");
    const readReplay = (): AiWorkspaceV2MutationAck | null => this.sql.transaction(() => {
      // Replay is independent of today's parent/artifact shape. A later edit
      // must not turn an already committed mutation into a false rejection.
      const { meta } = this.activeScope(userId, tenant);
      if (meta.epoch !== body.epoch) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "分实体准备版本已变化，请重新同步");
      const prior = this.sql.all<{ request_hash: string; ack_json: string }>(
        "SELECT request_hash,ack_json FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? AND mutation_id=?",
        tenant, storedUser, body.mutationId as string,
      )[0];
      if (!prior) return null;
      if (prior.request_hash !== requestHash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
      try { return JSON.parse(prior.ack_json) as AiWorkspaceV2MutationAck; } catch { return corrupt(); }
    });
    if (needsPreflight) {
      const replay = readReplay();
      if (replay) return replay;
    }
    try {
      for (const op of prepared) {
        if (op.kind === "draftAttachment" || op.kind === "videoDraftSettings") {
          const current = await this.readActiveEntity(userId, "manifest", "root", tenant);
          if (!current || current.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台索引已变化，请重新同步");
          const manifest = manifestValue(current.value);
          if (op.kind === "draftAttachment" && !manifest.hasDraftAttachments) throw new AiError(409, "V2_OPERATION_NOT_READY", "请先开启草稿附件索引");
          if (op.kind === "videoDraftSettings" && !manifest.hasVideoDraftSettings) throw new AiError(409, "V2_OPERATION_NOT_READY", "当前账号尚未启用视频草稿参数");
          op.manifestRevision = current.revision;
          continue;
        }
        if (op.kind === "manifest") {
          const current = await this.readActiveEntity(userId, "manifest", "root", tenant);
          if (!current || current.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台索引已变化，请重新同步");
          if (current.revision !== op.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台索引版本已变化，请重新同步");
          const previous = manifestValue(current.value);
          if (previous.hasDraftAttachments || !op.manifest!.hasDraftAttachments ||
            previous.hasVideoDraftSettings !== op.manifest!.hasVideoDraftSettings ||
            boundedManifestBase(previous.base) !== boundedManifestBase(op.manifest!.base)) {
            throw new AiError(409, "V2_OPERATION_NOT_READY", "目前仅开放草稿附件存在标志的开启");
          }
          continue;
        }
        if (op.kind === "conversation") {
          const conversation = op.conversation!;
          const refs: AiWorkspaceV2EntityRef[] = [{ kind: "conversation", entityId: conversation.id }];
          if (conversation.projectId) refs.push({ kind: "project", entityId: conversation.projectId });
          const batch = await this.readActiveEntities(userId, refs, tenant);
          const previous = batch.entities[0];
          if (previous?.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "已删除的对话不能通过旧保存请求恢复");
          if (previous) {
            const old = validateAiWorkspaceConversationEntity(previous.value);
            // Messages and project links need a separate writer that maintains
            // global ownership, asset provenance and multi-entity state.
            if (old.projectId !== conversation.projectId || canonical(old.messages) !== canonical(conversation.messages)) {
              throw new AiError(409, "V2_OPERATION_NOT_READY", "目前仅开放对话标题与时间标签修改");
            }
          } else {
            if (conversation.id === "new-conversation") invalid("新对话占位标识不能用作真实对话");
            if (conversation.messages.length) throw new AiError(409, "V2_OPERATION_NOT_READY", "新对话消息写入尚未开放");
          }
          if (conversation.projectId) {
            const project = batch.entities[1];
            if (!project || project.deleted || validateAiWorkspaceProjectEntity(project.value).id !== conversation.projectId) invalid("对话所属项目不存在");
            op.dependencies = [{ kind: "project", entityId: conversation.projectId, revision: project.revision }];
          }
          continue;
        }
        if (op.kind !== "artifact") continue;
        const artifact = op.artifact!;
        const refs: AiWorkspaceV2EntityRef[] = [{ kind: "conversation", entityId: artifact.conversationId }];
        if (artifact.projectId) refs.push({ kind: "project", entityId: artifact.projectId });
        refs.push({ kind: "artifact", entityId: artifact.id });
        const batch = await this.readActiveEntities(userId, refs, tenantId);
        const conversationEntity = batch.entities[0];
        if (!conversationEntity || conversationEntity.deleted) invalid("成果所属对话不存在");
        const conversation = validateAiWorkspaceConversationEntity(conversationEntity.value);
        if (conversation.id !== artifact.conversationId || conversation.projectId !== artifact.projectId) invalid("成果与对话的所属项目不一致");
        const dependencies: NonNullable<PreparedMutationOp["dependencies"]> = [{ kind: "conversation", entityId: conversation.id, revision: conversationEntity.revision }];
        if (artifact.projectId) {
          const projectEntity = batch.entities[1];
          if (!projectEntity || projectEntity.deleted || validateAiWorkspaceProjectEntity(projectEntity.value).id !== artifact.projectId) invalid("成果所属项目不存在");
          dependencies.push({ kind: "project", entityId: artifact.projectId, revision: projectEntity.revision });
        }
        const previous = batch.entities.at(-1);
        if (previous?.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "已删除的成果不能通过旧保存请求恢复");
        const priorImageAssets = new Set<string>();
        if (previous) {
          const owner = validateAiWorkspaceArtifactEntity(previous.value);
          if (owner.conversationId !== artifact.conversationId || owner.projectId !== artifact.projectId) invalid("成果不能跨对话或项目搬迁");
          for (const assetId of indexedImageAssets(owner)) priorImageAssets.add(assetId);
        }
        // Workspace artifacts are client-writable. Without a server-owned
        // generation provenance record, newly claimed asset IDs could make
        // another conversation's image appear generated in this one.
        if (op.imageAssets!.some(assetId => !priorImageAssets.has(assetId))) {
          throw new AiError(409, "V2_OPERATION_NOT_READY", "新增图片成果关联需要服务端来源核验，暂未开放");
        }
        op.dependencies = dependencies;
      }
    } catch (error) {
      // A concurrent identical request may commit while this request is in
      // async hash verification. Recheck its receipt before rejecting stale
      // parents or a now-enabled manifest flag.
      if (needsPreflight) {
        const replay = readReplay();
        if (replay) return replay;
      }
      throw error;
    }
    return this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      if (meta.epoch !== body.epoch) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "分实体准备版本已变化，请重新同步");
      if (this.sql.all<{ mutation_id: string }>("SELECT mutation_id FROM ai_workspace_v2_message_appends WHERE tenant_id=? AND user_id=? AND mutation_id=?",
        tenant, storedUser, body.mutationId as string)[0]) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于其他操作");
      const prior = this.sql.all<{ request_hash: string; ack_json: string }>("SELECT request_hash,ack_json FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? AND mutation_id=?", tenant, storedUser, body.mutationId as string)[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
        try { return JSON.parse(prior.ack_json) as AiWorkspaceV2MutationAck; } catch { return corrupt(); }
      }
      const entities: AiWorkspaceV2MutationAck["entities"] = [];
      for (const op of prepared) {
        const target = op.entityId;
        if (op.kind !== "artifact" && op.kind !== "project" && op.kind !== "conversation" && op.kind !== "manifest") {
          const relatedKind = target.startsWith("new-project-conversation:") ? "project" : "conversation";
          const relatedId = relatedKind === "project" ? target.slice("new-project-conversation:".length) : target;
          if (target !== "new-conversation" && !this.sql.all<{ entity_id: string }>(
            "SELECT entity_id FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=? AND deleted=0",
            tenant, storedUser, relatedKind, relatedId,
          )[0]) invalid("草稿所属对话或项目不存在");
        }
        const current = this.sql.all<EntityRow>("SELECT revision,ordinal,byte_length,sha256,chunk_count,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?",
          tenant, storedUser, op.kind, target)[0];
        if ((current?.revision ?? 0) !== op.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "此条工作台记录已更新，本次未覆盖任何内容");
        if (op.kind === "draftAttachment" || op.kind === "videoDraftSettings") {
          const manifest = this.sql.all<{ revision: number; deleted: number }>(
            "SELECT revision,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='manifest' AND entity_id='root'",
            tenant, storedUser,
          )[0];
          if (!manifest || manifest.deleted || manifest.revision !== op.manifestRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "草稿索引已变化，请重新同步");
          if (op.action === "delete" && (!current || current.deleted)) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "草稿参数已删除，请重新同步");
          if (op.kind === "draftAttachment" && op.action === "put" && (!current || current.deleted) && this.sql.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='draftAttachment' AND deleted=0", tenant, storedUser,
          )[0].count >= AI_WORKSPACE_LIMITS.conversations + AI_WORKSPACE_LIMITS.projects + 1) {
            throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "草稿附件数量超过安全上限");
          }
        }
        if (op.kind === "project") {
          if (current?.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "已删除的项目不能通过旧保存请求恢复");
          if (!current && this.sql.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='project' AND deleted=0", tenant, storedUser,
          )[0].count >= AI_WORKSPACE_LIMITS.projects) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "项目数量超过安全上限");
        }
        if (op.kind === "conversation") {
          if (meta.message_index_version !== 1 || current?.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "消息归属索引或对话记录已变化，请重新同步");
          for (const dependency of op.dependencies ?? []) {
            const project = this.sql.all<{ revision: number; deleted: number }>(
              "SELECT revision,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='project' AND entity_id=?",
              tenant, storedUser, dependency.entityId,
            )[0];
            if (!project || project.deleted || project.revision !== dependency.revision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话所属项目已变化，请重新同步");
          }
          if (!current && this.sql.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='conversation' AND deleted=0", tenant, storedUser,
          )[0].count >= AI_WORKSPACE_LIMITS.conversations) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "对话数量超过安全上限");
          const indexedIds = this.sql.all<{ message_id: string }>(
            "SELECT message_id FROM ai_workspace_v2_message_owners WHERE tenant_id=? AND user_id=? AND conversation_id=? ORDER BY message_id",
            tenant, storedUser, target,
          ).map(row => row.message_id);
          const messageIds = op.conversation!.messages.map(message => message.id).sort();
          if (canonical(indexedIds) !== canonical(messageIds)) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "对话消息归属索引不一致，请重新同步");
        }
        if (op.kind === "artifact") {
          if (meta.image_index_version !== 1 || current?.deleted) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "图片成果索引或记录已变化，请重新同步");
          for (const dependency of op.dependencies ?? []) {
            const currentParent = this.sql.all<{ revision: number; deleted: number }>(
              "SELECT revision,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?",
              tenant, storedUser, dependency.kind, dependency.entityId,
            )[0];
            if (!currentParent || currentParent.deleted || currentParent.revision !== dependency.revision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "成果关联的对话或项目已变化，请重新同步");
          }
          if (!current && this.sql.all<{ count: number }>(
            "SELECT COUNT(*) AS count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='artifact' AND deleted=0", tenant, storedUser,
          )[0].count >= AI_WORKSPACE_LIMITS.artifacts) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "成果数量超过安全上限");
          this.sql.exec("DELETE FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=? AND artifact_id=?", tenant, storedUser, target);
          const images = op.imageAssets ?? [];
          const count = this.sql.all<{ count: number }>("SELECT COUNT(*) AS count FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0].count;
          if (count + images.length > MAX_IMAGE_ARTIFACT_INDEX_ROWS) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "图片成果索引超出安全上限");
          for (const assetId of images) {
            if (this.sql.all<{ artifact_id: string }>(
              "SELECT artifact_id FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=? AND conversation_id=? AND asset_id=? LIMIT 1",
              tenant, storedUser, op.artifact!.conversationId, assetId,
            )[0]) throw new AiError(409, "AI_WORKSPACE_AMBIGUOUS_REFERENCE", "同一图片不能关联当前对话的多个成果");
            this.sql.exec("INSERT INTO ai_workspace_v2_image_artifacts(tenant_id,user_id,conversation_id,asset_id,artifact_id) VALUES(?,?,?,?,?)",
              tenant, storedUser, op.artifact!.conversationId, assetId, target);
          }
        }
        const ordinal = current?.ordinal ?? (op.kind === "conversation"
          ? (this.sql.all<{ min_ordinal: number | null }>("SELECT MIN(ordinal) AS min_ordinal FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind='conversation'", tenant, storedUser)[0]?.min_ordinal ?? 0) - 1
          : (this.sql.all<{ max_ordinal: number | null }>("SELECT MAX(ordinal) AS max_ordinal FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=?", tenant, storedUser, op.kind)[0]?.max_ordinal ?? -1) + 1);
        const revision = op.expectedRevision + 1, deleted = op.action === "delete";
        this.sql.exec("INSERT INTO ai_workspace_v2_entities(tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count,deleted) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,kind,entity_id) DO UPDATE SET revision=excluded.revision,ordinal=excluded.ordinal,byte_length=excluded.byte_length,sha256=excluded.sha256,chunk_count=excluded.chunk_count,deleted=excluded.deleted",
          tenant, storedUser, op.kind, target, revision, ordinal, op.bytes?.length ?? 0, op.sha256 ?? "", op.chunks?.length ?? 0, deleted ? 1 : 0);
        if (op.kind === "conversation") {
          const conversation = op.conversation!;
          this.sql.exec("INSERT INTO ai_workspace_v2_conversation_directory(tenant_id,user_id,conversation_id,title,time_label,project_id,ordinal,revision) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,conversation_id) DO UPDATE SET title=excluded.title,time_label=excluded.time_label,project_id=excluded.project_id,ordinal=excluded.ordinal,revision=excluded.revision",
            tenant, storedUser, target, conversation.title, conversation.timeLabel, conversation.projectId ?? null, ordinal, revision);
        }
        if (op.kind === "project") {
          const project = op.project!;
          this.sql.exec("INSERT INTO ai_workspace_v2_project_directory(tenant_id,user_id,project_id,title,time_label,ordinal,revision) VALUES(?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,project_id) DO UPDATE SET title=excluded.title,time_label=excluded.time_label,ordinal=excluded.ordinal,revision=excluded.revision",
            tenant, storedUser, target, project.title, project.timeLabel, ordinal, revision);
        }
        this.sql.exec("DELETE FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?", tenant, storedUser, op.kind, target);
        for (const [index, data] of (op.chunks ?? []).entries()) this.sql.exec("INSERT INTO ai_workspace_v2_entity_chunks(tenant_id,user_id,kind,entity_id,chunk_index,data) VALUES(?,?,?,?,?,?)", tenant, storedUser, op.kind, target, index, data);
        entities.push({ kind: op.kind, entityId: target, revision, deleted });
      }
      const ack = { epoch: meta.epoch, entities };
      this.sql.exec("INSERT INTO ai_workspace_v2_mutations(tenant_id,user_id,mutation_id,request_hash,ack_json) VALUES(?,?,?,?,?)", tenant, storedUser, body.mutationId as string, requestHash, JSON.stringify(ack));
      // Old receipts can be removed: entity revisions and tombstones still
      // reject stale retries, while current retries replay their exact ack.
      this.sql.exec("DELETE FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? AND rowid NOT IN (SELECT rowid FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? ORDER BY rowid DESC LIMIT ?)",
        tenant, storedUser, tenant, storedUser, MAX_MUTATION_RECEIPTS);
      return ack;
    });
  }
}
