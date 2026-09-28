import { describe, expect, it } from "vitest";
import type { AiQuota } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";
import { adminAiErrorMessage, calculateAiQuotaLimit, normalizeAiBaseUrl, parseAdminPoints } from "./adminAiForms";

const quota: AiQuota = { limitTokens: 1_000, usedTokens: 300, reservedTokens: 100, remainingTokens: 600, inputTokens: 150, outputTokens: 150 };

describe("AI administrator forms", () => {
  it("accepts a homepage and repairs a pasted completion endpoint", () => {
    expect(normalizeAiBaseUrl(" https://provider.example/ ")).toBe("https://provider.example/v1");
    expect(normalizeAiBaseUrl("https://provider.example/v1/chat/completions/")).toBe("https://provider.example/v1");
    expect(normalizeAiBaseUrl("https://provider.example/v1/responses")).toBe("https://provider.example/v1");
    expect(normalizeAiBaseUrl("https://images.example/v1/images/generations")).toBe("https://images.example/v1");
  });
  it.each(["http://provider.example", "https://user:secret@provider.example", "https://provider.example/?key=secret", "https://provider.example/#secret", "invalid"]) (
    "rejects an insecure or secret-bearing API URL %s", (url) => {
      expect(() => normalizeAiBaseUrl(url)).toThrow();
    },
  );
  it("never treats a cleared price field as 0 (free)", () => {
    expect(parseAdminPoints("", "每次搜索折算").error).toContain("请填写每次搜索折算");
    expect(parseAdminPoints("  ", "价格").error).not.toBe("");
    expect(parseAdminPoints("0", "价格")).toEqual({ value: 0, error: "" });
    expect(parseAdminPoints(" 2000 ", "价格")).toEqual({ value: 2000, error: "" });
    for (const bad of ["-1", "1.5", "1e3", "abc", "10000001"]) expect(parseAdminPoints(bad, "价格").error).not.toBe("");
    expect(parseAdminPoints("0", "价格", { min: 1 }).error).toContain("1 到");
    expect(parseAdminPoints("100", "预留", { min: 256, max: 131_072 }).error).toContain("256 到 131,072");
  });
  it("does not expose arbitrary error responses that may echo credentials", () => {
    expect(adminAiErrorMessage(new ApiRequestError(502, "PROVIDER_ERROR", "secret-token"), "连接失败")).toBe("连接失败");
    expect(adminAiErrorMessage(new Error("secret-token"), "连接失败")).toBe("连接失败");
    // A server-side 5xx never passes its text through, whatever the code.
    expect(adminAiErrorMessage(new ApiRequestError(502, "AI_HARNESS_INVALID", "secret-token"), "连接失败")).toBe("连接失败");
  });
  it("shows 同频's own validation messages, which name the field or tier to fix", () => {
    const tier = new ApiRequestError(400, "AI_HARNESS_INVALID", "业务档位单次最大输出需为 16 到 32768 的整数");
    expect(adminAiErrorMessage(tier, "配置保存失败")).toBe("业务档位单次最大输出需为 16 到 32768 的整数");
    expect(adminAiErrorMessage(new ApiRequestError(409, "AI_HARNESS_PROVIDER_IN_USE", "「语音朗读」正在使用服务连接「硅基流动」。"), "失败")).toContain("硅基流动");
    expect(adminAiErrorMessage(new ApiRequestError(400, "AI_IMAGE_QUOTA_REQUIRED", "快速档开放了生成图片，请设置每张图片折算的同频点（大于 0）"), "失败")).toContain("快速档");
  });
  it("distinguishes provider key failures from member session failures", () => {
    expect(adminAiErrorMessage(new ApiRequestError(502, "AI_PROVIDER_AUTH", "secret-token"), "连接失败")).toContain("API 密钥无效");
    expect(adminAiErrorMessage(new ApiRequestError(409, "AI_CONFIG_CHANGED", "secret-token"), "连接失败")).toContain("接入配置");
    expect(adminAiErrorMessage(new ApiRequestError(400, "AI_HOST_NOT_ALLOWED", "secret-token"), "连接失败")).toContain("服务商域名尚未接入");
    expect(adminAiErrorMessage(new ApiRequestError(503, "AI_AGENT_MODELS_UNVERIFIED", "secret-token"), "连接失败")).toContain("模型检查");
    expect(adminAiErrorMessage(new ApiRequestError(503, "AI_AGENT_ASTRA_UNAVAILABLE", "secret-token"), "连接失败")).toContain("Astra");
  });
});

describe("AI administrator quota forms", () => {
  it("turns an addition into an absolute total instead of a repeatable delta", () => {
    expect(calculateAiQuotaLimit("500", "add", quota)).toEqual({ limitTokens: 1_500, error: "" });
    expect(calculateAiQuotaLimit("500", "set", quota)).toEqual({ limitTokens: 500, error: "" });
  });
  it("does not reset usage and cannot take away an in-flight reservation", () => {
    expect(calculateAiQuotaLimit("399", "set", quota).error).toContain("处理中预留");
    expect(calculateAiQuotaLimit("400", "set", quota)).toEqual({ limitTokens: 400, error: "" });
    expect(quota.usedTokens).toBe(300);
  });
  it("supports zero initial allocation but rejects zero additions", () => {
    expect(calculateAiQuotaLimit("0", "set", { ...quota, usedTokens: 0, reservedTokens: 0 }).error).toBe("");
    expect(calculateAiQuotaLimit("0", "add", quota).error).not.toBe("");
  });
  it.each(["", "-1", "1.5", "1e6", "NaN", "Infinity", "9007199254740992", "1000000001"]) (
    "rejects invalid quota input %s", (amount) => {
      expect(calculateAiQuotaLimit(amount, "set", quota).error).not.toBe("");
    },
  );
  it("enforces the total cap after addition", () => {
    expect(calculateAiQuotaLimit("1000000000", "add", quota).error).not.toBe("");
  });
});
