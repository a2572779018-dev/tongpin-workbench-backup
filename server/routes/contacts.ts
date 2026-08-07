import { randomUUID } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { ApiError } from "../errors";
import { requireRole } from "../middleware";
import type { RealtimeHub } from "./boss";
import { JsonStore } from "../store";
import {
  toPublicUser,
  type Contact,
  type DatabaseShape,
  type DirectMessage,
} from "../types";

const userIdSchema = z.string().uuid();
const messageSchema = z.object({
  body: z.string().trim().min(1).max(500),
  mode: z.enum(["normal", "flash"]).default("normal"),
});

const FLASH_MESSAGE_LIFETIME_MS = 5_000;

function contactSummary(
  database: Readonly<DatabaseShape>,
  ownerId: string,
  contact: Contact,
) {
  const user = database.users.find(
    (candidate) =>
      candidate.id === contact.contactId &&
      candidate.status === "active" &&
      candidate.role !== "admin",
  );
  if (!user) return null;
  const messages = database.directMessages.filter(
    (message) =>
      (message.senderId === ownerId &&
        message.recipientId === contact.contactId) ||
      (message.senderId === contact.contactId &&
        message.recipientId === ownerId),
  );
  const lastMessage =
    messages.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    )[0] ?? null;
  return {
    user: toPublicUser(user),
    addedAt: contact.createdAt,
    unreadCount: database.directMessages.filter(
      (message) =>
        message.senderId === contact.contactId &&
        message.recipientId === ownerId &&
        !message.readAt,
    ).length,
    lastMessage,
  };
}

