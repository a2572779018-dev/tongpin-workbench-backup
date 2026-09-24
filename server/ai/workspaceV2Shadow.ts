import type { AiWorkspaceState } from "../../shared/aiWorkspace";
import { AiError } from "./security";
import type { AiSql } from "./storage";
import { normalizeAiTenantId, tenantStorageKey } from "./tenant";
import { AiWorkspaceRepository, validateAiWorkspaceState } from "./workspace";

/**
 * Inert preparation for a future per-entity workspace protocol. These tables
 * are not read or written by the V1 routes, and staging never changes the
 * active workspace version. Old desktop clients must remain on V1 until a
 * complete V2 client and all server readers have been migrated.
 */
type Kind = "manifest" | "project" | "conversation" | "artifact" | "draft" | "draftAttachment" | "videoDraftSettings";
export interface Segment { kind: Kind; entityId: string; ordinal: number; value: unknown }
interface ShadowMeta { source_revision: number; source_hash: string; staged_at: string }
interface ShadowChunk { kind: string; entity_id: string; ordinal: number; chunk_index: number; data: string }
export interface AiWorkspaceV2ShadowSnapshot {
  sourceRevision: number;
  currentRevision: number;
  sourceHash: string;
  stagedAt: string;
  stale: boolean;
  state: AiWorkspaceState;
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}
async function digest(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
function sqlChunks(serialized: string): string[] {
  const result: string[] = [];
  for (let start = 0; start < serialized.length;) {
    let end = Math.min(start + 64000, serialized.length);
    if (end < serialized.length && serialized.charCodeAt(end - 1) >= 0xd800 && serialized.charCodeAt(end - 1) <= 0xdbff) end--;
    result.push(serialized.slice(start, end));
    start = end;
  }
  return result;
}
export function split(state: AiWorkspaceState): Segment[] {
  const { projects, conversations, artifacts, drafts, draftAttachments, videoDraftSettings, ...base } = state;
  return [
    { kind: "manifest", entityId: "root", ordinal: 0, value: { base, hasDraftAttachments: draftAttachments !== undefined, hasVideoDraftSettings: videoDraftSettings !== undefined } },
    ...projects.map((value, ordinal) => ({ kind: "project" as const, entityId: value.id, ordinal, value })),
    ...conversations.map((value, ordinal) => ({ kind: "conversation" as const, entityId: value.id, ordinal, value })),
    ...artifacts.map((value, ordinal) => ({ kind: "artifact" as const, entityId: value.id, ordinal, value })),
    ...Object.entries(drafts).map(([entityId, value], ordinal) => ({ kind: "draft" as const, entityId, ordinal, value })),
    ...Object.entries(draftAttachments ?? {}).map(([entityId, value], ordinal) => ({ kind: "draftAttachment" as const, entityId, ordinal, value })),
    ...Object.entries(videoDraftSettings ?? {}).map(([entityId, value], ordinal) => ({ kind: "videoDraftSettings" as const, entityId, ordinal, value })),
  ];
}
function corrupt(): never { throw new AiError(500, "AI_WORKSPACE_CORRUPT", "工作台迁移预览不完整，原记录未被更改"); }
function assemble(rows: ShadowChunk[]): AiWorkspaceState {
  try {
    const grouped = new Map<string, { kind: string; entityId: string; ordinal: number; chunks: string[] }>();
    for (const row of rows) {
      const key = JSON.stringify([row.kind, row.entity_id]);
      let group = grouped.get(key);
      if (!group) { group = { kind: row.kind, entityId: row.entity_id, ordinal: row.ordinal, chunks: [] }; grouped.set(key, group); }
      if (row.ordinal !== group.ordinal || row.chunk_index !== group.chunks.length || !row.data) corrupt();
      group.chunks.push(row.data);
    }
    const byKind = new Map<Kind, Array<{ id: string; ordinal: number; value: unknown }>>();
    const kinds = new Set<Kind>(["manifest", "project", "conversation", "artifact", "draft", "draftAttachment", "videoDraftSettings"]);
    for (const group of grouped.values()) {
      if (!kinds.has(group.kind as Kind)) corrupt();
      const kind = group.kind as Kind;
      const collection = byKind.get(kind) ?? [];
      collection.push({ id: group.entityId, ordinal: group.ordinal, value: JSON.parse(group.chunks.join("")) });
      byKind.set(kind, collection);
    }
    const roots = byKind.get("manifest") ?? [];
    if (roots.length !== 1 || roots[0].id !== "root" || roots[0].ordinal !== 0) corrupt();
    const manifest = roots[0].value as { base?: Partial<AiWorkspaceState>; hasDraftAttachments?: boolean; hasVideoDraftSettings?: boolean };
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
      Object.keys(manifest).some(key => !["base", "hasDraftAttachments", "hasVideoDraftSettings"].includes(key)) ||
      !manifest.base || typeof manifest.base !== "object" || Array.isArray(manifest.base) ||
      typeof manifest.hasDraftAttachments !== "boolean" || typeof manifest.hasVideoDraftSettings !== "boolean") corrupt();
    if (Object.keys(manifest.base).some(key => ["projects", "conversations", "artifacts", "drafts", "draftAttachments", "videoDraftSettings"].includes(key))) corrupt();
    if ((!manifest.hasDraftAttachments && byKind.get("draftAttachment")?.length) ||
      (!manifest.hasVideoDraftSettings && byKind.get("videoDraftSettings")?.length)) corrupt();
    const ordered = (kind: Kind) => {
      const entries = (byKind.get(kind) ?? []).sort((a, b) => a.ordinal - b.ordinal);
      if (entries.some((entry, index) => entry.ordinal !== index)) corrupt();
      if (["project", "conversation", "artifact"].includes(kind) && entries.some(entry =>
        !entry.value || typeof entry.value !== "object" || Array.isArray(entry.value) || (entry.value as { id?: unknown }).id !== entry.id)) corrupt();
      return entries;
    };
    const collection = (kind: Kind) => ordered(kind).map(entry => entry.value);
    const keyed = (kind: Kind) => Object.fromEntries(ordered(kind).map(entry => [entry.id, entry.value]));
    const state = {
      ...manifest.base,
      projects: collection("project"), conversations: collection("conversation"), artifacts: collection("artifact"), drafts: keyed("draft"),
      ...(manifest.hasDraftAttachments ? { draftAttachments: keyed("draftAttachment") } : {}),
      ...(manifest.hasVideoDraftSettings ? { videoDraftSettings: keyed("videoDraftSettings") } : {}),
    };
    return validateAiWorkspaceState(state);
  } catch (error) {
    // A safe rollback can fail simply because its current V2 account exceeds
    // the old aggregate cap; do not misreport that as corrupted data.
    if (error instanceof AiError && error.code === "AI_WORKSPACE_TOO_LARGE") throw error;
    return corrupt();
  }
}

