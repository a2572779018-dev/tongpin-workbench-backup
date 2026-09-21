import { describe, expect, it } from "vitest";
import type { AiHarnessConfig, AiHarnessProviderInput } from "../../../shared/ai";
import { filterAiModels, planModelDiscovery } from "./adminAiModels";

const provider: AiHarnessProviderInput = { id: "provider-a", name: "Example", baseUrl: "https://provider.example/v1", protocol: "chat_completions", enabled: true };
const saved = { providers: [{ ...provider, apiKeyConfigured: true, availableModels: ["text-a"], modelsVerified: true }], migratedFromLegacy: false } as AiHarnessConfig;

describe("administrator model discovery", () => {
  it("lists all models without typing and searches case-insensitively with prefix matches first", () => {
    expect(filterAiModels(["GPT-B", "a-gpt", "GPT-A", "GPT-A"], "")).toEqual(["a-gpt", "GPT-A", "GPT-B"]);
    expect(filterAiModels(["GPT-B", "a-gpt", "GPT-A"], "GpT")).toEqual(["GPT-A", "GPT-B", "a-gpt"]);
  });
  it("queries the saved provider only when the address is unchanged", () => {
    expect(planModelDiscovery(provider, "", saved)).toEqual({ path: "/api/admin/ai/harness/providers/provider-a/discover" });
    expect(planModelDiscovery({ ...provider, baseUrl: "https://provider.example/v1/models/" }, "", saved)).toEqual({ path: "/api/admin/ai/harness/providers/provider-a/discover" });
    expect(planModelDiscovery({ ...provider, baseUrl: "https://different.example/v1" }, "", saved).error).toContain("地址已修改");
  });
  it("uses the current unsaved URL and key without persisting or reusing the old key", () => {
    expect(planModelDiscovery({ ...provider, baseUrl: "https://different.example/" }, " new-key ", saved)).toEqual({ path: "/api/admin/ai/provider/test", body: { target: "chat", baseUrl: "https://different.example/v1", apiKey: "new-key" } });
  });
  it("uses migration-aware discovery for legacy connections and prevents unconfigured discovery", () => {
    expect(planModelDiscovery(provider, "", { ...saved, migratedFromLegacy: true })).toEqual({ path: "/api/admin/ai/harness/providers/provider-a/discover" });
    expect(planModelDiscovery(provider, "", null).error).toContain("API Key");
    expect(planModelDiscovery({ ...provider, baseUrl: "http://invalid.example" }, "key", null).error).toContain("HTTPS");
  });
});
