import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import type { AiHarnessInput } from "../../shared/ai";
import type { AiTransport } from "./provider";

describe("unified AI settings migration", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-settings-migration-"));
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    transport.mockReset();
    transport.mockImplementation(async () => Response.json({ data: ["quick", "deep", "image", "minimax_h3"].map(id => ({ id })) }));
    await runtime.service.saveProvider({ name: "已有服务", baseUrl: "https://ai.example.com/v1", apiKey: "test-text-key",
      protocol: "chat_completions", quickModel: "quick", deepModel: "deep", maxOutputTokens: 2048, reasoningEffort: "high", enabled: true,
      imageModel: "image", imageBaseUrl: "https://images.example.com/v1", imageApiKey: "test-image-key", imageQuotaTokens: 1000 });
    await runtime.service.video.configure({ enabled: true, quotaPoints: 1000, apiKey: "test-video-key", defaultModel: "minimax_h3" });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });

  function draft(): AiHarnessInput {
    const value = runtime.service.harness.settings()!;
    return { ...value, providers: value.providers.map(({ id, name, baseUrl, protocol, enabled }) => ({ id, name, baseUrl, protocol, enabled })) };
  }

  it("projects all existing services without writing or exposing encrypted keys", () => {
    const settings = runtime.service.harness.settings()!;
    expect(settings.providers.map(p => p.id)).toEqual(["legacy", "legacy-image", "legacy-video"]);
    expect(settings.tiers.standard).toMatchObject({ modelId: "quick", imageModelId: "image", videoModelId: "minimax_h3" });
    expect(settings.tiers.deep.modelId).toBe("deep");
    expect(settings.tiers.quick.capabilities).toEqual(expect.arrayContaining(["image", "video"]));
    expect(JSON.stringify(settings)).not.toMatch(/encryptedKey|test-text-key|test-image-key|test-video-key/);
    expect(runtime.store.harness()).toBeNull();
  });

  it("discovers with each saved credential without activating migration, then retains them on save", async () => {
    for (const id of ["legacy", "legacy-image", "legacy-video"]) {
      const result = await runtime.service.harness.discover(id);
      expect(result.models).toContain("minimax_h3");
    }
    expect(transport.mock.calls.map(call => call[1].headers.Authorization)).toEqual(["Bearer test-text-key", "Bearer test-image-key", "Bearer test-video-key"]);
    expect(runtime.store.harness()).toBeNull();
    const settings = await runtime.service.saveHarness(draft());
    expect(settings.migratedFromLegacy).toBe(false);
    expect(settings.providers.every(provider => provider.apiKeyConfigured)).toBe(true);
    expect(runtime.store.harness()?.providers[0].encryptedKey).toBe(runtime.store.provider()?.encryptedKey);
  });

  it("never reuses a saved secret at a changed host", async () => {
    const value = draft(); value.providers[0].baseUrl = "https://different.example.com/v1";
    await expect(runtime.service.saveHarness(value)).rejects.toMatchObject({ code: "AI_KEY_REQUIRED" });
    expect(runtime.store.harness()).toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it("lets a fresh four-tier setup save capability pricing without a second text setup", async () => {
    const service = runtime.service.forTenant("fresh-team");
    const input = draft();
    input.providers = input.providers.map(provider => ({ ...provider, apiKey: "fresh-team-key" }));
    await service.saveHarness(input);
    expect(service.store.provider()).toBeNull();
    const baseline = service.provider()!;
    expect(baseline.baseUrl).toBe(input.providers[0].baseUrl);
    expect(JSON.stringify(baseline)).not.toMatch(/fresh-team-key|encryptedKey/);
    expect(service.store.provider()).toBeNull();
    await service.saveProvider({ ...baseline, imageQuotaTokens: 1200, webSearchEnabled: false });
    expect(service.provider()?.imageQuotaTokens).toBe(1200);
    expect(service.store.harness()?.tiers).toEqual(input.tiers);
    expect(runtime.service.provider()?.imageQuotaTokens).toBe(1000);
  });

  it("checks the image tier's provider rather than an unrelated legacy image URL", async () => {
    const service = runtime.service;
    const input = draft();
    await service.saveHarness(input);
    await service.harness.discover("legacy-image");
    service.setQuota("member", "admin", { limitTokens: 10_000 });
    const legacy = runtime.store.provider()!;
    runtime.store.saveProvider({ ...legacy, imageBaseUrl: "https://stale.example.com/v1", encryptedImageKey: "stale-invalid-key" });
    transport.mockClear();
    await service.availability("member", "image");
    expect(transport.mock.calls[0][0]).toBe("https://images.example.com/v1/models");
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer test-image-key");
  });

  it("rejects stale discovery when credentials change during the model request", async () => {
    let resolve!: (value: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const pending = runtime.service.harness.discover("legacy");
    await vi.waitFor(() => expect(resolve).toBeDefined());
    const previous = runtime.store.provider()!;
    runtime.store.saveProvider({ ...previous, encryptedKey: "changed-encrypted-key" });
    resolve(Response.json({ data: [{ id: "quick" }] }));
    await expect(pending).rejects.toMatchObject({ code: "AI_CONFIG_CHANGED" });
    expect(runtime.store.harness()).toBeNull();
  });
});
