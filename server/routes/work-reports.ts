import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { businessDateKey } from "../business-date";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { JsonStore } from "../store";
import { buildBossWorkReport } from "../work-report";
import type { RealtimeHub } from "./boss";
import {
  toPublicUser,
  type AppNotification,
  type BossWorkReportStatus,
  type DatabaseShape,
} from "../types";

const triggerSchema = z.object({
  trigger: z.enum(["startup", "login", "resume", "reconnect", "day-change"]),
});

const nudgeSchema = z.object({
  userId: z.string().uuid(),
});

function reportFromDatabase(
  database: Readonly<DatabaseShape>,
  bossUserId: string,
  reportDate: string,
) {
  const status =
    database.bossWorkReportStatuses.find(
      (item) =>
        item.bossUserId === bossUserId && item.reportDate === reportDate,
    ) ?? null;
  return buildBossWorkReport({
    reportDate,
    status,
    users: database.users.map(toPublicUser),
    tasks: database.tasks,
    audits: database.taskAuditEvents,
  });
}

export function createWorkReportsRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  realtime: RealtimeHub,
): Router {
  const router = Router();
  router.use(requireAuth, requireRole("boss"));

  router.get("/current", async (request, response, next) => {
    try {
      const reportDate = businessDateKey();
      const report = await store.read((database) =>
        reportFromDatabase(
          database,
          request.currentUser!.id,
          reportDate,
        ),
      );
      response.json({ report });
    } catch (error) {
      next(error);
    }
  });

  router.post("/claim", async (request, response, next) => {
    try {
      const { trigger } = triggerSchema.parse(request.body);
      const bossUserId = request.currentUser!.id;
      const reportDate = businessDateKey();
      const claimed = await store.mutate((database) => {
        const existing = database.bossWorkReportStatuses.find(
          (item) =>
            item.bossUserId === bossUserId && item.reportDate === reportDate,
        );
        if (existing) return false;
        const status: BossWorkReportStatus = {
          bossUserId,
          reportDate,
          trigger,
          openedAt: new Date().toISOString(),
          dismissedAt: null,
          readAt: null,
        };
        database.bossWorkReportStatuses.push(status);
        return true;
      });
      const report = await store.read((database) =>
        reportFromDatabase(database, bossUserId, reportDate),
      );
      response.json({ shouldOpen: claimed, report });
    } catch (error) {
      next(error);
    }
  });

  router.post("/nudge", async (request, response, next) => {
    try {
      const { userId } = nudgeSchema.parse(request.body);
      const notification = await store.mutate((database) => {
        const member = database.users.find(
          (candidate) =>
            candidate.id === userId &&
            candidate.role === "member" &&
            candidate.status === "active",
        );
        if (!member) {
          throw new ApiError(
            404,
            "USER_NOT_FOUND",
            "没有找到该成员",
          );
        }
        const now = new Date().toISOString();
        const created: AppNotification = {
          id: randomUUID(),
          dispatchId: randomUUID(),
          senderId: request.currentUser!.id,
          recipientId: member.id,
          title: "老板提醒您",
          body: "昨日任务不要忘记完成哦",
          requiresAcknowledgement: true,
          deliveredAt: null,
          acknowledgedAt: null,
          dingCount: 0,
          lastDingAt: null,
          readAt: null,
          createdAt: now,
        };
        database.notifications.push(created);
        return created;
      });
      realtime.notifyUser(notification.recipientId, notification);
      response.status(201).json({ notification });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/current/dismiss", async (request, response, next) => {
    try {
      const bossUserId = request.currentUser!.id;
      const reportDate = businessDateKey();
      await store.mutate((database) => {
        const status = database.bossWorkReportStatuses.find(
          (item) =>
            item.bossUserId === bossUserId && item.reportDate === reportDate,
        );
        if (status && !status.readAt) {
          status.dismissedAt ??= new Date().toISOString();
        }
      });
      const report = await store.read((database) =>
        reportFromDatabase(database, bossUserId, reportDate),
      );
      response.json({ report });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/current/read", async (request, response, next) => {
    try {
      const bossUserId = request.currentUser!.id;
      const reportDate = businessDateKey();
      await store.mutate((database) => {
        const status = database.bossWorkReportStatuses.find(
          (item) =>
            item.bossUserId === bossUserId && item.reportDate === reportDate,
        );
        if (!status) return;
        const now = new Date().toISOString();
        status.dismissedAt ??= now;
        status.readAt ??= now;
      });
      const report = await store.read((database) =>
        reportFromDatabase(database, bossUserId, reportDate),
      );
      response.json({ report });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
