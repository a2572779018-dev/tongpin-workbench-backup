import { buildCustomerHierarchy } from "./customerTreeLayout.js";

export const IDENTITY_COLOR_LABEL_MAX_LENGTH = 24;

export const IDENTITY_COLOR_KEYS = Object.freeze([
  "yellow",
  "blue",
  "pink",
  "green",
]);

export const IDENTITY_COLOR_PALETTE = Object.freeze({
  yellow: "#ffd84d",
  blue: "#8ab8f5",
  pink: "#ffcaca",
  green: "#bfeea5",
});

export const DEFAULT_IDENTITY_COLOR_SEMANTICS = Object.freeze({
  yellow: "合伙人",
  blue: "客户",
  pink: "渠道",
  green: "其他",
});

// Graphs written before identity colors existed used these colors purely for
// tree depth. Keeping neutral legacy labels avoids reclassifying every old
// first-level contact as a partner during migration.
export const LEGACY_IDENTITY_COLOR_SEMANTICS = Object.freeze({
  yellow: "一级关系",
  blue: "二级关系",
  pink: "三级关系",
  green: "四级及以上",
});

const IDENTITY_COLOR_KEY_SET = new Set(IDENTITY_COLOR_KEYS);
const LEGACY_LEVEL_COLOR_KEYS = Object.freeze({
  self: "yellow",
  core: "yellow",
  close: "blue",
  acquaintance: "pink",
  weak: "green",
});

export function isIdentityColorKey(value) {
  return typeof value === "string" && IDENTITY_COLOR_KEY_SET.has(value);
}

export function normalizeIdentityColorKey(value, fallback = "blue") {
  if (isIdentityColorKey(value)) return value;
  return isIdentityColorKey(fallback) ? fallback : "blue";
}

export function legacyIdentityColorKeyForLevel(level) {
  return LEGACY_LEVEL_COLOR_KEYS[level] || "blue";
}

export function legacyIdentityColorKeyForDepth(depth, fallbackLevel) {
  if (!Number.isFinite(depth) || depth < 0) {
    return legacyIdentityColorKeyForLevel(fallbackLevel);
  }
  if (depth <= 1) return "yellow";
  if (depth === 2) return "blue";
  if (depth === 3) return "pink";
  return "green";
}

function normalizedLabel(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return Array.from(trimmed).slice(0, IDENTITY_COLOR_LABEL_MAX_LENGTH).join("");
}

/**
 * Keep the identity meaning of each fixed color in one graph-level mapping.
 * Unknown colors are intentionally discarded: callers can only select from
 * the product's four audited colors, while labels remain user-editable.
 */
export function normalizeIdentityColorSemantics(value) {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
  return Object.fromEntries(IDENTITY_COLOR_KEYS.map((colorKey) => [
    colorKey,
    normalizedLabel(source[colorKey], DEFAULT_IDENTITY_COLOR_SEMANTICS[colorKey]),
  ]));
}

export function identityColorLabel(colorKey, semantics = DEFAULT_IDENTITY_COLOR_SEMANTICS) {
  const normalizedKey = normalizeIdentityColorKey(colorKey);
  return normalizeIdentityColorSemantics(semantics)[normalizedKey];
}

export function updateIdentityColorSemantic(semantics, colorKey, label) {
  if (!isIdentityColorKey(colorKey)) throw new Error("请选择有效的身份颜色");
  const trimmed = typeof label === "string" ? label.trim() : "";
  if (!trimmed) throw new Error("请输入颜色代表的身份");
  return normalizeIdentityColorSemantics({
    ...normalizeIdentityColorSemantics(semantics),
    [colorKey]: trimmed,
  });
}

/**
 * Upgrade graphs saved before identity colors existed without changing their
 * appearance. Connected people inherit the old depth colors. Disconnected
 * people use the old level colors because they have no tree depth. An explicit
 * valid colorKey always wins so later topology edits cannot change identity.
 */
export function migrateLegacyPersonColorKeys(people = [], connections = []) {
  const peopleList = Array.isArray(people) ? people : [];
  const hierarchy = buildCustomerHierarchy(peopleList, Array.isArray(connections) ? connections : []);

  return peopleList.map((person) => {
    if (isIdentityColorKey(person?.colorKey)) return person;
    const depth = hierarchy.depthById.get(person?.id);
    return {
      ...person,
      colorKey: legacyIdentityColorKeyForDepth(depth, person?.level),
    };
  });
}
