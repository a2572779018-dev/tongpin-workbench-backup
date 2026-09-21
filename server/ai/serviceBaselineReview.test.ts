import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_BUSINESS_TIERS, type AiHarnessCapability, type AiHarnessInput, type AiHarnessTierRoute, type AiMode } from "../../shared/ai";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";

function configuration(): AiHarnessInput {
  const route = (): AiHarnessTierRoute => ({ providerId: "text", modelId: "text-model", protocol: "chat_completions", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, capabilities: ["chat", "image"] as AiHarnessCapability[], imageProviderId: "images", imageModelId: "image-model" });
  return {
    providers: [
      { id: "text", name: "Text", baseUrl: "https://text.example.com/v1", apiKey: "text-key", protocol: "chat_completions", enabled: true },
      { id: "images", name: "Images", baseUrl: "https://images.example.com/v1", apiKey: "images-key", protocol: "chat_completions", enabled: true },
    ],
    tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(tier => [tier, route()])) as Record<AiMode, AiHarnessTierRoute>,
    policy: { strategy: "react", maxToolSteps: 3, requireApproval: true, autoWebSearch: true },
  };
}

describe("four-tier compatibility baseline review", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-baseline-review-"));
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    transport.mockReset();
    transport.mockImplementation(async () => Response.json({ data: ["text-model", "image-model"].map(id => ({ id })) }));
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  it("saves fresh pricing with an enabled Responses search tier without changing chat routes", async () => {
    const input = configuration();
    input.tiers.deep = { ...input.tiers.deep, protocol: "responses", capabilities: [...input.tiers.deep.capabilities, "web_search"] };
    await runtime.service.saveHarness(input);
    const baseline = runtime.service.provider()!;
    expect(baseline.protocol).toBe("chat_completions");
    expect(runtime.store.provider()).toBeNull();
    await runtime.service.saveProvider({ ...baseline, imageQuotaTokens: 1200, webSearchEnabled: true, webSearchQuotaTokens: 100 });
    expect(runtime.service.provider()).toMatchObject({ imageQuotaTokens: 1200, webSearchEnabled: true, webSearchQuotaTokens: 100 });
    expect(runtime.store.harness()?.tiers).toEqual(input.tiers);
    expect(JSON.stringify(runtime.service.provider())).not.toMatch(/encryptedKey|text-key|images-key/);
  });

  it("rejects saving a copied baseline when its stored key changes during image-key encryption", async () => {
    await runtime.service.saveHarness(configuration());
    const baseline = runtime.service.provider()!;
    const pending = runtime.service.saveProvider({ ...baseline, imageBaseUrl: "https://new-images.example.com/v1", imageApiKey: "new-image-key", imageQuotaTokens: 1000 });
    const concurrent = runtime.store.harness()!;
    concurrent.providers[0].encryptedKey = "concurrently-replaced-encrypted-key";
    runtime.store.saveHarness(concurrent);
    await expect(pending).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    expect(runtime.store.provider()).toBeNull();
  });
  it("tests a fresh harness baseline without persisting a duplicate provider", async () => {
    await runtime.service.saveHarness(configuration());
    const result = await runtime.service.testProvider({ target: "chat" });
    expect(result.models).toContain("text-model");
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer text-key");
    expect(runtime.store.provider()).toBeNull();
  });

  it("does not revive images from a legacy setting after canonical image capability is disabled", async () => {
    await runtime.service.saveProvider({ name: "Legacy", baseUrl: "https://old.example.com/v1", apiKey: "old-key", protocol: "chat_completions", quickModel: "text-model", deepModel: "text-model", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, imageModel: "old-image", imageQuotaTokens: 1000 });
    const input = configuration();
    for (const tier of AI_BUSINESS_TIERS) input.tiers[tier] = { ...input.tiers[tier], capabilities: ["chat"], imageProviderId: undefined, imageModelId: undefined };
    await runtime.service.saveHarness(input);
    runtime.service.setQuota("member", "admin", { limitTokens: 5000 });
    expect(runtime.service.status("member").imageEnabled).toBe(false);
  });

  it("probes a validated image route when an earlier tier has a disabled media provider", async () => {
    const input = configuration();
    input.providers.push({ id: "disabled-images", name: "Old images", baseUrl: "https://disabled.example.com/v1", apiKey: "disabled-key", protocol: "chat_completions", enabled: false });
    input.tiers.quick.imageProviderId = "disabled-images";
    await runtime.service.saveHarness(input);
    await runtime.service.discoverHarnessProvider("text");
    await runtime.service.discoverHarnessProvider("images");
    await runtime.service.saveProvider({ ...runtime.service.provider()!, imageQuotaTokens: 1000 });
    runtime.service.setQuota("member", "admin", { limitTokens: 5000 });
    transport.mockClear();
    const result = await runtime.service.availability("member", "image");
    expect(result.status.imageEnabled).toBe(true);
    expect(transport.mock.calls[0][0]).toBe("https://images.example.com/v1/models");
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer images-key");
  });
});
