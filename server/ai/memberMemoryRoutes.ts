import { json, Router, type NextFunction, type Request, type Response } from "express";
import { AI_MEMORY_LIMITS } from "../../shared/aiMemory";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { memoryReviewIds } from "./memberMemoryService";
import { AiError } from "./security";
import type { AiService } from "./service";
import { aiTenantIdFromPrincipal } from "./tenant";

function errorHandler(error: unknown, _request: Request, response: Response, next: NextFunction): void {
  if (error instanceof ApiError) { next(error); return; }
  if (error instanceof AiError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
  if (error && typeof error === "object" && "type" in error) {
    if (error.type === "entity.too.large") { response.status(413).json({ error: { code: "AI_MEMORY_TOO_LARGE", message: "提交内容过长，记忆未被修改" } }); return; }
    if (error.type === "entity.parse.failed") { response.status(400).json({ error: { code: "INVALID_JSON", message: "提交内容不是有效 JSON" } }); return; }
  }
  // Memory is private member data: never log or echo it on failure.
  response.status(500).json({ error: { code: "AI_MEMORY_ERROR", message: "记忆暂时不可用，请稍后重试" } });
}

/**
 * Mount at /api/ai/memory (scope "member") and /api/admin/ai/memory (scope
 * "admin") before the generic AI routers. Member routes only ever use the
 * authenticated account id; the admin router exposes settings and
 * organization aggregates, never memory text.
 */
export function createAiMemberMemoryRouter(
  service: AiService,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  scope: "member" | "admin",
): Router {
  const router = Router();
  const memory = (request: Request) => service.forTenant(aiTenantIdFromPrincipal(request.currentUser)).memberMemory;
  router.use(requireAuth, scope === "admin" ? requireRole("admin") : requireRole("member", "boss"));
  router.use((request, response, next) => {
    response.set("Cache-Control", "no-store");
    const expectedAccount = request.header("X-Tongpin-Account");
    if (expectedAccount !== undefined && expectedAccount !== request.currentUser!.id) throw new AiError(409, "AI_ACCOUNT_CHANGED", "账号已切换，本次未读取或修改其他账号的记忆");
    next();
  });
  router.use(json({ limit: AI_MEMORY_LIMITS.requestBytes }));
  if (scope === "admin") {
    router.get("/", (request, response) => response.json(memory(request).adminView()));
    router.put("/", (request, response) => response.json(memory(request).saveAdminSettings(request.body)));
  } else {
    const userId = (request: Request) => request.currentUser!.id;
    router.get("/", (request, response) => response.json(memory(request).state(userId(request))));
    router.delete("/", (request, response) => response.json(memory(request).clear(userId(request))));
    router.put("/settings", (request, response) => response.json(memory(request).setLearning(userId(request), request.body)));
    router.post("/entries", (request, response) => response.json(memory(request).updateEntry(userId(request), request.body)));
    router.get("/reviews", (request, response) => response.json({ reviews: memory(request).reviewStatuses(userId(request), memoryReviewIds(request.query.requestIds)) }));
    // History recall excerpts of one reply, and personal skills (Hermes-style learning).
    router.get("/recalls/:requestId", (request, response) => response.json({ recall: memory(request).recallDetail(userId(request), request.params.requestId) }));
    router.get("/skills", (request, response) => response.json(memory(request).personalSkills(userId(request))));
    router.post("/skills", (request, response) => response.json(memory(request).updateSkill(userId(request), request.body)));
  }
  router.use((_request, response) => response.status(404).json({ error: { code: "NOT_FOUND", message: "请求的接口不存在" } }));
  router.use(errorHandler);
  return router;
}
