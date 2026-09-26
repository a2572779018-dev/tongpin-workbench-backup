import { Router } from "express";
import { Readable } from "node:stream";
import { AiError } from "../ai/security";
import type { AiService } from "../ai/service";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import type { JsonStore } from "../store";
import type { AiMode } from "../../shared/ai";
import { aiTenantIdFromPrincipal } from "../ai/tenant";
import { createChatStreamResponse } from "../ai/chatStream";
import { readGeneratedAssetReference } from "../ai/generatedAssetReference";
import {
  createAiServiceMediaTaskOrchestrator,
  type MediaTaskConfirmation,
  type SubmitMediaTask,
} from "../ai/mediaTaskOrchestrator";
import type { MediaTaskRun } from "../ai/mediaTaskRuntime";
import { runGuidanceRoute } from "../ai/runGuidance";
import { registerAiVoiceRoutes } from "../ai/voiceRoutes";

const videoTier = (value: unknown): AiMode => ["quick", "standard", "deep", "pro"].includes(String(value)) ? value as AiMode : "quick";

function mediaTaskJson(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AiError(400, "INVALID_JSON", "请提交有效 JSON 内容");
  if ("tenantId" in value || "userId" in value) throw new AiError(400, "AI_MEDIA_TASK_SCOPE_FORBIDDEN", "任务账号范围只能由当前登录状态确定");
  return value as Record<string, unknown>;
}

function mediaTaskScope(run: MediaTaskRun, tenantId: string, userId: string): MediaTaskRun {
  if (run.tenantId !== tenantId || run.userId !== userId) throw new AiError(404, "AI_MEDIA_TASK_NOT_FOUND", "没有找到这条任务");
  return run;
}