export function createContactsRouter(
  store: JsonStore,
  requireAuth: ReturnType<typeof import("../middleware").createRequireAuth>,
  realtime: RealtimeHub,
): Router {
  const router = Router();
  const flashTimers = new Map<string, NodeJS.Timeout>();
  router.use(requireAuth, requireRole("member", "boss"));

  async function expireFlashMessage(messageId: string): Promise<void> {
    const message = await store.mutate((database) => {
      const target = database.directMessages.find(
        (candidate) =>
          candidate.id === messageId &&
          candidate.mode === "flash" &&
          candidate.expiresAt &&
          !candidate.destroyedAt,
      );
      if (!target || Date.parse(target.expiresAt!) > Date.now()) return null;
      target.body = "";
      target.destroyedAt = new Date().toISOString();
      return structuredClone(target);
    });
    flashTimers.delete(messageId);
    if (!message) return;
    realtime.pushUser(message.senderId, "message:expired", { message });
    realtime.pushUser(message.recipientId, "message:expired", { message });
  }

  function scheduleFlashMessage(message: DirectMessage): void {
    if (!message.expiresAt || message.destroyedAt) return;
    const previous = flashTimers.get(message.id);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(
      () => void expireFlashMessage(message.id),
      Math.max(0, Date.parse(message.expiresAt) - Date.now()),
    );
    timer.unref();
    flashTimers.set(message.id, timer);
  }

  async function expireDueFlashMessages(): Promise<void> {
    const dueIds = await store.read((database) =>
      database.directMessages
        .filter(
          (message) =>
            message.mode === "flash" &&
            message.expiresAt &&
            !message.destroyedAt &&
            Date.parse(message.expiresAt) <= Date.now(),
        )
        .map((message) => message.id),
    );
    await Promise.all(dueIds.map(expireFlashMessage));
  }

  router.get("/search", async (request, response, next) => {
    try {
      const { q } = z
        .object({ q: z.string().trim().min(1).max(30) })
        .parse(request.query);
      const normalized = q.toLocaleLowerCase("zh-CN");
      const users = await store.read((database) =>
        database.users
          .filter(
            (user) =>
              user.id !== request.currentUser!.id &&
              user.status === "active" &&
              user.role !== "admin" &&
              user.name.toLocaleLowerCase("zh-CN").includes(normalized),
          )
          .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
          .slice(0, 12)
          .map(toPublicUser),
      );
      response.json({ users });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (request, response, next) => {
    try {
      const ownerId = request.currentUser!.id;
      const contacts = await store.read((database) =>
        database.contacts
          .filter((contact) => contact.ownerId === ownerId)
          .map((contact) => contactSummary(database, ownerId, contact))
          .filter((contact) => contact !== null)
          .sort((left, right) =>
            (right.lastMessage?.createdAt ?? right.addedAt).localeCompare(
              left.lastMessage?.createdAt ?? left.addedAt,
            ),
          ),
      );
      response.json({
        contacts,
        unread: contacts.reduce(
          (total, contact) => total + contact.unreadCount,
          0,
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/", async (request, response, next) => {
    try {
      const { userId } = z
        .object({ userId: userIdSchema })
        .parse(request.body);
      const ownerId = request.currentUser!.id;
      if (userId === ownerId) {
        throw new ApiError(400, "CONTACT_SELF", "不能把自己添加为联系人");
      }
      const contact = await store.mutate((database) => {
        const user = database.users.find(
          (candidate) =>
            candidate.id === userId &&
            candidate.status === "active" &&
            candidate.role !== "admin",
        );
        if (!user) {
          throw new ApiError(404, "CONTACT_NOT_FOUND", "没有找到该联系人");
        }
        let entry = database.contacts.find(
          (candidate) =>
            candidate.ownerId === ownerId &&
            candidate.contactId === userId,
        );
        if (!entry) {
          entry = {
            ownerId,
            contactId: userId,
            createdAt: new Date().toISOString(),
          };
          database.contacts.push(entry);
        }
        return contactSummary(database, ownerId, entry);
      });
      response.status(201).json({ contact });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:contactId/messages", async (request, response, next) => {
    try {
      await expireDueFlashMessages();
      const contactId = userIdSchema.parse(request.params.contactId);
      const ownerId = request.currentUser!.id;
      const messages = await store.read((database) => {
        const contact = database.contacts.some(
          (candidate) =>
            candidate.ownerId === ownerId &&
            candidate.contactId === contactId,
        );
        if (!contact) {
          throw new ApiError(404, "CONTACT_NOT_FOUND", "请先添加该联系人");
        }
        return database.directMessages
          .filter(
            (message) =>
              (message.senderId === ownerId &&
                message.recipientId === contactId) ||
              (message.senderId === contactId &&
                message.recipientId === ownerId),
          )
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .slice(-100);
      });
      response.json({ messages });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:contactId/messages", async (request, response, next) => {
    try {
      const contactId = userIdSchema.parse(request.params.contactId);
      const { body, mode } = messageSchema.parse(request.body);
      const senderId = request.currentUser!.id;
      const result = await store.mutate((database) => {
        const hasContact = database.contacts.some(
          (contact) =>
            contact.ownerId === senderId &&
            contact.contactId === contactId,
        );
        const recipient = database.users.find(
          (candidate) =>
            candidate.id === contactId &&
            candidate.status === "active" &&
            candidate.role !== "admin",
        );
        const sender = database.users.find(
          (candidate) => candidate.id === senderId,
        );
        if (!hasContact || !recipient || !sender) {
          throw new ApiError(404, "CONTACT_NOT_FOUND", "请先添加该联系人");
        }
        const now = new Date().toISOString();
        const message: DirectMessage = {
          id: randomUUID(),
          senderId,
          recipientId: contactId,
          body,
          mode,
          readAt: null,
          expiresAt: null,
          destroyedAt: null,
          createdAt: now,
        };
        database.directMessages.push(message);
        if (
          !database.contacts.some(
            (contact) =>
              contact.ownerId === contactId &&
              contact.contactId === senderId,
          )
        ) {
          database.contacts.push({
            ownerId: contactId,
            contactId: senderId,
            createdAt: now,
          });
        }
        return { message, sender: toPublicUser(sender) };
      });
      realtime.messageUser(contactId, result.message, result.sender);
      response.status(201).json({ message: result.message });
    } catch (error) {
      next(error);
    }
  });

  router.patch("/:contactId/read", async (request, response, next) => {
    try {
      const contactId = userIdSchema.parse(request.params.contactId);
      const ownerId = request.currentUser!.id;
      const updated = await store.mutate((database) => {
        const readAt = new Date().toISOString();
        const changed: DirectMessage[] = [];
        for (const message of database.directMessages) {
          if (
            message.senderId === contactId &&
            message.recipientId === ownerId &&
            !message.readAt
          ) {
            message.readAt = readAt;
            if (message.mode === "flash" && !message.expiresAt) {
              message.expiresAt = new Date(
                Date.parse(readAt) + FLASH_MESSAGE_LIFETIME_MS,
              ).toISOString();
            }
            changed.push(structuredClone(message));
          }
        }
        return changed;
      });
      for (const message of updated) {
        if (message.mode === "flash") scheduleFlashMessage(message);
        realtime.pushUser(message.senderId, "message:read", { message });
        realtime.pushUser(message.recipientId, "message:read", { message });
      }
      response.json({ ok: true, messages: updated });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
