import { raw, Router, type NextFunction, type Request, type Response } from "express";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { AI_WORKSPACE_V2_REQUEST_BYTES, handleAiWorkspaceV2Request } from "./workspaceV2Protocol";
import type { AiWorkspaceV2Store } from "./workspaceV2Store";

/** Mount before the application's generic 768 KiB JSON parser. */
export function createAiWorkspaceV2Router(store: AiWorkspaceV2Store,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>): Router {
  const router = Router();
  router.use(requireAuth, requireRole("member", "boss"));
  router.use(raw({ type: "application/json", limit: AI_WORKSPACE_V2_REQUEST_BYTES }));
  router.use(async (request, response) => {
    try {
      const headers = new Headers();
      const account = request.header("X-Tongpin-Account");
      if (account !== undefined) headers.set("X-Tongpin-Account", account);
      if (request.header("Content-Type")) headers.set("Content-Type", request.header("Content-Type")!);
      const result = await handleAiWorkspaceV2Request(new globalThis.Request(`http://localhost${request.originalUrl}`, {
        method: request.method, headers,
        ...(Buffer.isBuffer(request.body) ? { body: Uint8Array.from(request.body) } : {}),
      }), store, request.currentUser!);
      result.headers.forEach((value, key) => response.set(key, value));
      response.status(result.status).send(await result.text());
    } catch {
      response.set("Cache-Control", "no-store").status(500).json({ error: { code: "AI_WORKSPACE_ERROR", message: "工作台服务暂不可用，请稍后重试" } });
    }
  });
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (error instanceof ApiError) { next(error); return; }
    if ((error as { type?: string })?.type === "entity.too.large") {
      response.set("Cache-Control", "no-store").status(413).json({ error: { code: "AI_WORKSPACE_TOO_LARGE", message: "单次分实体提交内容过大，原记录未被更改" } });
      return;
    }
    response.set("Cache-Control", "no-store").status(400).json({ error: { code: "INVALID_JSON", message: "提交内容不是有效 JSON" } });
  });
  return router;
}
