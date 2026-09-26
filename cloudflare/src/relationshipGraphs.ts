import {
  BOSS_RELATIONSHIP_GRAPHS_PATH,
  RELATIONSHIP_GRAPH_ME_PATH,
  RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES,
  type RelationshipGraphSnapshotMeta,
} from "../../shared/relationshipGraphMirror";
import {
  bossRelationshipGraphResponseBody,
  isRelationshipGraphMemberId,
  parseRelationshipGraphUpload,
  relationshipGraphSnapshotMeta,
  relationshipGraphTenantId,
  splitRelationshipGraphChunks,
} from "../../server/relationship-graph-snapshots";
import type { UserRole } from "../../server/types";
import { ApiError, firstRow, json, toPublicUser, type UserRow } from "./platform";
import { DATABASE_MIGRATION_7 } from "./schema";

/** What TongpinCore lends these routes; the Boss/member guards stay the core's requireUser. */
export interface RelationshipGraphRouteContext {
  sql: SqlStorage;
  transactionSync<T>(action: () => T): T;
  requireUser(request: Request, roles?: UserRole[]): Promise<UserRow>;
  /** Per Durable Object instance; set once the migration-7 tables are confirmed. */
  schema: { ready: boolean };
}

interface SnapshotRow extends Record<string, SqlStorageValue> {
  user_id: string;
  tenant_id: string;
  local_version: number;
  content_hash: string;
  updated_at: string;
  synced_at: string;
  contact_count: number;
  connection_count: number;
  avatars_omitted: number;
  byte_length: number;
  chunk_count: number;
}

interface ChunkRow extends Record<string, SqlStorageValue> {
  chunk_index: number;
  data: string;
}

const apiError = (status: number, code: string, message: string) =>
  new ApiError(status, code, message);

export function isRelationshipGraphPath(path: string): boolean {
  return (
    path === RELATIONSHIP_GRAPH_ME_PATH ||
    path === BOSS_RELATIONSHIP_GRAPHS_PATH ||
    path.startsWith(`${BOSS_RELATIONSHIP_GRAPHS_PATH}/`)
  );
}

function isRowWriteLimit(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Exceeded allowed rows written in Durable Objects free tier")
  );
}

/**
 * migrate() normally creates the tables (fresh and early-exit paths). If that
 * write was deferred by the free-plan row limit, create them on first use and
 * fail closed with a retryable 503 instead of a SQL error.
 */
function ensureSchema(context: RelationshipGraphRouteContext): void {
  if (context.schema.ready) return;
  const tables = context.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('relationship_graph_snapshots', 'relationship_graph_snapshot_chunks')`,
    )
    .toArray();
  if (tables.length !== 2) {
    try {
      context.transactionSync(() => {
        context.sql.exec(DATABASE_MIGRATION_7);
        context.sql.exec(`
          CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
            id INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
        context.sql.exec("INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (7)");
      });
    } catch (error) {
      if (isRowWriteLimit(error)) {
        throw apiError(503, "RELATIONSHIP_GRAPH_MAINTENANCE", "客户脉络图同步正在升级，请稍后重试");
      }
      throw error;
    }
  }
  context.schema.ready = true;
}

function sameTenant(row: UserRow, tenantId: string): boolean {
  try {
    return relationshipGraphTenantId(row, apiError) === tenantId;
  } catch {
    return false;
  }
}

function metaFromRow(row: SnapshotRow): RelationshipGraphSnapshotMeta {
  return relationshipGraphSnapshotMeta({
    localVersion: Number(row.local_version),
    contentHash: row.content_hash,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
    contactCount: Number(row.contact_count),
    connectionCount: Number(row.connection_count),
    avatarsOmitted: Number(row.avatars_omitted),
    bytes: Number(row.byte_length),
  });
}

function snapshotRow(
  context: RelationshipGraphRouteContext,
  userId: string,
): SnapshotRow | undefined {
  return firstRow(
    context.sql.exec<SnapshotRow>(
      "SELECT * FROM relationship_graph_snapshots WHERE user_id = ?",
      userId,
    ),
  );
}

