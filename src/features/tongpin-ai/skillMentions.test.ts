import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { TONGPIN_AI_SKILLS } from "./mockData";
import { REVIEWED_SKILL_IDS } from "./skills";
import { activeSkillMention, ALL_MENTION_IDS, draftsWithoutComputerRequests, insertSkillMention, mentionedSkillIds, mentionedToolId, mentionedToolIds, mentionedWorkflowId, naturalGenerationToolId, resolveToolIntent, TOOL_MENTIONS, workflowSkillIds, WORKFLOW_MENTIONS } from "./skillMentions";
describe("skill mentions", () => {
  it("opens only at an explicit @ token, not email addresses", () => {
    expect(activeSkillMention("你好 @", 4)?.query).toBe("");
    expect(activeSkillMention("a@b.com", 3)).toBeUndefined();
    expect(activeSkillMention("@内容", 3)?.query).toBe("内容");
  });
  it("inserts at the caret and invokes reviewed skills only", () => {
    expect(insertSkillMention("帮我 @co 做这个", { start: 3, end: 6 }, "content-editor").text).toBe("帮我 @content-editor  做这个");
    expect(mentionedSkillIds("@content-editor 优化 @slide-maker，演示")).toEqual(["content-editor", "slide-maker"]);
    expect(mentionedSkillIds("@computer @unknown a@deep-research")).toEqual([]);
    expect(mentionedToolId("请 @computer 打开计算器")).toBe("computer");
    expect(mentionedToolId("@video 做一段短片")).toBe("video");
    expect(mentionedToolId("@computer 然后 @image")).toBe("computer");
    expect(mentionedToolIds("@video 然后 @computer 再 @video")).toEqual(["video", "computer"]);
    expect(insertSkillMention("@", { start: 0, end: 1 }, "computer").text).toBe("@computer ");
    expect(() => insertSkillMention("@", { start: 0, end: 1 }, "shell")).toThrow("尚未接入");
  });
  it("covers every reviewed skill and every code-owned tool in the @ catalog", () => {
    expect(TONGPIN_AI_SKILLS.map(skill => skill.id)).toEqual([...REVIEWED_SKILL_IDS]);
    expect(new Set(ALL_MENTION_IDS)).toEqual(new Set([...REVIEWED_SKILL_IDS, ...TOOL_MENTIONS.map(item => item.id), ...WORKFLOW_MENTIONS.map(item => item.id)]));
    expect(new Set(ALL_MENTION_IDS).size).toBe(ALL_MENTION_IDS.length);
    for (const id of REVIEWED_SKILL_IDS) {
      const inserted = insertSkillMention("@", { start: 0, end: 1 }, id);
      expect(mentionedSkillIds(`${inserted.text}执行`)).toEqual([id]);
    }
    for (const { id } of TOOL_MENTIONS) {
      const inserted = insertSkillMention("@", { start: 0, end: 1 }, id);
      expect(mentionedToolId(`${inserted.text}执行`)).toBe(id);
    }
    for (const { id } of WORKFLOW_MENTIONS) {
      const inserted = insertSkillMention("@", { start: 0, end: 1 }, id);
      expect(mentionedWorkflowId(`${inserted.text}执行`)).toBe(id);
      expect(workflowSkillIds(`${inserted.text}执行`)).toHaveLength(3);
    }
  });
  it("removes live computer instructions from workspace draft persistence", () => {
    const drafts = {
      ordinary: "帮我整理资料",
      private: "@computer 输入 api-key-not-for-storage",
      mixed: "@image 然后 @computer 输入 secret-value",
    };
    const persisted = draftsWithoutComputerRequests(drafts);
    expect(persisted).toEqual({ ordinary: "帮我整理资料" });
    expect(JSON.stringify(persisted)).not.toContain("api-key-not-for-storage");
    expect(JSON.stringify(persisted)).not.toContain("secret-value");
  });
  it.each([
    ["帮我生成一张蓝色的品牌图片", "image"],
    ["请设计一张活动海报", "image"],
    ["生成一张视频封面图", "image"],
    ["帮我出一张图", "image"],
    ["Create a video thumbnail", "image"],
    ["把这些内容整理成一份 10 页 PPT", "ppt"],
    ["根据上面的内容做一份 PPT", "ppt"],
    ["Create a presentation for the quarterly review", "ppt"],
    ["用这张图生成一段 15 秒视频", "video"],
    ["Turn this image into a short video", "video"],
    ["Please create a product video", "video"],
  ])("infers an explicit natural-language generation command %s", (text, expected) => {
    expect(naturalGenerationToolId(text)).toBe(expected);
  });
  it.each([
    "帮我评价刚才生成的图片",
    "为什么不能生成视频",
    "视频生成失败了怎么办",
    "帮我生成一个视频脚本",
    "帮我生成一个视频脚本 ？",
    "请写一份图片生成提示词",
    "帮我生成一份 PPT 大纲",
    "不要生成图片",
    "如何制作 PPT？",
    "你能生成视频吗？",
    "Create a video prompt",
    "Generate a presentation outline",
  ])("keeps discussion and non-execution requests in ordinary chat: %s", text => {
    expect(naturalGenerationToolId(text)).toBeUndefined();
  });
  it("keeps an explicit @ tool ahead of a conflicting natural-language intent", () => {
    const text = "@image 帮我生成一段视频";
    expect(resolveToolIntent(text)).toEqual({ mentionedTools: ["image"], requestedTool: "image" });
    expect(resolveToolIntent("帮我生成一段视频")).toEqual({ mentionedTools: [], requestedTool: "video" });
  });
  it("renders the combined catalog as a keyboard-accessible listbox", () => {
    const workspace = readFileSync(new URL("./ChatWorkspace.tsx", import.meta.url), "utf8");
    expect(workspace).toContain("...TONGPIN_AI_SKILLS.map");
    expect(workspace).toContain("...TOOL_MENTIONS");
    expect(workspace).toContain('role="listbox"');
    expect(workspace).toContain('role="option"');
    expect(workspace).toContain('["ArrowDown", "ArrowUp", "Enter", "Tab"]');
    expect(workspace).toContain("resolveToolIntent(draft)");
    expect(workspace).toContain('<ImagePlus size={18} /><span>上传图片</span>');
  });
});
