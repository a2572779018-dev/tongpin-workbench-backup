import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { businessDateKey } from "../business-date";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import { JsonStore } from "../store";
import { appendTaskAudit } from "../task-audit";
import {
  toPublicUser,
  type AppNotification,
  type DirectMessage,
  type NotificationDispatch,
  type NotificationReceipt,
  type PublicUser,
  type Task,
} from "../types";

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)));

export interface RealtimeHub {
  notifyUser(
    userId: string,
    notification: AppNotification,
    type?: "notification:new" | "notification:ding",
  ): void;
  receiptUser(userId: string, receipt: NotificationReceipt): void;
  messageUser(
    userId: string,
    message: DirectMessage,
    sender: PublicUser,
  ): void;
  pushUser(userId: string, type: string, data: unknown): void;
}

export const silentRealtimeHub: RealtimeHub = {
  notifyUser: () => undefined,
  receiptUser: () => undefined,
  messageUser: () => undefined,
  pushUser: () => undefined,
};

function buildNotificationDispatches(
  notifications: AppNotification[],
  users: Parameters<typeof toPublicUser>[0][],
  senderId: string,
): NotificationDispatch[] {
  const grouped = new Map<string, AppNotification[]>();
  for (const notification of notifications) {
    if (
      notification.senderId !== senderId ||
      !notification.requiresAcknowledgement
    ) {
      continue;
    }
    const entries = grouped.get(notification.dispatchId) ?? [];
    entries.push(notification);
    grouped.set(notification.dispatchId, entries);
  }

  return [...grouped.entries()]
    .map(([dispatchId, entries]) => {
      const first = entries[0];
      const recipients: NotificationDispatch["recipients"] = [];
      for (const entry of entries) {
        const user = users.find((candidate) => candidate.id === entry.recipientId);
        if (!user) continue;
        recipients.push({
          notificationId: entry.id,
          user: toPublicUser(user),
          deliveredAt: entry.deliveredAt,
          acknowledgedAt: entry.acknowledgedAt,
        });
      }
      const acknowledged = recipients.filter(
        (recipient) => recipient.acknowledgedAt,
      ).length;
      const delivered = recipients.filter(
        (recipient) => recipient.deliveredAt,
      ).length;
      return {
        id: dispatchId,
        senderId,
        title: first.title,
        body: first.body,
        dingCount: first.dingCount,
        lastDingAt: first.lastDingAt,
        createdAt: first.createdAt,
        recipients,
        counts: {
          total: recipients.length,
          delivered,
          acknowledged,
          pending: recipients.length - acknowledged,
        },
      };
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
}

export function createBossRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  realtime: RealtimeHub,
): Router {
  const router = Router();
  router.use(requireAuth, requireRole("boss"));

  router.get("/team", async (request, response, next) => {
    try {
      const { date } = z.object({ date: dateSchema }).parse(request.query);
      const members = await store.read((database) =>
        database.users
          .filter(
            (user) =>
              user.status === "active" &&
              (user.role === "member" || user.role === "boss"),
          )
          .map((user) => {
            const tasks = database.tasks.filter(
              (task) => task.userId === user.id && task.date === date,
            );
            const done = tasks.filter((task) => task.status === "done").length;
            const doing = tasks.filter((task) => task.status === "doing").length;
            return {
              user: toPublicUser(user),
              total: tasks.length,
              done,
              doing,
              completionRate:
                tasks.length === 0 ? 0 : Math.round((done / tasks.length) * 100),
            };
          })
          .sort(
            (a, b) =>
              b.completionRate - a.completionRate ||
              a.user.name.localeCompare(b.user.name, "zh-CN"),
          ),
      );
      response.json({ date, members });
    } catch (error) {
      next(error);
    }
  });

  router.get(
    "/members/:userId/tasks/:taskId/history",
    async (request, response, next) => {
      try {
        const result = await store.read((database) => {
          const user = database.users.find(
            (candidate) =>
              candidate.id === request.params.userId &&
              candidate.status === "active" &&
              candidate.role !== "admin",
          );
          const task = database.tasks.find(
            (candidate) =>
              candidate.id === request.params.taskId &&
              candidate.userId === request.params.userId,
          );
          if (!user || !task) {
            throw new ApiError(404, "TASK_NOT_FOUND", "没有找到该成员的任务");
          }
          const history = database.taskAuditEvents
            .filter((event) => event.taskId === task.id)
            .sort((left, right) =>
              right.createdAt.localeCompare(left.createdAt),
            )
            .map((event) => {
              const actor = database.users.find(
                (candidate) => candidate.id === event.actorId,
              );
              return {
                ...event,
                actor: actor ? toPublicUser(actor) : null,
              };
            });
          return {
            user: toPublicUser(user),
            task,
            history,
            auditCoverage: history.length === 0 ? "legacy" : "tracked",
          };
        });
        response.json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get("/members/:userId/tasks", async (request, response, next) => {
    try {
      const { date } = z.object({ date: dateSchema }).parse(request.query);
      const result = await store.read((database) => {
        const user = database.users.find(
          (candidate) =>
            candidate.id === request.params.userId &&
            candidate.status === "active" &&
            candidate.role !== "admin",
        );
        if (!user) {
          throw new ApiError(404, "USER_NOT_FOUND", "没有找到该成员");
        }
        return {
          user: toPublicUser(user),
          tasks: database.tasks
            .filter(
              (task) => task.userId === user.id && task.date === date,
            )
            .sort((a, b) => {
              const statusRank = { doing: 0, todo: 1, done: 2 };
              const priorityRank = {
                p0: 0,
                p1: 1,
                p2: 2,
                p3: 3,
                p4: 4,
              };
              return (
                Number(a.status === "done") - Number(b.status === "done") ||
                priorityRank[a.priority] - priorityRank[b.priority] ||
                statusRank[a.status] - statusRank[b.status] ||
                b.createdAt.localeCompare(a.createdAt)
              );
            }),
        };
      });
      response.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/members/:userId/tasks", async (request, response, next) => {
    try {
      const body = z
        .object({
          title: z.string().trim().min(1).max(120),
          details: z.string().trim().max(1000).default(""),
          date: dateSchema,
          priority: z.enum(["p0", "p1", "p2", "p3", "p4"]).default("p2"),
        })
        .parse(request.body);
      if (body.date < businessDateKey()) {
        throw new ApiError(
          400,
          "PAST_TASK_CREATE_FORBIDDEN",
          "不能给成员派发往日任务",
        );
      }
      const assignerId = request.currentUser!.id;
      const result = await store.mutate((database) => {
        const assignee = database.users.find(
          (candidate) =>
            candidate.id === request.params.userId &&
            candidate.status === "active" &&
            candidate.role === "member",
        );
        const assigner = database.users.find(
          (candidate) => candidate.id === assignerId,
        );
        if (!assignee || !assigner) {
          throw new ApiError(
            404,
            "ASSIGNEE_NOT_FOUND",
            "没有找到可派发任务的成员",
          );
        }
        const now = new Date().toISOString();
        const task: Task = {
          id: randomUUID(),
          userId: assignee.id,
          title: body.title,
          details: body.details,
          date: body.date,
          status: "todo",
          priority: body.priority,
          origin: "assigned",
          assignedBy: assigner.id,
          assignmentId: randomUUID(),
          sourceTaskId: null,
          assignmentDeliveredAt: null,
          assignmentViewedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        };
        database.tasks.push(task);
        appendTaskAudit(
          database,
          task,
          assigner.id,
          "assigned",
          [],
          now,
        );
        return {
          task,
          assigner: toPublicUser(assigner),
          assignee: toPublicUser(assignee),
        };
      });
      realtime.pushUser(result.task.userId, "task:assigned", {
        task: result.task,
        assigner: result.assigner,
      });
      response.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/notifications", async (request, response, next) => {
    try {
      const body = z
        .object({
          all: z.boolean().default(false),
          recipientIds: z.array(z.string().uuid()).max(100).default([]),
          title: z.string().trim().min(1).max(50),
          body: z.string().trim().min(1).max(300),
        })
        .refine((value) => value.all || value.recipientIds.length > 0, {
          message: "请选择至少一位接收成员",
        })
        .parse(request.body);

      const notifications = await store.mutate((database) => {
        const recipients = database.users.filter(
          (user) =>
            user.status === "active" &&
            user.role !== "admin" &&
            user.id !== request.currentUser!.id &&
            (body.all || body.recipientIds.includes(user.id)),
        );
        if (recipients.length === 0) {
          throw new ApiError(400, "NO_RECIPIENTS", "没有可接收通知的成员");
        }
        const now = new Date().toISOString();
        const dispatchId = randomUUID();
        const created = recipients.map(
          (recipient): AppNotification => ({
            id: randomUUID(),
            dispatchId,
            senderId: request.currentUser!.id,
            recipientId: recipient.id,
            title: body.title,
            body: body.body,
            requiresAcknowledgement: true,
            deliveredAt: null,
            acknowledgedAt: null,
            dingCount: 0,
            lastDingAt: null,
            readAt: null,
            createdAt: now,
          }),
        );
        database.notifications.push(...created);
        return created;
      });

      for (const notification of notifications) {
        realtime.notifyUser(notification.recipientId, notification);
      }
      response.status(201).json({
        targeted: notifications.length,
        delivered: notifications.length,
        notifications,
        dispatch: (
          await store.read((database) =>
            buildNotificationDispatches(
              database.notifications,
              database.users,
              request.currentUser!.id,
            ),
          )
        )[0],
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/notification-dispatches", async (request, response, next) => {
    try {
      const dispatches = await store.read((database) =>
        buildNotificationDispatches(
          database.notifications,
          database.users,
          request.currentUser!.id,
        ),
      );
      response.json({ dispatches });
    } catch (error) {
      next(error);
    }
  });

  router.post(
    "/notification-dispatches/:dispatchId/ding",
    async (request, response, next) => {
      try {
        const result = await store.mutate((database) => {
          const entries = database.notifications.filter(
            (notification) =>
              notification.senderId === request.currentUser!.id &&
              notification.dispatchId === request.params.dispatchId &&
              notification.requiresAcknowledgement,
          );
          if (entries.length === 0) {
            throw new ApiError(
              404,
              "NOTIFICATION_DISPATCH_NOT_FOUND",
              "没有找到该提醒",
            );
          }
          const pending = entries.filter(
            (notification) => !notification.acknowledgedAt,
          );
          if (pending.length === 0) {
            throw new ApiError(
              409,
              "NOTIFICATION_ALREADY_ACKNOWLEDGED",
              "所有成员都已确认收到",
            );
          }
          const now = new Date().toISOString();
          for (const notification of entries) {
            notification.dingCount += 1;
            notification.lastDingAt = now;
          }
          return {
            pending: structuredClone(pending).map((notification) => ({
              ...notification,
              dingCount: entries[0].dingCount,
              lastDingAt: now,
            })),
            dispatches: buildNotificationDispatches(
              database.notifications,
              database.users,
              request.currentUser!.id,
            ),
          };
        });
        for (const notification of result.pending) {
          realtime.notifyUser(
            notification.recipientId,
            notification,
            "notification:ding",
          );
        }
        response.json({
          targeted: result.pending.length,
          dispatch: result.dispatches.find(
            (dispatch) => dispatch.id === request.params.dispatchId,
          ),
        });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
