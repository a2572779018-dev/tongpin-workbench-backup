export const RELATIONSHIP_PRESETS = [
  "直接合作",
  "客户引荐",
  "共同项目",
  "供应合作",
  "渠道合作",
  "家人",
  "朋友",
  "同事",
  "社群",
  "弱联系",
];

export const RELATIONSHIP_LIMITS = {
  type: 40,
  note: 1000,
};

export function relationPersonOptionLabel(person, privacy = false) {
  const visualName = person?.visualName || person?.name || "未命名人物";
  return !privacy && person?.alias ? `${visualName} · ${person.alias}` : visualName;
}

export function connectionRecord(connection) {
  if (Array.isArray(connection)) {
    return {
      source: connection[0] ?? "",
      target: connection[1] ?? "",
      relationship: connection[2] ?? "",
      strength: connection[3],
      note: connection[4] ?? "",
    };
  }

  return {
    source: connection?.source ?? "",
    target: connection?.target ?? "",
    relationship: connection?.relationship ?? "",
    strength: connection?.strength,
    note: connection?.note ?? "",
  };
}

export function connectionKey(source, target) {
  return [source, target].sort().join("::");
}

export function validateConnectionDraft(draft, people, connections, editingIndex = -1) {
  const errors = {};
  const peopleIds = new Set(people.map((person) => person.id));
  const relationship = typeof draft.relationship === "string" ? draft.relationship.trim() : "";
  const note = typeof draft.note === "string" ? draft.note.trim() : "";

  if (!draft.source) errors.source = "请选择起点人物";
  else if (!peopleIds.has(draft.source)) errors.source = "起点人物已不在当前关系图中";

  if (!draft.target) errors.target = "请选择终点人物";
  else if (!peopleIds.has(draft.target)) errors.target = "终点人物已不在当前关系图中";
  else if (draft.source === draft.target) errors.target = "起点和终点不能是同一人";

  if (!relationship) errors.relationship = "请选择或填写关系类型";
  else if (relationship.length > RELATIONSHIP_LIMITS.type) errors.relationship = `关系类型不能超过 ${RELATIONSHIP_LIMITS.type} 个字符`;

  if (note.length > RELATIONSHIP_LIMITS.note) errors.note = `备注不能超过 ${RELATIONSHIP_LIMITS.note} 个字符`;

  if (draft.strength !== undefined && draft.strength !== null && draft.strength !== "") {
    if (!Number.isFinite(draft.strength) || draft.strength < 0 || draft.strength > 1) {
      errors.strength = "关系强度必须在 0% 到 100% 之间";
    }
  }

  if (!errors.source && !errors.target) {
    const key = connectionKey(draft.source, draft.target);
    const duplicate = connections.some((connection, index) => {
      if (index === editingIndex) return false;
      const existing = connectionRecord(connection);
      return connectionKey(existing.source, existing.target) === key;
    });
    if (duplicate) errors.target = "这两个人物之间已有关系，请在人物详情中编辑";
  }

  return errors;
}

export function buildConnectionRecord(draft) {
  const record = {
    source: draft.source,
    target: draft.target,
    relationship: draft.relationship.trim(),
    strength: draft.strength === undefined || draft.strength === null || draft.strength === ""
      ? 0.65
      : draft.strength,
  };

  const note = typeof draft.note === "string" ? draft.note.trim() : "";
  if (note) record.note = note;
  return record;
}

export function connectionsForPerson(connections, personId) {
  return connections.flatMap((connection, index) => {
    const record = connectionRecord(connection);
    return record.source === personId || record.target === personId
      ? [{ ...record, index }]
      : [];
  });
}
