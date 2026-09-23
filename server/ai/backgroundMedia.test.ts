import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createNodeAi } from "./node";
import { createAiServiceMediaTaskOrchestrator } from "./mediaTaskOrchestrator";
import { MediaTaskRuntime } from "./mediaTaskRuntime";
import { AiWorkspaceRepository } from "./workspace";
import type { AiTransport } from "./provider";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => { await cleanup?.(); cleanup = undefined; });

it("background media tick rechecks the account and only plans the original queued task", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-media-tick-"));
  let active = false;
  const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({
    choices: [{ message: { content: JSON.stringify({ kind: "image", summary: "蓝色海报", prompt: "一张蓝色海报" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
  const node = await createNodeAi(path.join(directory, "db.json"), transport, (_tenantId, userId) => active && userId === "member");
  cleanup = async () => { node.close(); await rm(directory, { recursive: true }); };
  new AiWorkspaceRepository(node.store.sql).initialize();
  await node.service.saveProvider({
    name: "Fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret",
    protocol: "chat_completions", quickModel: "text-model", deepModel: "text-model",
    maxOutputTokens: 2048, reasoningEffort: "", enabled: true,
    imageModel: "image-model", imageQuotaTokens: 1000,
  });
  node.service.setQuota("member", "admin", { limitTokens: 20_000 });
  const coordinator = createAiServiceMediaTaskOrchestrator(node.service);
  const queued = await coordinator.submit("member", {
    requestId: crypto.randomUUID(), conversationId: "conversation-a", entrypoint: "menu",
    tier: "quick", intent: "image", requestText: "画一张蓝色海报", sourceAssetIds: [],
  });
  expect((await node.service.runBackgroundMediaCycle()).skippedInactive).toBe(1);
  expect(coordinator.get("member", queued.runId).status).toBe("queued");
  expect(transport).not.toHaveBeenCalled();
  active = true;
  expect((await node.service.runBackgroundMediaCycle()).advanced).toBe(0);
  const now = Date.now();
  const time = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000 + 1);
  try {
    expect((await node.service.runBackgroundMediaCycle()).advanced).toBe(1);
  } finally {
    time.mockRestore();
  }
  expect(coordinator.get("member", queued.runId).status).toBe("awaiting_authorization");
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await node.service.runBackgroundMediaCycle()).advanced).toBe(0);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("a queued task survives a Node process restart without a second submission", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-media-restart-"));
  const file = path.join(directory, "db.json");
  const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({
    choices: [{ message: { content: JSON.stringify({ kind: "image", summary: "蓝色海报", prompt: "一张蓝色海报" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
  let node = await createNodeAi(file, transport, () => true);
  cleanup = async () => { node.close(); await rm(directory, { recursive: true }); };
  new AiWorkspaceRepository(node.store.sql).initialize();
  await node.service.saveProvider({
    name: "Fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret",
    protocol: "chat_completions", quickModel: "text-model", deepModel: "text-model",
    maxOutputTokens: 2048, reasoningEffort: "", enabled: true,
    imageModel: "image-model", imageQuotaTokens: 1000,
  });
  node.service.setQuota("member", "admin", { limitTokens: 20_000 });
  const requestId = crypto.randomUUID();
  const queued = await createAiServiceMediaTaskOrchestrator(node.service).submit("member", {
    requestId, conversationId: "conversation-a", entrypoint: "menu",
    tier: "quick", intent: "image", requestText: "画一张蓝色海报", sourceAssetIds: [],
  });
  node.close();
  node = await createNodeAi(file, transport, () => true);
  new AiWorkspaceRepository(node.store.sql).initialize();
  const resumed = createAiServiceMediaTaskOrchestrator(node.service);
  expect(resumed.getByRequest("member", requestId).runId).toBe(queued.runId);
  expect((await node.service.runBackgroundMediaCycle()).advanced).toBe(1);
  expect(resumed.get("member", queued.runId).status).toBe("awaiting_authorization");
  expect(transport).toHaveBeenCalledTimes(1);
  expect((await node.service.runBackgroundMediaCycle()).advanced).toBe(0);
  expect(transport).toHaveBeenCalledTimes(1);
});

it("disabled accounts cannot starve a later active task beyond one bounded inspection", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-media-fairness-"));
  const transport = vi.fn<AiTransport>().mockResolvedValue(Response.json({
    choices: [{ message: { content: JSON.stringify({ kind: "image", summary: "蓝色海报", prompt: "一张蓝色海报" }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }));
  const node = await createNodeAi(path.join(directory, "db.json"), transport, (_tenantId, userId) => userId === "member");
  cleanup = async () => { node.close(); await rm(directory, { recursive: true }); };
  new AiWorkspaceRepository(node.store.sql).initialize();
  await node.service.saveProvider({
    name: "Fixture", baseUrl: "https://api.example.com/v1", apiKey: "fixture-secret",
    protocol: "chat_completions", quickModel: "text-model", deepModel: "text-model",
    maxOutputTokens: 2048, reasoningEffort: "", enabled: true,
    imageModel: "image-model", imageQuotaTokens: 1000,
  });
  node.service.setQuota("member", "admin", { limitTokens: 20_000 });
  const blockedRuntime = new MediaTaskRuntime(node.store, () => Date.now() - 60_000);
  for (let index = 0; index < 33; index++) blockedRuntime.submit(`disabled-${index}`, {
    requestId: crypto.randomUUID(), conversationId: "conversation-a", entrypoint: "menu",
    tier: "quick", intent: "image", requestText: "画一张蓝色海报",
    modelConfigVersion: "config-v1", sourceAssetIds: [], authorizationScope: null,
    deadlineAt: Date.now() + 60_000,
  });
  const active = await createAiServiceMediaTaskOrchestrator(node.service).submit("member", {
    requestId: crypto.randomUUID(), conversationId: "conversation-a", entrypoint: "menu",
    tier: "quick", intent: "image", requestText: "画一张蓝色海报", sourceAssetIds: [],
  });
  const first = await node.service.runBackgroundMediaCycle();
  expect(first.skippedInactive).toBe(32);
  expect(first.advanced).toBe(0);
  const second = await node.service.runBackgroundMediaCycle();
  expect(second.skippedInactive).toBe(1);
  expect(second.advanced).toBe(1);
  expect(createAiServiceMediaTaskOrchestrator(node.service).get("member", active.runId).status).toBe("awaiting_authorization");
  expect(transport).toHaveBeenCalledTimes(1);
});
