import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { JsonStore } from "../store";
import { toPublicUser } from "../types";

export function createAdminRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
): Router {
  const router = Router();
  router.use(requireAuth, requireRole("admin"));

  router.get("/users", async (_request, response, next) => {
    try {
      const users = await store.read((database) =>
        database.users
          .map((user) => ({
            ...toPublicUser(user),
            taskCount: database.tasks.filter((task) => task.userId === user.id)
              .length,
          }))
          .sort(
            (a, b) =>
              a.status.localeCompare(b.status) ||
              b.createdAt.localeCompare(a.createdAt),
          ),
      );
      response.json({ users });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/users/:userId/access", async (request, response, next) => {
    try {
      const { status } = z
        .object({ status: z.enum(["active", "disabled"]) })
        .parse(request.body);
      if (request.params.userId === request.currentUser!.id) {
        throw new ApiError(400, "SELF_ACCESS_CHANGE", "不能停用自己的管理员账号");
      }
      const user = await store.mutate((database) => {
        const target = database.users.find(
          (candidate) => candidate.id === request.params.userId,
        );
        if (!target) {
          throw new ApiError(404, "USER_NOT_FOUND", "没有找到该账号");
        }
        if (target.role === "admin") {
          throw new ApiError(403, "ADMIN_PROTECTED", "不能修改其他管理员账号");
        }
        if (!target.emailVerifiedAt) {
          throw new ApiError(
            400,
            "EMAIL_NOT_VERIFIED",
            "该账号尚未完成邮箱验证",
          );
        }
        target.status = status;
        target.updatedAt = new Date().toISOString();
        if (status === "disabled") {
          database.refreshSessions = database.refreshSessions.filter(
            (session) => session.userId !== target.id,
          );
        }
        return target;
      });
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/users/:userId/role", async (request, response, next) => {
    try {
      const { role } = z
        .object({ role: z.enum(["member", "boss"]) })
        .parse(request.body);
      const user = await store.mutate((database) => {
        const target = database.users.find(
          (candidate) => candidate.id === request.params.userId,
        );
        if (!target) {
          throw new ApiError(404, "USER_NOT_FOUND", "没有找到该账号");
        }
        if (target.role === "admin") {
          throw new ApiError(403, "ADMIN_PROTECTED", "不能修改管理员角色");
        }
        target.role = role;
        target.updatedAt = new Date().toISOString();
        database.refreshSessions = database.refreshSessions.filter(
          (session) => session.userId !== target.id,
        );
        return target;
      });
      response.json({
        user: toPublicUser(user),
        sessionRevoked: true,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/users/:userId/profile", async (request, response, next) => {
    try {
      const { jobTitle } = z
        .object({ jobTitle: z.string().trim().max(30) })
        .parse(request.body);
      const user = await store.mutate((database) => {
        const target = database.users.find(
          (candidate) => candidate.id === request.params.userId,
        );
        if (!target) {
          throw new ApiError(404, "USER_NOT_FOUND", "没有找到该账号");
        }
        if (target.role === "admin") {
          throw new ApiError(403, "ADMIN_PROTECTED", "不能修改管理员资料");
        }
        target.jobTitle = jobTitle;
        target.updatedAt = new Date().toISOString();
        return target;
      });
      response.json({ user: toPublicUser(user) });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
