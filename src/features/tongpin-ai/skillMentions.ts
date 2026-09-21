import { REVIEWED_SKILL_IDS, skillRequestIds, type ReviewedSkillId } from "./skills";
import { AI_WORKFLOW_TEMPLATES, aiWorkflowTemplate, type AiWorkflowId } from "../../../shared/aiWorkflows";

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

const REQUEST_PREFIX = "(?:(?:请|麻烦|劳驾|帮我|给我|替我|请你|请帮我|可以帮我|能帮我|我想要?|我要|我需要你(?:帮我)?|想请你|直接|立即|马上)\\s*)*";
const DIRECT_GENERATION = new RegExp(`^${REQUEST_PREFIX}(?:生成|制作|创建|做|画|绘制|设计|产出|出)\\s*(.+)$`, "iu");
const TRANSFORM_GENERATION = new RegExp(`^${REQUEST_PREFIX}(?:把|将|用|根据|基于|参考)\\s*.+?\\s*(?:生成|制作成?|设计成?|绘制成?|做(?:成|为|一份|一个)?|转换成|转成|改成|整理成)\\s*(.+)$`, "iu");
const ENGLISH_GENERATION = /^(?:(?:please|help me(?: to)?|i (?:want|need)(?: you)? to|could you please|can you please)\s+)*(?:create|generate|make|design|draw|produce)\s+(.+)$/iu;
const ENGLISH_TRANSFORM_GENERATION = /^(?:(?:please|help me(?: to)?|could you please|can you please)\s+)*(?:turn|convert|transform)\s+.+?\s+(?:into|to)\s+(.+)$/iu;

/**
 * Conservative natural-language routing for generation tools. This only
 * recognizes a direct creation command. Questions, troubleshooting and requests
 * for prompts/scripts stay in ordinary chat so they cannot start a paid tool flow.
 * Explicit @ tools are resolved by the caller before this fallback is used.
 */
export function naturalGenerationToolId(text: string): NaturalGenerationToolId | undefined {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 12_000) return undefined;
  const match = DIRECT_GENERATION.exec(normalized) ?? TRANSFORM_GENERATION.exec(normalized) ?? ENGLISH_GENERATION.exec(normalized) ?? ENGLISH_TRANSFORM_GENERATION.exec(normalized);
  const target = match?.[1]?.trim();
  if (!target || /^的/u.test(target)) return undefined;

  // These phrases describe or diagnose generation instead of asking to execute it.
  if (/(?:为什么|为何|怎么|如何|不能|无法|不了|失败|报错|错误|按钮|功能|接口|费用|价格|额度)|\b(?:why|how|error|failed|failure|button|feature|pricing|cost)\b/iu.test(target)) return undefined;
  if (/(?:视频|短片|动画|图片|图像|海报|PPT|PPTX|演示文稿|幻灯片)\s*(?:的)?\s*(?:提示词|脚本|文案|分镜|大纲|教程|方法|方案|流程)\s*[?？.!！。]*$/iu.test(target) || /\b(?:video|image|picture|presentation)\s+(?:prompt|script|storyboard|outline|tutorial|workflow)\b\s*[?!.]*$/iu.test(target)) return undefined;

  // A compound such as "视频封面图" is an image request, not a video request.
  if (/(?:视频|PPT|PPTX|演示文稿).{0,6}(?:封面图?|配图|缩略图|海报)/iu.test(target) || /\b(?:video|presentation|slides?).{0,16}(?:cover|thumbnail|poster|image)\b/iu.test(target) || /\b(?:thumbnail|cover image)\b/iu.test(target)) return "image";
  if (/(?:PPTX?|PowerPoint|演示文稿|幻灯片|演示稿|路演稿|\b(?:presentation|slide\s*deck|slides?)\b)/iu.test(target)) return "ppt";
  if (/(?:视频|短片|动画|宣传片|影片|片子|\b(?:video|clip|animation|movie)\b)/iu.test(target)) return "video";
  if (/(?:图片|图像|海报|插画|配图|封面图?|头像|Logo|标志|照片|效果图|表情包|(?:一|两|三|四|五|\d+)?\s*张图|^图$|\b(?:image|picture|photo|poster|illustration|logo|thumbnail)\b)/iu.test(target)) return "image";
  return undefined;
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
export function insertSkillMention(text: string, range: { start: number; end: number }, id: string) {
  if (!ALL_MENTION_IDS.includes(id as typeof ALL_MENTION_IDS[number])) throw Error("技能尚未接入");
  const prefix = text.slice(0, range.start) + `@${id} `;
  return { text: prefix + text.slice(range.end), caret: prefix.length };
}
