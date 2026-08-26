import { parseGraphDocument } from "./importGraph.js";

export const GRAPH_STORAGE_SCHEMA_VERSION = "1.0";
export const GRAPH_STORAGE_KEY = `murmur.relationship-map.graph.v${GRAPH_STORAGE_SCHEMA_VERSION}`;
export const GRAPH_STORAGE_MAX_BYTES = 25 * 1024 * 1024;

function memberStorageId(memberId) {
  const normalized = typeof memberId === "string" ? memberId.trim() : "";
  return (normalized || "preview-member")
    .slice(0, 160)
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

export function graphStorageKeyForMember(memberId) {
  return `tongpin.relationship-map.${memberStorageId(memberId)}.v${GRAPH_STORAGE_SCHEMA_VERSION}`;
}

export function themeStorageKeyForMember(memberId) {
  return `tongpin.relationship-map.${memberStorageId(memberId)}.theme.v1`;
}

const PERSON_FIELDS = [
  "id",
  "name",
  "alias",
  "initial",
  "avatar",
  "level",
  "relationship",
  "cooperationStatus",
  "community",
  "interactions",
  "lastContact",
  "activeDays",
  "mutual",
  "phone",
  "wechat",
  "tags",
  "note",
];

const CONNECTION_FIELDS = ["source", "target", "relationship", "strength", "note"];

function failure(code, error) {
  return { ok: false, code, error };
}

function copyDefinedFields(value, fields) {
  const copy = {};
  if (!value || typeof value !== "object") return copy;
  for (const field of fields) {
    if (value[field] !== undefined) copy[field] = value[field];
  }
  return copy;
}

function copyPosition(value) {
  if (!value || typeof value !== "object") return undefined;
  return { x: value.x, y: value.y };
}

function positionOverrides(items) {
  const positions = new Map();
  if (!items) return positions;

  if (items instanceof Map) {
    for (const [id, position] of items) positions.set(id, copyPosition(position));
    return positions;
  }

  if (Array.isArray(items)) {
    for (const item of items) {
      if (Array.isArray(item)) {
        positions.set(item[0], copyPosition(item[1]));
      } else if (item && typeof item === "object") {
        positions.set(item.id, copyPosition(item.position));
      }
    }
    return positions;
  }

  if (typeof items === "object") {
    for (const [id, position] of Object.entries(items)) positions.set(id, copyPosition(position));
  }
  return positions;
}

function whitelistPerson(person, positions) {
  const serialized = copyDefinedFields(person, PERSON_FIELDS);
  const position = positions.has(person?.id)
    ? positions.get(person.id)
    : copyPosition(person?.position);
  if (position) serialized.position = position;
  return serialized;
}

function whitelistConnection(connection) {
  if (!Array.isArray(connection)) return copyDefinedFields(connection, CONNECTION_FIELDS);
  const serialized = {
    source: connection[0],
    target: connection[1],
    relationship: connection[2],
    strength: connection[3] ?? 0.65,
  };
  if (connection[4] !== undefined) serialized.note = connection[4];
  return serialized;
}

function storageDocument(graph) {
  const positions = positionOverrides(graph?.positions);
  return {
    schemaVersion: GRAPH_STORAGE_SCHEMA_VERSION,
    title: graph?.title,
    generatedAt: new Date().toISOString(),
    people: Array.isArray(graph?.people)
      ? graph.people.map((person) => whitelistPerson(person, positions))
      : graph?.people,
    connections: Array.isArray(graph?.connections)
      ? graph.connections.map(whitelistConnection)
      : graph?.connections,
  };
}

// Counts UTF-8 bytes without allocating a second, encoded copy of a large string.
function utf8ByteLength(value, stopAfter = Number.POSITIVE_INFINITY) {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

/**
 * Persist one graph to a localStorage-compatible object.
 *
 * `graph.positions` may be the current React Flow nodes array, a Map keyed by
 * person id, or a plain object keyed by person id. It overrides stale positions
 * on `graph.people` without serializing any React Flow-only fields.
 */
export function serializeGraphForStorage(graph) {
  let serialized;
  try {
    serialized = JSON.stringify(storageDocument(graph));
  } catch {
    return failure("SERIALIZE_FAILED", "无法序列化当前关系图，请检查人物和关系数据。");
  }

  const bytes = utf8ByteLength(serialized, GRAPH_STORAGE_MAX_BYTES);
  if (bytes > GRAPH_STORAGE_MAX_BYTES) {
    return failure("TOO_LARGE", "关系图数据超过 25 MB，无法保存到本地。");
  }

  try {
    parseGraphDocument(serialized);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "数据格式无效";
    return failure("INVALID_GRAPH", `关系图数据无效：${reason}`);
  }

  return { ok: true, content: serialized, bytes };
}

export function saveGraph(storage, graph, storageKey = GRAPH_STORAGE_KEY) {
  const prepared = serializeGraphForStorage(graph);
  if (!prepared.ok) return prepared;

  try {
    storage.setItem(storageKey, prepared.content);
  } catch {
    return failure("STORAGE_WRITE_FAILED", "无法保存关系图，请检查本地存储权限或可用空间。");
  }

  return { ok: true, bytes: prepared.bytes };
}

export function parseGraphFromStorage(serialized) {
  if (serialized === null) return { ok: true, found: false, graph: null };
  if (typeof serialized !== "string") {
    return failure("INVALID_DATA", "本地保存的关系图已损坏：存储内容不是文本。");
  }

  const bytes = utf8ByteLength(serialized, GRAPH_STORAGE_MAX_BYTES);
  if (bytes > GRAPH_STORAGE_MAX_BYTES) {
    return failure("TOO_LARGE", "本地保存的关系图超过 25 MB，无法载入。");
  }

  try {
    return {
      ok: true,
      found: true,
      graph: parseGraphDocument(serialized),
      bytes,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "数据格式无效";
    return failure("INVALID_DATA", `本地保存的关系图已损坏：${reason}`);
  }
}

/** Load and strictly normalize the stored graph through parseGraphDocument. */
export function loadGraph(storage, storageKey = GRAPH_STORAGE_KEY) {
  let serialized;
  try {
    serialized = storage.getItem(storageKey);
  } catch {
    return failure("STORAGE_READ_FAILED", "无法读取本地关系图，请检查本地存储权限。");
  }
  return parseGraphFromStorage(serialized);
}

/** Remove only this module's versioned graph key. */
export function clearGraph(storage, storageKey = GRAPH_STORAGE_KEY) {
  try {
    storage.removeItem(storageKey);
    return { ok: true };
  } catch {
    return failure("STORAGE_CLEAR_FAILED", "无法清除本地关系图，请检查本地存储权限。");
  }
}
