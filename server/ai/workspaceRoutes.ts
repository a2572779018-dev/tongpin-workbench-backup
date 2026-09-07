import { json, Router, type NextFunction, type Request, type Response } from "express";
import { AI_WORKSPACE_LIMITS } from "../../shared/aiWorkspace";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { AiError } from "./security";
import type { AiWorkspaceRepository } from "./workspace";

/** Mount at /api/ai/workspace before any smaller global JSON body parser. */
export function createAiWorkspaceRouter(
  repository: AiWorkspaceRepository,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
): Router {
  const router = Router();
  router.use(requireAuth, requireRole("member", "boss"));
  router.use((_request, response, next) => { response.set("Cache-Control", "no-store"); next(); });
  router.use((request, _response, next) => {
    const expectedAccount = request.header("X-Tongpin-Account");
    if (expectedAccount !== undefined && expectedAccount !== request.currentUser!.id) throw new AiError(409, "AI_WORKSPACE_ACCOUNT_CHANGED", "当前登录账号已改变，请重新打开工作台");
    next();
  });
  router.use(json({ limit: AI_WORKSPACE_LIMITS.requestBytes }));
  router.get("/", (request, response) => response.json(repository.read(request.currentUser!.id)));
  router.put("/", async (request, response) => {
    response.json(await repository.save(request.currentUser!.id, request.body));
  });
  router.all("/", (_request, response) => response.set("Allow", "GET, PUT").status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持读取或保存工作台" } }));
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof ApiError) { next(error); return; }
    if (error instanceof AiError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error && typeof error === "object" && "type" in error) {
      if (error.type === "entity.too.large") {
        response.status(413).json({ error: { code: "AI_WORKSPACE_TOO_LARGE", message: "工作台提交内容过大，原记录未被更改" } }); return;
      }
      if (error.type === "entity.parse.failed") {
        response.status(400).json({ error: { code: "INVALID_JSON", message: "提交内容不是有效 JSON" } }); return;
      }
    }
    // Do not log or echo snapshots: they can contain private conversations and attachments.
    response.status(500).json({ error: { code: "AI_WORKSPACE_ERROR", message: "工作台保存服务暂不可用，请保留当前窗口后重试" } });
  });
  return router;
}
