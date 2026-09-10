import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiProviderConfig, AiProviderInput, AiQuota } from "../../../shared/ai";
import { ApiRequestError } from "../../lib/api";
import { adminAiErrorMessage, calculateAiQuotaLimit, normalizeAiBaseUrl, validateAiProviderConnection, validateAiProviderInput } from "./adminAiForms";

const provider: AiProviderInput = {
  name: "Company AI", baseUrl: "https://provider.example/v1", protocol: "responses",
  quickModel: "quick-model", deepModel: "deep-model", maxOutputTokens: 2_048,
  reasoningEffort: "", enabled: true,
};
const saved: AiProviderConfig = { ...provider, apiKeyConfigured: true, updatedAt: null };
const quota: AiQuota = { limitTokens: 1_000, usedTokens: 300, reservedTokens: 100, remainingTokens: 600, inputTokens: 150, outputTokens: 150 };

describe("AI administrator provider forms", () => {
  it("accepts a homepage and repairs a pasted completion endpoint", () => {
    expect(normalizeAiBaseUrl(" https://provider.example/ ")).toBe("https://provider.example/v1");
    expect(normalizeAiBaseUrl("https://provider.example/v1/chat/completions/")).toBe("https://provider.example/v1");
    expect(normalizeAiBaseUrl("https://provider.example/v1/responses")).toBe("https://provider.example/v1");
  });
  it.each(["http://provider.example", "https://user:secret@provider.example", "https://provider.example/?key=secret", "https://provider.example/#secret", "invalid"]) (
    "rejects an insecure or secret-bearing API URL %s", (url) => {
      expect(() => normalizeAiBaseUrl(url)).toThrow();
    },
  );
  it("requires a key for a first connection, but no model ID for discovery", () => {
    expect(validateAiProviderConnection(provider.baseUrl, "", null)).toContain("API 密钥");
    expect(validateAiProviderConnection(provider.baseUrl, "test-credential", null)).toBe("");
  });
  it("preserves a stored key only for the same normalized provider URL", () => {
    expect(validateAiProviderInput(provider, saved)).toBe("");
    expect(validateAiProviderInput({ ...provider, baseUrl: "https://another.example/v1" }, saved)).toContain("重新填写");
    expect(validateAiProviderInput({ ...provider, baseUrl: "https://another.example/v1", apiKey: "test-credential" }, saved)).toBe("");
  });
  it("requires a service name and model IDs before saving", () => {
    expect(validateAiProviderInput({ ...provider, name: " " }, saved)).toContain("服务名称");
    expect(validateAiProviderInput({ ...provider, quickModel: "" }, saved)).toContain("模型 ID");
    expect(validateAiProviderInput({ ...provider, deepModel: "" }, saved)).toContain("模型 ID");
  });
  it.each([0, 15, 32_769, 1.5, NaN])("rejects invalid output cap %s", (maxOutputTokens) => {
    expect(validateAiProviderInput({ ...provider, maxOutputTokens }, saved)).toContain("16–32,768");
  });
  it.each([0, 255, 131073, 1.5, NaN])("rejects invalid image input reserve %s", visionInputReserveTokens => {
    expect(validateAiProviderInput({ ...provider, visionInputReserveTokens }, saved)).toContain("256 到 131072");
  });
  it("accepts explicit search compatibility and bounded image reservation without enabling vision by itself", () => {
    expect(validateAiProviderInput({ ...provider, webSearchProtocol: "compatible", visionInputReserveTokens: 4096 }, saved)).toBe("");
    const source = readFileSync(new URL("./AdminAiProviderSettings.tsx", import.meta.url), "utf8");
    expect(source).toContain('webSearchProtocol: input.webSearchProtocol ?? "standard"');
    expect(source).toContain('visionInputReserveTokens: input.visionInputReserveTokens ?? 4096');
    expect(source).toContain('visionEnabled: input.visionEnabled ?? false');
    expect(source).toContain("不包含音轨");
    expect(source).toContain("不能保证服务商同时停止计费");
  });
  it("does not expose arbitrary error responses that may echo credentials", () => {
    expect(adminAiErrorMessage(new ApiRequestError(502, "PROVIDER_ERROR", "secret-token"), "连接失败")).toBe("连接失败");
    expect(adminAiErrorMessage(new Error("secret-token"), "连接失败")).toBe("连接失败");
  });
  it("distinguishes provider key failures from member session failures", () => {
    expect(adminAiErrorMessage(new ApiRequestError(502, "AI_PROVIDER_AUTH", "secret-token"), "连接失败")).toContain("API 密钥无效");
    expect(adminAiErrorMessage(new ApiRequestError(409, "AI_CONFIG_CHANGED", "secret-token"), "连接失败")).toContain("接入配置");
    expect(adminAiErrorMessage(new ApiRequestError(400, "AI_HOST_NOT_ALLOWED", "secret-token"), "连接失败")).toContain("服务商域名尚未接入");
  });
  it("keeps secrets in a write-only password field and permits model discovery before saving", () => {
    const source = readFileSync(new URL("./AdminAiProviderSettings.tsx", import.meta.url), "utf8");
    expect(source).toContain('type="password"');
    expect(source).toContain('setApiKey("")');
    expect(source).not.toMatch(/localStorage|sessionStorage|console\./);
    const testHandler = source.slice(source.indexOf("async function testConnection"), source.indexOf("\n  return ("));
    expect(testHandler).toContain("validateAiProviderConnection");
    expect(testHandler).not.toContain("validateAiProviderInput");
    expect(testHandler).not.toContain("|| dirty");
    expect(testHandler).not.toContain("result.message");
  });
  it("requires explicit image conversion and never reuses the text key for a new image host", () => {
    expect(validateAiProviderInput({ ...provider, imageModel: "image" }, saved)).toContain("折算的同频点");
    expect(validateAiProviderInput({ ...provider, imageModel: "image", imageQuotaTokens: 100 }, saved)).toBe("");
    expect(validateAiProviderInput({ ...provider, imageBaseUrl: "https://images.example/v1", imageQuotaTokens: 100 }, saved)).toContain("图片密钥");
    expect(validateAiProviderInput({ ...provider, imageBaseUrl: "https://images.example/v1", imageApiKey: "image-test-only", imageQuotaTokens: 100 }, saved)).toBe("");
    expect(validateAiProviderInput({ ...provider, imageApiKey: "image-test-only" }, saved)).toContain("图片 API 地址");
  });
  it("requires Responses and a nonzero explicit search conversion before enabling search", () => {
    expect(validateAiProviderInput({ ...provider, webSearchEnabled: true }, saved)).toContain("联网搜索");
    expect(validateAiProviderInput({ ...provider, protocol: "chat_completions", webSearchEnabled: true, webSearchQuotaTokens: 20 }, saved)).toContain("Responses");
    expect(validateAiProviderInput({ ...provider, webSearchEnabled: true, webSearchQuotaTokens: 20 }, saved)).toBe("");
    expect(validateAiProviderInput({ ...provider, imageQuotaTokens: NaN }, saved)).toContain("整数");
    expect(normalizeAiBaseUrl("https://images.example/v1/images/generations")).toBe("https://images.example/v1");
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
