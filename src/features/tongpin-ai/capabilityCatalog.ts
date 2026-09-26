import { TONGPIN_AI_SKILLS } from "./mockData";
import { AI_WORKFLOW_TEMPLATES, type AiWorkflowId } from "../../../shared/aiWorkflows";

export type CapabilityCenterSection = "base" | "skills" | "hubs";

export interface BaseCapability {
  id: "chat" | "attachments" | "image" | "video" | "presentation" | "computer";
  name: string;
  description: string;
  availability: string;
}

export const BASE_CAPABILITIES: readonly BaseCapability[] = [
  { id: "chat", name: "对话与分析", description: "理解上下文，整理思路并给出可执行结果。", availability: "直接对话" },
  { id: "attachments", name: "文件与图片理解", description: "在当前对话中读取上传的资料与图片。", availability: "通过 + 上传" },
  { id: "image", name: "图片生成", description: "先由同频 AI 整理要求，确认后调用管理员配置的服务。", availability: "对话内调用" },
  { id: "video", name: "视频生成", description: "保留提示词和参考图，生成状态与结果回到同一对话。", availability: "对话内审批" },
  { id: "presentation", name: "演示文稿", description: "根据对话和资料组织结构，在对话内生成可下载成果。", availability: "对话内调用" },
  { id: "computer", name: "Computer Use", description: "直接说出要在电脑上完成的事（或用 @computer），授权一次后由 Jev 逐步决策、自动执行并核对结果。", availability: "macOS 与 Windows 桌面端" },
];

export interface CapabilityHub {
  id: AiWorkflowId;
  name: string;
  description: string;
  skillIds: readonly string[];
  steps: readonly { id: string; title: string; instruction: string }[];
}

export const CAPABILITY_HUBS: readonly CapabilityHub[] = AI_WORKFLOW_TEMPLATES;

export function hubSkillNames(hub: CapabilityHub): string[] {
  return hub.skillIds.map(id => TONGPIN_AI_SKILLS.find(skill => skill.id === id)?.name).filter((name): name is string => Boolean(name));
}

export function hubIsActive(hub: CapabilityHub, enabled: ReadonlySet<string>): boolean {
  return hub.skillIds.length > 0 && hub.skillIds.every(id => enabled.has(id));
}