/** Reuse V1 shape validation when a local migration needs to reconstruct an
 * active V2 account. Active ordinals may be negative after prepend, unlike
 * the contiguous ordinals in an inert shadow snapshot. */
export function assembleV2Segments(segments: Segment[]): AiWorkspaceState {
  const kinds: Kind[] = ["manifest", "project", "conversation", "artifact", "draft", "draftAttachment", "videoDraftSettings"];
  const rows: ShadowChunk[] = [];
  for (const kind of kinds) {
    const entries = segments.filter(segment => segment.kind === kind).sort((a, b) => a.ordinal - b.ordinal);
    if (entries.some((entry, index) => index > 0 && entry.ordinal === entries[index - 1].ordinal)) corrupt();
    for (const [ordinal, entry] of entries.entries()) rows.push({ kind, entity_id: entry.entityId, ordinal, chunk_index: 0, data: JSON.stringify(entry.value) });
  }
  if (rows.length !== segments.length) corrupt();
  return assemble(rows);
}

export class AiWorkspaceV2ShadowRepository {
  constructor(readonly sql: AiSql, readonly workspace: AiWorkspaceRepository) {}

  /** Explicit staging only; there is intentionally no route or background job. */
  async stageFromV1(userId: string, tenantId?: string): Promise<AiWorkspaceV2ShadowSnapshot | null> {
    const tenant = normalizeAiTenantId(tenantId);
    const storedUser = tenantStorageKey(tenant, userId);
    const source = this.workspace.read(userId, tenant);
    if (!source.state) return null;
    const original = canonical(source.state);
    const hash = await digest(source.state);
    const segments = split(source.state);
    const stagedAt = new Date().toISOString();
    this.sql.transaction(() => {
      const current = this.workspace.read(userId, tenant);
      if (current.revision !== source.revision || !current.state || canonical(current.state) !== original) {
        throw new AiError(409, "AI_WORKSPACE_CONFLICT", "工作台已更新，请重新准备迁移预览");
      }
      this.sql.exec("DELETE FROM ai_workspace_v2_shadow_segments WHERE tenant_id=? AND user_id=?", tenant, storedUser);
      for (const segment of segments) {
        for (const [index, data] of sqlChunks(JSON.stringify(segment.value)).entries()) {
          this.sql.exec("INSERT INTO ai_workspace_v2_shadow_segments(tenant_id,user_id,kind,entity_id,ordinal,chunk_index,data) VALUES(?,?,?,?,?,?,?)", tenant, storedUser, segment.kind, segment.entityId, segment.ordinal, index, data);
        }
      }
      this.sql.exec("INSERT INTO ai_workspace_v2_shadow_meta(tenant_id,user_id,source_revision,source_hash,staged_at) VALUES(?,?,?,?,?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET source_revision=excluded.source_revision,source_hash=excluded.source_hash,staged_at=excluded.staged_at", tenant, storedUser, source.revision, hash, stagedAt);
    });
    return this.read(userId, tenant);
  }

  async read(userId: string, tenantId?: string): Promise<AiWorkspaceV2ShadowSnapshot | null> {
    const tenant = normalizeAiTenantId(tenantId);
    const storedUser = tenantStorageKey(tenant, userId);
    // Enforce the same current-account grant as V1 before touching private rows.
    const current = this.workspace.read(userId, tenant);
    const meta = this.sql.all<ShadowMeta>("SELECT source_revision,source_hash,staged_at FROM ai_workspace_v2_shadow_meta WHERE tenant_id=? AND user_id=?", tenant, storedUser)[0];
    if (!meta) return null;
    const rows = this.sql.all<ShadowChunk>("SELECT kind,entity_id,ordinal,chunk_index,data FROM ai_workspace_v2_shadow_segments WHERE tenant_id=? AND user_id=? ORDER BY kind,entity_id,chunk_index", tenant, storedUser);
    const state = assemble(rows);
    if (await digest(state) !== meta.source_hash) corrupt();
    return { sourceRevision: meta.source_revision, currentRevision: current.revision, sourceHash: meta.source_hash, stagedAt: meta.staged_at, stale: current.revision !== meta.source_revision, state };
  }
}
