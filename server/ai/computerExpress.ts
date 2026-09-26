import type { NextFunction, Request, Response } from "express";
import { handleComputerApi } from "./computerRoutes";
import type { AiService } from "./service";

/** Express adapter: `router.use("/computer", computerExpressRoutes(scoped, prefix))`. */
export function computerExpressRoutes(scoped: (request: Request) => AiService, prefix: "/api/ai" | "/api/admin/ai") {
  return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    const result = await handleComputerApi(scoped(request), {
      method: request.method,
      path: `${prefix}/computer${request.path === "/" ? "" : request.path}`,
      userId: request.currentUser!.id,
      readBody: async () => request.body,
    });
    if (!result) { next(); return; }
    response.status(result.status).json(result.body);
  };
}
