import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config";
import { ApiError } from "./errors";
import { verifyAccessToken } from "./security";
import { JsonStore } from "./store";
import { toPublicUser, type UserRole } from "./types";

export function createRequireAuth(store: JsonStore, config: AppConfig) {
  return async function requireAuth(
    request: Request,
    _response: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const authorization = request.header("authorization");
      if (!authorization?.startsWith("Bearer ")) {
        throw new ApiError(401, "AUTH_REQUIRED", "请先登录");
      }

      const claims = verifyAccessToken(authorization.slice(7), config);
      const user = await store.read((database) =>
        database.users.find((candidate) => candidate.id === claims.sub),
      );

      if (!user || user.status !== "active") {
        throw new ApiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录");
      }

      request.currentUser = toPublicUser(user);
      next();
    } catch (error) {
      if (error instanceof ApiError) {
        next(error);
        return;
      }
      next(new ApiError(401, "SESSION_INVALID", "登录状态已失效，请重新登录"));
    }
  };
}

export function requireRole(...roles: UserRole[]) {
  return function roleGuard(
    request: Request,
    _response: Response,
    next: NextFunction,
  ): void {
    if (!request.currentUser) {
      next(new ApiError(401, "AUTH_REQUIRED", "请先登录"));
      return;
    }
    if (!roles.includes(request.currentUser.role)) {
      next(new ApiError(403, "FORBIDDEN", "你没有访问此功能的权限"));
      return;
    }
    next();
  };
}
