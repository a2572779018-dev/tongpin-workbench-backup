import { Router } from "express";
import { Readable } from "node:stream";
import { AiError } from "../ai/security";
import type { AiService } from "../ai/service";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import type { JsonStore } from "../store";

export function createAiRouter(service: AiService, users: JsonStore, requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>, admin = false): Router {
  const router = Router();
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
    router.get("/video", (_request, response) => response.json({ settings: service.video.settings(), pending: service.video.adminPending() }));
    router.put("/video", async (request, response) => response.json({ settings: await service.video.configure(request.body) }));
    router.post("/video/test", async (_request, response) => response.json(await service.video.test()));
    router.post("/videos/:userId/:id/reconcile", (request, response) => response.json({ job: service.video.reconcile(request.params.userId, request.params.id, request.currentUser!.id, request.body) }));
    router.get("/provider", (_request, response) => response.json({ provider: service.provider() }));
    router.put("/provider", async (request, response) => response.json({ provider: await service.saveProvider(request.body) }));
    router.post("/provider/test", async (request, response) => response.json(await service.testProvider(request.body)));
    router.get("/members", async (_request, response) => {
      const members = await users.read(db => db.users.filter(user => user.role === "member" || user.role === "boss").map(({ id, email, name, role, status }) => ({ id, email, name, role, status })));
      response.json({ members: service.members(members) });
    });
    router.put("/members/:id/quota", async (request, response) => {
      const member = await users.read(db => db.users.find(user => user.id === request.params.id));
      if (!member) throw new ApiError(404, "USER_NOT_FOUND", "没有找到该成员");
      if (member.role !== "member" && member.role !== "boss") throw new ApiError(403, "AI_MEMBER_REQUIRED", "AI 额度仅可分配给成员或老板账号");
      const quota = service.setQuota(member.id, request.currentUser!.id, request.body);
      response.json({ member: { id: member.id, email: member.email, name: member.name, role: member.role, status: member.status, quota } });
    });
    router.get("/usage", (request, response) => response.json({ entries: service.store.usage(typeof request.query.userId === "string" ? request.query.userId : undefined) }));
  } else {
    router.use(requireRole("member", "boss"));
    router.get("/videos", (request, response) => response.json(service.video.list(request.currentUser!.id)));
    router.post("/videos", async (request, response) => response.json({ job: await service.video.submit(request.currentUser!.id, request.body) }));
    router.get("/videos/:id", async (request, response) => response.json({ job: await service.video.refresh(request.currentUser!.id, request.params.id) }));
    router.get("/videos/:id/content", async (request, response) => {
      const video = await service.video.content(request.currentUser!.id, request.params.id);
      video.headers.forEach((value, key) => response.set(key, value));
      const stream = Readable.fromWeb(video.body as import("node:stream/web").ReadableStream);
      response.on("close", () => stream.destroy()); stream.on("error", () => response.destroy()); stream.pipe(response);
    });
    router.get("/status", (request, response) => response.json(service.status(request.currentUser!.id)));
    router.get("/availability", async (request, response) => response.json(await service.availability(request.currentUser!.id, typeof request.query.target === "string" ? request.query.target : "chat")));
    router.get("/usage", (request, response) => { service.quota(request.currentUser!.id); response.json({ entries: service.store.usage(request.currentUser!.id) }); });
    router.post("/preflight", (request, response) => response.json(service.preflight(request.currentUser!.id, request.body)));
    router.post("/chat", async (request, response) => response.json(await service.chat(request.currentUser!.id, request.body)));
    router.post("/images", async (request, response) => response.json(await service.generateImage(request.currentUser!.id, request.body)));
    router.get("/assets/:id", (request, response) => response.json(service.getAsset(request.currentUser!.id, request.params.id)));
    router.delete("/assets/:id", (request, response) => { service.deleteAsset(request.currentUser!.id, request.params.id); response.json({ deleted: true }); });
    router.get("/requests/:id", (request, response) => response.json(service.getRequestResult(request.currentUser!.id, request.params.id)));
  }
  // Provider error bodies and caught network errors are deliberately never logged or forwarded.
  router.use((error: unknown, _request: import("express").Request, response: import("express").Response, next: import("express").NextFunction) => {
    if (error instanceof ApiError) { next(error); return; }
    if (error instanceof AiError) { response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}), ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) } }); return; }
    response.status(500).json({ error: { code: "AI_SERVER_ERROR", message: "AI 服务处理失败，请稍后重试" } });
  });
  return router;
}
