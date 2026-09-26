import { describe, expect, it } from "vitest";
import { needsComputation, needsOnlineEvidence, routeChatProvider } from "./autoRouting";
import type { AiChatRequest, AiProviderConfig } from "../../shared/ai";
import { BAI_AGENT_MODELS, BAI_QUICK_MODELS, LEGACY_BAI_QUICK_AUTO, TONGPIN_QUICK_AGENT } from "../../shared/aiAuto";

const provider = { baseUrl: "https://api.b.ai/v1", quickModel: TONGPIN_QUICK_AGENT, deepModel: "old-model", protocol: "responses" } as AiProviderConfig;
const request = (content: string): AiChatRequest => ({ requestId: "fixture-request-12345", mode: "quick", messages: [{ role: "user", content }] });
const errorCode = (operation: () => unknown): string => {
  try { operation(); }
  catch (error) { return typeof error === "object" && error !== null && "code" in error ? String(error.code) : ""; }
  return "";
};

describe("B.AI bounded Agent routing", () => {
  it.each([["\u4f60\u597d", "hy3"], ["\u5e2e\u6211\u5199 Python \u4ee3\u7801", "mimo-v2.5"], ["\u6587".repeat(16001), "qwen3.8-flash"]])("selects a verified permitted model for input", (text, model) => {
    const routed = routeChatProvider(provider, request(text), BAI_AGENT_MODELS);
    expect(routed.quickModel).toBe(model);
    expect(BAI_QUICK_MODELS).toContain(routed.quickModel);
    expect(routed.protocol).toBe("chat_completions");
    expect(provider.quickModel).toBe(TONGPIN_QUICK_AGENT);
  });

  it("routes visual inputs to a verified visual model and deep mode only to verified Astra Responses", () => {
    const visual = { ...request("\u8fd9\u662f\u4ec0\u4e48"), attachments: [{ name: "image.jpg", mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/" }] };
    expect(routeChatProvider(provider, visual, BAI_AGENT_MODELS).quickModel).toBe("qwen3.8-flash");
    expect(routeChatProvider(provider, { ...request("\u4f60\u597d"), mode: "deep" }, BAI_AGENT_MODELS)).toMatchObject({ deepModel: "gpt-6-astra", protocol: "responses" });
  });

  it("escalates only a freshness-shaped search turn when administrator search is configured", () => {
    const searchProvider = { ...provider, webSearchEnabled: true, webSearchQuotaTokens: 8000 };
    expect(routeChatProvider(searchProvider, { ...request("\u4eca\u5929\u7684\u65b0\u95fb\u662f\u4ec0\u4e48"), webSearchMode: "auto" }, BAI_AGENT_MODELS)).toMatchObject({ quickModel: "gpt-6-astra", protocol: "responses" });
    expect(routeChatProvider(searchProvider, { ...request("\u5e2e\u6211\u6539\u5199\u8fd9\u6bb5\u6587\u5b57"), webSearchMode: "auto" }, BAI_AGENT_MODELS)).toMatchObject({ quickModel: "hy3", protocol: "chat_completions" });
    expect(routeChatProvider(provider, { ...request("\u4eca\u5929\u7684\u65b0\u95fb"), webSearchMode: "auto" }, BAI_AGENT_MODELS)).toMatchObject({ quickModel: "hy3", protocol: "chat_completions" });
    expect(needsOnlineEvidence("\u8bf7\u4e0a\u7f51\u67e5\u4e00\u4e0b\u6700\u65b0\u7248\u672c")).toBe(true);
    expect(needsOnlineEvidence("\u603b\u7ed3\u6211\u63d0\u4f9b\u7684\u6587\u6863")).toBe(false);
  });

  it("falls back only within the verified quick-model intersection", () => {
    expect(routeChatProvider(provider, request("\u4f60\u597d"), ["qwen3.8-flash"]).quickModel).toBe("qwen3.8-flash");
    expect(routeChatProvider(provider, request("\u5e2e\u6211\u5199 Python \u4ee3\u7801"), ["hy3"]).quickModel).toBe("hy3");
    const visual = { ...request("\u8bc6\u522b\u8fd9\u5f20\u56fe"), attachments: [{ name: "image.jpg", mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/" }] };
    expect(routeChatProvider(provider, visual, ["mimo-v2.5"]).quickModel).toBe("mimo-v2.5");
    expect(errorCode(() => routeChatProvider(provider, visual, ["hy3"]))).toBe("AI_AGENT_VISION_MODEL_UNAVAILABLE");
  });

  it("fails before a provider call when verification or a required model family is absent", () => {
    expect(errorCode(() => routeChatProvider(provider, request("\u4f60\u597d")))).toBe("AI_AGENT_MODELS_UNVERIFIED");
    expect(errorCode(() => routeChatProvider(provider, request("\u4f60\u597d"), ["gpt-6-astra"]))).toBe("AI_AGENT_QUICK_MODELS_UNAVAILABLE");
    expect(errorCode(() => routeChatProvider(provider, { ...request("\u4f60\u597d"), mode: "deep" }, ["hy3"]))).toBe("AI_AGENT_ASTRA_UNAVAILABLE");
    const searchProvider = { ...provider, webSearchEnabled: true, webSearchQuotaTokens: 8000 };
    expect(errorCode(() => routeChatProvider(searchProvider, { ...request("\u4eca\u5929\u7684\u65b0\u95fb"), webSearchMode: "auto" }, ["hy3"]))).toBe("AI_AGENT_ASTRA_UNAVAILABLE");
  });

  it("never routes another provider through the local agent", () => {
    expect(() => routeChatProvider({ ...provider, baseUrl: "https://api.example.com/v1" }, request("\u4f60\u597d"), BAI_AGENT_MODELS)).toThrow("\u4ec5\u652f\u6301 B.AI");
    const manual = { ...provider, quickModel: "custom" };
    expect(routeChatProvider(manual, request("\u4f60\u597d"))).toBe(manual);
  });

  it("routes structured tools and legacy saved agent identifiers through the verified bounded agent", () => {
    expect(routeChatProvider(provider, { ...request("\u505a\u4e00\u4e2a\u89c6\u9891"), outputFormat: "video_plan" }, BAI_AGENT_MODELS).quickModel).toBe("qwen3.8-flash");
    expect(routeChatProvider({ ...provider, quickModel: LEGACY_BAI_QUICK_AUTO }, request("\u4f60\u597d"), BAI_AGENT_MODELS).quickModel).toBe("hy3");
  });
});

describe("needsComputation heuristic", () => {
  it("recognizes calculation, plotting and data-analysis phrasing", () => {
    expect(needsComputation("\u5e2e\u6211\u8ba1\u7b97\u4e00\u4e0b\u8fd9\u7ec4\u6570\u636e\u7684\u5e73\u5747\u503c")).toBe(true);
    expect(needsComputation("\u753b\u4e00\u4e2a\u67f1\u72b6\u56fe\u5c55\u793a\u8fd9\u51e0\u4e2a\u6708\u7684\u9500\u91cf")).toBe(true);
    expect(needsComputation("\u5e2e\u6211\u5206\u6790\u4e00\u4e0b\u8fd9\u4efd\u6570\u636e")).toBe(true);
    expect(needsComputation("\u8fd0\u884c\u4e00\u4e0b\u4ee3\u7801\u770b\u770b\u7ed3\u679c")).toBe(true);
    expect(needsComputation("calculate the standard deviation of this list")).toBe(true);
  });
  it("treats a tabular data attachment as evidence on its own, independent of the message text", () => {
    expect(needsComputation("\u5e2e\u6211\u770b\u770b\u8fd9\u4e2a\u6587\u4ef6", [{ name: "sales.csv" }])).toBe(true);
    expect(needsComputation("\u8fd9\u662f\u4ec0\u4e48", [{ name: "report.xlsx" }])).toBe(true);
    expect(needsComputation("\u8fd9\u662f\u4ec0\u4e48", [{ name: "photo.png" }])).toBe(false);
  });
  it("never fires on ordinary chat, matching needsOnlineEvidence's false-negative-biased asymmetry", () => {
    expect(needsComputation("\u4f60\u597d\uff0c\u5f88\u9ad8\u5174\u8ba4\u8bc6\u4f60")).toBe(false);
    expect(needsComputation("\u5e2e\u6211\u5199\u4e00\u6bb5\u5173\u4e8e\u79cb\u5929\u7684\u6563\u6587")).toBe(false);
    expect(needsComputation("\u4ecb\u7ecd\u4e00\u4e0b\u4f60\u81ea\u5df1")).toBe(false);
  });
});
