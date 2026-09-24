import { AiError } from "./security";
import type { AiSql } from "./storage";
import { normalizeAiTenantId, tenantStorageKey } from "./tenant";
import { AiWorkspaceRepository } from "./workspace";
import { AiWorkspaceV2ShadowRepository, canonical, split, type Segment } from "./workspaceV2Shadow";

/**
 * Prepared-only V2 storage. No HTTP route or automatic migration calls this
 * repository. A future client must get per-entity reads, CAS writes, media
 * references, legacy-client exclusion and all background readers before an
 * account can be activated. V1 remains authoritative throughout preparation.
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
`;

const ENTITY_KINDS = new Set<Segment["kind"]>(["manifest", "project", "conversation", "artifact", "draft", "draftAttachment", "videoDraftSettings"]);
const BINARY_CHUNK_BYTES = 48 * 1024; // Base64 data is at most 64 KiB per SQLite row.
interface MetaRow { source_revision: number; source_hash: string; epoch: number; prepared_at: string; activated_at: string | null }
interface EntityRow { revision: number; ordinal: number; byte_length: number; sha256: string; chunk_count: number }
interface ChunkRow { chunk_index: number; data: string }
interface PreparedEntity { segment: Segment; bytes: Uint8Array; sha256: string; chunks: string[] }
export interface AiWorkspaceV2PreparedSnapshot { sourceRevision: number; sourceHash: string; epoch: number; preparedAt: string; entityCount: number }
export interface AiWorkspaceV2PreparedEntity { kind: Segment["kind"]; entityId: string; revision: number; ordinal: number; value: unknown }

function corrupt(): never { throw new AiError(500, "AI_WORKSPACE_CORRUPT", "工作台分实体准备数据不完整，原记录未被更改"); }
function stale(): never { throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台已更新，请重新准备分实体数据"); }
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
  initialize(): void { this.sql.exec(AI_WORKSPACE_V2_SCHEMA); }

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
      for (const item of prepared) {
        const { kind, entityId, ordinal } = item.segment;
        this.sql.exec("INSERT INTO ai_workspace_v2_entities(tenant_id,user_id,kind,entity_id,revision,ordinal,byte_length,sha256,chunk_count) VALUES(?,?,?,?,1,?,?,?,?)",
          tenant, storedUser, kind, entityId, ordinal, item.bytes.length, item.sha256, item.chunks.length);
        for (const [index, data] of item.chunks.entries()) {
          this.sql.exec("INSERT INTO ai_workspace_v2_entity_chunks(tenant_id,user_id,kind,entity_id,chunk_index,data) VALUES(?,?,?,?,?,?)",
            tenant, storedUser, kind, entityId, index, data);
        }
      }
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
    const current = this.workspace.read(userId, tenant);
    const meta = this.sql.all<MetaRow>("SELECT source_revision,source_hash,epoch,prepared_at,activated_at FROM ai_workspace_v2_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    if (!meta) return null;
    if (meta.activated_at || !current.state || current.revision !== meta.source_revision ||
      await hash(new TextEncoder().encode(canonical(current.state))) !== meta.source_hash) stale();
    const entity = this.sql.all<EntityRow>("SELECT revision,ordinal,byte_length,sha256,chunk_count FROM ai_workspace_v2_entities WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=?", tenant, storedUser, kind, entityId)[0];
    if (!entity) return null;
    const rows = this.sql.all<ChunkRow>("SELECT chunk_index,data FROM ai_workspace_v2_entity_chunks WHERE tenant_id=? AND user_id=? AND kind=? AND entity_id=? ORDER BY chunk_index", tenant, storedUser, kind, entityId);
    const bytes = decodeChunks(rows, entity);
    if (await hash(bytes) !== entity.sha256) corrupt();
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)); } catch { return corrupt(); }
    if (["project", "conversation", "artifact"].includes(kind) &&
      (!value || typeof value !== "object" || Array.isArray(value) || (value as { id?: unknown }).id !== entityId)) corrupt();
    return { kind, entityId, revision: entity.revision, ordinal: entity.ordinal, value };
  }
}
