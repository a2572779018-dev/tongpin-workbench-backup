import { AiError } from "./security";
import type { AiWorkspaceArtifact } from "../../shared/aiWorkspace";
import { AiStore } from "./storage";
import type { AiSql } from "./storage";
import { normalizeAiTenantId, tenantStorageKey } from "./tenant";
import { AiWorkspaceRepository, validateAiWorkspaceDraft, validateAiWorkspaceVideoDraftSetting } from "./workspace";
import { AiWorkspaceV2ShadowRepository, canonical, split, type Segment } from "./workspaceV2Shadow";

/**
 * Internal V2 preparation plus a deliberately narrow draft/settings CAS proof.
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
CREATE TABLE IF NOT EXISTS ai_workspace_v2_image_artifacts (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  PRIMARY KEY(tenant_id,user_id,conversation_id,asset_id,artifact_id)
);
CREATE INDEX IF NOT EXISTS ai_workspace_v2_image_artifacts_by_artifact ON ai_workspace_v2_image_artifacts(tenant_id,user_id,artifact_id);
`;

const ENTITY_KINDS = new Set<Segment["kind"]>(["manifest", "project", "conversation", "artifact", "draft", "draftAttachment", "videoDraftSettings"]);
const BINARY_CHUNK_BYTES = 48 * 1024; // Base64 data is at most 64 KiB per SQLite row.
interface MetaRow { source_revision: number; source_hash: string; epoch: number; prepared_at: string; activated_at: string | null }
interface EntityRow { revision: number; ordinal: number; byte_length: number; sha256: string; chunk_count: number; deleted: number }
interface ChunkRow { chunk_index: number; data: string }
interface ActiveSnapshotEntry extends AiWorkspaceV2EntityRef { entity: EntityRow | undefined; rows: ChunkRow[] }
interface ActiveSnapshot { epoch: number; entries: ActiveSnapshotEntry[] }
interface PreparedEntity { segment: Segment; bytes: Uint8Array; sha256: string; chunks: string[] }
export interface AiWorkspaceV2PreparedSnapshot { sourceRevision: number; sourceHash: string; epoch: number; preparedAt: string; entityCount: number }
export interface AiWorkspaceV2PreparedEntity { kind: Segment["kind"]; entityId: string; revision: number; ordinal: number; value: unknown }
export interface AiWorkspaceV2ActiveEntity extends AiWorkspaceV2PreparedEntity { deleted: boolean }
export interface AiWorkspaceV2EntityRef { kind: Segment["kind"]; entityId: string }
export interface AiWorkspaceV2ActiveBatch { epoch: number; entities: Array<AiWorkspaceV2ActiveEntity | null> }
export interface AiWorkspaceV2MutationAck { epoch: number; entities: Array<{ kind: "draft" | "videoDraftSettings"; entityId: string; revision: number; deleted: boolean }> }
type WritableKind = "draft" | "videoDraftSettings";
interface PreparedMutationOp { kind: WritableKind; entityId: string; expectedRevision: number; action: "put" | "delete"; bytes?: Uint8Array; sha256?: string; chunks?: string[] }
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_DRAFT_BYTES = 96 * 1024;
const MAX_VIDEO_DRAFT_BYTES = 2 * 1024;
const MAX_MUTATION_RECEIPTS = 256;
const MAX_ACTIVE_BATCH_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_ARTIFACT_INDEX_ROWS = 4096;
const MAX_IMAGE_ARTIFACT_SCAN_ROWS = 8192;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  constructor(readonly sql: AiSql, readonly workspace: AiWorkspaceRepository) {
    this.shadow = new AiWorkspaceV2ShadowRepository(sql, workspace);
  }
  initialize(): void {
    this.sql.exec(AI_WORKSPACE_V2_SCHEMA);
    // Existing prepared-only test tables predate tombstones; no account is
    // activated by this additive migration.
    if (!this.sql.all<{ name: string }>("PRAGMA table_info(ai_workspace_v2_entities)").some(column => column.name === "deleted")) {
      this.sql.exec("ALTER TABLE ai_workspace_v2_entities ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
    }
  }

  private activeScope(userId: string, tenantId?: string): { tenant: string; storedUser: string; meta: MetaRow } {
    if (typeof userId !== "string" || !ID.test(userId)) invalid("工作台账号标识无效");
    const tenant = normalizeAiTenantId(tenantId);
    new AiStore(this.sql, tenant).assertAccess(userId);
    const storedUser = tenantStorageKey(tenant, userId);
    const meta = this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    const current = this.sql.all<{ schema_version: number; revision: number }>("SELECT schema_version,revision FROM ai_workspaces WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    if (!meta?.activated_at || current?.schema_version !== 2) unsupported();
    if (current.revision !== meta.source_revision) stale();
    return { tenant, storedUser, meta };
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
    const original = canonical(source.state);
    const preparedAt = new Date().toISOString();
    return this.sql.transaction(() => {
      const current = this.workspace.read(userId, tenant);
      const shadowMeta = this.sql.all<{ source_revision: number; source_hash: string; staged_at: string }>(
        "SELECT source_revision,source_hash,staged_at FROM ai_workspace_v2_shadow_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser,
      )[0];
      if (!current.state || current.revision !== source.sourceRevision || canonical(current.state) !== original ||
        shadowMeta?.source_revision !== source.sourceRevision || shadowMeta.source_hash !== source.sourceHash || shadowMeta.staged_at !== source.stagedAt) stale();
      const prior = this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
      if (prior?.activated_at) throw new AiError(409, "AI_WORKSPACE_VERSION_UNSUPPORTED", "已启用分实体工作台，不能再覆盖准备记录");
      const epoch = (prior?.epoch ?? 0) + 1;
      this.sql.exec("DELETE FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      this.sql.exec("DELETE FROM ai_workspace_v2_image_artifacts WHERE tenant_id=? AND user_id=?", tenant, storedUser);
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
      this.sql.exec("INSERT INTO ai_workspace_v2_meta(tenant_id,user_id,source_revision,source_hash,epoch,prepared_at,activated_at) VALUES(?,?,?,?,?,?,NULL) ON CONFLICT(tenant_id,user_id) DO UPDATE SET source_revision=excluded.source_revision,source_hash=excluded.source_hash,epoch=excluded.epoch,prepared_at=excluded.prepared_at,activated_at=NULL",
        tenant, storedUser, source.sourceRevision, source.sourceHash, epoch, preparedAt);
      return { sourceRevision: source.sourceRevision, sourceHash: source.sourceHash, epoch, preparedAt, entityCount: prepared.length };
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
      meta: this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0],
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

  /** Index is only a candidate locator. Capture it with the conversation and
   * artifact in one SQL snapshot; caller must still validate their linkage and
   * current asset ownership before granting a reference. */
  async readActiveImageSourceEntities(userId: string, conversationId: string, assetId: string, tenantId?: string): Promise<{ artifactId: string; batch: AiWorkspaceV2ActiveBatch } | null> {
    if (!ID.test(conversationId) || !ASSET_ID.test(assetId)) invalid("图片成果标识无效");
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    const snapshot = this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
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

  /** CAS is implemented for only two low-risk leaf kinds. There is no HTTP
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
    for (const raw of body.ops) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid("分实体操作无效");
      const op = raw as Record<string, unknown>;
      if (Object.keys(op).some(key => !["kind", "entityId", "expectedRevision", "action", "value"].includes(key))) invalid("分实体操作包含不支持的字段");
      if (!ENTITY_KINDS.has(op.kind as Segment["kind"])) invalid("分实体类型无效");
      if (op.kind !== "draft" && op.kind !== "videoDraftSettings") throw new AiError(409, "V2_OPERATION_NOT_READY", "此类工作台实体尚未开放逐条写入");
      if (typeof op.entityId !== "string" || op.entityId.length > 160 ||
        !(ID.test(op.entityId) || op.entityId.startsWith("new-project-conversation:") && ID.test(op.entityId.slice("new-project-conversation:".length)))) invalid("分实体标识无效");
      if (!Number.isSafeInteger(op.expectedRevision) || Number(op.expectedRevision) < 0 || Number(op.expectedRevision) >= Number.MAX_SAFE_INTEGER) invalid("分实体版本无效");
      if (op.action !== "put" && op.action !== "delete") invalid("分实体操作类型无效");
      const identity = JSON.stringify([op.kind, op.entityId]);
      if (identities.has(identity)) invalid("同一实体不能在单次请求中重复写入");
      identities.add(identity);
      const normalized: PreparedMutationOp = { kind: op.kind, entityId: op.entityId, expectedRevision: Number(op.expectedRevision), action: op.action };
      const forHash: Record<string, unknown> = { kind: op.kind, entityId: op.entityId, expectedRevision: op.expectedRevision, action: op.action };
      if (op.action === "put") {
        const validated = op.kind === "draft" ? validateAiWorkspaceDraft(op.value) : validateAiWorkspaceVideoDraftSetting(op.value);
        const value = JSON.parse(JSON.stringify(validated)) as unknown;
        const bytes = new TextEncoder().encode(JSON.stringify(value));
        if (bytes.length > (op.kind === "draft" ? MAX_DRAFT_BYTES : MAX_VIDEO_DRAFT_BYTES)) throw new AiError(413, "AI_WORKSPACE_TOO_LARGE", "分实体内容超出安全保存上限");
        normalized.bytes = bytes;
        normalized.sha256 = await hash(bytes);
        normalized.chunks = encodeChunks(bytes);
        forHash.value = value;
      } else if (op.value !== undefined) invalid("删除操作不能携带内容");
      prepared.push(normalized);
      canonicalOps.push(forHash);
    }
    const requestHash = await hash(new TextEncoder().encode(canonical({ epoch: body.epoch, ops: canonicalOps })));
    const tenant = normalizeAiTenantId(tenantId), storedUser = tenantStorageKey(tenant, userId);
    return this.sql.transaction(() => {
      const { meta } = this.activeScope(userId, tenant);
      if (meta.epoch !== body.epoch) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "分实体准备版本已变化，请重新同步");
      const prior = this.sql.all<{ request_hash: string; ack_json: string }>("SELECT request_hash,ack_json FROM ai_workspace_v2_mutations WHERE tenant_id=? AND user_id=? AND mutation_id=?", tenant, storedUser, body.mutationId as string)[0];
      if (prior) {
        if (prior.request_hash !== requestHash) throw new AiError(409, "AI_WORKSPACE_MUTATION_CONFLICT", "保存请求标识已用于不同内容，请重新同步");
        try { return JSON.parse(prior.ack_json) as AiWorkspaceV2MutationAck; } catch { return corrupt(); }
      }
      const entities: AiWorkspaceV2MutationAck["entities"] = [];
      for (const op of prepared) {
        const target = op.entityId;
        const relatedKind = target.startsWith("new-project-conversation:") ? "project" : "conversation";
        const relatedId = relatedKind === "project" ? target.slice("new-project-conversation:".length) : target;
        if (target !== "new-conversation" && !this.sql.all<{ entity_id: string }>(
          "SELECT entity_id FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=? AND deleted=0",
          tenant, storedUser, relatedKind, relatedId,
        )[0]) invalid("草稿所属对话或项目不存在");
        const current = this.sql.all<EntityRow>("SELECT revision,ordinal,byte_length,sha256,chunk_count,deleted FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?",
          tenant, storedUser, op.kind, target)[0];
        if ((current?.revision ?? 0) !== op.expectedRevision) throw new AiError(409, "AI_WORKSPACE_CONFLICT", "此条工作台记录已更新，本次未覆盖任何内容");
        const ordinal = current?.ordinal ?? (this.sql.all<{ max_ordinal: number | null }>("SELECT MAX(ordinal) AS max_ordinal FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=?", tenant, storedUser, op.kind)[0]?.max_ordinal ?? -1) + 1;
        const revision = op.expectedRevision + 1, deleted = op.action === "delete";
        this.sql.exec("INSERT INTO ai_workspace_v2_entities(tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count,deleted) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,user_id,kind,entity_id) DO UPDATE SET revision=excluded.revision,ordinal=excluded.ordinal,byte_length=excluded.byte_length,sha256=excluded.sha256,chunk_count=excluded.chunk_count,deleted=excluded.deleted",
          tenant, storedUser, op.kind, target, revision, ordinal, op.bytes?.length ?? 0, op.sha256 ?? "", op.chunks?.length ?? 0, deleted ? 1 : 0);
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
