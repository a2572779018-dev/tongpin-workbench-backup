import { describe, expect, it } from "vitest";
import type { AiChatRequest } from "../../shared/ai";
import { providerBody } from "./provider";
import type { StoredProvider } from "./storage";

const request: AiChatRequest = {
  requestId: "bai-provider-body",
  mode: "deep",
  messages: [{ role: "user", content: "你好" }],
};

function provider(baseUrl: string, protocol: StoredProvider["protocol"] = "chat_completions"): StoredProvider {
  return {
    name: "Provider",
    baseUrl,
    protocol,
    quickModel: "quick-model",
    deepModel: "deep-model",
    maxOutputTokens: 2048,
    reasoningEffort: "high",
    enabled: true,
    apiKeyConfigured: true,
    updatedAt: null,
    encryptedKey: "encrypted-fixture",
  };
}

describe("Provider request compatibility", () => {
  it("uses B.AI Chat Completions output limits without a generic reasoning parameter", () => {
    const body = providerBody(provider("https://api.b.ai/v1"), request, "glm-5.3-flash", 1536);

    expect(body).toMatchObject({ model: "glm-5.3-flash", max_tokens: 1536, stream: false });
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("preserves the existing Chat Completions body for other providers", () => {
    const body = providerBody(provider("https://api.example.com/v1"), request, "deep-model", 1536);

    expect(body).toMatchObject({ model: "deep-model", max_completion_tokens: 1536, reasoning_effort: "high", stream: false });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("does not treat a lookalike hostname as B.AI", () => {
    const body = providerBody(provider("https://api.b.ai.example.com/v1"), request, "deep-model", 1536);

    expect(body).toMatchObject({ max_completion_tokens: 1536, reasoning_effort: "high" });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("preserves B.AI Responses protocol behavior", () => {
    const body = providerBody(provider("https://api.b.ai/v1", "responses"), request, "deep-model", 1536);

    expect(body).toMatchObject({ max_output_tokens: 1536, reasoning: { effort: "high" }, stream: true });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});
