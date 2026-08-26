import { CUSTOMER_COOPERATION_STATUS, normalizeCustomerCooperationStatus } from "./customerStatus.js";

export const PERSON_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const PERSON_LEVELS = ["core", "close", "acquaintance", "weak"];
export const PERSON_RELATIONSHIPS = ["家人", "朋友", "同事", "社群", "弱联系", "已合作客户", "待合作客户"];

export const PERSON_LIMITS = {
  name: 80,
  alias: 80,
  relationship: 40,
  community: 80,
  phone: 80,
  wechat: 120,
  tag: 40,
  tags: 20,
  note: 2000,
  avatar: 8_000_000,
};

export const PERSON_POSITION_MIN_DISTANCE = 180;

const DEFAULT_CENTER = { x: 620, y: 315 };
const TAG_SEPARATOR = /[,，、;；\n\r]+/;
const DATA_IMAGE_PATTERN = /^data:image\/(?:png|jpe?g|webp|gif);base64,/i;

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function characterCount(value) {
  return Array.from(value).length;
}

function editingPersonFrom(value) {
  if (!value || typeof value !== "object") return null;
  return value.editingPerson && typeof value.editingPerson === "object"
    ? value.editingPerson
    : value.id
      ? value
      : null;
}

function isSelfPerson(person) {
  return person?.id === "self" || person?.level === "self";
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function avatarWasChanged(draft, editingPerson) {
  return hasOwn(draft, "avatar") && draft.avatar !== editingPerson?.avatar;
}

function normalizedInitial(name) {
  const firstCharacter = Array.from(name)[0] || "人";
  return /^[a-z]$/i.test(firstCharacter) ? firstCharacter.toLocaleUpperCase("en-US") : firstCharacter;
}

/**
 * Accept either the form's comma-delimited value or an already structured tag
 * array. Array entries may also contain delimiters, which keeps pasted values
 * consistent with typed values.
 */
export function splitPersonTags(value) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const tags = [];
  const seen = new Set();

  source.forEach((entry) => {
    if (typeof entry !== "string") return;
    entry.split(TAG_SEPARATOR).forEach((part) => {
      const tag = part.trim();
      if (!tag || seen.has(tag)) return;
      seen.add(tag);
      tags.push(tag);
    });
  });

  return tags;
}

export const normalizePersonTags = splitPersonTags;

export function isPersonAvatarDataUri(value) {
  return typeof value === "string"
    && value.length <= PERSON_LIMITS.avatar
    && DATA_IMAGE_PATTERN.test(value);
}

/**
 * Validate only serializable form data. Reading and validating a selected File
 * belongs to the caller; this model accepts the resulting data URI or null.
 */
