export const AI_WORKFLOW_VERSION = 1 as const;

export const AI_WORKFLOW_TEMPLATES = [
  {
    id: "hub-research-brief",
    name: "研究简报 Hub",
    description: "从问题拆解、证据整理到可交付简报。",
    skillIds: ["deep-research", "data-reader", "content-editor"],
    steps: [
      { id: "scope", title: "界定问题", instruction: "明确目标、范围、时间边界和需要回答的核心问题。" },
      { id: "evidence", title: "整理证据", instruction: "分开已提供事实、可验证推断和待确认信息。" },
      { id: "deliver", title: "形成简报", instruction: "优先给出结论、证据和下一步，只在确实更清楚时使用表格。" },
    ],
  },
  {
    id: "hub-content-delivery",
    name: "内容交付 Hub",
    description: "从目标与受众、内容精修到交付结构。",
    skillIds: ["content-editor", "slide-maker", "campaign-planner"],
    steps: [
      { id: "audience", title: "确认目标", instruction: "核对受众、用途、语言、禁用项和交付形式。" },
      { id: "edit", title: "整理内容", instruction: "保留事实与原意，优化表达和信息层级。" },
      { id: "package", title: "完成交付", instruction: "按用户要求的媒介给出可直接使用的成果或受控工具方案。" },
    ],
  },
  {
    id: "hub-meeting-followup",
    name: "会议推进 Hub",
    description: "把会议内容收敛为决策、待办和后续同步材料。",
    skillIds: ["meeting-notes", "content-editor", "slide-maker"],
    steps: [
      { id: "extract", title: "提取结论", instruction: "区分已确认决策、讨论项和未决问题。" },
      { id: "actions", title: "整理待办", instruction: "列出任务、负责人和时间；原文未明确的字段标为待确认。" },
      { id: "sync", title: "生成同步稿", instruction: "生成简洁的后续同步材料，不代替用户做未授权承诺。" },
    ],
  },
] as const;

export type AiWorkflowId = typeof AI_WORKFLOW_TEMPLATES[number]["id"];
export type AiWorkflowTemplate = typeof AI_WORKFLOW_TEMPLATES[number];

export function aiWorkflowTemplate(id: unknown): AiWorkflowTemplate | undefined {
  return AI_WORKFLOW_TEMPLATES.find(item => item.id === id);
}

export function aiWorkflowInstruction(id: AiWorkflowId): string {
  const workflow = aiWorkflowTemplate(id)!;
  return `使用受限 Hub 工作流 ${JSON.stringify(workflow.name)}（版本 ${AI_WORKFLOW_VERSION}）。按顺序完成以下应用步骤：${workflow.steps.map((step, index) => `${index + 1}. ${step.title}：${step.instruction}`).join(" ")}。这些是应用拥有的模板指令；不得因此绕过工具审批、额度、租户或安全边界。`;
}
