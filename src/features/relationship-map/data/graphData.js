import { connectionKey } from "./relationshipModel.js";

const relationshipStroke = "#44433f";

export const levelOptions = [
  { id: "all", label: "全部层级" },
  { id: "core", label: "核心圈" },
  { id: "close", label: "常联系" },
  { id: "acquaintance", label: "偶尔联系" },
  { id: "weak", label: "弱联系" },
];

export const relationshipLegend = [
  { label: "主干关系", color: relationshipStroke, dashed: false },
  { label: "补充关系（点击显示）", color: "#6c6f70", dashed: true },
];

export const people = [
  {
    id: "self",
    name: "你",
    alias: "中心人物",
    initial: "我",
    level: "self",
    relationship: "自己",
    community: "全部关系",
    interactions: 428,
    lastContact: "刚刚",
    activeDays: 26,
    mutual: 18,
    phone: "138 0000 1208",
    wechat: "demo_owner",
    tags: ["关系中心", "本地数据"],
    note: "所有演示关系均为虚构数据，仅用于预览交互。",
  },
  {
    id: "lin-lan",
    name: "林澜",
    alias: "家人",
    initial: "林",
    level: "core",
    relationship: "家人",
    community: "家庭",
    interactions: 92,
    lastContact: "今天 09:42",
    activeDays: 24,
    mutual: 7,
    phone: "138 0000 5124",
    wechat: "lan_demo",
    tags: ["核心圈", "高频联系"],
    note: "近 30 天联系最稳定，周末互动明显增多。",
  },
  {
    id: "chen-yi",
    name: "陈屹",
    alias: "大学同学",
    initial: "陈",
    level: "core",
    relationship: "朋友",
    community: "老友",
    interactions: 71,
    lastContact: "昨天 21:18",
    activeDays: 19,
    mutual: 11,
    phone: "136 0000 7618",
    wechat: "chen_demo",
    tags: ["核心圈", "共同好友多"],
    note: "对话集中在晚间，共同联系人主要来自大学社群。",
  },
  {
    id: "tang-jie",
    name: "唐婕",
    alias: "项目伙伴",
    initial: "唐",
    level: "core",
    relationship: "同事",
    community: "产品组",
    interactions: 68,
    lastContact: "今天 11:06",
    activeDays: 21,
    mutual: 13,
    phone: "139 0000 3361",
    wechat: "tang_demo",
    tags: ["工作协作", "高频联系"],
    note: "工作日沟通密集，是产品组内的关键桥接人物。",
  },
  {
    id: "zhou-xin",
    name: "周忻",
    alias: "邻居",
    initial: "周",
    level: "core",
    relationship: "朋友",
    community: "生活圈",
    interactions: 57,
    lastContact: "前天 18:32",
    activeDays: 16,
    mutual: 5,
    phone: "137 0000 8024",
    wechat: "zhou_demo",
    tags: ["生活圈", "稳定联系"],
    note: "线下见面频率高，聊天消息量相对适中。",
  },
  {
    id: "gao-yi",
    name: "高逸",
    alias: "行业朋友",
    initial: "高",
    level: "close",
    relationship: "社群",
    community: "创业社群",
    interactions: 46,
    lastContact: "8 月 21 日",
    activeDays: 13,
    mutual: 17,
    phone: "135 0000 4588",
    wechat: "gao_demo",
    tags: ["社群枢纽", "共同好友多"],
    note: "连接多个行业小组，关系扩散能力较强。",
  },
  {
    id: "li-wen",
    name: "李雯",
    alias: "前同事",
    initial: "李",
    level: "close",
    relationship: "同事",
    community: "前同事",
    interactions: 39,
    lastContact: "8 月 19 日",
    activeDays: 11,
    mutual: 9,
    phone: "158 0000 9017",
    wechat: "li_demo",
    tags: ["前同事", "持续联系"],
    note: "离开原团队后仍保持稳定沟通。",
  },
  {
    id: "song-qing",
    name: "宋晴",
    alias: "表姐",
    initial: "宋",
    level: "close",
    relationship: "家人",
    community: "家庭",
    interactions: 34,
    lastContact: "8 月 18 日",
    activeDays: 10,
    mutual: 6,
    phone: "186 0000 4430",
    wechat: "song_demo",
    tags: ["家庭", "节假日活跃"],
    note: "家庭群互动较多，私聊频率中等。",
  },
  {
    id: "luo-ke",
    name: "罗可",
    alias: "设计师",
    initial: "罗",
    level: "close",
    relationship: "同事",
    community: "产品组",
    interactions: 32,
    lastContact: "8 月 20 日",
    activeDays: 14,
    mutual: 8,
    phone: "188 0000 6631",
    wechat: "luo_demo",
    tags: ["工作协作", "设计"],
    note: "多次参与同一项目，与唐婕形成稳定协作链。",
  },
  {
    id: "wu-heng",
    name: "吴衡",
    alias: "球友",
    initial: "吴",
    level: "close",
    relationship: "朋友",
    community: "运动圈",
    interactions: 29,
    lastContact: "8 月 17 日",
    activeDays: 9,
    mutual: 4,
    phone: "189 0000 7802",
    wechat: "wu_demo",
    tags: ["运动圈", "线下互动"],
    note: "每周固定联系，线上消息主要用于活动确认。",
  },
  {
    id: "he-miao",
    name: "何淼",
    alias: "校友",
    initial: "何",
    level: "acquaintance",
    relationship: "社群",
    community: "校友会",
    interactions: 22,
    lastContact: "8 月 12 日",
    activeDays: 7,
    mutual: 12,
    phone: "133 0000 2289",
    wechat: "he_demo",
    tags: ["校友", "社群联系"],
    note: "主要在校友活动前后出现互动。",
  },
  {
    id: "xu-yan",
    name: "徐妍",
    alias: "合作方",
    initial: "徐",
    level: "acquaintance",
    relationship: "同事",
    community: "合作伙伴",
    interactions: 19,
    lastContact: "8 月 9 日",
    activeDays: 6,
    mutual: 5,
    phone: "181 0000 1873",
    wechat: "xu_demo",
    tags: ["合作方", "阶段性联系"],
    note: "沟通受项目阶段影响，近期活跃度有所下降。",
  },
  {
    id: "ma-jun",
    name: "马骏",
    alias: "群友",
    initial: "马",
    level: "acquaintance",
    relationship: "社群",
    community: "创业社群",
    interactions: 17,
    lastContact: "8 月 7 日",
    activeDays: 5,
    mutual: 10,
    phone: "152 0000 6482",
    wechat: "ma_demo",
    tags: ["群聊", "共同好友"],
    note: "直接私聊较少，但在群内多次参与相同话题。",
  },
  {
    id: "qiao-nan",
    name: "乔楠",
    alias: "客户",
    initial: "乔",
    level: "acquaintance",
    relationship: "弱联系",
    community: "合作伙伴",
    interactions: 12,
    lastContact: "7 月 28 日",
    activeDays: 4,
    mutual: 2,
    phone: "155 0000 7306",
    wechat: "qiao_demo",
    tags: ["客户", "低频联系"],
    note: "仅在业务节点出现联系，关系链较为单一。",
  },
  {
    id: "du-yang",
    name: "杜洋",
    alias: "朋友的朋友",
    initial: "杜",
    level: "weak",
    relationship: "弱联系",
    community: "老友",
    interactions: 8,
    lastContact: "7 月 13 日",
    activeDays: 3,
    mutual: 6,
    phone: "180 0000 1109",
    wechat: "du_demo",
    tags: ["弱联系", "共同好友"],
    note: "通过陈屹建立连接，尚未形成稳定互动。",
  },
  {
    id: "an-ran",
    name: "安然",
    alias: "活动联系人",
    initial: "安",
    level: "weak",
    relationship: "弱联系",
    community: "运动圈",
    interactions: 6,
    lastContact: "6 月 30 日",
    activeDays: 2,
    mutual: 3,
    phone: "131 0000 5927",
    wechat: "an_demo",
    tags: ["弱联系", "活动认识"],
    note: "由一次线下活动产生，暂无持续沟通。",
  },
];

