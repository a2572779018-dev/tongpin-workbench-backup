import { Router } from "express";
import { Readable } from "node:stream";
import { AiError } from "../ai/security";
import type { AiService } from "../ai/service";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import type { JsonStore } from "../store";
import type { AiMode } from "../../shared/ai";
import { aiTenantIdFromPrincipal } from "../ai/tenant";
import { createDifyGrantResponse, type DifyRouteOptions } from "../ai/difyRuntimeRoutes";

const videoTier = (value: unknown): AiMode => ["quick", "standard", "deep", "pro"].includes(String(value)) ? value as AiMode : "quick";

export function createAiRouter(service: AiService, users: JsonStore, requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>, admin = false, dify: DifyRouteOptions = {}): Router {
  const router = Router();
  const scoped = (request: import("express").Request) => service.forTenant(aiTenantIdFromPrincipal(request.currentUser));
  const video = (request: import("express").Request) => scoped(request).video;
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
    router.post("/dify/grants", async (request, response) => {
      const result = await createDifyGrantResponse(scoped(request), { tenantId: aiTenantIdFromPrincipal(request.currentUser), userId: request.currentUser!.id }, request.body, dify);
      result.headers.forEach((value, key) => response.set(key, value));
      response.status(result.status).send(await result.text());
    });
    router.get("/videos", (request, response) => response.json(video(request).list(request.currentUser!.id, videoTier(request.query.tier))));
    router.post("/video-references", async (request, response) => response.json(await video(request).uploadReference(request.currentUser!.id, request.body)));
    router.post("/videos", async (request, response) => response.json({ job: await video(request).submit(request.currentUser!.id, request.body) }));
    router.get("/videos/:id", async (request, response) => response.json({ job: await video(request).refresh(request.currentUser!.id, request.params.id) }));
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
    router.post("/images", async (request, response) => response.json(await scoped(request).generateImage(request.currentUser!.id, request.body)));
    router.get("/assets/:id", (request, response) => response.json(scoped(request).getAsset(request.currentUser!.id, request.params.id)));
    router.delete("/assets/:id", (request, response) => { scoped(request).deleteAsset(request.currentUser!.id, request.params.id); response.json({ deleted: true }); });
    router.get("/requests/:id", (request, response) => response.json(scoped(request).getRequestResult(request.currentUser!.id, request.params.id)));
    router.get("/runs/:id", (request, response) => response.json({ trace: scoped(request).harnessTrace(request.currentUser!.id, request.params.id) }));
    router.post("/runs/:id/resume", async (request, response) => response.json({ trace: await scoped(request).resumeHarnessRun(request.currentUser!.id, request.params.id) }));
    router.delete("/runs/:id", (request, response) => response.json({ trace: scoped(request).cancelHarnessRun(request.currentUser!.id, request.params.id) }));
  }
  // Provider error bodies and caught network errors are deliberately never logged or forwarded.
  router.use((error: unknown, _request: import("express").Request, response: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof ApiError) { next(error); return; }
    if (error instanceof AiError) { response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } }); return; }
    response.status(500).json({ error: { code: "AI_SERVER_ERROR", message: "AI 服务处理失败，请稍后重试" } });
  });
  return router;
}
