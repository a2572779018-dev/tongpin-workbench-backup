import {
  RELATIONSHIP_GRAPH_MIRROR_AVATAR_MAX_CHARS,
  RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES,
  RELATIONSHIP_GRAPH_MIRROR_MAX_CONNECTIONS,
  RELATIONSHIP_GRAPH_MIRROR_MAX_PEOPLE,
  type RelationshipGraphSnapshotMeta,
} from "../shared/relationshipGraphMirror";
import { aiTenantIdFromPrincipal } from "./ai/tenant";

/**
 * Shared by the Express mirror (server/routes/relationship-graphs.ts) and the
 * Cloudflare Worker (cloudflare/src/relationshipGraphs.ts). Web-platform APIs
 * only (TextEncoder, crypto.subtle) so both runtimes execute identical checks.
 */
export type RelationshipGraphErrorFactory = (
  status: number,
  code: string,
  message: string,
) => Error;

export interface ValidatedRelationshipGraphUpload {
  /** Canonical JSON text that is stored and served to the boss. */
  serialized: string;
  bytes: number;
  contentHash: string;
  localVersion: number;
  updatedAt: string;
  avatarsOmitted: number;
  contactCount: number;
  connectionCount: number;
}

/** Stored record; graph content lives next to it (JSON field or SQLite chunks). */
export interface RelationshipGraphSnapshotRecordMeta {
  localVersion: number;
  contentHash: string;
  updatedAt: string;
  syncedAt: string;
  contactCount: number;
  connectionCount: number;
  avatarsOmitted: number;
  bytes: number;
}

/** Durable Objects cap one SQLite row at 2 MB; a UTF-16 unit is at most 3 UTF-8 bytes. */
export const RELATIONSHIP_GRAPH_CHUNK_CHARS = 256 * 1024;