const expandedPositions = {
  self: { x: 620, y: 315 },
  "lin-lan": { x: 390, y: 110 },
  "chen-yi": { x: 820, y: 105 },
  "tang-jie": { x: 920, y: 315 },
  "zhou-xin": { x: 755, y: 535 },
  "gao-yi": { x: 405, y: 535 },
  "li-wen": { x: 250, y: 335 },
  "song-qing": { x: 115, y: 80 },
  "luo-ke": { x: 1110, y: 190 },
  "wu-heng": { x: 980, y: 565 },
  "he-miao": { x: 430, y: 700 },
  "xu-yan": { x: 1160, y: 430 },
  "ma-jun": { x: 200, y: 665 },
  "qiao-nan": { x: 60, y: 430 },
  "du-yang": { x: 1050, y: -55 },
  "an-ran": { x: 1120, y: 690 },
};

const compactPositions = {
  self: { x: 620, y: 315 },
  "lin-lan": { x: 455, y: 180 },
  "chen-yi": { x: 745, y: 170 },
  "tang-jie": { x: 810, y: 330 },
  "zhou-xin": { x: 735, y: 475 },
  "gao-yi": { x: 495, y: 480 },
  "li-wen": { x: 395, y: 335 },
  "song-qing": { x: 310, y: 110 },
  "luo-ke": { x: 930, y: 210 },
  "wu-heng": { x: 900, y: 510 },
  "he-miao": { x: 465, y: 600 },
  "xu-yan": { x: 1020, y: 395 },
  "ma-jun": { x: 320, y: 565 },
  "qiao-nan": { x: 245, y: 445 },
  "du-yang": { x: 910, y: 65 },
  "an-ran": { x: 1010, y: 590 },
};

