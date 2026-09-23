import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AI_BUSINESS_TIERS, type AiAttachment, type AiHarnessInput, type AiMode, type AiHarnessTierRoute } from "../../shared/ai";
import { createNodeAi } from "./node";
import type { AiTransport } from "./provider";
import { toolPlanContextFingerprint } from "./toolPlans";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const attachments: AiAttachment[] = [{ name: "reference.png", text: "参考图", mediaType: "image/png", dataUrl: `data:image/png;base64,${PNG}` }];
const baseUrl = "https://image-edit.example.com/v1";
describe("reference image execution through the real service and SQLite ledger", () => {
  let directory: string;
  let runtime: Awaited<ReturnType<typeof createNodeAi>>;
  const transport = vi.fn<AiTransport>();
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "tongpin-image-edit-flow-"));
    runtime = await createNodeAi(path.join(directory, "fixture.json"), transport);
    transport.mockReset();
    transport.mockImplementation(async () => Response.json({ data: [{ id: "text-model" }, { id: "image-model" }] }));
    await runtime.service.saveProvider({ name: "Images", baseUrl, apiKey: "fixture-not-real", protocol: "chat_completions", quickModel: "text-model", deepModel: "text-model", maxOutputTokens: 2048, reasoningEffort: "", enabled: true, imageModel: "image-model", imageQuotaTokens: 1000 });
    runtime.service.setQuota("member", "admin", { limitTokens: 10000 });
  });
  afterEach(async () => { runtime.close(); await rm(directory, { recursive: true }); });
  async function configure(editing: boolean) {
    const tier = { providerId: "images", modelId: "text-model", protocol: "chat_completions" as const, maxOutputTokens: 2048, reasoningEffort: "" as const, enabled: true, capabilities: ["chat", "image"] as AiHarnessTierRoute["capabilities"], imageProviderId: "images", imageModelId: "image-model",
      ...(editing ? { imageEditCapability: { baseUrl, modelId: "image-model", profile: "openai-gpt-image-edits-v1" as const } } : {}) };
    const input: AiHarnessInput = { providers: [{ id: "images", name: "Images", baseUrl, apiKey: "fixture-not-real", protocol: "chat_completions", enabled: true }], tiers: Object.fromEntries(AI_BUSINESS_TIERS.map(mode => [mode, { ...tier }])) as Record<AiMode, AiHarnessTierRoute>, policy: { strategy: "direct", maxToolSteps: 1, requireApproval: true, autoWebSearch: false } };
    await runtime.service.saveHarness(input);
    await runtime.service.discoverHarnessProvider("images");
    transport.mockClear();
    transport.mockImplementation(async () => Response.json({ data: [{ b64_json: PNG }] }));
  }
  async function request() {
    const planRequestId = crypto.randomUUID();
    const prompt = "沿用这张图片的人物并调整背景";
    runtime.store.saveRequest({ requestId: planRequestId, userId: "member", hash: "plan-fixture", kind: "chat", status: "completed", createdAt: new Date().toISOString(), expiresAt: Date.now() + 60000, inputReserve: 0, outputReserve: 0, convertedReserve: 0, model: "text-model", mode: "quick", conversationId: "conversation-a", toolPlanContextFingerprint: await toolPlanContextFingerprint(undefined, attachments), result: { requestId: planRequestId, content: "", model: "text-model", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimated: false }, toolPlan: { kind: "image", summary: "修改背景", prompt } } });
    return { requestId: crypto.randomUUID(), conversationId: "conversation-a", prompt, planRequestId, attachments };
  }
  it("does not silently discard references when the route has no edit capability", async () => {
    await configure(false);
    await expect(runtime.service.generateImage("member", await request())).rejects.toMatchObject({ code: "AI_IMAGE_EDIT_UNSUPPORTED" });
    expect(transport).not.toHaveBeenCalled();
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: 0, reservedTokens: 0 });
  });
  it("sends real reference bytes to edits, bills once, and replays without generation", async () => {
    await configure(true);
    const input = await request();
    const result = await runtime.service.generateImage("member", input);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe(`${baseUrl}/images/edits`);
    const multipart = await new Response(init.binaryBody ? new Uint8Array(init.binaryBody) : undefined, { headers: { "Content-Type": init.headers["Content-Type"] } }).formData();
    expect(multipart.get("prompt")).toBe(input.prompt);
    const image = multipart.getAll("image[]")[0] ?? multipart.get("image");
    expect(image).toBeInstanceOf(File);
    expect(Buffer.from(await (image as File).arrayBuffer()).toString("base64")).toBe(PNG);
    expect(await runtime.service.generateImage("member", input)).toMatchObject({ images: result.images });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(runtime.service.quota("member")).toMatchObject({ usedTokens: 1000, reservedTokens: 0 });
    const generated = runtime.store.usage("member").filter(item => item.requestId === input.requestId);
    expect(generated).toHaveLength(1);
  });
});