const CONTENT_HASH = /^[0-9a-f]{64}$/;
const PERSON_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MEMBER_ID = /^[0-9a-f-]{1,64}$/i;
const AVATAR_DATA_URL = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isRelationshipGraphMemberId(value: string): boolean {
  return MEMBER_ID.test(value);
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Only the authenticated principal decides the organization; request data never does. */
export function relationshipGraphTenantId(
  principal: unknown,
  fail: RelationshipGraphErrorFactory,
): string {
  try {
    return aiTenantIdFromPrincipal(principal);
  } catch {
    throw fail(403, "TENANT_INVALID", "组织范围无效，请重新登录");
  }
}

function validateMirrorGraph(
  graph: unknown,
  fail: RelationshipGraphErrorFactory,
): { contactCount: number; connectionCount: number } {
  const invalid = (detail: string) =>
    fail(400, "RELATIONSHIP_GRAPH_INVALID", `客户脉络图格式无效：${detail}`);
  if (!isPlainObject(graph)) throw invalid("内容必须是对象");
  if (graph.schemaVersion !== "1.0") throw invalid("版本不受支持");
  const { people, connections } = graph;
  if (
    !Array.isArray(people) ||
    people.length < 1 ||
    people.length > RELATIONSHIP_GRAPH_MIRROR_MAX_PEOPLE
  ) {
    throw invalid("人物数量无效");
  }
  if (
    !Array.isArray(connections) ||
    connections.length > RELATIONSHIP_GRAPH_MIRROR_MAX_CONNECTIONS
  ) {
    throw invalid("关系数量无效");
  }
  const ids = new Set<string>();
  let centers = 0;
  for (const person of people) {
    if (
      !isPlainObject(person) ||
      typeof person.id !== "string" ||
      !PERSON_ID.test(person.id) ||
      typeof person.name !== "string" ||
      !person.name.trim() ||
      person.name.length > 80
    ) {
      throw invalid("人物资料无效");
    }
    if (ids.has(person.id)) throw invalid("人物 ID 重复");
    ids.add(person.id);
    if (person.level === "self") centers += 1;
    const { avatar } = person;
    if (
      avatar !== undefined &&
      avatar !== null &&
      (typeof avatar !== "string" ||
        avatar.length > RELATIONSHIP_GRAPH_MIRROR_AVATAR_MAX_CHARS ||
        !AVATAR_DATA_URL.test(avatar))
    ) {
      throw invalid("头像需先在本机缩小");
    }
  }
  if (centers !== 1) throw invalid("必须且只能有一个关系中心");
  for (const connection of connections) {
    if (
      !isPlainObject(connection) ||
      typeof connection.source !== "string" ||
      typeof connection.target !== "string" ||
      connection.source === connection.target ||
      !ids.has(connection.source) ||
      !ids.has(connection.target)
    ) {
      throw invalid("关系引用了不存在的人物");
    }
  }
  return { contactCount: people.length - 1, connectionCount: connections.length };
}

/**
 * Validate a member upload and derive the canonical stored text. Unknown
 * top-level fields are ignored so newer desktop clients keep syncing against
 * an older backend. The content hash must match the canonical text, which is
 * exactly what `JSON.stringify(graph)` produced on the member client.
 */
export async function parseRelationshipGraphUpload(
  body: unknown,
  fail: RelationshipGraphErrorFactory,
): Promise<ValidatedRelationshipGraphUpload> {
  if (!isPlainObject(body)) {
    throw fail(400, "RELATIONSHIP_GRAPH_INVALID", "同步内容格式无效");
  }
  const { graph, localVersion, contentHash, updatedAt } = body;
  const avatarsOmitted = body.avatarsOmitted ?? 0;
  if (
    typeof localVersion !== "number" ||
    !Number.isSafeInteger(localVersion) ||
    localVersion < 1
  ) {
    throw fail(400, "RELATIONSHIP_GRAPH_INVALID", "本机版本号无效");
  }
  if (typeof contentHash !== "string" || !CONTENT_HASH.test(contentHash)) {
    throw fail(400, "RELATIONSHIP_GRAPH_INVALID", "内容校验值无效");
  }
  const updatedAtMs =
    typeof updatedAt === "string" && updatedAt.length <= 40
      ? Date.parse(updatedAt)
      : Number.NaN;
  if (!Number.isFinite(updatedAtMs)) {
    throw fail(400, "RELATIONSHIP_GRAPH_INVALID", "本机保存时间无效");
  }
  if (
    typeof avatarsOmitted !== "number" ||
    !Number.isSafeInteger(avatarsOmitted) ||
    avatarsOmitted < 0 ||
    avatarsOmitted > RELATIONSHIP_GRAPH_MIRROR_MAX_PEOPLE
  ) {
    throw fail(400, "RELATIONSHIP_GRAPH_INVALID", "头像统计无效");
  }
  const counts = validateMirrorGraph(graph, fail);
  const serialized = JSON.stringify(graph);
  const encoded = new TextEncoder().encode(serialized);
  if (encoded.byteLength > RELATIONSHIP_GRAPH_MIRROR_MAX_BYTES) {
    throw fail(
      413,
      "RELATIONSHIP_GRAPH_TOO_LARGE",
      "客户脉络图超过 5 MB，无法同步给老板",
    );
  }
  if ((await sha256Hex(encoded)) !== contentHash) {
    throw fail(
      400,
      "RELATIONSHIP_GRAPH_HASH_MISMATCH",
      "客户脉络图校验失败，请稍后重试",
    );
  }
  return {
    serialized,
    bytes: encoded.byteLength,
    contentHash,
    localVersion,
    updatedAt: new Date(updatedAtMs).toISOString(),
    avatarsOmitted,
    ...counts,
  };
}

export function relationshipGraphSnapshotMeta(
  record: RelationshipGraphSnapshotRecordMeta,
): RelationshipGraphSnapshotMeta {
  return {
    localVersion: record.localVersion,
    contentHash: record.contentHash,
    updatedAt: record.updatedAt,
    syncedAt: record.syncedAt,
    contactCount: record.contactCount,
    connectionCount: record.connectionCount,
    avatarsOmitted: record.avatarsOmitted,
    bytes: record.bytes,
  };
}

/** Split without breaking a UTF-16 surrogate pair across rows. */
export function splitRelationshipGraphChunks(
  serialized: string,
  size = RELATIONSHIP_GRAPH_CHUNK_CHARS,
): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < serialized.length; ) {
    let end = Math.min(start + size, serialized.length);
    const code = serialized.charCodeAt(end - 1);
    if (end < serialized.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    chunks.push(serialized.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * The stored graph text is our own JSON.stringify output, so the boss response
 * embeds it verbatim instead of paying for another parse/serialize cycle.
 */
export function bossRelationshipGraphResponseBody(
  user: unknown,
  snapshot: RelationshipGraphSnapshotMeta,
  graphJson: string,
): string {
  return `{"user":${JSON.stringify(user)},"snapshot":${JSON.stringify(snapshot)},"graph":${graphJson}}`;
}