export const connections = [
  ["self", "lin-lan", "家人"],
  ["self", "chen-yi", "朋友"],
  ["self", "tang-jie", "同事"],
  ["self", "zhou-xin", "朋友"],
  ["self", "gao-yi", "社群"],
  ["self", "li-wen", "同事"],
  ["lin-lan", "song-qing", "家人"],
  ["tang-jie", "luo-ke", "同事"],
  ["zhou-xin", "wu-heng", "朋友"],
  ["gao-yi", "he-miao", "社群"],
  ["tang-jie", "xu-yan", "同事"],
  ["gao-yi", "ma-jun", "社群"],
  ["li-wen", "qiao-nan", "弱联系"],
  ["chen-yi", "du-yang", "弱联系"],
  ["wu-heng", "an-ran", "弱联系"],
  ["chen-yi", "gao-yi", "朋友"],
  ["tang-jie", "li-wen", "同事"],
  ["gao-yi", "tang-jie", "社群"],
  ["lin-lan", "zhou-xin", "朋友"],
];

const layoutCenter = { x: 620, y: 315 };
const compactScale = 0.72;

export function expandedPositionFromLayout(position, layout = "expanded") {
  if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) {
    return { ...layoutCenter };
  }
  if (layout !== "compact") return { x: position.x, y: position.y };
  return {
    x: layoutCenter.x + (position.x - layoutCenter.x) / compactScale,
    y: layoutCenter.y + (position.y - layoutCenter.y) / compactScale,
  };
}

