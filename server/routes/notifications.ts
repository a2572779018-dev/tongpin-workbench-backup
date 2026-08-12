import { Router } from "express";
import { ApiError } from "../errors";
import { JsonStore } from "../store";
import type { RealtimeHub } from "./boss";

export function createNotificationsRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  realtime: RealtimeHub,
): Router {
  const router = Router();
  router.use(requireAuth);

  router.get("/", async (request, response, next) => {
    try {
      const notifications = await store.read((database) => {
        const sorted = database.notifications
          .filter(
            (notification) =>
              notification.recipientId === request.currentUser!.id,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const merged = new Map(
          sorted
            .filter(
              (notification) =>
                notification.requiresAcknowledgement &&
                !notification.acknowledgedAt,
            )
            .map((notification) => [notification.id, notification]),
        );
        for (const notification of sorted.slice(0, 100)) {
          merged.set(notification.id, notification);
        }
        return [...merged.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
      });
      response.json({
        notifications,
        unread: notifications.filter((item) => !item.readAt).length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:notificationId/read", async (request, response, next) => {
    try {
      const notification = await store.mutate((database) => {
        const target = database.notifications.find(
          (candidate) =>
            candidate.id === request.params.notificationId &&
            candidate.recipientId === request.currentUser!.id,
        );
        if (!target) {
          throw new ApiError(404, "NOTIFICATION_NOT_FOUND", "没有找到该通知");
        }
        target.readAt ??= new Date().toISOString();
        return target;
      });
      response.json({ notification });
    } catch (error) {
      next(error);
    }
  });

  router.patch(
    "/:notificationId/delivered",
    async (request, response, next) => {
      try {
        const result = await store.mutate((database) => {
          const target = database.notifications.find(
            (candidate) =>
              candidate.id === request.params.notificationId &&
              candidate.recipientId === request.currentUser!.id &&
              candidate.requiresAcknowledgement,
          );
          if (!target) {
            throw new ApiError(
              404,
              "NOTIFICATION_NOT_FOUND",
              "没有找到该提醒",
            );
          }
          const changed = !target.deliveredAt;
          target.deliveredAt ??= new Date().toISOString();
          return { notification: target, changed };
        });
        const { notification } = result;
        if (result.changed) {
          realtime.receiptUser(notification.senderId, {
            notificationId: notification.id,
            dispatchId: notification.dispatchId,
            recipientId: notification.recipientId,
            deliveredAt: notification.deliveredAt,
            acknowledgedAt: notification.acknowledgedAt,
          });
        }
        realtime.notifyUser(notification.recipientId, notification);
        response.json({ notification });
      } catch (error) {
        next(error);
      }
    },
  );

  router.patch(
    "/:notificationId/acknowledge",
    async (request, response, next) => {
      try {
        const result = await store.mutate((database) => {
          const target = database.notifications.find(
            (candidate) =>
              candidate.id === request.params.notificationId &&
              candidate.recipientId === request.currentUser!.id &&
              candidate.requiresAcknowledgement,
          );
          if (!target) {
            throw new ApiError(
              404,
              "NOTIFICATION_NOT_FOUND",
              "没有找到该提醒",
            );
          }
          const changed = !target.acknowledgedAt;
          const now = new Date().toISOString();
          target.deliveredAt ??= now;
          target.acknowledgedAt ??= now;
          target.readAt ??= now;
          return { notification: target, changed };
        });
        const { notification } = result;
        if (result.changed) {
          realtime.receiptUser(notification.senderId, {
            notificationId: notification.id,
            dispatchId: notification.dispatchId,
            recipientId: notification.recipientId,
            deliveredAt: notification.deliveredAt,
            acknowledgedAt: notification.acknowledgedAt,
          });
        }
        realtime.notifyUser(notification.recipientId, notification);
        response.json({ notification });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
