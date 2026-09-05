import type {
  TongpinAIArtifact,
  TongpinAIConversation,
  TongpinAIProject,
  TongpinAISkill,
} from "./types";

// P0 intentionally starts with no projects. A project exists only after the
// member creates a container from the sidebar.
export const INITIAL_PROJECTS: TongpinAIProject[] = [];

export const INITIAL_CONVERSATIONS: TongpinAIConversation[] = [
  {
    id: "weekly-focus",
    title: "本周工作重点整理",
    timeLabel: "刚刚",
    messages: [
      {
        id: "welcome",
        role: "assistant",
        content:
          "你好，我是同频 AI。你可以直接交代任务，也可以先创建项目，把同一主题的资料和对话整理在一起。",
        time: "14:28",
      },
      {
        id: "weekly-request",
        role: "user",
        content:
          "把今天的重点任务整理成一份简短周报，突出产品推进和成员测试安排。",
        time: "14:30",
      },
      {
        id: "weekly-answer",
        role: "assistant",
        content:
          "示例周报已展示。它采用“进展—安排—风险”的结构，用来验证成果预览、复制和导出流程。",
        time: "14:31",
        artifactId: "weekly-brief",
      },
    ],
  },
  {
    id: "member-test",
    title: "成员测试邀请文案",
    timeLabel: "昨天",
    messages: [
      {
        id: "member-test-answer",
        role: "assistant",
        content:
          "这是一条演示历史记录：测试邀请示例先说明体验目标，再给出反馈入口和截止时间。",
        time: "昨天 18:42",
        artifactId: "member-test-plan",
      },
    ],
  },
  {
    id: "meeting-notes",
    title: "产品会议纪要",
    timeLabel: "周一",
    messages: [
      {
        id: "meeting-answer",
        role: "assistant",
        content:
          "这是一条演示历史记录：会议纪要示例按决策、负责人和截止时间编排。",
        time: "周一 16:10",
        artifactId: "meeting-note",
      },
    ],
  },
];

export const INITIAL_ARTIFACTS: TongpinAIArtifact[] = [
  {
    id: "weekly-brief",
    conversationId: "weekly-focus",
    title: "同频产品推进周报",
    kind: "周报草稿",
    updatedLabel: "刚刚更新",
    summary: "围绕产品推进、成员测试与上线准备的简明同步稿。",
    sections: [
      {
        heading: "01 / 本周进展",
        lines: [
          "完成 AI 成员端页面结构与核心交互定义",
          "明确免费测试期的服务器和模型成本边界",
          "整理成员测试需要验证的五个关键路径",
        ],
      },
      {
        heading: "02 / 下一步安排",
        lines: [
          "完成内部预览后邀请首批成员体验",
          "记录高频任务并确定首批 Skill 上架顺序",
        ],
      },
      {
        heading: "03 / 当前提醒",
        lines: ["首批成员体验后，再根据高频任务确定 Skill 上架顺序。"],
      },
    ],
  },
  {
    id: "member-test-plan",
    conversationId: "member-test",
    title: "首批成员测试邀请",
    kind: "沟通文案",
    updatedLabel: "昨天更新",
    summary: "用于邀请首批成员体验 AI 工作台的内部通知。",
    sections: [
      {
        heading: "体验目标",
        lines: ["用真实工作任务验证对话、Skill 与成果预览是否顺手。"],
      },
      {
        heading: "反馈重点",
        lines: ["任务是否容易发起", "结果是否可直接使用", "额度提示是否清楚"],
      },
    ],
  },
  {
    id: "meeting-note",
    conversationId: "meeting-notes",
    title: "产品会议纪要",
    kind: "会议纪要",
    updatedLabel: "周一更新",
    summary: "把讨论内容整理成可继续推进的任务清单。",
    sections: [
      {
        heading: "已确认",
        lines: ["成员端先完成聊天与 Skill 市场", "后续再接入正式模型服务"],
      },
      {
        heading: "待跟进",
        lines: ["确认首批测试成员", "补充成果导出格式"],
      },
    ],
  },
];

export const TONGPIN_AI_SKILLS: TongpinAISkill[] = [
  {
    id: "content-editor",
    name: "内容精修",
    description: "保留原意和结构，快速优化措辞、语气与节奏。",
    category: "内容",
    icon: "writing",
    accent: "yellow",
    featured: true,
  },
  {
    id: "deep-research",
    name: "深度研究",
    description: "拆解问题、整理来源，并形成带结论的研究简报。",
    category: "研究",
    icon: "research",
    accent: "blue",
  },
  {
    id: "slide-maker",
    name: "演示提纲",
    description: "从主题或文档梳理清晰的表达结构与逐页要点。",
    category: "办公",
    icon: "slides",
    accent: "pink",
  },
  {
    id: "data-reader",
    name: "数据解读",
    description: "识别关键变化，解释指标，并给出下一步建议。",
    category: "研究",
    icon: "data",
    accent: "green",
  },
  {
    id: "meeting-notes",
    name: "会议纪要",
    description: "把讨论整理为决策、负责人、截止时间和待办。",
    category: "办公",
    icon: "meeting",
    accent: "blue",
  },
  {
    id: "campaign-planner",
    name: "活动策划",
    description: "围绕目标人群生成主题、节奏与内容分发计划。",
    category: "增长",
    icon: "campaign",
    accent: "yellow",
  },
];