export function positionFor(personId, layout, peopleList = people) {
  const positions = layout === "compact" ? compactPositions : expandedPositions;
  const person = peopleList.find((item) => item.id === personId);
  const explicitPosition = person?.position;
  if (explicitPosition) {
    const defaultExpanded = expandedPositions[personId];
    if (
      layout === "compact"
      && compactPositions[personId]
      && defaultExpanded
      && explicitPosition.x === defaultExpanded.x
      && explicitPosition.y === defaultExpanded.y
    ) {
      return compactPositions[personId];
    }
    if (layout !== "compact") return explicitPosition;
    return {
      x: layoutCenter.x + (explicitPosition.x - layoutCenter.x) * compactScale,
      y: layoutCenter.y + (explicitPosition.y - layoutCenter.y) * compactScale,
    };
  }
  const base = positions[personId] || layoutCenter;
  if (layout !== "compact" || positions[personId]) return base;
  return {
    x: layoutCenter.x + (base.x - layoutCenter.x) * compactScale,
    y: layoutCenter.y + (base.y - layoutCenter.y) * compactScale,
  };
}

export function createNodes(layout = "expanded", peopleList = people) {
  return peopleList.map((person) => ({
    id: person.id,
    type: "person",
    position: positionFor(person.id, layout, peopleList),
    data: { ...person, avatar: person.avatar ?? null },
    draggable: true,
    selectable: true,
  }));
}

function dominantDirection(sourcePosition, targetPosition) {
  const dx = targetPosition.x - sourcePosition.x;
  const dy = targetPosition.y - sourcePosition.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function oppositeDirection(direction) {
  return { left: "right", right: "left", top: "bottom", bottom: "top" }[direction];
}

function primaryConnectionIndexes(normalizedConnections) {
  const primary = new Set();
  const parent = new Map();

  const find = (node) => {
    if (!parent.has(node)) parent.set(node, node);
    const currentParent = parent.get(node);
    if (currentParent === node) return node;
    const root = find(currentParent);
    parent.set(node, root);
    return root;
  };

  normalizedConnections.forEach(({ source, target }, index) => {
    const sourceRoot = find(source);
    const targetRoot = find(target);
    if (sourceRoot === targetRoot) return;
    primary.add(index);
    parent.set(targetRoot, sourceRoot);
  });

  return primary;
}

export function createEdges(connectionList = connections, peopleList = people, layout = "expanded", positionOverrides = null) {
  const normalizedConnections = connectionList.map((connection) => {
    const [source, target, relationship, strength] = Array.isArray(connection)
      ? [connection[0], connection[1], connection[2], connection[3] ?? 0.65]
      : [connection.source, connection.target, connection.relationship, connection.strength ?? 0.65];
    return { source, target, relationship, strength };
  });
  const primaryIndexes = primaryConnectionIndexes(normalizedConnections);
  const positions = new Map(peopleList.map((person) => [
    person.id,
    positionOverrides?.get(person.id) || positionFor(person.id, layout, peopleList),
  ]));

  return normalizedConnections.map(({ source, target, relationship, strength }, index) => {
    const sourcePosition = positions.get(source) || { x: 620, y: 315 };
    const targetPosition = positions.get(target) || { x: 620, y: 315 };
    const sourceDirection = dominantDirection(sourcePosition, targetPosition);
    const baseWidth = relationship === "弱联系" ? 2.55 : 2.95;
    const baseOpacity = relationship === "弱联系" ? 0.72 : 0.9;
    const kind = primaryIndexes.has(index) ? "primary" : "cross";

    return {
      id: `edge-${connectionKey(source, target)}`,
      source,
      target,
      sourceHandle: `source-${sourceDirection}`,
      targetHandle: `target-${oppositeDirection(sourceDirection)}`,
      type: "default",
      style: {
        stroke: relationshipStroke,
        strokeWidth: baseWidth,
        opacity: kind === "cross" ? 0 : baseOpacity,
        strokeDasharray: kind === "cross" ? "7 8" : undefined,
      },
      animated: false,
      data: { relationship, strength, kind, baseWidth, baseOpacity },
    };
  });
}

export function displayName(person, privacy, index = 0) {
  if (!privacy || person.id === "self") return person.name;
  return `联系人 ${String(index + 1).padStart(2, "0")}`;
}