export function createAiRouter(service: AiService, users: JsonStore, requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>, admin = false): Router {
  const router = Router();
  const scoped = (request: import("express").Request) => service.forTenant(aiTenantIdFromPrincipal(request.currentUser));
  const video = (request: import("express").Request) => scoped(request).video;
  type ScheduledMediaTask = { cancelled: boolean; timer?: ReturnType<typeof setTimeout> };
  const scheduledMediaTasks = new Map<string, ScheduledMediaTask>();
  const mediaTaskKey = (run: Pick<MediaTaskRun, "tenantId" | "userId" | "runId">) => `${run.tenantId}\u0000${run.userId}\u0000${run.runId}`;
  const mediaTaskPrincipalActive = (run: Pick<MediaTaskRun, "tenantId" | "userId">) => users.read(database => {
    const current = database.users.find(item => item.id === run.userId);
    return current?.status === "active" && (current.role === "member" || current.role === "boss")
      && aiTenantIdFromPrincipal(current) === run.tenantId;
  });
  const scheduleMediaTask = (run: MediaTaskRun): void => {
    const key = mediaTaskKey(run);
    const previous = scheduledMediaTasks.get(key);
    if (previous) { previous.cancelled = true; if (previous.timer) clearTimeout(previous.timer); scheduledMediaTasks.delete(key); }
    const schedulable = ["queued", "planning", "awaiting_input", "running", "partial", "unknown"].includes(run.status)
      || run.status === "awaiting_authorization" && run.authorization !== undefined;
    if (run.dueAt === null || !schedulable) return;
    const scheduled: ScheduledMediaTask = { cancelled: false };
    const execute = () => {
      if (scheduled.cancelled || scheduledMediaTasks.get(key) !== scheduled) return;
      scheduledMediaTasks.delete(key);
      void mediaTaskPrincipalActive(run)
        .then(active => active ? createAiServiceMediaTaskOrchestrator(service.forTenant(run.tenantId)).advance(run.userId, run.runId) : null)
        .then(next => { if (next) scheduleMediaTask(mediaTaskScope(next, run.tenantId, run.userId)); })
        .catch(() => {
          const retryAt = Math.min(run.deadlineAt, Date.now() + 5_000);
          if (retryAt > Date.now()) scheduleMediaTask({ ...run, dueAt: retryAt });
        });
    };
    scheduledMediaTasks.set(key, scheduled);
    const delay = Math.max(0, run.dueAt - Date.now());
    if (delay === 0) queueMicrotask(execute);
    else { scheduled.timer = setTimeout(execute, delay); scheduled.timer.unref?.(); }
  };
  const scheduleAfterResponse = (response: import("express").Response, run: MediaTaskRun): void => {
    response.once("finish", () => scheduleMediaTask(run));
  };
  router.use(requireAuth);
  router.use((request, _response, next) => {
    if (request.get("X-Tongpin-Account") !== undefined && request.get("X-Tongpin-Account") !== request.currentUser!.id) {
      next(new ApiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，请重新打开工作台")); return;
    }
    next();
  });
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  if (admin) {
    router.use(requireRole("admin"));
    router.get("/video", (request, response) => response.json({ settings: video(request).settings(), pending: video(request).adminPending() }));
    router.put("/video", async (request, response) => response.json({ settings: await video(request).configure(request.body) }));
    router.post("/video/test", async (request, response) => response.json(await video(request).test()));
    router.post("/videos/:userId/:id/reconcile", (request, response) => response.json({ job: video(request).reconcile(request.params.userId, request.params.id, request.currentUser!.id, request.body) }));
    router.get("/provider", (request, response) => response.json({ provider: scoped(request).provider() }));
    router.put("/provider", async (request, response) => response.json({ provider: await scoped(request).saveProvider(request.body) }));
    router.post("/provider/test", async (request, response) => response.json(await scoped(request).testProvider(request.body)));
    router.get("/harness", (request, response) => response.json({ harness: scoped(request).harnessSettings() }));
    router.put("/harness", async (request, response) => response.json({ harness: await scoped(request).saveHarness(request.body) }));
    router.post("/harness/providers/:id/discover", async (request, response) => response.json(await scoped(request).discoverHarnessProvider(request.params.id)));
    router.get("/observability", (request, response) => response.json(scoped(request).observability(Number(request.query.windowMinutes ?? 60))));
    router.patch("/observability/alerts/:id/acknowledge", (request, response) => response.json({ alert: scoped(request).acknowledgeObservabilityAlert(request.params.id, request.currentUser!.id) }));
    router.get("/members", async (request, response) => {
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const members = await users.read(db => db.users.filter(user => (user.role === "member" || user.role === "boss") && aiTenantIdFromPrincipal(user) === tenantId).map(({ id, email, name, role, status }) => ({ id, email, name, role, status })));
      response.json({ members: scoped(request).members(members) });
    });
    router.put("/members/:id/quota", async (request, response) => {
      const member = await users.read(db => db.users.find(user => user.id === request.params.id));
      if (!member || aiTenantIdFromPrincipal(member) !== aiTenantIdFromPrincipal(request.currentUser)) throw new ApiError(404, "USER_NOT_FOUND", "没有找到该成员");
      if (member.role !== "member" && member.role !== "boss") throw new ApiError(403, "AI_MEMBER_REQUIRED", "AI 额度仅可分配给成员或老板账号");
      const quota = scoped(request).setQuota(member.id, request.currentUser!.id, request.body);
      response.json({ member: { id: member.id, email: member.email, name: member.name, role: member.role, status: member.status, quota } });
    });
    router.get("/usage", (request, response) => response.json({ entries: scoped(request).store.usage(typeof request.query.userId === "string" ? request.query.userId : undefined) }));
  } else {
    router.use(requireRole("member", "boss"));
    router.get("/videos", (request, response) => response.json(video(request).list(request.currentUser!.id, videoTier(request.query.tier))));
    router.post("/video-references", async (request, response) => response.json(await video(request).uploadReference(request.currentUser!.id, request.body)));
    router.post("/video-references/generated-asset", async (request, response) => response.json(await video(request).generatedReferenceSource(request.currentUser!.id, request.body)));
    router.post("/videos", async (request, response) => response.json({ job: await video(request).submit(request.currentUser!.id, request.body) }));
    router.get("/videos/:id", async (request, response) => response.json({ job: await video(request).refresh(request.currentUser!.id, request.params.id) }));
    router.get("/videos/:id/content/check", async (request, response) => response.json(await video(request).checkContent(request.currentUser!.id, request.params.id)));
    router.get("/videos/:id/content", async (request, response) => {
      const result = await video(request).content(request.currentUser!.id, request.params.id);
      result.headers.forEach((value, key) => response.set(key, value));
      const stream = Readable.fromWeb(result.body as import("node:stream/web").ReadableStream);
      response.on("close", () => stream.destroy()); stream.on("error", () => response.destroy()); stream.pipe(response);
    });
    router.get("/status", (request, response) => response.json(scoped(request).status(request.currentUser!.id)));
    router.get("/availability", async (request, response) => response.json(await scoped(request).availability(request.currentUser!.id, typeof request.query.target === "string" ? request.query.target : "chat")));
    router.get("/usage", (request, response) => { const current = scoped(request); current.quota(request.currentUser!.id); response.json({ entries: current.memberUsage(request.currentUser!.id) }); });
    router.post("/preflight", (request, response) => response.json(scoped(request).preflight(request.currentUser!.id, request.body)));
    router.post("/chat", async (request, response) => response.json(await scoped(request).chat(request.currentUser!.id, request.body)));
    router.post("/chat/stream", (request, response) => {
      const result = createChatStreamResponse(scoped(request), request.currentUser!.id, request.body);
      result.headers.forEach((value, key) => response.set(key, value));
      response.flushHeaders();
      const stream = Readable.fromWeb(result.body as import("node:stream/web").ReadableStream);
      response.on("close", () => stream.destroy()); stream.on("error", () => response.destroy()); stream.pipe(response);
    });
    router.get("/requests/:id/events", (request, response) => response.json({ events: scoped(request).getRunEvents(request.currentUser!.id, request.params.id, Number(request.query.after ?? 0)) }));
    router.post("/media-tasks", async (request, response) => {
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const body = mediaTaskJson(request.body);
      const orchestrator = createAiServiceMediaTaskOrchestrator(scoped(request));
      const task = mediaTaskScope(await orchestrator.submit(userId, {
        requestId: body.requestId,
        conversationId: body.conversationId,
        entrypoint: body.entrypoint,
        tier: body.tier,
        intent: body.intent,
        requestText: body.requestText,
        sourceAssetIds: body.sourceAssetIds,
        ...(body.videoParameters !== undefined ? { videoParameters: body.videoParameters } : {}),
        ...(body.deadlineAt !== undefined ? { deadlineAt: body.deadlineAt } : {}),
        ...(body.confirmedMediaExecution !== undefined ? { confirmedMediaExecution: body.confirmedMediaExecution } : {}),
      } as SubmitMediaTask), tenantId, userId);
      scheduleAfterResponse(response, task);
      response.status(202).json({ task });
    });
    router.get("/media-tasks/by-request/:requestId", async (request, response) => {
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const orchestrator = createAiServiceMediaTaskOrchestrator(scoped(request));
      let task = orchestrator.getByRequest(userId, request.params.requestId);
      if (task.status === "unknown" && task.tool?.capability === "video") task = await orchestrator.advance(userId, task.runId);
      response.json({ task: mediaTaskScope(task, tenantId, userId) });
    });
    router.get("/media-tasks/:id/events", (request, response) => {
      const userId = request.currentUser!.id;
      const events = createAiServiceMediaTaskOrchestrator(scoped(request)).events(userId, request.params.id, Number(request.query.after ?? 0));
      response.json({ events });
    });
    router.get("/media-tasks/:id", (request, response) => {
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const task = createAiServiceMediaTaskOrchestrator(scoped(request)).get(userId, request.params.id);
      response.json({ task: mediaTaskScope(task, tenantId, userId) });
    });
    router.post("/media-tasks/:id/advance", async (request, response) => {
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const task = mediaTaskScope(await createAiServiceMediaTaskOrchestrator(scoped(request)).advance(userId, request.params.id), tenantId, userId);
      scheduleAfterResponse(response, task);
      response.json({ task });
    });
    router.post("/media-tasks/:id/answer", (request, response) => {
      const body = mediaTaskJson(request.body);
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const orchestrator = createAiServiceMediaTaskOrchestrator(scoped(request));
      const task = mediaTaskScope(orchestrator.answer(userId, request.params.id, body.questionId as string, body.answer as string), tenantId, userId);
      scheduleAfterResponse(response, task);
      response.json({ task });
    });
    router.post("/media-tasks/:id/authorize", async (request, response) => {
      const body = mediaTaskJson(request.body);
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const task = mediaTaskScope(await createAiServiceMediaTaskOrchestrator(scoped(request)).authorizeAndExecute(userId, request.params.id, {
        confirmed: body.confirmed,
        maxPointsPerTool: body.maxPointsPerTool,
        ...(body.automaticChoice !== undefined ? { automaticChoice: body.automaticChoice } : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      } as MediaTaskConfirmation), tenantId, userId);
      scheduleAfterResponse(response, task);
      response.json({ task });
    });
    router.delete("/media-tasks/:id", (request, response) => {
      const tenantId = aiTenantIdFromPrincipal(request.currentUser);
      const userId = request.currentUser!.id;
      const task = mediaTaskScope(createAiServiceMediaTaskOrchestrator(scoped(request)).cancel(userId, request.params.id), tenantId, userId);
      scheduleMediaTask(task);
      response.json({ task });
    });
    router.post("/images", async (request, response) => response.json(await scoped(request).generateImage(request.currentUser!.id, request.body)));
    router.get("/assets/:id/conversation/:conversationId", async (request, response) => response.json(await readGeneratedAssetReference(scoped(request).store, request.currentUser!.id,
      { assetId: request.params.id, conversationId: request.params.conversationId })));
    router.get("/assets/:id/check", (request, response) => response.json(scoped(request).checkAsset(request.currentUser!.id, request.params.id)));
    router.get("/assets/:id", (request, response) => response.json(scoped(request).getAsset(request.currentUser!.id, request.params.id)));
    router.delete("/assets/:id", (request, response) => { scoped(request).deleteAsset(request.currentUser!.id, request.params.id); response.json({ deleted: true }); });
    router.get("/requests/:id", (request, response) => response.json(scoped(request).getRequestResult(request.currentUser!.id, request.params.id)));
    // Mid-run guidance (steer); same contract as the Worker via runGuidanceRoute.
    router.post("/requests/:id/guidance", (request, response) => response.json(runGuidanceRoute(scoped(request).store, request.currentUser!.id, "POST", request.params.id, undefined, request.body)));
    router.get("/requests/:id/guidance", (request, response) => response.json(runGuidanceRoute(scoped(request).store, request.currentUser!.id, "GET", request.params.id)));
    router.delete("/requests/:id/guidance/:guidanceId", (request, response) => response.json(runGuidanceRoute(scoped(request).store, request.currentUser!.id, "DELETE", request.params.id, request.params.guidanceId)));
    router.get("/runs/:id", (request, response) => response.json({ trace: scoped(request).harnessTrace(request.currentUser!.id, request.params.id) }));
    router.post("/runs/:id/resume", async (request, response) => response.json({ trace: await scoped(request).resumeHarnessRun(request.currentUser!.id, request.params.id) }));
    router.delete("/runs/:id", (request, response) => response.json({ trace: scoped(request).cancelHarnessRun(request.currentUser!.id, request.params.id) }));
  }
  registerAiVoiceRoutes(router, request => scoped(request).voice, admin);
  // Provider error bodies and caught network errors are deliberately never logged or forwarded.
  router.use((error: unknown, _request: import("express").Request, response: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof ApiError) { next(error); return; }
    if (error instanceof AiError) { response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } }); return; }
    response.status(500).json({ error: { code: "AI_SERVER_ERROR", message: "AI 服务处理失败，请稍后重试" } });
  });
  return router;
}
