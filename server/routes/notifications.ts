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
      const notifications = await store.read((database) =>
        database.notifications
          .filter(
            (notification) =>
              notification.recipientId === request.currentUser!.id,
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 100),
      );
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
        const notification = await store.mutate((database) => {
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
          target.deliveredAt ??= new Date().toISOString();
          return target;
        });
        realtime.receiptUser(notification.senderId, {
          notificationId: notification.id,
          dispatchId: notification.dispatchId,
          recipientId: notification.recipientId,
          deliveredAt: notification.deliveredAt,
          acknowledgedAt: notification.acknowledgedAt,
        });
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
        const notification = await store.mutate((database) => {
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
          const now = new Date().toISOString();
          target.deliveredAt ??= now;
          target.acknowledgedAt ??= now;
          target.readAt ??= now;
          return target;
        });
        realtime.receiptUser(notification.senderId, {
          notificationId: notification.id,
          dispatchId: notification.dispatchId,
          recipientId: notification.recipientId,
          deliveredAt: notification.deliveredAt,
          acknowledgedAt: notification.acknowledgedAt,
        });
        response.json({ notification });
      } catch (error) {
        next(error);
      }
    },
  );

  return router;
}