function graphJsonFromChunks(
  context: RelationshipGraphRouteContext,
  row: SnapshotRow,
): string {
  const chunks = context.sql
    .exec<ChunkRow>(
      `SELECT chunk_index, data FROM relationship_graph_snapshot_chunks
       WHERE user_id = ? ORDER BY chunk_index`,
      row.user_id,
    )
    .toArray();
  if (
    chunks.length !== Number(row.chunk_count) ||
    chunks.some((chunk, index) => Number(chunk.chunk_index) !== index)
  ) {
    throw apiError(
      500,
      "RELATIONSHIP_GRAPH_CORRUPT",
      "客户脉络图副本不完整，请让成员重新打开客户脉络图后再同步",
    );
  }
  return chunks.map((chunk) => chunk.data).join("");
}

async function readUploadBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES) {
    throw apiError(413, "RELATIONSHIP_GRAPH_TOO_LARGE", "客户脉络图超过 5 MB，无法同步给老板");
  }
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > RELATIONSHIP_GRAPH_MIRROR_REQUEST_BYTES) {
    throw apiError(413, "RELATIONSHIP_GRAPH_TOO_LARGE", "客户脉络图超过 5 MB，无法同步给老板");
  }
  try {
    return JSON.parse(new TextDecoder().decode(buffer)) as unknown;
  } catch {
    throw apiError(400, "INVALID_JSON", "提交内容不是有效 JSON");
  }
}

async function getOwnSnapshot(
  request: Request,
  context: RelationshipGraphRouteContext,
): Promise<Response> {
  const member = await context.requireUser(request, ["member"]);
  ensureSchema(context);
  const tenantId = relationshipGraphTenantId(member, apiError);
  const row = snapshotRow(context, member.id);
  return json({ snapshot: row && row.tenant_id === tenantId ? metaFromRow(row) : null });
}

async function putOwnSnapshot(
  request: Request,
  context: RelationshipGraphRouteContext,
): Promise<Response> {
  // Authorize before parsing the (up to 5 MB) body.
  const member = await context.requireUser(request, ["member"]);
  ensureSchema(context);
  const tenantId = relationshipGraphTenantId(member, apiError);
  const upload = await parseRelationshipGraphUpload(
    await readUploadBody(request),
    apiError,
  );
  const syncedAt = new Date().toISOString();
  const current = snapshotRow(context, member.id);
  const unchanged =
    current?.tenant_id === tenantId && current.content_hash === upload.contentHash;
  try {
    context.transactionSync(() => {
      if (unchanged) {
        // Identical content: refresh freshness metadata only (one row write).
        context.sql.exec(
          `UPDATE relationship_graph_snapshots
           SET local_version = ?, updated_at = ?, synced_at = ?, avatars_omitted = ?
           WHERE user_id = ?`,
          upload.localVersion,
          upload.updatedAt,
          syncedAt,
          upload.avatarsOmitted,
          member.id,
        );
        return;
      }
      const chunks = splitRelationshipGraphChunks(upload.serialized);
      context.sql.exec(
        `INSERT INTO relationship_graph_snapshots
         (user_id, tenant_id, local_version, content_hash, updated_at, synced_at,
          contact_count, connection_count, avatars_omitted, byte_length, chunk_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           tenant_id = excluded.tenant_id,
           local_version = excluded.local_version,
           content_hash = excluded.content_hash,
           updated_at = excluded.updated_at,
           synced_at = excluded.synced_at,
           contact_count = excluded.contact_count,
           connection_count = excluded.connection_count,
           avatars_omitted = excluded.avatars_omitted,
           byte_length = excluded.byte_length,
           chunk_count = excluded.chunk_count`,
        member.id,
        tenantId,
        upload.localVersion,
        upload.contentHash,
        upload.updatedAt,
        syncedAt,
        upload.contactCount,
        upload.connectionCount,
        upload.avatarsOmitted,
        upload.bytes,
        chunks.length,
      );
      // Only the latest snapshot is kept per member.
      context.sql.exec(
        "DELETE FROM relationship_graph_snapshot_chunks WHERE user_id = ?",
        member.id,
      );
      for (const [index, data] of chunks.entries()) {
        context.sql.exec(
          `INSERT INTO relationship_graph_snapshot_chunks (user_id, chunk_index, data)
           VALUES (?, ?, ?)`,
          member.id,
          index,
          data,
        );
      }
    });
  } catch (error) {
    if (isRowWriteLimit(error)) {
      throw apiError(503, "RELATIONSHIP_GRAPH_SYNC_BUSY", "服务器暂时无法保存同步副本，稍后会自动重试");
    }
    throw error;
  }
  return json({
    snapshot: relationshipGraphSnapshotMeta({
      localVersion: upload.localVersion,
      contentHash: upload.contentHash,
      updatedAt: upload.updatedAt,
      syncedAt,
      contactCount: upload.contactCount,
      connectionCount: upload.connectionCount,
      avatarsOmitted: upload.avatarsOmitted,
      bytes: upload.bytes,
    }),
  });
}

