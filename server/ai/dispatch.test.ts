import { describe, expect, it } from "vitest";
import { parseAiDispatchDecision } from "./dispatch";

describe("AI server dispatcher", () => {
  it("keeps a multiline Markdown answer as the same charged model response", () => {
    const content = "结论如下：\n\n| 方案 | 风险 |\n| --- | --- |\n| A | 低 |\n\n- 保留现状\n- 继续验证";
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content }), "quick")).toEqual({ kind: "text", content });
  });

  it("returns only a non-executing tool proposal and optional clarification", () => {
    expect(parseAiDispatchDecision(JSON.stringify({
      kind: "video",
      prompt: "制作一段品牌短片\n保持 Logo 原样",
      clarification: "需要横屏还是竖屏？",
    }), "deep")).toEqual({ kind: "video", prompt: "制作一段品牌短片\n保持 Logo 原样", clarification: "需要横屏还是竖屏？" });
  });

  it("accepts only a tier-bounded public summary on text dispatch", () => {
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content: "正式答复", analysisSummary: "根据风险与成本比较。" }), "quick"))
      .toEqual({ kind: "text", content: "正式答复", analysisSummary: "根据风险与成本比较。" });
    expect(parseAiDispatchDecision(JSON.stringify({ kind: "text", content: "正式答复", analysisSummary: "据".repeat(81) }), "quick"))
      .toEqual({ kind: "text", content: "正式答复" });
  });

  it("rejects extra fields, hidden reasoning and unsafe controls", () => {
    expect(() => parseAiDispatchDecision('{"kind":"image","prompt":"海报","reasoning":"private"}', "pro")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
    expect(() => parseAiDispatchDecision('{"kind":"text","content":"answer","reasoning_content":"private"}', "pro")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
    expect(() => parseAiDispatchDecision(JSON.stringify({ kind: "text", content: "before\u0000after" }), "pro")).toThrow(expect.objectContaining({ code: "AI_DISPATCH_INVALID" }));
  });
});
