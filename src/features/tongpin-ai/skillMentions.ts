import { REVIEWED_SKILL_IDS, skillRequestIds, type ReviewedSkillId } from "./skills";
import { AI_WORKFLOW_TEMPLATES, aiWorkflowTemplate, type AiWorkflowId } from "../../../shared/aiWorkflows";
import { naturalGenerationIntent } from "../../../shared/aiGenerationIntent";

export const TOOL_MENTIONS = [
  { id: "image", name: "生成图片" },
  { id: "video", name: "生成视频" },
  { id: "ppt", name: "生成 PPT" },
  { id: "computer", name: "控制电脑" },
] as const;
export type ToolMentionId = typeof TOOL_MENTIONS[number]["id"];
const TOOL_MENTION_IDS = TOOL_MENTIONS.map(item => item.id) as ToolMentionId[];
export const WORKFLOW_MENTIONS = AI_WORKFLOW_TEMPLATES.map(({ id, name }) => ({ id, name }));
const WORKFLOW_MENTION_IDS = AI_WORKFLOW_TEMPLATES.map(item => item.id) as AiWorkflowId[];
export const ALL_MENTION_IDS = [...REVIEWED_SKILL_IDS, ...TOOL_MENTION_IDS, ...WORKFLOW_MENTION_IDS] as const;

export function activeSkillMention(text: string, caret: number) {
  const match = /(?:^|\s)@([\p{L}\p{N}_-]*)$/u.exec(text.slice(0, caret));
  return match ? { query: match[1].toLowerCase(), start: caret - match[1].length - 1, end: caret } : undefined;
}
export function mentionedSkillIds(text: string): ReviewedSkillId[] {
  const ids = [...text.matchAll(/(?:^|\s)@([a-z0-9-]+)(?=\s|$|[，。！？,:;])/gi)].map(m => m[1].toLowerCase());
  return skillRequestIds(ids.filter(id => REVIEWED_SKILL_IDS.includes(id as ReviewedSkillId)));
}
export function mentionedWorkflowId(text: string): AiWorkflowId | undefined {
  const ids = [...text.matchAll(/(?:^|\s)@([a-z0-9-]+)(?=\s|$|[，。！？,:;])/gi)].map(match => match[1].toLowerCase());
  const workflows = ids.filter((id): id is AiWorkflowId => WORKFLOW_MENTION_IDS.includes(id as AiWorkflowId));
  return workflows.length === 1 ? workflows[0] : undefined;
}

export function workflowSkillIds(text: string): ReviewedSkillId[] | undefined {
  const workflow = aiWorkflowTemplate(mentionedWorkflowId(text));
  return workflow ? [...workflow.skillIds] as ReviewedSkillId[] : undefined;
}
/**
 * Skills and Hub workflow carried by one member turn. An explicit Hub mention
 * wins, then explicitly mentioned reviewed skills, then the locally selected
 * reviewed skills. The server revalidates every id against its own allowlist.
 */
export function mentionedCapabilityRequest(text: string, selected: Iterable<string> = []): { skillIds: ReviewedSkillId[]; workflowId?: AiWorkflowId } {
  const workflowId = mentionedWorkflowId(text);
  const workflow = aiWorkflowTemplate(workflowId);
  if (workflow) return { skillIds: [...workflow.skillIds] as ReviewedSkillId[], workflowId: workflow.id };
  const mentioned = mentionedSkillIds(text);
  return { skillIds: mentioned.length ? mentioned : skillRequestIds(new Set(selected)) };
}
export function mentionedToolId(text: string): ToolMentionId | undefined {
  return mentionedToolIds(text)[0];
}
export function mentionedToolIds(text: string): ToolMentionId[] {
  const ids = [...text.matchAll(/(?:^|\s)@([a-z0-9-]+)(?=\s|$|[，。！？,:;])/gi)].map(match => match[1].toLowerCase());
  return ids.filter((id, index): id is ToolMentionId =>
    TOOL_MENTION_IDS.includes(id as ToolMentionId) && ids.indexOf(id) === index,
  );
}

export type NaturalGenerationToolId = Exclude<ToolMentionId, "computer">;

/**
 * Conservative natural-language routing for generation tools. This only
 * recognizes a direct creation command. Questions, troubleshooting and requests
 * for prompts/scripts stay in ordinary chat so they cannot start a paid tool flow.
 * Explicit @ tools are resolved by the caller before this fallback is used.
 */
export function naturalGenerationToolId(text: string): NaturalGenerationToolId | undefined {
  return naturalGenerationIntent(text);
}

export function resolveToolIntent(text: string): { mentionedTools: ToolMentionId[]; requestedTool?: ToolMentionId } {
  const mentionedTools = mentionedToolIds(text);
  return {
    mentionedTools,
    requestedTool: mentionedTools.length ? mentionedTools[0] : naturalGenerationToolId(text),
  };
}

export function draftsWithoutComputerRequests(drafts: Record<string, string>) {
  return Object.fromEntries(Object.entries(drafts).filter(
    ([, value]) => !mentionedToolIds(value).includes("computer"),
  ));
}
/** A member's own adopted skill (`@my-xxxxxx`); the server resolves it for that member only. */
export const PERSONAL_SKILL_MENTION = /^my-[a-z0-9]{6}$/;
export function insertSkillMention(text: string, range: { start: number; end: number }, id: string) {
  if (!ALL_MENTION_IDS.includes(id as typeof ALL_MENTION_IDS[number]) && !PERSONAL_SKILL_MENTION.test(id)) throw Error("技能尚未接入");
  const prefix = text.slice(0, range.start) + `@${id} `;
  return { text: prefix + text.slice(range.end), caret: prefix.length };
}
