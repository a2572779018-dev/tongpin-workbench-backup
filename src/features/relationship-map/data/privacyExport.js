function anonymousPersonId(index, isSelf) {
  return isSelf ? "self" : `contact-${String(index).padStart(3, "0")}`;
}

/**
 * Build a shareable graph copy without names, account identifiers, contact
 * details, avatars, groups, tags, free-text notes, precise activity metrics,
 * original coordinates, or relationship topology.
 */
export function createPrivacySafeGraph({ people = [] } = {}) {
  const idMap = new Map();
  let contactIndex = 0;

  for (const person of people) {
    const isSelf = person?.level === "self" || person?.id === "self";
    if (!isSelf) contactIndex += 1;
    idMap.set(person?.id, anonymousPersonId(contactIndex, isSelf));
  }

  const anonymousPeople = people.map((person) => {
    const id = idMap.get(person?.id);
    const isSelf = id === "self";
    const displayIndex = isSelf ? 0 : Number(id.slice("contact-".length));

    return {
      id,
      name: isSelf ? "我" : `联系人 ${String(displayIndex).padStart(2, "0")}`,
      alias: isSelf ? "关系中心" : "联系人",
      initial: isSelf ? "我" : "人",
      avatar: null,
      level: isSelf ? "self" : person.level,
      relationship: isSelf ? "自己" : "朋友",
      cooperationStatus: "collaborated",
      community: "未分组",
      interactions: 0,
      lastContact: "暂无记录",
      activeDays: 0,
      mutual: 0,
      phone: "",
      wechat: "",
      tags: [],
      note: "",
    };
  });

  return {
    title: "关系图隐私副本",
    people: anonymousPeople,
    connections: [],
  };
}

export function relationshipReportTitle(graphTitle, privacy) {
  return privacy ? "关系摘要（隐私副本）" : `${graphTitle} · 关系摘要`;
}

export function createPrivacySafeReportSummary() {
  return {
    people: "已隐藏",
    connections: "已隐藏",
    corePeople: "已隐藏",
    mostActive: null,
  };
}
