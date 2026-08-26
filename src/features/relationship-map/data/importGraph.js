import { CUSTOMER_COOPERATION_STATUS, normalizeCustomerCooperationStatus } from "./customerStatus.js";

const LEVELS = new Set(["self", "core", "close", "acquaintance", "weak"]);
const RELATIONSHIPS = new Set(["自己", "家人", "朋友", "同事", "社群", "弱联系", "已合作客户", "待合作客户"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_PEOPLE = 5000;
const MAX_CONNECTIONS = 20000;
const MAX_CLUSTERS = 5000;

function asString(value, fallback = "", maxLength = 2000) {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

function asNonNegativeInteger(value, fallback = 0) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function safeAvatar(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 8_000_000) return null;
  if (/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(value)) return value;
  if (value.startsWith("blob:")) return value;
  if (/^(\.\/|\/assets\/)[A-Za-z0-9._/-]+$/.test(value) && !value.includes("..")) return value;
  return null;
}

function radialPosition(index, total) {
  if (index === 0) return { x: 620, y: 315 };
  const friendIndex = index - 1;
  const ring = Math.floor(friendIndex / 10);
  const ringStart = ring * 10;
  const ringCount = Math.min(10, Math.max(1, total - 1 - ringStart));
  const slot = friendIndex - ringStart;
  const radiusX = 340 + ring * 210;
  const radiusY = 255 + ring * 155;
  const angle = -Math.PI / 2 + (slot / ringCount) * Math.PI * 2;
  return {
    x: Math.round(620 + Math.cos(angle) * radiusX),
    y: Math.round(315 + Math.sin(angle) * radiusY),
  };
}

function normalizePosition(value, index, total) {
  if (value && Number.isFinite(value.x) && Number.isFinite(value.y)) {
    return {
      x: Math.max(-100000, Math.min(100000, value.x)),
      y: Math.max(-100000, Math.min(100000, value.y)),
    };
  }
  return radialPosition(index, total);
}

function normalizePerson(person, index, total, idMap) {
  if (!person || typeof person !== "object") throw new Error(`第 ${index + 1} 个人物不是有效对象`);
  const originalId = asString(person.id, "", 64);
  if (!ID_PATTERN.test(originalId)) throw new Error(`人物 ID 无效：${originalId || `第 ${index + 1} 项`}`);
  const level = LEVELS.has(person.level) ? person.level : "acquaintance";
  const id = idMap.get(originalId) || originalId;
  const name = asString(person.name, "", 80).trim();
  if (!name) throw new Error(`人物 ${originalId} 缺少姓名`);
  const relationship = RELATIONSHIPS.has(person.relationship)
    ? person.relationship
    : level === "self" ? "自己" : "朋友";

  return {
    id,
    name,
    alias: asString(person.alias, relationship, 80),
    initial: asString(person.initial, Array.from(name)[0] || "人", 4),
    avatar: safeAvatar(person.avatar),
    level,
    relationship,
    cooperationStatus: level === "self"
      ? CUSTOMER_COOPERATION_STATUS.COLLABORATED
      : normalizeCustomerCooperationStatus(person.cooperationStatus),
    community: asString(person.community, "未分组", 80),
    interactions: asNonNegativeInteger(person.interactions),
    lastContact: asString(person.lastContact, "暂无记录", 80),
    activeDays: asNonNegativeInteger(person.activeDays),
    mutual: asNonNegativeInteger(person.mutual),
    phone: asString(person.phone, "", 80),
    wechat: asString(person.wechat, "", 120),
    tags: Array.isArray(person.tags)
      ? [...new Set(person.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim().slice(0, 40)))].slice(0, 20)
      : [],
    note: asString(person.note, "暂无关系洞察。", 2000),
    position: normalizePosition(person.position, index, total),
  };
}

function normalizeConnections(items, peopleIds, idMap) {
  if (!Array.isArray(items)) throw new Error("connections 必须是数组");
  const seen = new Set();
  return items.map((connection, index) => {
    const tuple = Array.isArray(connection);
    const originalSource = asString(tuple ? connection[0] : connection?.source, "", 64);
    const originalTarget = asString(tuple ? connection[1] : connection?.target, "", 64);
    const source = idMap.get(originalSource) || originalSource;
    const target = idMap.get(originalTarget) || originalTarget;
    const relationshipValue = asString(tuple ? connection[2] : connection?.relationship, "", 40).trim();
    const relationship = relationshipValue || "朋友";
    const strengthValue = tuple ? connection[3] : connection?.strength;
    const note = asString(tuple ? connection[4] : connection?.note, "", 1000).trim();

    if (!peopleIds.has(source) || !peopleIds.has(target)) {
      throw new Error(`第 ${index + 1} 条连接引用了不存在的人物`);
    }
    if (source === target) throw new Error(`第 ${index + 1} 条连接不能指向同一人物`);
    if (strengthValue !== undefined && (!Number.isFinite(strengthValue) || strengthValue < 0 || strengthValue > 1)) {
      throw new Error(`第 ${index + 1} 条连接的 strength 必须在 0 到 1 之间`);
    }
    const key = [source, target].sort().join("::");
    if (seen.has(key)) throw new Error(`检测到重复连接：${source} 与 ${target}`);
    seen.add(key);

    const normalized = {
      source,
      target,
      relationship,
      strength: strengthValue === undefined ? 0.65 : strengthValue,
    };
    if (note) normalized.note = note;
    return normalized;
  });
}

function normalizeStandardGraph(payload) {
  if (!Array.isArray(payload.people) || payload.people.length === 0) throw new Error("people 至少需要一个人物");
  if (payload.people.length > MAX_PEOPLE) throw new Error(`人物数量不能超过 ${MAX_PEOPLE}`);
  if (!Array.isArray(payload.connections) || payload.connections.length > MAX_CONNECTIONS) throw new Error("connections 无效或数量过多");

  const selfPeople = payload.people.filter((person) => person?.level === "self");
  if (selfPeople.length !== 1) throw new Error("关系图必须且只能有一个 level 为 self 的中心人物");
  const selfOriginalId = asString(selfPeople[0].id, "", 64);
  const idMap = new Map([[selfOriginalId, "self"]]);
  const ordered = [selfPeople[0], ...payload.people.filter((person) => person !== selfPeople[0])];
  const people = ordered.map((person, index) => normalizePerson(person, index, ordered.length, idMap));
  const ids = new Set();
  for (const person of people) {
    if (ids.has(person.id)) throw new Error(`人物 ID 重复：${person.id}`);
    ids.add(person.id);
  }

  return {
    schemaVersion: "1.0",
    title: asString(payload.title, "我的关系图", 120) || "我的关系图",
    generatedAt: asString(payload.generatedAt, new Date().toISOString(), 64),
    people,
    connections: normalizeConnections(payload.connections, ids, idMap),
  };
}

const TIER_TO_LEVEL = { self: "self", A: "core", B: "close", C: "acquaintance", D: "weak", E: "weak" };
const EDGE_TYPE_TO_RELATIONSHIP = {
  private: "朋友",
  close_pair: "朋友",
  dm_inferred: "朋友",
  co_group: "社群",
  co_active: "社群",
  mutual_reply: "社群",
  mention: "社群",
  moments_cross: "朋友",
};

function adaptMurmurGraph(payload) {
  const sourceNodes = payload.nodes;
  const sourceEdges = payload.edges;
  const sourceClusters = payload.clusters ?? [];

  if (sourceNodes.length > MAX_PEOPLE) throw new Error(`人物数量不能超过 ${MAX_PEOPLE}`);
  if (sourceEdges.length > MAX_CONNECTIONS) throw new Error(`连接数量不能超过 ${MAX_CONNECTIONS}`);
  if (!Array.isArray(sourceClusters)) throw new Error("clusters 必须是数组");
  if (sourceClusters.length > MAX_CLUSTERS) throw new Error(`分组数量不能超过 ${MAX_CLUSTERS}`);

  const selfNode = sourceNodes.find((node) => node?.is_self || node?.tier === "self" || node?.id === "self");
  if (!selfNode) throw new Error("Murmur 图数据中没有找到中心人物");
  const clusterLabels = new Map(sourceClusters.map((cluster) => [cluster.id, cluster.label || cluster.id]));
  const ordered = [selfNode, ...sourceNodes.filter((node) => node !== selfNode)];
  let maxScore = 1;
  for (const node of ordered) {
    maxScore = Math.max(maxScore, Number(node.combined_score) || 0);
  }
  const people = ordered.map((node, index) => {
    const level = TIER_TO_LEVEL[node.tier] || (node.is_self ? "self" : "acquaintance");
    const name = asString(node.name, level === "self" ? "你" : `联系人 ${index}`, 80);
    const score = Number(node.combined_score) || 0;
    return {
      id: level === "self" ? "self" : asString(node.id, `person-${index}`, 64),
      name: level === "self" ? "你" : name,
      alias: level === "self" ? "关系中心" : `Murmur ${node.tier || "C"} 级关系`,
      initial: level === "self" ? "我" : Array.from(name)[0] || "人",
      avatar: null,
      level,
      relationship: level === "self" ? "自己" : "朋友",
      cooperationStatus: CUSTOMER_COOPERATION_STATUS.COLLABORATED,
      community: clusterLabels.get(node.cluster) || "未分组",
      interactions: asNonNegativeInteger((node.private_msgs || 0) + (node.group_msgs || 0)),
      lastContact: "来自 Murmur 图数据",
      activeDays: 0,
      mutual: asNonNegativeInteger(node.groups),
      phone: "",
      wechat: "",
      tags: [level === "core" ? "核心圈" : "Murmur 导入", ...(node.bridge ? ["桥梁人物"] : [])],
      note: `Murmur 综合关系分 ${Math.round((score / maxScore) * 100)}，请结合原始数据语境判断。`,
      position: Number.isFinite(node.x) && Number.isFinite(node.y)
        ? { x: Math.round(620 + node.x), y: Math.round(315 + node.y) }
        : radialPosition(index, ordered.length),
    };
  });
  const idMap = new Map([[String(selfNode.id), "self"]]);
  const ids = new Set(people.map((person) => person.id));
  const connections = sourceEdges
    .map((edge) => ({
      source: idMap.get(String(edge.source)) || String(edge.source),
      target: idMap.get(String(edge.target)) || String(edge.target),
      relationship: EDGE_TYPE_TO_RELATIONSHIP[edge.type] || "社群",
      strength: Math.max(0.05, Math.min(1, Number(edge.weight) || 0.5)),
    }))
    .filter((edge) => ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target);

  return normalizeStandardGraph({
    schemaVersion: "1.0",
    title: asString(payload.title, "Murmur 导入关系图", 120),
    generatedAt: new Date().toISOString(),
    people,
    connections,
  });
}

export function parseGraphDocument(input) {
  let payload;
  try {
    payload = typeof input === "string" ? JSON.parse(input) : input;
  } catch {
    throw new Error("文件不是有效的 JSON");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("关系图文件必须是 JSON 对象");
  if (Array.isArray(payload.nodes) && Array.isArray(payload.edges)) return adaptMurmurGraph(payload);
  if (payload.schemaVersion !== "1.0") throw new Error("当前仅支持 schemaVersion 1.0 或 Murmur GraphData");
  return normalizeStandardGraph(payload);
}

export function serializeGraphDocument({ title, people, connections }) {
  return JSON.stringify({
    schemaVersion: "1.0",
    title,
    generatedAt: new Date().toISOString(),
    people: people.map(({ position, ...person }) => ({ ...person, position })),
    connections: connections.map((connection) => {
      if (!Array.isArray(connection)) return connection;
      const serialized = {
        source: connection[0],
        target: connection[1],
        relationship: connection[2],
        strength: connection[3] ?? 0.65,
      };
      if (connection[4]) serialized.note = connection[4];
      return serialized;
    }),
  }, null, 2);
}
