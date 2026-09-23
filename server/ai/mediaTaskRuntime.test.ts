import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeAi } from "./node";
import { MediaTaskRuntime, type MediaTaskCreateInput } from "./mediaTaskRuntime";

const input = (requestId: string = crypto.randomUUID()): MediaTaskCreateInput => ({
  requestId,
  conversationId: "conversation-a",
  entrypoint: "natural",
  tier: "standard",
  intent: "video",
  requestText: "用刚才的人物图生成竖屏视频",
  modelConfigVersion: "config-v1",
  sourceAssetIds: ["asset-a"],
  authorizationScope: null,
  deadlineAt: Date.now() + 60_000,
});

describe("persisted media task runtime", () => {
  let directory: string;
  let node: Awaited<ReturnType<typeof createNodeAi>>;
  let tasks: MediaTaskRuntime;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "tongpin-media-task-"));
    node = await createNodeAi(path.join(directory, "runtime.json"));
    tasks = new MediaTaskRuntime(node.store);
  });

  afterEach(async () => {
    node.close();
    await rm(directory, { recursive: true });
  });

  it("persists a scoped immutable snapshot and replays one submission without changing its run identifiers", async () => {
    const submitted = input();
    const first = tasks.submit("member", submitted);
    submitted.sourceAssetIds.push("asset-b");
    const second = tasks.submit("member", { ...input(first.requestId), deadlineAt: first.deadlineAt });
    expect(second).toMatchObject({ runId: first.runId, stepId: first.stepId, attemptId: first.attemptId, status: "queued" });
    expect(tasks.snapshot("member", first.runId)?.sourceAssetIds).toEqual(["asset-a"]);
    expect(tasks.forTenant("other-tenant").get("member", first.runId)).toBeNull();
    expect(tasks.get("other-member", first.runId)).toBeNull();
    expect(() => tasks.submit("member", { ...input(first.requestId), requestText: "different", deadlineAt: first.deadlineAt })).toThrow();

    node.close();
    node = await createNodeAi(path.join(directory, "runtime.json"));
    tasks = new MediaTaskRuntime(node.store);
    expect(tasks.get("member", first.runId)?.status).toBe("queued");
    expect(tasks.snapshot("member", first.runId)?.requestText).toBe("用刚才的人物图生成竖屏视频");
  });

  it("settles a manual choice and the timeout default at most once across runtime instances", () => {
    const run = tasks.submit("member", input());
    expect(tasks.claimPlanning("member", run.runId)?.status).toBe("planning");
    const opened = tasks.openQuestion("member", run.runId, {
      options: [
        { id: "recommended", label: "生成竖屏视频", estimatedPoints: 250 },
        { id: "landscape", label: "生成横屏视频", estimatedPoints: 250 },
      ],
      defaultOptionId: "recommended",
      deadlineAt: Date.now() - 1,
    });
    const otherWindow = new MediaTaskRuntime(node.store);
    expect(tasks.settleQuestion("member", run.runId, opened.question!.questionId, "landscape", "user").kind).toBe("selected");
    expect(otherWindow.settleQuestion("member", run.runId, opened.question!.questionId, "recommended", "timeout").kind).toBe("already_selected");
    expect(tasks.get("member", run.runId)?.question?.selectedOptionId).toBe("landscape");
  });

  it("does not turn silence into payment or choose defaults without explicit automatic-choice authorization", () => {
    const run = tasks.submit("member", input());
    tasks.claimPlanning("member", run.runId);
    const opened = tasks.openQuestion("member", run.runId, {
      options: [{ id: "recommended", label: "生成竖屏视频", estimatedPoints: 250 }],
      defaultOptionId: "recommended",
      deadlineAt: Date.now() - 1,
    });
    expect(tasks.settleQuestion("member", run.runId, opened.question!.questionId, "recommended", "timeout").kind).toBe("not_authorized");
    expect(tasks.get("member", run.runId)?.status).toBe("awaiting_input");
    expect(tasks.due(10).some(item => item.runId === run.runId)).toBe(false);
    expect(tasks.get("member", run.runId)?.question?.timeoutBlockedReason).toBe("not_authorized");
  });

  it("rechecks the current budget, configuration and assets before one timed selection", () => {
    const run = tasks.submit("member", input());
    tasks.claimPlanning("member", run.runId);
    const opened = tasks.openQuestion("member", run.runId, {
      options: [{ id: "recommended", label: "生成竖屏视频", estimatedPoints: 250, capability: "video", sourceAssetIds: ["asset-a"] }],
      defaultOptionId: "recommended", deadlineAt: Date.now() - 1,
    });
    tasks.grantAuthorization("member", run.runId, {
      grantId: crypto.randomUUID(), capabilities: ["video"], sourceAssetIds: ["asset-a"],
      maxPointsPerTool: 300, budgetVersion: "budget-v1", modelConfigVersion: "config-v1",
      automaticChoice: true, expiresAt: Date.now() + 60_000,
    });
    const questionId = opened.question!.questionId;
    const guard = { modelConfigVersion: "config-v1", budgetVersion: "budget-v1", availablePoints: 500, sourceAssetsValid: true };
    expect(tasks.settleQuestion("member", run.runId, questionId, "recommended", "timeout", { ...guard, availablePoints: 100 }).kind).toBe("budget_changed");
    expect(tasks.settleQuestion("member", run.runId, questionId, "recommended", "timeout", { ...guard, modelConfigVersion: "config-v2" }).kind).toBe("configuration_changed");
    expect(tasks.settleQuestion("member", run.runId, questionId, "recommended", "timeout", { ...guard, sourceAssetsValid: false }).kind).toBe("source_unavailable");
    expect(tasks.settleQuestion("member", run.runId, questionId, "recommended", "timeout", guard).kind).toBe("selected");
    expect(new MediaTaskRuntime(node.store).settleQuestion("member", run.runId, questionId, "recommended", "user").kind).toBe("already_selected");
    expect(tasks.get("member", run.runId)?.status).toBe("planning");
  });

  it("keeps paid tool submission gated and marks an expired started call unknown without replay", () => {
    const run = tasks.submit("member", input());
    tasks.claimPlanning("member", run.runId);
    tasks.stageTool("member", run.runId, {
      capability: "video", operationKey: "video-step-1", estimatedPoints: 250,
      sourceAssetIds: ["asset-a"], planRequestId: "approved-plan-request-01",
    });
    const guard = { modelConfigVersion: "config-v1", budgetVersion: "budget-v1", availablePoints: 500, sourceAssetsValid: true };
    expect(tasks.beginTool("member", run.runId, guard).kind).toBe("not_authorized");
    tasks.grantAuthorization("member", run.runId, {
      grantId: crypto.randomUUID(), capabilities: ["video"], sourceAssetIds: ["asset-a"],
      maxPointsPerTool: 300, budgetVersion: "budget-v1", modelConfigVersion: "config-v1",
      automaticChoice: false, expiresAt: Date.now() + 60_000,
    });
    const started = tasks.beginTool("member", run.runId, guard);
    expect(started.kind).toBe("started");
    expect(started.run.tool?.toolCallId).toBeTruthy();
    expect(started.run.tool?.inputSnapshot).toMatchObject({
      tenantId: "default", userId: "member", conversationId: "conversation-a", tier: "standard",
      modelConfigVersion: "config-v1", budgetVersion: "budget-v1", sourceAssetIds: ["asset-a"],
      runId: run.runId, stepId: started.run.stepId, attemptId: started.run.attemptId,
    });
    expect(tasks.beginTool("member", run.runId, guard).kind).toBe("already_started");
    expect(tasks.get("member", run.runId)?.tool?.toolCallId).toBe(started.run.tool?.toolCallId);
    const expired = tasks.sweepExpired(Date.now() + 120_000);
    expect(expired).toBeGreaterThan(0);
    expect(tasks.get("member", run.runId)?.status).toBe("unknown");
    expect(tasks.beginTool("member", run.runId, guard).kind).toBe("unknown");
  });

  it("does not mark an accepted asynchronous submission completed without a ready artifact", () => {
    const run = tasks.submit("member", input());
    tasks.claimPlanning("member", run.runId);
    tasks.stageTool("member", run.runId, { capability: "video", operationKey: "video-step", estimatedPoints: 250, sourceAssetIds: [] });
    tasks.grantAuthorization("member", run.runId, {
      grantId: crypto.randomUUID(), capabilities: ["video"], sourceAssetIds: [],
      maxPointsPerTool: 300, budgetVersion: "budget-v1", modelConfigVersion: "config-v1",
      automaticChoice: false, expiresAt: Date.now() + 60_000,
    });
    const started = tasks.beginTool("member", run.runId, { modelConfigVersion: "config-v1", budgetVersion: "budget-v1", availablePoints: 500, sourceAssetsValid: true });
    const toolCallId = started.run.tool!.toolCallId!;
    expect(tasks.recordToolSubmission("member", run.runId, toolCallId, toolCallId, Date.now() + 1000).status).toBe("running");
    expect(() => tasks.completeTool("member", run.runId, toolCallId, [])).toThrow();
    expect(tasks.completeTool("member", run.runId, toolCallId, ["ready-asset-1"]).status).toBe("completed");
    expect(tasks.completeTool("member", run.runId, toolCallId, ["ready-asset-1"]).status).toBe("completed");
  });

  it("cancels queued work locally, but keeps an already-started paid call live until provider acknowledgement", () => {
    const queued = tasks.submit("member", input());
    expect(tasks.cancel("member", queued.runId).status).toBe("cancelled");
    expect(tasks.claimPlanning("member", queued.runId)).toBeNull();
    expect(tasks.due().some(item => item.runId === queued.runId)).toBe(false);

    const run = tasks.submit("member", input());
    tasks.claimPlanning("member", run.runId);
    tasks.stageTool("member", run.runId, { capability: "video", operationKey: "video-step", estimatedPoints: 250, sourceAssetIds: [] });
    tasks.grantAuthorization("member", run.runId, {
      grantId: crypto.randomUUID(), capabilities: ["video"], sourceAssetIds: [],
      maxPointsPerTool: 300, budgetVersion: "budget-v1", modelConfigVersion: "config-v1",
      automaticChoice: false, expiresAt: Date.now() + 60_000,
    });
    const started = tasks.beginTool("member", run.runId, { modelConfigVersion: "config-v1", budgetVersion: "budget-v1", availablePoints: 500, sourceAssetsValid: true });
    const toolCallId = started.run.tool!.toolCallId!;
    const cancelled = tasks.cancel("member", run.runId);
    expect(cancelled).toMatchObject({ status: "running", cancelRequested: true });
    expect(tasks.cancel("member", run.runId).version).toBe(cancelled.version);
    expect(tasks.acknowledgeCancel("member", run.runId, toolCallId).status).toBe("cancelled");
    expect(tasks.acknowledgeCancel("member", run.runId, toolCallId).status).toBe("cancelled");
    expect(() => tasks.completeTool("member", run.runId, toolCallId, ["asset-after-cancel"])).toThrow();
  });

  it("freezes a compatible server-selected video model, dimensions and reference IDs", () => {
    const referenceId = "a".repeat(64);
    const parameters = { model: "minimax_h3" as const, seconds: 10, resolution: "768p" as const, aspectRatio: "9:16" as const, referenceIds: [referenceId] };
    const run = tasks.submit("member", { ...input(), videoParameters: parameters });
    parameters.referenceIds.push("b".repeat(64));
    expect(tasks.snapshot("member", run.runId)?.videoParameters?.referenceIds).toEqual([referenceId]);
    expect(() => tasks.submit("member", { ...input(), videoParameters: { ...parameters, model: "sd-2.5-c1", seconds: 15, resolution: "720p" } })).toThrow();
    expect(() => tasks.submit("member", { ...input(), videoParameters: { ...parameters, referenceIds: [referenceId, referenceId] } })).toThrow();
    expect(() => tasks.submit("member", { ...input(), intent: "image", videoParameters: parameters })).toThrow();
  });

  it("never starts work after its persisted deadline and lets a verified artifact resolve an uncertain run", () => {
    let clock = 1_000_000;
    tasks = new MediaTaskRuntime(node.store, () => clock);
    const expiredQueue = tasks.submit("member", { ...input(), deadlineAt: clock + 100 });
    clock += 101;
    expect(tasks.claimPlanning("member", expiredQueue.runId)).toBeNull();
    expect(tasks.get("member", expiredQueue.runId)?.status).toBe("failed");

    const run = tasks.submit("member", { ...input(), deadlineAt: clock + 100 });
    tasks.claimPlanning("member", run.runId);
    tasks.stageTool("member", run.runId, { capability: "video", operationKey: "video-step", estimatedPoints: 250, sourceAssetIds: [] });
    tasks.grantAuthorization("member", run.runId, {
      grantId: crypto.randomUUID(), capabilities: ["video"], sourceAssetIds: [],
      maxPointsPerTool: 300, budgetVersion: "budget-v1", modelConfigVersion: "config-v1",
      automaticChoice: false, expiresAt: clock + 100,
    });
    const started = tasks.beginTool("member", run.runId, { modelConfigVersion: "config-v1", budgetVersion: "budget-v1", availablePoints: 500, sourceAssetsValid: true });
    clock += 101;
    expect(tasks.sweepExpired(clock)).toBe(1);
    expect(tasks.get("member", run.runId)?.status).toBe("unknown");
    expect(tasks.beginTool("member", run.runId, { modelConfigVersion: "config-v1", budgetVersion: "budget-v1", availablePoints: 500, sourceAssetsValid: true }).kind).toBe("unknown");
    expect(tasks.completeTool("member", run.runId, started.run.tool!.toolCallId!, ["verified-ready-asset"]).status).toBe("completed");
  });
});