export function validatePersonDraft(draft = {}, optionsOrEditingPerson = {}) {
  const editingPerson = editingPersonFrom(optionsOrEditingPerson);
  const editingSelf = isSelfPerson(editingPerson);
  const errors = {};
  const name = trimmedString(draft.name);
  const alias = trimmedString(draft.alias);
  const relationship = trimmedString(draft.relationship);
  const community = trimmedString(draft.community);
  const phone = trimmedString(draft.phone);
  const wechat = trimmedString(draft.wechat);
  const note = trimmedString(draft.note);

  if (!name) errors.name = "请输入姓名";
  else if (characterCount(name) > PERSON_LIMITS.name) errors.name = `姓名不能超过 ${PERSON_LIMITS.name} 个字符`;

  if (!alias) errors.alias = "请输入身份备注";
  else if (characterCount(alias) > PERSON_LIMITS.alias) errors.alias = `身份备注不能超过 ${PERSON_LIMITS.alias} 个字符`;

  if (!editingSelf) {
    if (!relationship) errors.relationship = "请选择关系类型";
    else if (characterCount(relationship) > PERSON_LIMITS.relationship) {
      errors.relationship = `关系类型不能超过 ${PERSON_LIMITS.relationship} 个字符`;
    } else if (!PERSON_RELATIONSHIPS.includes(relationship)) {
      errors.relationship = "请选择有效的关系类型";
    }

    if (draft.level === "self") errors.level = "普通人物不能设为中心人物";
    else if (!PERSON_LEVELS.includes(draft.level)) errors.level = "请选择有效的关系层级";

    if (![CUSTOMER_COOPERATION_STATUS.COLLABORATED, CUSTOMER_COOPERATION_STATUS.PENDING].includes(draft.cooperationStatus)) {
      errors.cooperationStatus = "请选择有效的合作状态";
    }
  }

  if (!community) errors.community = "请输入所属分组";
  else if (characterCount(community) > PERSON_LIMITS.community) errors.community = `分组不能超过 ${PERSON_LIMITS.community} 个字符`;
  if (characterCount(phone) > PERSON_LIMITS.phone) errors.phone = `手机号不能超过 ${PERSON_LIMITS.phone} 个字符`;
  if (characterCount(wechat) > PERSON_LIMITS.wechat) errors.wechat = `微信号不能超过 ${PERSON_LIMITS.wechat} 个字符`;
  if (characterCount(note) > PERSON_LIMITS.note) errors.note = `备注不能超过 ${PERSON_LIMITS.note} 个字符`;

  if (draft.tags !== undefined && typeof draft.tags !== "string" && !Array.isArray(draft.tags)) {
    errors.tags = "标签格式无效";
  } else if (Array.isArray(draft.tags) && draft.tags.some((tag) => typeof tag !== "string")) {
    errors.tags = "标签必须是文本";
  } else {
    const tags = splitPersonTags(draft.tags);
    if (tags.some((tag) => characterCount(tag) > PERSON_LIMITS.tag)) {
      errors.tags = `单个标签不能超过 ${PERSON_LIMITS.tag} 个字符`;
    } else if (tags.length > PERSON_LIMITS.tags) {
      errors.tags = `标签不能超过 ${PERSON_LIMITS.tags} 个`;
    }
  }

  if (avatarWasChanged(draft, editingPerson)) {
    if (draft.avatar !== null && !isPersonAvatarDataUri(draft.avatar)) {
      errors.avatar = "头像必须是已验证的图片数据";
    }
  }

  return errors;
}

function asciiIdBase(name) {
  const normalized = trimmedString(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safeBase = !normalized || normalized === "self" ? "person" : normalized;
  return safeBase.slice(0, 64).replace(/-+$/g, "") || "person";
}

export function createPersonId(name, people = []) {
  const usedIds = new Set(
    (Array.isArray(people) ? people : [])
      .map((person) => typeof person?.id === "string" ? person.id.toLocaleLowerCase("en-US") : "")
      .filter(Boolean),
  );
  const base = asciiIdBase(name);

  if (!usedIds.has(base)) return base;

  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const suffixText = `-${suffix}`;
    const candidate = `${base.slice(0, 64 - suffixText.length).replace(/-+$/g, "")}${suffixText}`;
    if (!usedIds.has(candidate)) return candidate;
  }

  throw new Error("无法生成唯一人物 ID");
}

export const generateUniquePersonId = createPersonId;

function finitePosition(position) {
  return position && Number.isFinite(position.x) && Number.isFinite(position.y)
    ? { x: position.x, y: position.y }
    : null;
}

function distanceSquared(first, second) {
  return (first.x - second.x) ** 2 + (first.y - second.y) ** 2;
}

/**
 * Find the first free slot on progressively larger elliptical rings. The
 * canonical expanded positions can be passed directly, and every returned
 * point maintains a node-sized gap from all known positions.
 */