async function listForBoss(
  request: Request,
  context: RelationshipGraphRouteContext,
): Promise<Response> {
  const boss = await context.requireUser(request, ["boss"]);
  ensureSchema(context);
  const tenantId = relationshipGraphTenantId(boss, apiError);
  const snapshots = new Map(
    context.sql
      .exec<SnapshotRow>(
        "SELECT * FROM relationship_graph_snapshots WHERE tenant_id = ?",
        tenantId,
      )
      .toArray()
      .map((row) => [row.user_id, row] as const),
  );
  const members = context.sql
    .exec<UserRow>("SELECT * FROM users WHERE status = 'active' AND role = 'member'")
    .toArray()
    .filter((row) => sameTenant(row, tenantId))
    .map((row) => {
      const snapshot = snapshots.get(row.id);
      return {
        user: toPublicUser(row),
        snapshot: snapshot ? metaFromRow(snapshot) : null,
      };
    })
    .sort((left, right) => left.user.name.localeCompare(right.user.name, "zh-CN"));
  return json({ members });
}

async function getForBoss(
  request: Request,
  context: RelationshipGraphRouteContext,
  userId: string,
): Promise<Response> {
  const boss = await context.requireUser(request, ["boss"]);
  ensureSchema(context);
  const tenantId = relationshipGraphTenantId(boss, apiError);
  const user = isRelationshipGraphMemberId(userId)
    ? firstRow(context.sql.exec<UserRow>("SELECT * FROM users WHERE id = ?", userId))
    : undefined;
  if (
    !user ||
    user.status !== "active" ||
    user.role !== "member" ||
    !sameTenant(user, tenantId)
  ) {
    throw apiError(404, "USER_NOT_FOUND", "没有找到该成员");
  }
  const row = snapshotRow(context, user.id);
  if (!row || row.tenant_id !== tenantId) {
    throw apiError(404, "RELATIONSHIP_GRAPH_NOT_SYNCED", "该成员尚未同步客户脉络图");
  }
  return new Response(
    bossRelationshipGraphResponseBody(
      toPublicUser(user),
      metaFromRow(row),
      graphJsonFromChunks(context, row),
    ),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Member: GET/PUT own snapshot. Boss: list the organization and read one member (read-only). */
export async function handleRelationshipGraphRequest(
  request: Request,
  path: string,
  context: RelationshipGraphRouteContext,
): Promise<Response> {
  const method = request.method;
  if (path === RELATIONSHIP_GRAPH_ME_PATH) {
    if (method === "GET") return getOwnSnapshot(request, context);
    if (method === "PUT") return putOwnSnapshot(request, context);
  } else if (path === BOSS_RELATIONSHIP_GRAPHS_PATH) {
    if (method === "GET") return listForBoss(request, context);
  } else {
    const userId = path.slice(BOSS_RELATIONSHIP_GRAPHS_PATH.length + 1);
    if (method === "GET" && userId && !userId.includes("/")) {
      return getForBoss(request, context, userId);
    }
  }
  throw apiError(404, "NOT_FOUND", "请求的接口不存在");
}
