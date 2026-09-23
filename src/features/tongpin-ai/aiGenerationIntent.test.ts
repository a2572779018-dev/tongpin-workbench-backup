import { describe, expect, it } from "vitest";
import { isExplicitMediaCreationRequest, naturalGenerationIntent, withoutLeadingMediaMention } from "../../../shared/aiGenerationIntent";
import { naturalGenerationToolId } from "./skillMentions";

describe("shared natural creation intent and media Send authorization", () => {
  it.each([
    ["请设计一张活动海报", "image"],
    ["帮我出一张图", "image"],
    ["Create a video thumbnail", "image"],
    ["生成一张视频封面图", "image"],
    ["帮我生成一张图片", "image"],
    ["Please create a product video", "video"],
    ["生成视频，不要字幕或旁白", "video"],
    ["这个是 logo，帮我生成一段视频", "video"],
    ["用刚才同一个人物做视频", "video"],
    ["把这些内容整理成一份 10 页 PPT", "ppt"],
  ] as const)("routes and authorizes only the requested capability: %s", (text, intent) => {
    expect(naturalGenerationToolId(text)).toBe(intent);
    expect(naturalGenerationIntent(text)).toBe(intent);
    expect(isExplicitMediaCreationRequest("image", text)).toBe(intent === "image");
    expect(isExplicitMediaCreationRequest("video", text)).toBe(intent === "video");
  });

  it.each([
    "为什么生成图片失败？", "如何生成视频？", "帮我生成一张图片可以吗？",
    "请设计一张海报的提示词", "帮我生成视频脚本", "帮我生成一个视频脚本，再写两个标题", "Create a video prompt", "Create a video prompt and script",
    "不要生成图片", "帮我生成图片，但先不要生成", "帮我设计一张海报，但是暂不制作",
    "Please create a video, but don't create it", "Please create a video?",
  ])("does not turn a question, negation or prompt-only request into consent: %s", text => {
    expect(naturalGenerationToolId(text)).toBeUndefined();
    expect(naturalGenerationIntent(text)).toBeUndefined();
    expect(isExplicitMediaCreationRequest("image", text)).toBe(false);
    expect(isExplicitMediaCreationRequest("video", text)).toBe(false);
  });

  it("removes only the selected leading mention from planning and bare-request checks", () => {
    expect(withoutLeadingMediaMention(" @image 帮我生成一张图片 ", "image")).toBe("帮我生成一张图片");
    expect(withoutLeadingMediaMention("@video 用这张图生成视频", "video")).toBe("用这张图生成视频");
    expect(withoutLeadingMediaMention("@image 生成视频", "video")).toBe("@image 生成视频");
    expect(withoutLeadingMediaMention("@image", "image")).toBe("");
  });
});