export function findAvailablePersonPosition(people = [], minDistance = PERSON_POSITION_MIN_DISTANCE) {
  const list = Array.isArray(people) ? people : [];
  const self = list.find(isSelfPerson);
  const center = finitePosition(self?.position) || DEFAULT_CENTER;
  const occupied = list
    .map((person) => finitePosition(person?.position) || (isSelfPerson(person) ? center : null))
    .filter(Boolean);
  const safeMinimum = Number.isFinite(minDistance) && minDistance > 0
    ? minDistance
    : PERSON_POSITION_MIN_DISTANCE;
  const minimumSquared = safeMinimum ** 2;

  if (occupied.length === 0) return { ...center };

  for (let ring = 0; ring < 512; ring += 1) {
    const slots = 12 + ring * 4;
    const radiusX = 340 + ring * 190;
    const radiusY = 255 + ring * 155;

    for (let slot = 0; slot < slots; slot += 1) {
      const angle = -Math.PI / 2 + (slot / slots) * Math.PI * 2;
      const candidate = {
        x: Math.round(center.x + Math.cos(angle) * radiusX),
        y: Math.round(center.y + Math.sin(angle) * radiusY),
      };

      if (occupied.every((position) => distanceSquared(position, candidate) >= minimumSquared)) {
        return candidate;
      }
    }
  }

  throw new Error("无法为新人物找到空闲位置");
}

export const calculatePersonPosition = findAvailablePersonPosition;

function validationError(errors) {
  const error = new Error(Object.values(errors)[0] || "人物信息无效");
  error.name = "PersonDraftValidationError";
  error.errors = errors;
  return error;
}

export function buildPersonRecord(draft, people = [], editingPersonValue = null) {
  const editingPerson = editingPersonFrom(editingPersonValue);
  const errors = validatePersonDraft(draft, { editingPerson });
  if (Object.keys(errors).length > 0) throw validationError(errors);

  const editingSelf = isSelfPerson(editingPerson);
  const name = trimmedString(draft.name);
  const relationship = editingSelf ? "自己" : trimmedString(draft.relationship);
  const commonFields = {
    name,
    alias: trimmedString(draft.alias),
    initial: normalizedInitial(name),
    level: editingSelf ? "self" : draft.level,
    relationship,
    cooperationStatus: editingSelf
      ? CUSTOMER_COOPERATION_STATUS.COLLABORATED
      : normalizeCustomerCooperationStatus(draft.cooperationStatus),
    community: trimmedString(draft.community),
    phone: trimmedString(draft.phone),
    wechat: trimmedString(draft.wechat),
    tags: splitPersonTags(draft.tags),
    note: trimmedString(draft.note),
  };

  if (editingPerson) {
    const result = {
      ...editingPerson,
      ...commonFields,
      id: editingPerson.id,
    };
    if (avatarWasChanged(draft, editingPerson)) result.avatar = draft.avatar;
    return result;
  }

  return {
    id: createPersonId(name, people),
    ...commonFields,
    avatar: hasOwn(draft, "avatar") ? draft.avatar : null,
    interactions: 0,
    lastContact: "暂无记录",
    activeDays: 0,
    mutual: 0,
    position: findAvailablePersonPosition(people),
  };
}

function connectionEndpoints(connection) {
  return Array.isArray(connection)
    ? { source: connection[0], target: connection[1] }
    : { source: connection?.source, target: connection?.target };
}

export function planPersonDeletion(personId, people = [], connections = []) {
  const peopleList = Array.isArray(people) ? people : [];
  const connectionList = Array.isArray(connections) ? connections : [];
  const person = peopleList.find((item) => item?.id === personId);

  if (personId === "self" || isSelfPerson(person)) throw new Error("不能删除中心人物");
  if (!person) throw new Error("要删除的人物不存在");

  const remainingConnections = connectionList.filter((connection) => {
    const { source, target } = connectionEndpoints(connection);
    return source !== personId && target !== personId;
  });

  return {
    people: peopleList.filter((item) => item?.id !== personId),
    connections: remainingConnections,
    deletedConnectionCount: connectionList.length - remainingConnections.length,
    deletedPerson: person,
  };
}

export const buildPersonDeletionPlan = planPersonDeletion;
