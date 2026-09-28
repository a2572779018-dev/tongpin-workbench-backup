import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiHarnessCapability, AiHarnessInput } from "../../shared/ai";
import type { AiTransport } from "./provider";
import { AiError, createSecretBox } from "./security";
import { AiService } from "./service";
import { AiStore, type AiSql } from "./storage";

const KEY = "capability-provider-secret-never-return";

function harnessInput(capabilities: AiHarnessCapability[] = ["chat"]): AiHarnessInput {
  const route = {
    providerId: "primary", modelId: "chat-model", protocol: "responses" as const, maxOutputTokens: 1024, reasoningEffort: "" as const,
    capabilities: ["chat" as const, ...capabilities.filter(item => item !== "chat")], enabled: true,
    ...(capabilities.includes("image") ? { imageProviderId: "primary", imageModelId: "image-model" } : {}),
  };
  return {
    providers: [{ id: "primary", name: "Primary", baseUrl: "https://gateway.example.com/v1", protocol: "responses", apiKey: KEY, enabled: true }],
    tiers: { quick: route, standard: route, deep: route, pro: route },
    policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: true },
  };
}

describe("AI 管理 capability settings (tools, prices) without legacy connection fields", () => {
  let database: DatabaseSync;
  let store: AiStore;
  let service: AiService;
  const transport = vi.fn<AiTransport>();
  const failure = async (action: Promise<unknown>) => { try { await action; } catch (error) { return error as AiError; } throw new Error("expected a failure"); };

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    const sql: AiSql = {
      exec(query, ...bindings) { if (bindings.length) database.prepare(query).run(...bindings); else database.exec(query); },
      all<T>(query: string, ...bindings: Array<string | number | null>): T[] { return database.prepare(query).all(...bindings) as T[]; },
      transaction<T>(action: () => T): T { database.exec("BEGIN"); try { const result = action(); database.exec("COMMIT"); return result; } catch (error) { database.exec("ROLLBACK"); throw error; } },
    };
    store = new AiStore(sql); store.initialize();
    transport.mockReset();
    transport.mockImplementation(async url => {
      if (url.endsWith("/models")) return Response.json({ data: ["chat-model", "image-model"].map(id => ({ id })) });
      throw new Error(`unexpected ${url}`);
    });
    service = new AiService(store, () => createSecretBox("capability-settings-test-secret-32-bytes"), transport);
  });
  afterEach(() => database.close());

  it("needs saved four tiers first", async () => {
    const error = await failure(service.saveCapabilities({ webSearchEnabled: false }));
    expect([error.status, error.code]).toEqual([409, "AI_HARNESS_REQUIRED"]);
  });

  it("saves only the fields sent, keeps connection, key and versions, and shows the price to members", async () => {
    await service.saveHarness(harnessInput(["web_search", "code_interpreter"]));
    await service.discoverHarnessProvider("primary");
    // A tenant that never saved the old single-connection card has no settings row yet.
    expect(store.provider()).toBeNull();
    const first = await service.saveCapabilities({ webSearchEnabled: true, webSearchQuotaTokens: 10_000, webSearchProtocol: "compatible" });
    expect(first).toMatchObject({ webSearchEnabled: true, webSearchQuotaTokens: 10_000, webSearchProtocol: "compatible", codeInterpreterEnabled: false });
    const row = store.provider()!;
    await service.saveCapabilities({ codeInterpreterEnabled: true, codeInterpreterQuotaTokens: 30_000 });
    const after = store.provider()!;
    expect(after).toMatchObject({ webSearchEnabled: true, webSearchQuotaTokens: 10_000, codeInterpreterEnabled: true, codeInterpreterQuotaTokens: 30_000 });
    // Connection, encrypted key and model-check versions are untouched by a price change.
    expect({ ...after, codeInterpreterEnabled: row.codeInterpreterEnabled, codeInterpreterQuotaTokens: row.codeInterpreterQuotaTokens, updatedAt: row.updatedAt }).toEqual(row);
    expect(JSON.stringify(await service.saveCapabilities({ imageStream: true }))).not.toContain(KEY);
    // Members now see search offered: a Responses tier opens it and it has a price.
    expect(service.status("member")).toMatchObject({ webSearchEnabled: true, webSearchQuotaTokens: 10_000 });
  });

  it("refuses a price that would silently switch a tier's tool off, and unknown fields", async () => {
    await service.saveHarness(harnessInput(["image"]));
    await service.discoverHarnessProvider("primary");
    const image = await failure(service.saveCapabilities({ imageQuotaTokens: 0 }));
    expect([image.code, image.message]).toEqual(["AI_IMAGE_QUOTA_REQUIRED", expect.stringContaining("快速、标准、深度、Pro档开放了生成图片")]);
    await expect(service.saveCapabilities({ imageQuotaTokens: 2_000 })).resolves.toMatchObject({ imageQuotaTokens: 2_000 });
    expect((await failure(service.saveCapabilities({ webSearchEnabled: true, webSearchQuotaTokens: 0 }))).code).toBe("AI_SEARCH_CONFIG_INVALID");
    expect((await failure(service.saveCapabilities({ codeInterpreterEnabled: true }))).code).toBe("AI_CODE_INTERPRETER_CONFIG_INVALID");
    expect((await failure(service.saveCapabilities({ imageQuotaTokens: -1 }))).code).toBe("AI_CAPABILITY_INVALID");
    expect((await failure(service.saveCapabilities({ imageStream: "yes" }))).code).toBe("AI_CAPABILITY_INVALID");
    expect((await failure(service.saveCapabilities({ visionInputReserveTokens: 100 }))).code).toBe("AI_VISION_CONFIG_INVALID");
    expect((await failure(service.saveCapabilities({ baseUrl: "https://other.example.com/v1" }))).code).toBe("AI_INPUT_INVALID");
    // A failed save changes nothing.
    expect(store.provider()).toMatchObject({ imageQuotaTokens: 2_000, webSearchEnabled: false, codeInterpreterEnabled: false });
  });
});
