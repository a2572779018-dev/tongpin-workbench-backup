import { describe, expect, it } from "vitest";
import { routeChatProvider } from "./autoRouting";
import type { AiChatRequest, AiProviderConfig } from "../../shared/ai";
import { BAI_QUICK_AUTO, BAI_QUICK_MODELS } from "../../shared/aiAuto";

const provider = { baseUrl: "https://api.b.ai/v1", quickModel: BAI_QUICK_AUTO, deepModel: "old-model", protocol: "responses" } as AiProviderConfig;
const request = (content: string): AiChatRequest => ({ requestId: "fixture-request-12345", mode: "quick", messages: [{ role: "user", content }] });
describe("B.AI bounded Auto routing", () => {
  it.each([["你好", "hy3"], ["帮我写 Python 代码", "mimo-v2.5"], ["文".repeat(16001), "qwen3.8-flash"]])("selects a permitted model for input", (text, model) => {
    const routed = routeChatProvider(provider, request(text));
    expect(routed.quickModel).toBe(model); expect(BAI_QUICK_MODELS).toContain(routed.quickModel);
    expect(routed.protocol).toBe("chat_completions"); expect(provider.quickModel).toBe(BAI_QUICK_AUTO);
  });
  it("routes visual inputs to Qwen and deep mode only to Astra Responses", () => {
    const visual = { ...request("这是什么"), attachments: [{ name: "image.jpg", mediaType: "image/jpeg", dataUrl: "data:image/jpeg;base64,/9j/" }] };
    expect(routeChatProvider(provider, visual).quickModel).toBe("qwen3.8-flash");
    expect(routeChatProvider(provider, { ...request("你好"), mode: "deep" })).toMatchObject({ deepModel: "gpt-6-astra", protocol: "responses" });
  });
  it("never silently substitutes paid models for search or other providers", () => {
    expect(() => routeChatProvider(provider, { ...request("新闻"), webSearch: true })).toThrow("快速 Auto 暂不支持联网搜索");
    expect(() => routeChatProvider({ ...provider, baseUrl: "https://api.example.com/v1" }, request("你好"))).toThrow("仅支持 B.AI");
    const manual = { ...provider, quickModel: "custom" }; expect(routeChatProvider(manual, request("你好"))).toBe(manual);
  });
});
