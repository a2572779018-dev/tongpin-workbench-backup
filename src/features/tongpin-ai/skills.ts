export const MAX_SELECTED_SKILLS = 3;
export const REVIEWED_SKILL_IDS = ["content-editor", "deep-research", "slide-maker", "data-reader", "meeting-notes", "campaign-planner"] as const;
export type ReviewedSkillId = typeof REVIEWED_SKILL_IDS[number];

export function selectSkill(current: ReadonlySet<string>, id: string): Set<string> {
  if (!REVIEWED_SKILL_IDS.includes(id as ReviewedSkillId)) throw new Error("这个 Skill 尚未经过审核，不能启用");
  const next = new Set([...current].filter(value => REVIEWED_SKILL_IDS.includes(value as ReviewedSkillId)));
  if (next.has(id)) next.delete(id);
  else {
    if (next.size >= MAX_SELECTED_SKILLS) throw new Error("每次最多启用 3 个 Skill，请先取消一个");
    next.add(id);
  }
  return next;
}

export function skillRequestIds(ids: Iterable<string>): ReviewedSkillId[] {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_SELECTED_SKILLS || unique.some(id => !REVIEWED_SKILL_IDS.includes(id as ReviewedSkillId))) throw new Error("Skill 选择无效，请重新选择");
  return unique as ReviewedSkillId[];
}

export interface ImportedSkillDocument {
  name: string;
  description: string;
  text: string;
  trust: "untrusted-attachment";
}

/** Read a small Markdown document, never YAML tags, dependencies, code, paths or remote resources. */
export function parseSkillMarkdown(markdown: string, fileName = "SKILL.md"): ImportedSkillDocument {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
  if (!text || text.length > 24_000 || new TextEncoder().encode(text).length > 48_000) throw new Error("Skill 文件为空或过长，最多 24,000 字符");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new Error("Skill 必须是纯文本 Markdown 文件");
  let name = fileName.replace(/\.md$/i, "").slice(0, 80) || "导入的 Skill";
  let description = "导入资料，仅作为文本参考，不执行脚本";
  const frontmatter = /^---\n([\s\S]{0,4000}?)\n---(?:\n|$)/.exec(text);
  if (frontmatter) {
    for (const line of frontmatter[1].split("\n")) {
      const match = /^(name|description):\s*(.+)$/.exec(line);
      if (!match) continue;
      let value = match[2].trim();
      if (/^[!&*>{|]/.test(value)) continue;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (match[1] === "name" && value) name = value.slice(0, 80);
      else if (match[1] === "description" && value) description = value.slice(0, 240);
    }
  }
  return { name, description, text, trust: "untrusted-attachment" };
}
