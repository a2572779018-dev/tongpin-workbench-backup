import { describe, expect, it } from "vitest";
import type { AiChatRequest } from "../../shared/ai";
import { parseReplyChart, parseReplyFollowups } from "../../src/features/tongpin-ai/replyRichBlocks";
import { chatInstructions, RICH_BLOCKS } from "./capabilities";

const chat = (extra: Partial<AiChatRequest> = {}): AiChatRequest => ({ requestId: crypto.randomUUID(), mode: "quick", messages: [{ role: "user", content: "对比两个季度" }], ...extra });

describe("rich reply block instructions", () => {
  it("reaches ordinary answers, including the main chat dispatch path", () => {
    for (const request of [chat(), chat({ outputFormat: "dispatch" })]) {
      const instructions = chatInstructions(request);
      expect(instructions).toContain(RICH_BLOCKS);
      expect(instructions).toContain("宁简勿繁");
    }
    // The optional blocks are explicitly on demand, not a template.
    expect(RICH_BLOCKS).toContain("仅在确有帮助时使用，多数回复不需要");
  });

  it("stays out of JSON-only tool plans, PPT generation and the agent continuation protocol", () => {
    for (const outputFormat of ["image_plan", "presentation_plan", "computer_plan"] as const) {
      expect(chatInstructions(chat({ outputFormat }))).not.toContain("```chart");
    }
    expect(chatInstructions(chat({ outputFormat: "presentation", toolPlanRequestId: "plan-request-0000001" }))).not.toContain("```chart");
    expect(chatInstructions(chat({ skillIds: ["agent-continuation-v1"] }))).not.toContain("```followups");
  });

  it("describes exactly the chart and followup payloads the renderer accepts", () => {
    const template = /```chart 代码块，内容仅为 JSON (\{.*?\]\})/.exec(RICH_BLOCKS)?.[1];
    expect(template).toBeTruthy();
    // Filling the documented template with real values must pass the parser.
    const filled = template!.replace('"bar|line"', '"bar"').replace("数字", "42");
    expect(parseReplyChart(filled)).toEqual({ type: "bar", title: "标题", unit: "单位", source: "数据来源", series: [{ label: "项目", value: 42 }] });
    expect(RICH_BLOCKS).toContain("最多 24 个点");
    expect(RICH_BLOCKS).toContain("最多 3 条");
    expect(parseReplyFollowups('["一", "二", "三", "四"]')).toHaveLength(3);
    // Unsupported syntaxes and media links are ruled out rather than silently degraded.
    for (const text of ["不输出 HTML、Mermaid", "$...$", "不用 \\( \\) 或 \\[ \\]", "界面不会显示回复中的图片或视频链接"]) expect(RICH_BLOCKS).toContain(text);
  });
});
