import { describe, expect, it } from "vitest";
import type { AiChatRequest, AiMode } from "../../shared/ai";
import { chatInstructions } from "./capabilities";
import {
  AI_PUBLIC_ANALYSIS_LIMITS,
  parseProviderPublicSummary,
  providerPublicSummaryFromResponse,
  parsePublicExplanation,
  publicExplanationInstruction,
  supportsPublicExplanation,
} from "./publicExplanation";

const request = (mode: AiMode, extra: Partial<AiChatRequest> = {}): AiChatRequest => ({
  requestId: crypto.randomUUID(),
  mode,
  messages: [{ role: "user", content: "比较两个方案" }],
  ...extra,
});

describe("public analysis summaries", () => {
  it.each(["quick", "standard", "deep", "pro"] as const)("uses a tier-bounded public-summary contract for %s", (mode) => {
    const instructions = publicExplanationInstruction(request(mode));
    expect(instructions).toContain("<analysis_summary>...</analysis_summary>");
    expect(instructions).toContain(`最多 ${AI_PUBLIC_ANALYSIS_LIMITS[mode]} 个字符`);
    expect(instructions).toContain("不是逐步思维链");
    expect(chatInstructions(request(mode))).toContain(instructions);
  });

  it.each(["quick", "standard", "deep", "pro"] as const)("keeps the same safe public-summary limit without wrapping the answer in JSON for %s", (mode) => {
    const instructions = chatInstructions(request(mode, { outputFormat: "dispatch" }));
    expect(instructions).toContain(`最多 ${AI_PUBLIC_ANALYSIS_LIMITS[mode]} 个字符`);
    expect(instructions).toContain("不要把整篇回答包装成 JSON");
    expect(instructions).toContain("不是逐步思维链");
    expect(instructions).toContain("<analysis_summary>");
    expect(instructions).toContain("<tool_request>");
  });

  it("extracts only an explicitly paired leading summary and keeps the formal answer separate", () => {
    expect(parsePublicExplanation(
      "<analysis_summary>依据交付风险与总成本比较，方案 B 更稳妥。</analysis_summary>\n\n正式回答。",
      "deep",
    )).toEqual({
      analysisSummary: "依据交付风险与总成本比较，方案 B 更稳妥。",
      content: "正式回答。",
    });
  });

  it("does not fabricate a summary when the provider omits, malforms or exceeds the contract", () => {
    expect(parsePublicExplanation("直接回答。", "quick")).toEqual({ content: "直接回答。" });
    expect(parsePublicExplanation("<analysis_summary>未闭合\n正式回答。", "quick")).toEqual({ content: "未闭合\n正式回答。" });
    const overlong = "据".repeat(AI_PUBLIC_ANALYSIS_LIMITS.quick + 1);
    expect(parsePublicExplanation(`<analysis_summary>${overlong}</analysis_summary>\n正式回答。`, "quick"))
      .toEqual({ content: "正式回答。" });
  });

  it("never promotes private-reasoning markup into the public summary or formal answer", () => {
    const value = parsePublicExplanation(
      "<think>private chain</think><reasoning_content>secret tokens</reasoning_content>可见回答。",
      "pro",
    );
    expect(value).toEqual({ content: "可见回答。" });
    expect(JSON.stringify(value)).not.toMatch(/private chain|secret tokens/);
  });

  it("accepts a longer provider-designated public summary without accepting private tags", () => {
    const publishedSummary = "有据可查的公开摘要。".repeat(32);
    expect(parseProviderPublicSummary(publishedSummary)).toBe(publishedSummary);
    expect(parseProviderPublicSummary(`<think>hidden</think>${publishedSummary}`)).toBeUndefined();
    expect(parseProviderPublicSummary("z".repeat(2001))).toBeUndefined();
  });

  it("reads only terminal public summary items, never private reasoning content", () => {
    const result = {
      output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "公开依据" }], content: [{ type: "reasoning_text", text: "private chain" }], encrypted_content: "secret" }],
    };
    expect(providerPublicSummaryFromResponse(result)).toBe("公开依据");
    expect(providerPublicSummaryFromResponse({ output: [{ type: "reasoning", content: [{ type: "reasoning_text", text: "private chain" }] }] })).toBeUndefined();
  });

  it("leaves strict structured-output and continuation prompts untouched", () => {
    for (const outputFormat of ["image_plan", "video_plan", "presentation_plan", "computer_plan"] as const) {
      const value = request("deep", { outputFormat });
      expect(supportsPublicExplanation(value)).toBe(false);
      expect(publicExplanationInstruction(value)).toBe("");
      expect(chatInstructions(value)).not.toContain("analysis_summary");
    }
    const continuation = request("deep", { skillIds: ["agent-continuation-v1"] });
    expect(supportsPublicExplanation(continuation)).toBe(false);
    expect(chatInstructions(continuation)).not.toContain("analysis_summary");
  });
});
