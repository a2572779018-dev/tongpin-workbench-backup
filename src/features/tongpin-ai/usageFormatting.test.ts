import { describe, expect, it } from "vitest";
import { aiDiagnosticDescription, aiUsageDescription, aiUsageTotal } from "./usageFormatting";

describe("honest text and tool billing labels", () => {
  it("shows bounded provider status without echoing arbitrary upstream text", () => {
    expect(aiDiagnosticDescription({ operation: "image", httpStatus: 502, category: "upstream_unavailable", billing: "unknown" })).toBe("HTTP 502 · 服务商暂时故障");
    expect(aiDiagnosticDescription({ operation: "image", httpStatus: 403, category: "authentication", billing: "rejected", code: "invalid_api_key" })).toBe("HTTP 403 · 密钥或分组权限异常");
  });
  it("shows actual token input and output independently of converted tool charges", () => {
    const usage = { inputTokens: 12, outputTokens: 8, totalTokens: 20, estimated: false };
    expect(aiUsageDescription(usage)).toBe("输入 12 / 输出 8 Token");
    expect(aiUsageTotal(usage)).toBe("20 同频点");
  });
  it("does not describe image conversion as actual model tokens or uncertain text usage", () => {
    const image = { inputTokens: 0, outputTokens: 0, convertedTokens: 2_000, totalTokens: 2_000, estimated: true, billingKind: "image_conversion" as const };
    expect(aiUsageDescription(image)).toBe("图片生成折算 2,000 同频点");
    expect(aiUsageTotal(image)).toBe("2,000 同频点");
    const search = { ...image, inputTokens: 12, outputTokens: 8, totalTokens: 2_020, estimated: false, billingKind: "tokens_with_search" as const };
    expect(aiUsageDescription(search)).toBe("输入 12 / 输出 8 Token · 搜索折算 2,000 同频点");
    expect(aiUsageDescription({ ...search, estimated: true, tokenUsageEstimated: false, searchCalls: 2 })).toBe("输入 12 / 输出 8 Token · 搜索 2 次折算 2,000 同频点");
    expect(aiUsageDescription({ ...search, estimated: true, tokenUsageEstimated: true, searchCalls: 2 })).toContain("文本用量待核对");
    expect(aiUsageTotal(search)).toBe("2,020 同频点");
    const exec = { ...search, billingKind: "tokens_with_code_exec" as const, execCalls: 1, convertedTokens: 200 };
    expect(aiUsageDescription(exec)).toBe("输入 12 / 输出 8 Token · 代码执行 1 次折算 200 同频点");
    expect(aiUsageDescription({ ...exec, execCalls: undefined })).toBe("输入 12 / 输出 8 Token · 代码执行折算 200 同频点");
    const both = { ...search, billingKind: "tokens_with_tools" as const, searchCalls: 1, execCalls: 1, convertedTokens: 800 };
    expect(aiUsageDescription(both)).toBe("输入 12 / 输出 8 Token · 搜索 1 次 + 代码执行 1 次折算 800 同频点");
  });
  it("keeps historic and estimated text records intact rather than recomputing totals", () => {
    const original = Object.freeze({ inputTokens: 123, outputTokens: 45, totalTokens: 170, estimated: true });
    expect(aiUsageDescription(original)).toBe("输入 123 / 输出 45 Token · 文本用量待核对");
    expect(aiUsageTotal(original)).toBe("170 同频点");
    expect(original).toEqual({ inputTokens: 123, outputTokens: 45, totalTokens: 170, estimated: true });
  });
});
