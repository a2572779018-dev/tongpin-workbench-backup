import { describe, expect, it } from "vitest";
import { aiUsageDescription, aiUsageTotal } from "./usageFormatting";

describe("honest text and tool billing labels", () => {
  it("shows actual token input and output independently of converted tool charges", () => {
    const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20, estimated: false };
    expect(aiUsageDescription(usage)).toBe("输入 12 / 输出 8 Token");
    expect(aiUsageTotal(usage)).toBe("20 Token");
  });
  it("does not describe image conversion as actual model tokens or uncertain text usage", () => {
    const image = { inputTokens: 0, outputTokens: 0, convertedTokens: 2_000, totalTokens: 2_000, estimated: true, billingKind: "image_conversion" as const };
    expect(aiUsageDescription(image)).toBe("图片生成折算 2,000 额度");
    expect(aiUsageTotal(image)).toBe("2,000 额度");
    const search = { ...image, inputTokens: 12, outputTokens: 8, totalTokens: 2_020, estimated: false, billingKind: "tokens_with_search" as const };
    expect(aiUsageDescription(search)).toBe("输入 12 / 输出 8 Token · 搜索折算 2,000 额度");
  });
});
