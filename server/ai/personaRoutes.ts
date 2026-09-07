import { json, Router, type NextFunction, type Request, type Response } from "express";
import { AI_PERSONA_LIMITS } from "../../shared/aiPersona";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { AiError } from "./security";
import type { AiPersonaRepository } from "./persona";

/** Mount at /api/ai/persona before the global body parser. No administrator browsing endpoint. */
export function createAiPersonaRouter(
  repository: AiPersonaRepository,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
): Router {
  const router = Router();
  router.use(requireAuth, requireRole("member", "boss"));
  router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    const expectedAccount = request.header("X-Tongpin-Account");
    if (expectedAccount !== undefined && expectedAccount !== request.currentUser!.id) throw new AiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，本次未读取或修改其他账号的专属 AI 设置");
    next();
  });
  router.use(json({ limit: AI_PERSONA_LIMITS.requestBytes }));
  router.get("/", (request, response) => response.json(repository.read(request.currentUser!.id)));
  router.put("/", (request, response) => response.json(repository.save(request.currentUser!.id, request.body)));
  router.all("/", (_request, response) => response.set("Allow", "GET, PUT").status(405).json({ error: { code: "METHOD_NOT_ALLOWED", message: "此接口仅支持读取或保存专属 AI 设置" } }));
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof ApiError) { next(error); return; }
    if (error instanceof AiError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error && typeof error === "object" && "type" in error) {
      if (error.type === "entity.too.large") {
        response.status(413).json({ error: { code: "AI_PERSONA_TOO_LARGE", message: "专属 AI 设置过长，原设置未被更改" } }); return;
      }
      if (error.type === "entity.parse.failed") {
        response.status(400).json({ error: { code: "INVALID_JSON", message: "提交内容不是有效 JSON" } }); return;
      }
    }
    // Preferences may contain private information; never log or echo them on failure.
    response.status(500).json({ error: { code: "AI_PERSONA_ERROR", message: "专属 AI 设置暂时不可用，请稍后重试" } });
  });
  return router;
}
